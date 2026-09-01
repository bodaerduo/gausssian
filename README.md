# Gaussian 视频/图片建模工程

完整目录、职责和协作流程见 [`AGENTS.md`](./AGENTS.md)。

## 目录

- `front/`：Node/vinext 前端，负责上传、进度展示和模型下载。
- `backend/`：FastAPI API + GPU Worker，负责任务编排和产物校验。
- `engines/colmap/`：官方 COLMAP 源码。
- `engines/brush/`：官方 Brush 源码。
- `docs/`：架构、流程、Ubuntu 部署和方案文档。
- `scripts/`：前端、后端、COLMAP、Brush 的部署脚本。

## 建模流程

```text
上传视频/图片 → FastAPI 创建任务 → FFmpeg → COLMAP → Brush
→ output/final.ply → SSE 推送进度 → 前端下载模型
```

## Ubuntu 快速部署

在服务器上进入本项目根目录后执行：

```bash
chmod +x scripts/*.sh
DEMO_MODE=false ./scripts/deploy-all-ubuntu.sh
```

如果服务器已安装 CUDA toolkit 且 `nvcc --version` 正常，推荐使用：

```bash
APP_DIR="$PWD" INSTALL_CUDA=false DEMO_MODE=false \
./scripts/deploy-all-ubuntu.sh
```

如果必须由 root 部署，使用显式开关：

```bash
ALLOW_ROOT=true APP_DIR="$PWD" INSTALL_CUDA=false DEMO_MODE=false \
./scripts/deploy-all-ubuntu.sh
```

此模式会让 systemd 中的 API/Worker 和前端服务以 root 运行，仅建议用于受控内网或临时部署。

脚本默认按自身位置识别项目根目录，不依赖固定的服务器绝对路径。也可以使用 `APP_DIR=/path/to/gaussian` 指定项目目录。

`engines/colmap/` 和 `engines/brush/` 为可选的本地源码缓存，已加入 Git 忽略；部署服务器没有源码时，安装脚本会从官方仓库自动拉取。

详细说明：

- [`docs/ubuntu-deployment.md`](./docs/ubuntu-deployment.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/folder-layout.md`](./docs/folder-layout.md)
- [`docs/视频重建Gaussian方案对比与推荐.md`](./docs/视频重建Gaussian方案对比与推荐.md)
