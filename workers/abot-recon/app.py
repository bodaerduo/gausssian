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
        add_event(job_id, progress=5, message="准备视频帧")
        frames = prepare_frames(source, work_dir, request.quality)
        if not frames:
            raise ValueError("没有找到可推理的视频帧")
        add_event(job_id, progress=12, message=f"已准备 {len(frames)} 帧，加载 ABot 模型")
        result = load_model().infer(frames, output_local_points=True, output_world_points=True, output_confidence=True, loop_closure=False)
        add_event(job_id, progress=18, message="推理完成，开始发布增量点云")
        publish_previews(job_id, result, preview_dir)
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
