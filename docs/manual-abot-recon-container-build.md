# 基于现有 CUDA 12.4 devel 镜像手动安装 ABot-Recon

本文针对服务器上已有的基础镜像：

```text
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04
```

目标是在独立容器内补齐 ABot-Recon 的 Python、PyTorch、FFmpeg 和 API 依赖，验证 GPU 推理后再封装成长期使用的镜像。宿主机的 `(base)` Conda 环境、现有 `backend`、COLMAP、Brush 和 SuperSplat 都不修改。

> 这条手动流程用于制作和验收 ABot Worker 镜像。产品联调时只保留一个 ABot Worker，不要同时启动手动容器和 `docker/compose-abot.yml` 中的 `abot-worker`。

## 1. 版本与隔离边界

ABot-Recon 官方发布环境要求 Linux、Python 3.10+、PyTorch 2.5.1。本文使用 PyTorch CUDA 12.1 wheel，运行在现有 CUDA 12.4 devel 用户态镜像中；最终能否使用 GPU 以容器内 `torch.cuda.is_available()` 和 `nvidia-smi` 为准。

| 项目 | 设置 |
| --- | --- |
| 基础镜像 | `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04` |
| Python | 容器内 `python3` + `/opt/venvs/abot` |
| PyTorch | `2.5.1`，`cu121` wheel |
| 推理服务 | FastAPI + Uvicorn，端口 `8091` |
| 数据目录 | `/app/runtime/data`，与主 API 使用同一个 `gaussian-data` 卷 |
| 模型缓存 | Docker volume `abot-huggingface` |
| 生产产物 | 只写 `jobs/<job_id>/preview` 和 `products/abot_recon_poc`，不写 `output/final.ply` |

## 2. 宿主机准备

在服务器上执行，确认 Docker、NVIDIA Container Toolkit 和现有镜像可用：

```bash
cd /mnt/data/tk-koc1/tk-server/gaussian

export ABOT_BASE_IMAGE='swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04'
export ABOT_CONTAINER='abot-recon-manual'
export ABOT_IMAGE='gaussian/abot-recon:cuda12.4-devel-manual'

docker image inspect "$ABOT_BASE_IMAGE" >/dev/null
docker run --rm --gpus all "$ABOT_BASE_IMAGE" nvidia-smi
```

如果 `nvidia-smi` 失败，先修复宿主机 NVIDIA Container Toolkit；不要在 ABot 容器里安装宿主机驱动。

## 3. 优先复用 `gaussian:deps`

如果服务器已有 `gaussian:deps`，优先用它作为 ABot 基础镜像。该镜像由项目的手动构建流程产生，通常已经包含 Python、FFmpeg、Git 以及标准 Gaussian 链路依赖；但 Torch 是否存在、版本是否匹配，以容器内检查结果为准：

```bash
export ABOT_DEPS_IMAGE='gaussian:deps'

docker image inspect "$ABOT_DEPS_IMAGE" >/dev/null
docker run --rm --gpus all "$ABOT_DEPS_IMAGE" bash -lc '
  command -v ffmpeg
  python3 - <<"PY"
try:
    import torch
    print("torch:", torch.__version__)
    print("torch cuda:", torch.version.cuda)
    print("cuda available:", torch.cuda.is_available())
except Exception as exc:
    print("torch unavailable:", exc)
PY
'
```

满足以下条件即可直接复用：`ffmpeg` 存在，Torch 为 `2.5.x`（最好是 `2.5.1`），并且 `cuda available: True`。然后把前面的基础镜像变量改为：

```bash
export ABOT_BASE_IMAGE='gaussian:deps'
```

如果 Torch 不存在、是 CPU 版本或版本不兼容，再改回本文开头的 CUDA 12.4 devel 镜像，并执行完整的 Torch 安装步骤。不要在宿主机 `(base)` 环境中补包。

如果检查通过，最快的产品联调方式是不手动创建容器，直接让现有 ABot Compose 使用这个镜像作为构建基底：

```bash
ABOT_RECON_CUDA_IMAGE=gaussian:deps \
docker compose -p gaussian \
  -f docker/compose.yml \
  -f docker/compose-abot.yml \
  up -d --build
```

