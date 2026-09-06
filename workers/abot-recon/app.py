from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


DATA_ROOT = Path(os.getenv("ABOT_RECON_DATA_ROOT", "/app/runtime/data")).resolve()
MODEL_ID = os.getenv("ABOT_RECON_MODEL", "acvlab/ABot-Recon")
DEVICE = os.getenv("ABOT_RECON_DEVICE", "cuda")
FFMPEG_BIN = os.getenv("ABOT_RECON_FFMPEG", "/usr/bin/ffmpeg")
MAX_FRAMES = int(os.getenv("ABOT_RECON_MAX_FRAMES", "22000"))
PREVIEW_FRAME_STRIDE = max(1, int(os.getenv("ABOT_RECON_PREVIEW_FRAME_STRIDE", "8")))
POINT_STRIDE = max(1, int(os.getenv("ABOT_RECON_POINT_STRIDE", "8")))
MAX_PREVIEW_POINTS = max(10_000, int(os.getenv("ABOT_RECON_MAX_PREVIEW_POINTS", "250000")))
WINDOW_FRAMES = max(12, int(os.getenv("ABOT_RECON_WINDOW_FRAMES", "32")))

app = FastAPI(title="ABot-Recon Worker", version="0.1.0")
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="abot-recon")
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.RLock()
model_lock = threading.Lock()
model: Any = None


class JobRequest(BaseModel):
    job_id: str
    source_kind: str
    source_path: str
    output_dir: str
    preview_dir: str
    quality: str = "balanced"


def safe_shared_path(value: str) -> Path:
    path = Path(value).resolve()
    if path != DATA_ROOT and DATA_ROOT not in path.parents:
        raise ValueError(f"路径不在共享数据卷内：{path}")
    return path


def add_event(job_id: str, *, progress: int, message: str, **extra: Any) -> None:
    with jobs_lock:
        job = jobs[job_id]
        event = {"progress": progress, "message": message, **extra}
        job.setdefault("events", []).append(event)
        job["progress"] = progress
        job["message"] = message


def load_model() -> Any:
    global model
    if model is not None:
        return model
    with model_lock:
        if model is None:
            from abot_recon import ABotRecon

            model = ABotRecon.from_pretrained(
                MODEL_ID,
                device=DEVICE,
                attention_backend=os.getenv("ABOT_RECON_ATTENTION_BACKEND", "auto"),
                amp_dtype=os.getenv("ABOT_RECON_AMP_DTYPE", "bf16"),
                max_frames=MAX_FRAMES,
                output_local_points=True,
                output_world_points=True,
                output_confidence=True,
                confidence_threshold=float(os.getenv("ABOT_RECON_CONFIDENCE_THRESHOLD", "0")),
                loop_closure=False,
            )
    return model


