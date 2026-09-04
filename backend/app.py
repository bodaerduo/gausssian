from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
import uuid
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncIterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel


QUALITY = {
    "fast": {"fps": 2, "video_width": 854, "video_height": 480, "steps": 10_000, "max_resolution": 480, "max_splats": 2_000_000},
    "balanced": {"fps": 4, "video_width": 1280, "video_height": 720, "steps": 30_000, "max_resolution": 720, "max_splats": 5_000_000},
    "high": {"fps": 6, "video_width": 1920, "video_height": 1080, "steps": 50_000, "max_resolution": 1080, "max_splats": 8_000_000},
}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v"}
TERMINAL_STATUSES = {"completed", "failed"}


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT_VALUE = os.getenv("GAUSSIAN_DATA_ROOT", "").strip()
DATA_ROOT = Path(DATA_ROOT_VALUE) if DATA_ROOT_VALUE else PROJECT_ROOT / "runtime" / "data"
FFMPEG_BIN = os.getenv("FFMPEG_BIN", "/usr/bin/ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "/usr/bin/ffprobe")
VIDEO_MAX_DIMENSION = env_int("GAUSSIAN_VIDEO_MAX_DIMENSION", 1920)
COLMAP_BIN = os.getenv("COLMAP_BIN", "/usr/local/bin/colmap")
BRUSH_BIN = os.getenv("BRUSH_BIN", "/usr/local/bin/brush-cli")
BRUSH_EXTRA_ARGS = shlex.split(os.getenv("BRUSH_EXTRA_ARGS", ""))
CUBECL_WGPU_DEFAULT_DEVICE = os.getenv("CUBECL_WGPU_DEFAULT_DEVICE", "DiscreteGpu(0)").strip() or "DiscreteGpu(0)"
os.environ.setdefault("CUBECL_WGPU_DEFAULT_DEVICE", CUBECL_WGPU_DEFAULT_DEVICE)
MAX_UPLOAD_BYTES = env_int("GAUSSIAN_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024)
MAX_WORKERS = env_int("GAUSSIAN_MAX_WORKERS", 1)
MATCHER = os.getenv("COLMAP_MATCHER", "exhaustive")


class ReconstructionUpdate(BaseModel):
    name: str | None = None
    thumbnail: str | None = None

PRODUCT_ROUTES = [
    {
        "id": "brush_static",
        "name": "标准 Gaussian 建模",
        "kind": "production",
        "enabled": True,
        "asset_type": "gaussian",
        "description": "现有 FFmpeg、COLMAP、Brush 和 SuperSplat 生产路线。",
        "features": ["稳定生成 final.ply", "SuperSplat 编辑", "PLY/SOG 版本管理"],
    },
    {
        "id": "abot_recon_poc",
        "name": "ABot-Recon 流式扫描",
        "kind": "poc",
        "enabled": os.getenv("ABOT_RECON_ENABLED", "false").lower() == "true",
        "asset_type": "pointcloud_preview",
        "description": "固定 12 帧局部上下文的流式点图、轨迹和置信度预览。",
        "features": ["逐窗口点云增长", "相机轨迹", "置信度过滤", "可选回环优化"],
    },
    {
        "id": "lingbot_map",
        "name": "LingBot-Map 空间地图",
        "kind": "showcase",
        "enabled": os.getenv("LINGBOT_MAP_ENABLED", "false").lower() == "true",
        "asset_type": "pointcloud_preview",
        "description": "面向长视频的流式空间重建、轨迹展示和点云飞行回放。",
        "features": ["长视频滑窗推理", "Viser 交互查看", "鸟瞰/跟随镜头", "天空遮罩"],
    },
]
SPLAT_TRANSFORM_BIN = os.getenv("SPLAT_TRANSFORM_BIN", "splat-transform")

STATE_LOCK = threading.RLock()
LOG_LOCK = threading.RLock()
JOB_LOCKS: dict[str, threading.RLock] = {}
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="gaussian-worker")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def elapsed_seconds(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    try:
        return max(0.0, (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds())
    except (TypeError, ValueError):
        return None


def job_dir(job_id: str) -> Path:
    return DATA_ROOT / "jobs" / job_id


def daily_log_path() -> Path:
    """Return the log file for the server's current calendar day."""
    day = datetime.now().astimezone().date().isoformat()
    return DATA_ROOT / "logs" / f"{day}.log"


def valid_job_id(job_id: str) -> bool:
    return re.fullmatch(r"gs-[0-9a-f]{12}", job_id) is not None


def state_path(job_id: str) -> Path:
    return job_dir(job_id) / "state.json"


def events_path(job_id: str) -> Path:
    return job_dir(job_id) / "events.ndjson"


def read_state(job_id: str) -> dict[str, Any] | None:
    path = state_path(job_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_state(job_id: str, state: dict[str, Any]) -> None:
    state["updated_at"] = now()
    path = state_path(job_id)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def emit(job_id: str, *, event_type: str = "progress", phase: str, progress: int, message: str, **extra: Any) -> None:
    lock = JOB_LOCKS[job_id]
    with lock:
        state = read_state(job_id) or {"id": job_id}
        timestamp = now()
        previous_phase = state.get("phase")
        previous_started = state.get("phase_started_at")
        stage_durations = dict(state.get("stage_durations") or {})
        if previous_phase and previous_phase != phase:
            duration = elapsed_seconds(previous_started, timestamp)
            if duration is not None:
                stage_durations[previous_phase] = round(duration, 1)
        phase_started_at = previous_started if previous_phase == phase else timestamp
        status = state.get("status", "processing")
        if event_type == "completed":
            status = "completed"
        elif event_type == "failed":
            status = "failed"
        elif status == "queued":
            status = "processing"
        state.update({"status": status, "phase": phase, "progress": progress, "message": message, "phase_started_at": phase_started_at, "stage_durations": stage_durations, **extra})
        if event_type in TERMINAL_STATUSES:
            if previous_phase == phase:
                duration = elapsed_seconds(previous_started, timestamp)
                if duration is not None:
                    stage_durations[phase] = round(duration, 1)
            state["stage_durations"] = stage_durations
            state["finished_at"] = timestamp
            total = elapsed_seconds(state.get("created_at"), timestamp)
            if total is not None:
                state["total_duration_seconds"] = round(total, 1)
        event = {"type": event_type, "id": job_id, "phase": phase, "progress": progress, "message": message, **extra}
        with events_path(job_id).open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
        write_state(job_id, state)


def append_log(job_id: str, text: str) -> None:
    # Keep the per-job log for detailed troubleshooting and also append to a
    # date-rotated application log so operators have one predictable place to
    # inspect all worker activity. Both files live below GAUSSIAN_DATA_ROOT.
    timestamp = now()
    with LOG_LOCK:
        worker_path = job_dir(job_id) / "worker.log"
        worker_path.parent.mkdir(parents=True, exist_ok=True)
        with worker_path.open("a", encoding="utf-8") as stream:
            stream.write(text)

        daily_path = daily_log_path()
        daily_path.parent.mkdir(parents=True, exist_ok=True)
        with daily_path.open("a", encoding="utf-8") as stream:
            for line in text.splitlines() or [""]:
                stream.write(f"[{timestamp}] [{job_id}] {line}\n")


def run_command(
    job_id: str,
    command: list[str],
    *,
    timeout: int = 0,
    error_output: tuple[str, ...] = (),
) -> None:
    command_line = shlex.join(command)
    append_log(job_id, f"\n$ {command_line}\n")
    try:
        process = subprocess.Popen(
            command,
            cwd=job_dir(job_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"找不到可执行文件：{command[0]}") from exc

    deadline = time.monotonic() + timeout if timeout else None
    assert process.stdout is not None
    for line in process.stdout:
        append_log(job_id, line)
        if any(marker.lower() in line.lower() for marker in error_output):
            append_log(job_id, f"ERROR: GPU 加速异常或发生 CPU 回退：{line.strip()}\n")
        if deadline and time.monotonic() > deadline:
            os.killpg(process.pid, signal.SIGTERM)
            raise RuntimeError(f"命令超时：{command[0]}")
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(
            f"命令失败（退出码 {return_code}）：{command[0]}，详见任务 worker.log 或 "
            "GAUSSIAN_DATA_ROOT/logs/YYYY-MM-DD.log"
        )


def safe_filename(filename: str | None, fallback: str) -> str:
    candidate = Path(filename or fallback).name
    if not candidate or candidate in {".", ".."}:
        return fallback
    return candidate


async def save_upload(upload: UploadFile, target: Path) -> int:
    total = 0
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as stream:
        while chunk := await upload.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="单个文件超过上传大小限制")
            stream.write(chunk)
    return total


def image_files(image_dir: Path) -> list[Path]:
    return sorted(path for path in image_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)


def validate_ply(path: Path) -> int:
    if not path.exists() or path.stat().st_size < 100:
        raise RuntimeError("Brush 没有生成有效的 PLY 文件")
    with path.open("rb") as stream:
        header = stream.read(4096)
    if not header.startswith(b"ply") or b"end_header" not in header:
        raise RuntimeError("输出文件不是合法的 PLY")
    for line in header.decode("ascii", errors="ignore").splitlines():
        if line.startswith("element vertex "):
            count = int(line.split()[-1])
            if count <= 0:
                raise RuntimeError("PLY 顶点数量必须大于 0")
            return count
    raise RuntimeError("PLY 缺少 vertex 数量")


def variant_dir(job_id: str) -> Path:
    return job_dir(job_id) / "output" / "variants"


def version_name(version: int) -> str:
    return f"v{version:03d}"


def next_variant_version(job_id: str) -> int:
    root = variant_dir(job_id)
    if not root.exists():
        return 1
    versions = []
    for path in root.glob("v*.ply"):
        try:
            versions.append(int(path.stem[1:]))
        except ValueError:
            continue
    return max(versions, default=0) + 1


def variant_path(job_id: str, version: int) -> Path:
    return variant_dir(job_id) / f"{version_name(version)}.ply"


def parse_variant(version: str) -> int:
    match = re.fullmatch(r"v?(\d{1,6})", version)
    if not match:
        raise HTTPException(status_code=404, detail="编辑版本不存在")
    return int(match.group(1))


def optimization_entry(job_id: str, version: int, decimate: str | None, harmonics: int) -> None:
    source = variant_path(job_id, version)
    output_dir = variant_dir(job_id)
    optimized = output_dir / f"{version_name(version)}.compressed.ply"
    sog = output_dir / f"{version_name(version)}.sog"
    try:
        if not shutil.which(SPLAT_TRANSFORM_BIN):
            raise RuntimeError(f"未找到 SplatTransform：{SPLAT_TRANSFORM_BIN}")
        command = [SPLAT_TRANSFORM_BIN, str(source), "--filter-nan", "--filter-harmonics", str(max(0, min(3, harmonics)))]
        if decimate:
            command.extend(["--decimate", decimate])
        command.append(str(optimized))
        result = subprocess.run(command, capture_output=True, text=True, timeout=3600, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "SplatTransform 压缩失败")
        sog_result = subprocess.run([SPLAT_TRANSFORM_BIN, str(optimized), str(sog)], capture_output=True, text=True, timeout=3600, check=False)
        if sog_result.returncode != 0:
            raise RuntimeError(sog_result.stderr.strip() or "SOG 导出失败")
        state = read_state(job_id) or {}
        variants = state.get("variants", [])
        for item in variants:
            if item.get("version") == version:
                item.update({"optimization": "completed", "compressed_url": f"/api/v1/reconstructions/{job_id}/variants/{version}/compressed", "sog_url": f"/api/v1/reconstructions/{job_id}/variants/{version}/sog", "compressed_bytes": optimized.stat().st_size, "sog_bytes": sog.stat().st_size})
        write_state(job_id, state)
    except Exception as exc:  # noqa: BLE001 - background boundary
        state = read_state(job_id) or {}
        for item in state.get("variants", []):
            if item.get("version") == version:
                item.update({"optimization": "failed", "optimization_error": str(exc)})
        write_state(job_id, state)


def run_pipeline(job_id: str, source_kind: str, source_path: Path, quality_name: str) -> None:
    config = QUALITY[quality_name]
    video_width = min(config["video_width"], VIDEO_MAX_DIMENSION)
    video_height = min(config["video_height"], VIDEO_MAX_DIMENSION)
    root = job_dir(job_id)
    dataset = root / "dataset"
    images = dataset / "images"
    sparse = dataset / "sparse"
    output = root / "output"
    images.mkdir(parents=True, exist_ok=True)
    sparse.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)

    emit(job_id, phase="素材检查", progress=5, message="正在检查输入素材")
    if source_kind == "video":
        emit(job_id, phase="素材检查", progress=8, message="正在读取视频信息")
        run_command(job_id, [FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(source_path)])
        emit(
            job_id,
            phase="FFmpeg 抽帧",
            progress=12,
            message=f"正在将视频限制到 {video_width}×{video_height}px 并抽取多视角帧",
        )
        run_command(
            job_id,
            [
                FFMPEG_BIN,
                "-hide_banner",
                "-loglevel",
                "warning",
                "-y",
                "-i",
                str(source_path),
                "-vf",
                f"fps={config['fps']},scale={video_width}:{video_height}:force_original_aspect_ratio=decrease",
                str(images / "%06d.jpg"),
            ],
        )
    else:
        emit(job_id, phase="FFmpeg 抽帧", progress=12, message="图片组无需抽帧，正在整理输入")
        for index, source in enumerate(sorted(source_path.iterdir()), start=1):
            if source.is_file() and source.suffix.lower() in IMAGE_EXTENSIONS:
                destination = images / f"{index:06d}{source.suffix.lower()}"
                shutil.copy2(source, destination)

    count = len(image_files(images))
    if count < 3:
        raise RuntimeError(f"有效图片只有 {count} 张，至少需要 3 张")

    database = dataset / "database.db"
    emit(job_id, phase="COLMAP 机位姿与稀疏重建", progress=25, message=f"正在提取特征 · {count} 张图片")
    run_command(
        job_id,
        [COLMAP_BIN, "feature_extractor", "--database_path", str(database), "--image_path", str(images), "--ImageReader.single_camera", "1", "--FeatureExtraction.use_gpu", "1", "--FeatureExtraction.gpu_index", "0"],
    )

    matcher_name = "sequential" if source_kind == "video" else MATCHER
    if matcher_name not in {"exhaustive", "sequential"}:
        raise RuntimeError("COLMAP_MATCHER 只能是 exhaustive 或 sequential")
    matcher_command = f"{matcher_name}_matcher"
    emit(job_id, phase="COLMAP 机位姿与稀疏重建", progress=45, message=f"正在进行{matcher_name}匹配")
    run_command(job_id, [COLMAP_BIN, matcher_command, "--database_path", str(database), "--FeatureMatching.use_gpu", "1", "--FeatureMatching.gpu_index", "0"])

    emit(job_id, phase="COLMAP 机位姿与稀疏重建", progress=65, message="正在估计相机位姿和稀疏点云")
    run_command(
        job_id,
        [
            COLMAP_BIN,
            "mapper",
            "--database_path",
            str(database),
            "--image_path",
            str(images),
            "--output_path",
            str(sparse),
            "--Mapper.ba_use_gpu",
            "1",
            "--Mapper.ba_gpu_index",
            "0",
        ],
        error_output=(
            "Falling back to CPU-based",
            "compiled without CUDA support",
            "compiled without cuDSS support",
            "no CUDA GPU is available",
        ),
    )
    model_dir = sparse / "0"
    if not (model_dir / "cameras.bin").exists() or not (model_dir / "images.bin").exists():
        raise RuntimeError("COLMAP 未生成 sparse/0 相机模型，请检查素材重叠和注册率")

    brush_args = [
        BRUSH_BIN,
        str(dataset),
        "--total-train-iters",
        str(config["steps"]),
        "--max-resolution",
        str(config["max_resolution"]),
        "--max-splats",
        str(config["max_splats"]),
        "--export-path",
        str(output),
        "--export-name",
        "final.ply",
        "--export-every",
        str(config["steps"]),
        *BRUSH_EXTRA_ARGS,
    ]
    ply = output / "final.ply"
    emit(job_id, phase="Brush Gaussian 训练", progress=72, message=f"开始训练 · {config['steps']} iterations")
    try:
        run_command(job_id, brush_args)
    except RuntimeError as exc:
        # Brush may segfault during native teardown after it has already
        # exported the final model. Keep the artifact only when it passes the
        # same validation used for normal successful exits.
        if "退出码 -11" not in str(exc):
            raise
        validate_ply(ply)
        append_log(job_id, f"\nWARNING: Brush exited with -11 after exporting a valid PLY; continuing.\n")

    emit(job_id, phase="PLY 质量校验", progress=97, message="正在校验 PLY 输出")
    splat_count = validate_ply(ply)
    emit(
        job_id,
        event_type="completed",
        phase="PLY 质量校验",
        progress=100,
        message="建模完成，模型可以下载",
        download_url=f"/api/v1/reconstructions/{job_id}/download/{job_id}.ply",
        ply_bytes=ply.stat().st_size,
        image_count=count,
        splat_count=splat_count,
    )


def run_addon_pipeline(job_id: str, source_kind: str, source_path: Path, quality_name: str, route: str) -> None:
    """Run an optional external worker without importing its Python environment."""
    route_name = next(item["name"] for item in PRODUCT_ROUTES if item["id"] == route)
    preview_dir = job_dir(job_id) / "preview"
    preview_dir.mkdir(parents=True, exist_ok=True)
    output_dir = job_dir(job_id) / "products" / route
    output_dir.mkdir(parents=True, exist_ok=True)
    emit(job_id, phase=f"{route_name} POC", progress=8, message=f"已进入 {route_name} 独立 Worker 适配层")
    command_key = "ABOT_RECON_CMD" if route == "abot_recon_poc" else "LINGBOT_MAP_CMD"
    service_key = "ABOT_RECON_URL" if route == "abot_recon_poc" else "LINGBOT_MAP_URL"
    service_url = os.getenv(service_key, "").strip().rstrip("/")
    if service_url:
        run_remote_addon_pipeline(job_id, source_kind, source_path, quality_name, route, service_url, output_dir, preview_dir)
        return
    command_template = os.getenv(command_key, "").strip()
    if not command_template:
        raise RuntimeError(f"{route_name} Worker 尚未安装或配置（请设置 {command_key}）；标准 Brush 路线不受影响")
    command = command_template.format(
        job_id=job_id,
        source=str(source_path),
        output=str(output_dir),
        preview=str(preview_dir),
        quality=quality_name,
    )
    append_log(job_id, f"\n[{route_name}] 启动外部 Worker：{command}\n")
    process = subprocess.Popen(
        shlex.split(command),
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    for line in process.stdout:
        append_log(job_id, line)
        emit(job_id, phase=f"{route_name} POC", progress=20, message=line.strip()[:240] or "Worker 运行中")
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(f"{route_name} Worker 退出码 {return_code}")
    emit(job_id, event_type="completed", phase=f"{route_name} POC", progress=100, message="预览资产已写入独立产物目录", route=route, asset_type="pointcloud_preview", preview_url=f"/api/v1/reconstructions/{job_id}/preview")


def json_http(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Worker API 请求失败：{url}") from exc


def run_remote_addon_pipeline(job_id: str, source_kind: str, source_path: Path, quality_name: str, route: str, service_url: str, output_dir: Path, preview_dir: Path) -> None:
    route_name = next(item["name"] for item in PRODUCT_ROUTES if item["id"] == route)
    submitted = json_http(
        f"{service_url}/v1/jobs",
        method="POST",
        payload={
            "job_id": job_id,
            "source_kind": source_kind,
            "source_path": str(source_path),
            "output_dir": str(output_dir),
            "preview_dir": str(preview_dir),
            "quality": quality_name,
        },
    )
    worker_job_id = str(submitted.get("id", ""))
    if not worker_job_id:
        raise RuntimeError(f"{route_name} Worker 未返回任务 ID")
    event_index = 0
    while True:
        status = json_http(f"{service_url}/v1/jobs/{worker_job_id}")
        events = status.get("events", [])
        for event in events[event_index:]:
            event_index += 1
            emit(
                job_id,
                phase=f"{route_name} POC",
                progress=max(8, min(98, int(event.get("progress", 20)))),
                message=str(event.get("message", "Worker 运行中"))[:240],
                route=route,
                asset_type="pointcloud_preview",
                frame=event.get("frame"),
                point_count=event.get("point_count"),
                confidence=event.get("confidence"),
                preview_url=event.get("preview_url"),
            )
        state = status.get("status")
        if state == "completed":
            emit(job_id, event_type="completed", phase=f"{route_name} POC", progress=100, message="预览资产已写入独立产物目录", route=route, asset_type="pointcloud_preview", preview_url=f"/api/v1/reconstructions/{job_id}/preview")
            return
        if state == "failed":
            raise RuntimeError(str(status.get("error") or f"{route_name} Worker 失败"))
        time.sleep(0.75)


def worker_entry(job_id: str, source_kind: str, source_path: Path, quality_name: str, route: str = "brush_static") -> None:
    try:
        if route == "brush_static":
            run_pipeline(job_id, source_kind, source_path, quality_name)
        else:
            run_addon_pipeline(job_id, source_kind, source_path, quality_name, route)
    except Exception as exc:  # noqa: BLE001 - boundary for background jobs
        append_log(job_id, f"\nERROR: {exc}\n")
        emit(job_id, event_type="failed", phase="失败", progress=0, message=str(exc))


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    DATA_ROOT.joinpath("jobs").mkdir(parents=True, exist_ok=True)
    DATA_ROOT.joinpath("logs").mkdir(parents=True, exist_ok=True)
    yield
    EXECUTOR.shutdown(wait=False, cancel_futures=False)


app = FastAPI(title="Gaussian GPU API", version="0.1.0", lifespan=lifespan)
origins = [origin.strip() for origin in os.getenv("API_CORS_ORIGINS", "*").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engines": {
            "ffmpeg": shutil.which(FFMPEG_BIN) or Path(FFMPEG_BIN).exists(),
            "ffprobe": shutil.which(FFPROBE_BIN) or Path(FFPROBE_BIN).exists(),
            "colmap": shutil.which(COLMAP_BIN) or Path(COLMAP_BIN).exists(),
            "brush": shutil.which(BRUSH_BIN) or Path(BRUSH_BIN).exists(),
            "splat_transform": bool(shutil.which(SPLAT_TRANSFORM_BIN)),
        },
    }


@app.get("/api/v1/products")
def products() -> dict[str, list[dict[str, Any]]]:
    """Return additive product routes without changing the default Brush route."""
    return {"products": PRODUCT_ROUTES}


def product_route(route_id: str) -> dict[str, Any]:
    route = next((item for item in PRODUCT_ROUTES if item["id"] == route_id), None)
    if route is None:
        raise HTTPException(status_code=400, detail=f"不支持的产品路线：{route_id}")
    if not route["enabled"]:
        raise HTTPException(status_code=409, detail=f"产品路线 {route['name']} 尚未启用 GPU Worker")
    return route


@app.post("/api/v1/reconstructions", status_code=202)
async def create_reconstruction(
    videos: UploadFile | None = File(default=None),
    images: list[UploadFile] | None = File(default=None),
    quality: str = Form(default="balanced"),
    route: str = Form(default="brush_static"),
) -> dict[str, Any]:
    if quality not in QUALITY:
        raise HTTPException(status_code=400, detail=f"quality 必须是：{', '.join(QUALITY)}")
    selected_route = product_route(route)
    image_uploads = images or []
    has_video = videos is not None and bool(videos.filename)
    has_images = bool(image_uploads)
    if has_video == has_images:
        raise HTTPException(status_code=400, detail="请提交一个视频或一组图片，不能同时提交或全部为空")
    if has_video and Path(videos.filename or "").suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的视频格式")
    if has_images and any(Path(upload.filename or "").suffix.lower() not in IMAGE_EXTENSIONS for upload in image_uploads):
        raise HTTPException(status_code=400, detail="图片仅支持 JPG、JPEG、PNG、WEBP")

    job_id = f"gs-{uuid.uuid4().hex[:12]}"
    root = job_dir(job_id)
    root.mkdir(parents=True, exist_ok=False)
    JOB_LOCKS[job_id] = threading.RLock()
    created_at = now()
    state = {"id": job_id, "status": "queued", "progress": 0, "phase": "素材检查", "message": "任务已排队", "quality": quality, "route": selected_route["id"], "asset_type": selected_route["asset_type"], "created_at": created_at, "updated_at": created_at, "phase_started_at": created_at, "stage_durations": {}}
    state_path(job_id).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    events_path(job_id).write_text(json.dumps({"type": "queued", "id": job_id, "route": selected_route["id"], "asset_type": selected_route["asset_type"], "phase": "素材检查", "progress": 0, "message": "任务已排队"}, ensure_ascii=False) + "\n", encoding="utf-8")

    total = 0
    try:
        if has_video:
            video = videos
            video_path = root / "source" / safe_filename(video.filename, "source.mp4")
            total = await save_upload(video, video_path)
            source_kind = "video"
            source_path = video_path
        else:
            image_dir = root / "source-images"
            image_dir.mkdir()
            for index, upload in enumerate(image_uploads, start=1):
                filename = safe_filename(upload.filename, f"image-{index}.jpg")
                total += await save_upload(upload, image_dir / f"{index:06d}-{filename}")
            source_kind = "images"
            source_path = image_dir
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="上传总大小超过限制")
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        JOB_LOCKS.pop(job_id, None)
        raise

    EXECUTOR.submit(worker_entry, job_id, source_kind, source_path, quality, selected_route["id"])
    return {"id": job_id, "status": "queued", "route": selected_route["id"], "asset_type": selected_route["asset_type"], "events_url": f"/api/v1/reconstructions/{job_id}/events", "download_url": f"/api/v1/reconstructions/{job_id}/download/{job_id}.ply"}


@app.get("/api/v1/reconstructions")
def list_reconstructions() -> dict[str, list[dict[str, Any]]]:
    jobs_root = DATA_ROOT / "jobs"
    jobs: list[dict[str, Any]] = []
    if jobs_root.exists():
        for path in jobs_root.iterdir():
            if not path.is_dir():
                continue
            state = read_state(path.name)
            if state:
                state["modelUrl"] = f"/api/v1/reconstructions/{path.name}/download/{path.name}.ply"
                jobs.append(state)
    jobs.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return {"jobs": jobs}


@app.get("/api/v1/reconstructions/{job_id}/preview")
def list_preview_assets(job_id: str) -> dict[str, Any]:
    """List additive point-cloud/video preview assets produced by optional workers."""
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    preview_dir = job_dir(job_id) / "preview"
    assets = []
    if preview_dir.exists():
        for path in sorted(preview_dir.iterdir()):
            if path.is_file() and path.name != "state.json":
                assets.append({
                    "name": path.name,
                    "bytes": path.stat().st_size,
                    "url": f"/api/v1/reconstructions/{job_id}/preview/{path.name}",
                })
    return {"id": job_id, "route": (read_state(job_id) or {}).get("route"), "assets": assets}


@app.get("/api/v1/reconstructions/{job_id}/preview/{filename}")
def download_preview_asset(job_id: str, filename: str) -> FileResponse:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    safe_name = Path(filename).name
    if safe_name != filename or filename in {"", ".", ".."}:
        raise HTTPException(status_code=400, detail="非法预览文件名")
    path = job_dir(job_id) / "preview" / safe_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="预览资产不存在")
    return FileResponse(path, media_type="application/octet-stream", filename=safe_name)


@app.post("/api/v1/reconstructions/import", status_code=201)
async def import_ply(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = safe_filename(file.filename, "imported.ply")
    if Path(filename).suffix.lower() != ".ply":
        raise HTTPException(status_code=400, detail="只支持导入 Gaussian PLY 文件")
    job_id = f"gs-{uuid.uuid4().hex[:12]}"
    root = job_dir(job_id)
    root.mkdir(parents=True, exist_ok=False)
    JOB_LOCKS[job_id] = threading.RLock()
    target = root / "output" / "final.ply"
    try:
        await save_upload(file, target)
        splat_count = validate_ply(target)
    except Exception as exc:
        shutil.rmtree(root, ignore_errors=True)
        JOB_LOCKS.pop(job_id, None)
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    state = {
        "id": job_id,
        "status": "completed",
        "progress": 100,
        "phase": "PLY 导入",
        "message": "PLY 模型已导入",
        "quality": "imported",
        "sourceName": filename,
        "sourceKind": "ply",
        "created_at": now(),
        "updated_at": now(),
        "ply_bytes": target.stat().st_size,
        "splat_count": splat_count,
        "image_count": 0,
    }
    state_path(job_id).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"id": job_id, "status": "completed", "modelUrl": f"/api/v1/reconstructions/{job_id}/download/{job_id}.ply", "splat_count": splat_count, "ply_bytes": target.stat().st_size}


@app.delete("/api/v1/reconstructions/{job_id}", status_code=204)
def delete_reconstruction(job_id: str) -> None:
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    state = read_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if state.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=409, detail="任务正在运行，暂不能删除")
    shutil.rmtree(job_dir(job_id), ignore_errors=False)
    JOB_LOCKS.pop(job_id, None)


@app.post("/api/v1/reconstructions/{job_id}/variants", status_code=201)
async def upload_variant(job_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if Path(file.filename or "").suffix.lower() != ".ply":
        raise HTTPException(status_code=400, detail="编辑器只接受 PLY 导出文件")
    version = next_variant_version(job_id)
    target = variant_path(job_id, version)
    await save_upload(file, target)
    try:
        count = validate_ply(target)
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    state = read_state(job_id) or {}
    variants = state.setdefault("variants", [])
    variants.append({"version": version, "name": safe_filename(file.filename, f"{version_name(version)}.ply"), "splat_count": count, "bytes": target.stat().st_size, "optimization": "not_started", "download_url": f"/api/v1/reconstructions/{job_id}/variants/{version}/download"})
    write_state(job_id, state)
    return variants[-1]


@app.post("/api/v1/reconstructions/{job_id}/variants/{version}/optimize", status_code=202)
def optimize_variant(job_id: str, version: str, decimate: str | None = Form(default=None), harmonics: int = Form(default=2)) -> dict[str, Any]:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    parsed = parse_variant(version)
    if not variant_path(job_id, parsed).exists():
        raise HTTPException(status_code=404, detail="编辑版本不存在")
    state = read_state(job_id) or {}
    for item in state.get("variants", []):
        if item.get("version") == parsed:
            item["optimization"] = "queued"
    write_state(job_id, state)
    EXECUTOR.submit(optimization_entry, job_id, parsed, decimate, harmonics)
    return {"status": "queued", "version": parsed}


@app.get("/api/v1/reconstructions/{job_id}/variants/{version}/download")
def download_variant(job_id: str, version: str) -> FileResponse:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    parsed = parse_variant(version)
    path = variant_path(job_id, parsed)
    if not path.exists():
        raise HTTPException(status_code=404, detail="编辑版本不存在")
    return FileResponse(path, media_type="application/octet-stream", filename=f"{job_id}-{version_name(parsed)}.ply")


@app.get("/api/v1/reconstructions/{job_id}/variants/{version}/compressed")
def download_compressed_variant(job_id: str, version: str) -> FileResponse:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    parsed = parse_variant(version)
    path = variant_dir(job_id) / f"{version_name(parsed)}.compressed.ply"
    if not path.exists():
        raise HTTPException(status_code=404, detail="压缩版本尚未生成")
    return FileResponse(path, media_type="application/octet-stream", filename=f"{job_id}-{version_name(parsed)}.compressed.ply")


@app.get("/api/v1/reconstructions/{job_id}/variants/{version}/sog")
def download_sog_variant(job_id: str, version: str) -> FileResponse:
    if not valid_job_id(job_id) or read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    parsed = parse_variant(version)
    path = variant_dir(job_id) / f"{version_name(parsed)}.sog"
    if not path.exists():
        raise HTTPException(status_code=404, detail="SOG 版本尚未生成")
    return FileResponse(path, media_type="application/octet-stream", filename=f"{job_id}-{version_name(parsed)}.sog")


@app.get("/api/v1/reconstructions/{job_id}/colmap")
def reconstruction_colmap(job_id: str) -> dict[str, Any]:
    """Return a lightweight, read-only summary of a job's COLMAP artefacts."""
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    state = read_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    dataset = job_dir(job_id) / "dataset"
    images = dataset / "images"
    sparse = dataset / "sparse" / "0"
    database = dataset / "database.db"
    image_count = len(image_files(images)) if images.exists() else 0
    artefacts = []
    for path in (database, sparse / "cameras.bin", sparse / "images.bin", sparse / "points3D.bin"):
        if path.exists():
            artefacts.append({"name": str(path.relative_to(dataset)).replace("\\", "/"), "bytes": path.stat().st_size})
    return {
        "id": job_id,
        "status": state.get("status"),
        "image_count": image_count or state.get("image_count", 0),
        "sparse_ready": (sparse / "cameras.bin").exists() and (sparse / "images.bin").exists(),
        "artefacts": artefacts,
    }


@app.get("/api/v1/system/gpu")
def gpu_status() -> dict[str, Any]:
    """Read current NVIDIA GPU metrics when nvidia-smi is available."""
    query = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
    try:
        result = subprocess.run(
            ["nvidia-smi", f"--query-gpu={query}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False, "message": "未检测到 nvidia-smi"}
    if result.returncode != 0 or not result.stdout.strip():
        return {"available": False, "message": result.stderr.strip() or "GPU 暂不可用"}
    devices = []
    for line in result.stdout.strip().splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 6:
            continue
        name, utilization, memory_used, memory_total, temperature, power = fields
        devices.append({"name": name, "utilization": utilization, "memory_used": memory_used, "memory_total": memory_total, "temperature": temperature, "power": power})
    return {"available": bool(devices), "devices": devices, "timestamp": now()}


@app.get("/api/v1/reconstructions/{job_id}")
def reconstruction_status(job_id: str) -> dict[str, Any]:
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    state = read_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return state


@app.patch("/api/v1/reconstructions/{job_id}")
def update_reconstruction(job_id: str, payload: ReconstructionUpdate) -> dict[str, Any]:
    """Persist user-facing scene metadata alongside the generated model."""
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    lock = JOB_LOCKS.setdefault(job_id, threading.RLock())
    with lock:
        state = read_state(job_id)
        if state is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if payload.name is not None:
            name = payload.name.strip()
            if not name:
                raise HTTPException(status_code=400, detail="场景名称不能为空")
            if len(name) > 120:
                raise HTTPException(status_code=400, detail="场景名称不能超过 120 个字符")
            state["display_name"] = name
        if payload.thumbnail is not None:
            thumbnail = payload.thumbnail.strip()
            match = re.fullmatch(r"data:image/(?P<kind>jpeg|png|webp);base64,(?P<data>[A-Za-z0-9+/=]+)", thumbnail)
            if match is None:
                raise HTTPException(status_code=400, detail="封面必须是 JPEG、PNG 或 WebP 图片")
            if len(thumbnail) > 4 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="封面图片不能超过 4 MB")
            try:
                image_bytes = base64.b64decode(match.group("data"), validate=True)
            except (binascii.Error, ValueError) as exc:
                raise HTTPException(status_code=400, detail="封面图片编码无效") from exc
            suffix = {"jpeg": ".jpg", "png": ".png", "webp": ".webp"}[match.group("kind")]
            thumbnail_path = job_dir(job_id) / f"thumbnail{suffix}"
            temporary = thumbnail_path.with_suffix(f"{suffix}.tmp")
            temporary.write_bytes(image_bytes)
            temporary.replace(thumbnail_path)
            state["thumbnail_file"] = thumbnail_path.name
            state["thumbnail_media_type"] = f"image/{match.group('kind')}"
            state["thumbnail"] = f"/api/v1/reconstructions/{job_id}/thumbnail?v={time.time_ns()}"
        write_state(job_id, state)
        return {"id": job_id, "display_name": state.get("display_name"), "thumbnail": state.get("thumbnail")}


@app.get("/api/v1/reconstructions/{job_id}/thumbnail")
def reconstruction_thumbnail(job_id: str) -> FileResponse:
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    state = read_state(job_id)
    filename = state.get("thumbnail_file") if state else None
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise HTTPException(status_code=404, detail="场景封面不存在")
    thumbnail_path = job_dir(job_id) / filename
    if not thumbnail_path.is_file():
        raise HTTPException(status_code=404, detail="场景封面不存在")
    return FileResponse(thumbnail_path, media_type=state.get("thumbnail_media_type", "image/jpeg"), headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/v1/reconstructions/{job_id}/events")
async def reconstruction_events(job_id: str) -> StreamingResponse:
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    if read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")

    async def stream() -> AsyncIterator[str]:
        line_number = 0
        while True:
            path = events_path(job_id)
            if path.exists():
                lines = path.read_text(encoding="utf-8").splitlines()
                for line in lines[line_number:]:
                    yield f"data: {line}\n\n"
                line_number = len(lines)
            state = read_state(job_id)
            if state and state.get("status") in TERMINAL_STATUSES and line_number >= len(path.read_text(encoding="utf-8").splitlines()):
                break
            yield ": heartbeat\n\n"
            await asyncio.sleep(0.75)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/v1/reconstructions/{job_id}/download")
def download_reconstruction(job_id: str) -> FileResponse:
    if not valid_job_id(job_id):
        raise HTTPException(status_code=404, detail="任务不存在")
    if read_state(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    output = job_dir(job_id) / "output" / "final.ply"
    if not output.exists():
        raise HTTPException(status_code=409, detail="模型尚未生成")
    return FileResponse(output, media_type="application/octet-stream", filename=f"{job_id}.ply")


@app.get("/api/v1/reconstructions/{job_id}/download/{filename}")
def download_reconstruction_named(job_id: str, filename: str) -> FileResponse:
    if filename != f"{job_id}.ply":
        raise HTTPException(status_code=404, detail="模型文件不存在")
    return download_reconstruction(job_id)


@app.get("/api/v1/reconstructions/{job_id}/model")
def model_alias(job_id: str) -> FileResponse:
    return download_reconstruction(job_id)