这会继续创建独立的 `abot-worker`，不会把 ABot 包装进主 `backend`。下面的手动步骤适合需要逐条观察安装过程、排查依赖或制作固定版本镜像的情况。

确认主 Compose 的数据卷和网络名称：

```bash
docker volume ls | grep gaussian-data || true
docker network ls | grep gaussian || true
```

如果主 Compose 尚未创建 `gaussian-data`，可以先启动标准服务：

```bash
docker compose -p gaussian -f docker/compose.yml up -d
```

## 4. 创建临时安装容器

下面的容器使用 `ABOT_BASE_IMAGE` 指定的镜像（优先为 `gaussian:deps`），不会把依赖安装到宿主机。`gaussian-data` 与 Hugging Face 缓存都是持久卷，容器删除后仍可复用。

```bash
docker rm -f "$ABOT_CONTAINER" 2>/dev/null || true

docker run -d \
  --name "$ABOT_CONTAINER" \
  --gpus all \
  --ipc=host \
  --shm-size=16g \
  --network gaussian_default \
  --network-alias abot-worker \
  -v gaussian-data:/app/runtime/data \
  -v abot-huggingface:/root/.cache/huggingface \
  -v "$PWD/workers/abot-recon:/opt/abot-worker-src:ro" \
  "$ABOT_BASE_IMAGE" \
  bash -lc 'sleep infinity'
```

如果实际网络名称不是 `gaussian_default`，把 `--network` 改成 `docker network ls` 输出的 Gaussian Compose 网络名。

## 5. 安装系统依赖

进入容器安装 Python、虚拟环境、Git、FFmpeg 和常用图像库。以下命令只作用于 `abot-recon-manual`：

```bash
docker exec "$ABOT_CONTAINER" bash -lc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    python3 python3-dev python3-venv python3-pip \
    git ffmpeg ca-certificates build-essential pkg-config \
    libgl1 libglib2.0-0
  rm -rf /var/lib/apt/lists/*
  python3 -m venv --system-site-packages /opt/venvs/abot
  /opt/venvs/abot/bin/python -m pip install --upgrade pip setuptools wheel
'
```

## 6. 安装 PyTorch 与 ABot-Recon

如果上一步检查确认 `gaussian:deps` 中已有兼容 Torch，可以跳过下面第一段 `pip install torch...`，虚拟环境会通过 `--system-site-packages` 复用它。若 Torch 不存在或版本不兼容，再执行第一段安装 PyTorch CUDA 12.1 wheel；基础镜像仍保持 CUDA 12.4，不需要降级。

```bash
docker exec "$ABOT_CONTAINER" bash -lc '
  # 仅在 gaussian:deps 中没有兼容 Torch 时执行这一段。
  /opt/venvs/abot/bin/pip install \
    torch==2.5.1 torchvision==0.20.1 \
    --index-url https://download.pytorch.org/whl/cu121

  rm -rf /opt/ABot-Recon
  git clone --depth 1 --branch main \
    https://github.com/amap-cvlab/ABot-Recon.git /opt/ABot-Recon

  /opt/venvs/abot/bin/pip install -e /opt/ABot-Recon
  /opt/venvs/abot/bin/pip install -r /opt/abot-worker-src/requirements.txt

  mkdir -p /opt/abot-worker
  cp /opt/abot-worker-src/app.py /opt/abot-worker/app.py
'
```

如果服务器访问不了 `download.pytorch.org` 或 GitHub，可以在可联网机器预下载 wheel、ABot-Recon 源码和模型权重，再通过挂载目录复制进容器；不要改用宿主机 Conda 环境混装。

## 7. GPU 与 Python 验收

```bash
docker exec "$ABOT_CONTAINER" bash -lc '
  /opt/venvs/abot/bin/python - <<"PY"
import torch
import abot_recon

print("torch:", torch.__version__)
print("torch cuda:", torch.version.cuda)
print("cuda available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu:", torch.cuda.get_device_name(0))
print("abot_recon:", abot_recon.__file__)
PY
'
```