def prepare_frames(source: Path, work_dir: Path, quality: str) -> list[Path]:
    if source.is_dir():
        frames = sorted(path for path in source.iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
        return frames[:MAX_FRAMES]
    if not source.is_file():
        raise FileNotFoundError(source)
    fps = {"fast": 2, "balanced": 4, "high": 6}.get(quality, 4)
    frame_dir = work_dir / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    command = [FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-i", str(source), "-vf", f"fps={fps}", "-q:v", "2", str(frame_dir / "%06d.jpg")]
    subprocess.run(command, check=True, timeout=3600)
    return sorted(frame_dir.glob("*.jpg"))[:MAX_FRAMES]


def iter_frame_batches(source: Path, work_dir: Path, quality: str) -> Any:
    """Decode a video in bounded windows so inference can start before EOF."""
    if source.is_dir():
        frames = sorted(path for path in source.iterdir() if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})[:MAX_FRAMES]
        for offset in range(0, len(frames), WINDOW_FRAMES):
            yield offset, frames[offset:offset + WINDOW_FRAMES]
        return
    if not source.is_file():
        raise FileNotFoundError(source)
    fps = {"fast": 2, "balanced": 4, "high": 6}.get(quality, 4)
    batch_seconds = WINDOW_FRAMES / fps
    frame_root = work_dir / "frames"
    frame_root.mkdir(parents=True, exist_ok=True)
    offset = 0
    while offset < MAX_FRAMES:
        batch_dir = frame_root / f"batch-{offset:06d}"
        batch_dir.mkdir(parents=True, exist_ok=True)
        command = [FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-ss", f"{offset / fps:.3f}", "-t", f"{batch_seconds:.3f}", "-i", str(source), "-vf", f"fps={fps}", "-q:v", "2", str(batch_dir / "%06d.jpg")]
        subprocess.run(command, check=True, timeout=3600)
        frames = sorted(batch_dir.glob("*.jpg"))
        if not frames:
            break
        yield offset, frames[:WINDOW_FRAMES]
        offset += len(frames)
        if len(frames) < WINDOW_FRAMES:
            break


def write_ply(path: Path, points: np.ndarray, colors: np.ndarray) -> int:
    valid = np.isfinite(points).all(axis=1)
    points = points[valid]
    colors = colors[valid]
    if len(points) > MAX_PREVIEW_POINTS:
        keep = np.linspace(0, len(points) - 1, MAX_PREVIEW_POINTS, dtype=np.int64)
        points, colors = points[keep], colors[keep]
    vertex = np.empty(len(points), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("red", "u1"), ("green", "u1"), ("blue", "u1")])
    vertex["x"], vertex["y"], vertex["z"] = points[:, 0], points[:, 1], points[:, 2]
    vertex["red"], vertex["green"], vertex["blue"] = colors[:, 0], colors[:, 1], colors[:, 2]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as stream:
        stream.write(b"ply\nformat binary_little_endian 1.0\n")
        stream.write(f"element vertex {len(vertex)}\n".encode())
        stream.write(b"property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
        vertex.tofile(stream)
    return len(vertex)


def tensor_points(value: Any) -> np.ndarray:
    tensor = value.detach().float().cpu() if isinstance(value, torch.Tensor) else torch.as_tensor(value).float()
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4 or tensor.shape[-1] != 3:
        raise ValueError(f"ABot 点图形状不支持：{tuple(tensor.shape)}")
    return tensor.numpy()


def tensor_poses(value: Any) -> np.ndarray:
    tensor = value.detach().float().cpu().numpy() if isinstance(value, torch.Tensor) else np.asarray(value, dtype=np.float32)
    if tensor.ndim != 3 or tensor.shape[-2:] != (4, 4):
        raise ValueError(f"ABot 相机位姿形状不支持：{tuple(tensor.shape)}")
    return tensor


def transform_points(points: np.ndarray, transform: np.ndarray) -> np.ndarray:
    flat = points.reshape(-1, 3)
    homogeneous = np.concatenate([flat, np.ones((len(flat), 1), dtype=np.float32)], axis=1)
    return (homogeneous @ transform.T)[:, :3].reshape(points.shape)


def source_rgb_colors(frames: list[Path], point_maps: np.ndarray) -> np.ndarray | None:
    """Sample source-frame RGB values at the same pixels as the point map."""
    try:
        from PIL import Image
    except ImportError:
        return None
    height, width = point_maps.shape[1:3]
    colors: list[np.ndarray] = []
    for frame in frames[:len(point_maps)]:
        with Image.open(frame) as image:
            rgb = np.asarray(image.convert("RGB").resize((width, height), Image.Resampling.BILINEAR), dtype=np.uint8)
        colors.append(rgb[::POINT_STRIDE, ::POINT_STRIDE].reshape(-1, 3))
    if not colors:
        return None
    sampled = np.concatenate(colors, axis=0)
    expected = len(point_maps) * len(point_maps[0, ::POINT_STRIDE, ::POINT_STRIDE].reshape(-1, 3))
    return sampled if sampled.shape[0] == expected else None


def pseudo_rgb_colors(points: np.ndarray) -> np.ndarray:
    span = np.max(np.abs(points), axis=0) if len(points) else np.ones(3)
    return np.clip((points / np.maximum(span, 1e-6) + 1) * 127.5, 0, 255).astype(np.uint8)


def publish_preview_batch(job_id: str, result: Any, frames: list[Path], preview_dir: Path, preview_index: int, frame_offset: int, total_frames: int, accumulated: list[np.ndarray], accumulated_colors: list[np.ndarray], trajectory: list[list[float]], global_anchor: np.ndarray | None) -> tuple[int, np.ndarray | None]:
    points_value = result.world_points if result.world_points is not None else result.local_points
    if points_value is None:
        raise ValueError("ABot 未返回点图")
    point_maps = tensor_points(points_value)
    poses = tensor_poses(result.camera_poses)
    alignment = np.eye(4, dtype=np.float32) if global_anchor is None or not len(poses) else global_anchor @ np.linalg.inv(poses[0])
    if len(poses):
        transformed_poses = np.einsum("ij,njk->nik", alignment, poses)
        trajectory.extend(transformed_poses[:, :3, 3].tolist())
    points = point_maps[:, ::POINT_STRIDE, ::POINT_STRIDE].reshape(-1, 3)
    transformed = transform_points(points, alignment)
    accumulated.append(transformed)
    colors = source_rgb_colors(frames, point_maps)
    accumulated_colors.append(colors if colors is not None else pseudo_rgb_colors(transformed))
    merged = np.concatenate(accumulated, axis=0)
    merged_colors = np.concatenate(accumulated_colors, axis=0)
    preview_name = f"points-{preview_index + 1:04d}.ply"
    count = write_ply(preview_dir / preview_name, merged, merged_colors)
    confidence = None
    if result.confidence is not None:
        confidence = round(float(result.confidence.detach().float().mean().cpu()), 4)
    progress = round((frame_offset + len(point_maps)) / max(1, total_frames) * 90) + 8
    add_event(job_id, progress=max(20, min(95, progress)), message=f"已生成第 {frame_offset + len(point_maps)} 帧点云", frame=frame_offset + len(point_maps), point_count=count, confidence=confidence, preview_url=f"/api/v1/reconstructions/{job_id}/preview/{preview_name}")
    (preview_dir / "trajectory.json").write_text(json.dumps({"poses": trajectory}, ensure_ascii=False), encoding="utf-8")
    return count, transformed_poses[-1] if len(transformed_poses) else global_anchor


def publish_previews(job_id: str, result: Any, preview_dir: Path) -> None:
    points_value = result.world_points if result.world_points is not None else result.local_points
    if points_value is None:
        raise ValueError("ABot 未返回点图")
    point_maps = tensor_points(points_value)
    poses = result.camera_poses.detach().float().cpu().numpy()
    total = len(point_maps)
    step = max(1, PREVIEW_FRAME_STRIDE)
    trajectory: list[list[float]] = []
    for index in range(0, total, step):
        frame_points = point_maps[: index + 1, ::POINT_STRIDE, ::POINT_STRIDE].reshape(-1, 3)
        scale = np.nan_to_num(frame_points, nan=0.0, posinf=0.0, neginf=0.0)
        span = np.max(np.abs(scale), axis=0) if len(scale) else np.ones(3)
        normalized = np.clip((scale / np.maximum(span, 1e-6) + 1) * 127.5, 0, 255).astype(np.uint8)
        preview_name = f"points-{index // step + 1:04d}.ply"
        count = write_ply(preview_dir / preview_name, scale, normalized)
        if len(poses):
            trajectory = poses[: index + 1, :3, 3].tolist()
        confidence = None
        if result.confidence is not None:
            confidence_tensor = result.confidence[: index + 1].detach().float().cpu()
            confidence = round(float(confidence_tensor.mean()), 4)
        add_event(job_id, progress=max(20, min(95, round((index + 1) / total * 90))), message=f"已生成第 {index + 1}/{total} 个扫描窗口", frame=index + 1, point_count=count, confidence=confidence, preview_url=f"/api/v1/reconstructions/{job_id}/preview/{preview_name}")
    (preview_dir / "trajectory.json").write_text(json.dumps({"poses": trajectory}, ensure_ascii=False), encoding="utf-8")


def run_job(job_id: str, request: JobRequest) -> None:
    try:
        source = safe_shared_path(request.source_path)
        output_dir = safe_shared_path(request.output_dir)
        preview_dir = safe_shared_path(request.preview_dir)
        work_dir = output_dir / "runtime"
        add_event(job_id, progress=5, message="开始按窗口解码视频帧")
        batches = iter_frame_batches(source, work_dir, request.quality)
        model_instance = load_model()
        accumulated: list[np.ndarray] = []
        accumulated_colors: list[np.ndarray] = []
        trajectory: list[list[float]] = []
        global_anchor: np.ndarray | None = None
        preview_index = 0
        seen_frames = 0
        total_hint = MAX_FRAMES
        for frame_offset, frames in batches:
            if not frames:
                continue
            result = model_instance.infer(frames, output_local_points=True, output_world_points=True, output_confidence=True, loop_closure=False)
            _, global_anchor = publish_preview_batch(job_id, result, frames, preview_dir, preview_index, frame_offset, total_hint, accumulated, accumulated_colors, trajectory, global_anchor)
            preview_index += 1
            seen_frames = frame_offset + len(frames)
            if seen_frames >= MAX_FRAMES:
                break
        if not preview_index:
            raise ValueError("没有找到可推理的视频帧")
        with jobs_lock:
            jobs[job_id].update({"status": "completed", "progress": 100, "message": "ABot 预览完成"})
    except Exception as exc:  # noqa: BLE001 - worker boundary
        with jobs_lock:
            jobs[job_id].update({"status": "failed", "error": str(exc), "message": str(exc)})


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE, "cuda": bool(torch.cuda.is_available())}


@app.post("/v1/jobs", status_code=202)
def create_job(request: JobRequest) -> dict[str, str]:
    if not request.job_id.startswith("gs-"):
        raise HTTPException(status_code=400, detail="非法主任务 ID")
    with jobs_lock:
        if request.job_id in jobs:
            raise HTTPException(status_code=409, detail="Worker 已存在该任务")
        jobs[request.job_id] = {"id": request.job_id, "status": "queued", "progress": 0, "message": "Worker 已排队", "events": []}
    executor.submit(run_job, request.job_id, request)
    return {"id": request.job_id}


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Worker 任务不存在")
        return dict(job)
