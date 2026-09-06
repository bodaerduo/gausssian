# ABot-Recon：使用 `docker/compose-abot.yml` 手动封装并启动

本文只说明如何把 ABot-Recon 接入已经正常运行的 `compose-gussian.yml`。不使用 Dockerfile，不修改主 `app`、Brush、COLMAP 或 SuperSplat。

最终结果：

```text
https://192.168.2.11:8080/streaming-scan
        ↓
app → http://abot-worker:8091 → ABot-Recon → preview/*.ply
```

## 前提

- 当前目录：`/mnt/data/tk-koc1/tk-server/gaussian`
- 已存在镜像：`gaussian/abot-recon:cuda12.4-abot-20260906`
- 主服务由 `docker/compose-gussian.yml` 启动，服务名为 `app`
- 宿主机已安装 NVIDIA Container Toolkit
- GPU 容器内可以执行 `nvidia-smi`
- 宿主机预留模型目录：`runtime/models/abot-recon`

## 1. 检查基础镜像

```bash
cd /mnt/data/tk-koc1/tk-server/gaussian

docker image inspect gaussian:deps >/dev/null
docker run --rm --gpus all gaussian:deps nvidia-smi
docker run --rm --gpus all gaussian:deps bash -lc 'ffmpeg -version | head -1'
```

`gaussian:deps` 已包含 CUDA 12.4.1 和 FFmpeg，但当前实测不包含 Torch；Torch 会在 ABot Worker 容器内单独安装。

模型不写入镜像。将完整的 `acvlab/ABot-Recon` 模型目录复制到宿主机：

```bash
mkdir -p runtime/models/abot-recon
# 将模型配置和权重文件复制到 runtime/models/abot-recon/
```

## 2. 启动 ABot Worker

`compose-abot.yml` 已内置正式镜像、模型挂载目录、正式模式和 8081 端口，正常启动不需要额外 `export`：

```bash
docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  up -d abot-worker
```

这里故意只启动 `abot-worker`。`app` 已经由 `compose-gussian.yml` 正常运行，不需要重启它。若需要临时手动安装，编辑该 Compose 文件中的镜像和 `ABOT_RECON_MANUAL` 默认值，完成 `docker commit` 后恢复正式值。

确认容器状态：

```bash
docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  ps abot-worker
```

## 3. 进入 Worker 并安装 Python 环境

```bash
docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  exec abot-worker bash
```

在容器内执行：

```bash
apt-get update
apt-get install -y --no-install-recommends \
  python3-dev python3-venv python3-pip \
  git ca-certificates curl build-essential \
  libgl1 libglib2.0-0
rm -rf /var/lib/apt/lists/*

python3 -m venv /opt/venvs/abot
/opt/venvs/abot/bin/python -m pip install --upgrade pip setuptools wheel
```

## 4. 安装 Torch、ABot-Recon 和 Worker API

仍在 Worker 容器内执行：

```bash
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
```

## 5. 验证 CUDA 和 ABot 包

```bash
/opt/venvs/abot/bin/python - <<'PY'
import torch
import abot_recon

print("torch:", torch.__version__)
print("torch cuda:", torch.version.cuda)
print("cuda available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu:", torch.cuda.get_device_name(0))
print("abot:", abot_recon.__file__)
PY
```

期望看到 `torch: 2.5.1+cu121` 和 `cuda available: True`。

## 6. 验证宿主机模型挂载

Compose 会把宿主机的 `runtime/models/abot-recon` 以只读方式挂载到容器 `/models/abot-recon`。确认容器内能看到模型文件：

```bash
ls -lah /models/abot-recon
```

使用本地路径加载，不访问 Hugging Face：

```bash
/opt/venvs/abot/bin/python - <<'PY'
from abot_recon import ABotRecon

model = ABotRecon.from_pretrained(
    "/models/abot-recon",
    device="cuda",
    attention_backend="auto",
    amp_dtype="bf16",
    max_frames=22000,
    output_local_points=True,
    output_world_points=True,
    output_confidence=True,
    loop_closure=False,
)
print("ABot-Recon local checkpoint loaded")
del model
PY
```