期望看到 `torch: 2.5.1+cu121`、`cuda available: True`，以及服务器上的 GPU 名称。首次真正推理时，`ABotRecon.from_pretrained("acvlab/ABot-Recon")` 会下载模型权重并缓存到 `abot-huggingface`；第一次任务较慢是正常的。

## 8. 启动 Worker

```bash
docker exec -d "$ABOT_CONTAINER" bash -lc '
  cd /opt/abot-worker
  exec /opt/venvs/abot/bin/python -m uvicorn app:app \
    --host 0.0.0.0 \
    --port 8091
'

docker exec "$ABOT_CONTAINER" bash -lc 'curl -f http://127.0.0.1:8091/health'
docker logs "$ABOT_CONTAINER" --tail 100
```

容器间调用使用 Compose 网络别名 `http://abot-worker:8091`，不是宿主机映射端口。主 API 需要配置：

```text
ABOT_RECON_ENABLED=true
ABOT_RECON_URL=http://abot-worker:8091
```

Worker 端点为 `POST /v1/jobs`、`GET /v1/jobs/{job_id}` 和 `GET /health`。

## 9. 封装成长期镜像

手动安装验证通过后，把当前容器保存为镜像。模型权重继续放在 `abot-huggingface` volume，不要写进镜像。

```bash
docker commit \
  --change 'CMD ["/opt/venvs/abot/bin/python", "-m", "uvicorn", "app:app", "--app-dir", "/opt/abot-worker", "--host", "0.0.0.0", "--port", "8091"]' \
  "$ABOT_CONTAINER" \
  "$ABOT_IMAGE"

docker image inspect "$ABOT_IMAGE" --format '{{.RepoTags}} {{.Id}}'
```

后续用 Compose 管理时，应把 `docker/compose-abot.yml` 的 Worker 镜像替换为已验收镜像，并保留：共享 `gaussian-data`、独立 Python/PyTorch/CUDA 用户态库、`ABOT_RECON_URL=http://abot-worker:8091`，以及不覆盖 `output/final.ply`。

## 10. 最小联调检查

1. `/health` 返回 `status=ok`。
2. 浏览器进入“流式扫描”，上传短视频并点击“开始扫描”。
3. Worker 日志出现抽帧、加载模型和预览生成信息。
4. 任务目录出现 `jobs/<job_id>/preview/points-0001.ply` 和 `jobs/<job_id>/products/abot_recon_poc/`。
5. 标准 Brush 任务仍只写 `jobs/<job_id>/output/final.ply`。

## 11. 常见问题

### `torch.cuda.is_available()` 为 `False`

先在同一个基础镜像中执行 `docker run --rm --gpus all "$ABOT_BASE_IMAGE" nvidia-smi`。若这里也失败，是宿主机 Toolkit 或 GPU runtime 问题；若 `nvidia-smi` 成功，再检查是否误用了 CPU 版 PyTorch wheel。

### `pip install` 下载超时

在可联网机器下载 PyTorch `cu121` wheel 和 ABot-Recon 源码，挂载进容器后使用本地路径安装。不要从宿主机复制 Conda site-packages。

### Hugging Face 权重下载失败

确认 `abot-huggingface` volume 可写。若服务器不能访问 Hugging Face，将权重目录挂载到容器，并把 `ABOT_RECON_MODEL` 设置为本地模型目录；代码和权重版本必须匹配。

### 单卡显存不足

保持主 API 的 `GAUSSIAN_MAX_WORKERS=1`，不要让 Brush 和 ABot 同时抢占显存。先用前端 `fast` 质量档位和短视频完成 POC，再调高抽帧频率或点云密度。

## 相关文件

- [ABot Worker 实现](../workers/abot-recon/app.py)
- [ABot Worker Dockerfile](../workers/abot-recon/Dockerfile)
- [ABot Compose 覆盖配置](../docker/compose-abot.yml)
- [ABot 流式扫描规划](./abot-streaming-scan-plan.md)
- [容器部署总说明](./container-deployment.md)
- [ABot-Recon 官方仓库](https://github.com/amap-cvlab/ABot-Recon)
