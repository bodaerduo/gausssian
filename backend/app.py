from __future__ import annotations

import asyncio
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
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncIterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse


QUALITY = {
    "fast": {"fps": 2, "steps": 10_000, "max_resolution": 1024, "max_splats": 2_000_000},
    "balanced": {"fps": 4, "steps": 30_000, "max_resolution": 1600, "max_splats": 5_000_000},
    "high": {"fps": 6, "steps": 50_000, "max_resolution": 2048, "max_splats": 8_000_000},
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

STATE_LOCK = threading.RLock()
LOG_LOCK = threading.RLock()
JOB_LOCKS: dict[str, threading.RLock] = {}
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="gaussian-worker")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        status = state.get("status", "processing")
        if event_type == "completed":
            status = "completed"
        elif event_type == "failed":
            status = "failed"
        elif status == "queued":
            status = "processing"
        state.update({"status": status, "phase": phase, "progress": progress, "message": message, **extra})
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
            return int(line.split()[-1])
    raise RuntimeError("PLY 缺少 vertex 数量")


def run_pipeline(job_id: str, source_kind: str, source_path: Path, quality_name: str) -> None:
    config = QUALITY[quality_name]
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
            message=f"正在将视频限制到最长边 {VIDEO_MAX_DIMENSION}px 并抽取多视角帧",
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
                f"fps={config['fps']},scale={VIDEO_MAX_DIMENSION}:{VIDEO_MAX_DIMENSION}:force_original_aspect_ratio=decrease",
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
    emit(job_id, phase="COLMAP 相机重建", progress=25, message=f"正在提取特征 · {count} 张图片")
    run_command(
        job_id,
        [COLMAP_BIN, "feature_extractor", "--database_path", str(database), "--image_path", str(images), "--ImageReader.single_camera", "1", "--FeatureExtraction.use_gpu", "1", "--FeatureExtraction.gpu_index", "0"],
    )

    matcher_name = "sequential" if source_kind == "video" else MATCHER
    if matcher_name not in {"exhaustive", "sequential"}:
        raise RuntimeError("COLMAP_MATCHER 只能是 exhaustive 或 sequential")
    matcher_command = f"{matcher_name}_matcher"
    emit(job_id, phase="COLMAP 相机重建", progress=45, message=f"正在进行{matcher_name}匹配")
    run_command(job_id, [COLMAP_BIN, matcher_command, "--database_path", str(database), "--FeatureMatching.use_gpu", "1", "--FeatureMatching.gpu_index", "0"])

    emit(job_id, phase="COLMAP 相机重建", progress=65, message="正在估计相机位姿和稀疏点云")
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
        download_url=f"/api/v1/reconstructions/{job_id}/download",
        ply_bytes=ply.stat().st_size,
        image_count=count,
        splat_count=splat_count,
    )


def worker_entry(job_id: str, source_kind: str, source_path: Path, quality_name: str) -> None:
    try:
        run_pipeline(job_id, source_kind, source_path, quality_name)
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
        },
    }


@app.post("/api/v1/reconstructions", status_code=202)
async def create_reconstruction(
    videos: UploadFile | None = File(default=None),
    images: list[UploadFile] | None = File(default=None),
    quality: str = Form(default="balanced"),
) -> dict[str, Any]:
    if quality not in QUALITY:
        raise HTTPException(status_code=400, detail=f"quality 必须是：{', '.join(QUALITY)}")
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
    state = {"id": job_id, "status": "queued", "progress": 0, "phase": "素材检查", "message": "任务已排队", "quality": quality, "created_at": now(), "updated_at": now()}
    state_path(job_id).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    events_path(job_id).write_text(json.dumps({"type": "queued", "id": job_id, "phase": "素材检查", "progress": 0, "message": "任务已排队"}, ensure_ascii=False) + "\n", encoding="utf-8")

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

    EXECUTOR.submit(worker_entry, job_id, source_kind, source_path, quality)
    return {"id": job_id, "status": "queued", "events_url": f"/api/v1/reconstructions/{job_id}/events", "download_url": f"/api/v1/reconstructions/{job_id}/download"}


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
                state["modelUrl"] = f"/api/v1/reconstructions/{path.name}/download"
                jobs.append(state)
    jobs.sort(key=lambda item: item.get("created_at", ""), reverse=True)
    return {"jobs": jobs}


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


@app.get("/api/v1/reconstructions/{job_id}/model")
def model_alias(job_id: str) -> FileResponse:
    return download_reconstruction(job_id)