## 7. 提交已验收镜像

退出 Worker 容器：

```bash
exit
```

在宿主机提交当前 ABot 容器。模型权重位于宿主机挂载目录，不写进镜像：

```bash
export ABOT_RECON_IMAGE=gaussian/abot-recon:cuda12.4-abot-20260906

docker commit \
  --change 'CMD ["/opt/venvs/abot/bin/python", "-m", "uvicorn", "app:app", "--app-dir", "/opt/abot-worker", "--host", "0.0.0.0", "--port", "8091"]' \
  "$(docker compose -p gussian -f docker/compose-gussian.yml -f docker/compose-abot.yml ps -q abot-worker)" \
  "$ABOT_RECON_IMAGE"

docker image inspect "$ABOT_RECON_IMAGE" --format '{{.RepoTags}} {{.Id}}'
```

## 8. 启动正式 ABot Worker

关闭手动模式，让 Compose 使用刚提交的镜像启动 Uvicorn：

```bash
export ABOT_RECON_MANUAL=false

docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  up -d --force-recreate abot-worker
```

检查 Worker 健康状态和容器间网络：

```bash
curl -f http://127.0.0.1:${ABOT_RECON_PORT:-8081}/health

docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  exec -T app curl -f http://abot-worker:8091/health

docker compose -p gussian \
  -f docker/compose-gussian.yml \
  -f docker/compose-abot.yml \
  logs --tail 100 abot-worker
```

健康响应应包含：

```json
{"status":"ok","model":"acvlab/ABot-Recon","device":"cuda","cuda":true}
```

## 9. 验证流式扫描调用

打开：

```text
https://192.168.2.11:8080/streaming-scan
```

上传短 MP4/MOV/WebM，点击“开始扫描”。页面会提交：

```text
POST /api/v1/reconstructions
route=abot_recon_poc
quality=fast
```

主 `app` 通过 `ABOT_RECON_URL=http://abot-worker:8091` 调用 Worker。Worker 读取共享的 `runtime/data`，并写入：

```text
runtime/data/jobs/<job_id>/preview/points-0001.ply
runtime/data/jobs/<job_id>/products/abot_recon_poc/
```

前端收到 SSE 的 `preview_url` 后，右侧点云区域会加载预览。ABot 路线不会生成或覆盖标准 Brush 的 `output/final.ply`。

## 10. 故障排查

### Torch 导入失败

确认使用容器内的 Python：

```bash
/opt/venvs/abot/bin/python -c 'import torch; print(torch.__version__)'
```

不要使用宿主机 `(base)` Python。

### `cuda available: False`

执行：

```bash
docker run --rm --gpus all gaussian:deps nvidia-smi
```

如果失败，是宿主机 NVIDIA Container Toolkit 问题；如果成功，重新检查是否安装了 `cu121` wheel。

### 本地模型目录为空

确认宿主机模型目录存在且包含配置和权重文件：

```bash
find runtime/models/abot-recon -maxdepth 2 -type f | head -20
```

Compose 默认将该目录挂载到 `/models/abot-recon`；模型不需要写进镜像。

### 主 API 无法调用 Worker

容器内地址必须是：

```text
http://abot-worker:8091
```

确认 `app` 和 `abot-worker` 是由同一组 Compose 文件启动，并且 `app` 环境包含：

```text
ABOT_RECON_ENABLED=true
ABOT_RECON_URL=http://abot-worker:8091
```

## 相关文件

- [ABot Compose 配置](../docker/compose-abot.yml)
- [ABot Worker API](../workers/abot-recon/app.py)
- [流式扫描页面](../front/app/streaming-scan/page.tsx)
- [ABot 流式扫描规划](./abot-streaming-scan-plan.md)
