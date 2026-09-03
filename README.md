# Gaussian 视频/图片建模工程

完整目录、职责和协作流程见 [`AGENTS.md`](./AGENTS.md)。

## 目录

- `front/`：Node/vinext 前端，负责上传、进度展示和模型下载。
- `backend/`：FastAPI API + GPU Worker，负责任务编排和产物校验。
- `engines/colmap/`：官方 COLMAP 源码。
- `engines/brush/`：官方 Brush 源码。
- `docs/`：架构、流程、Ubuntu 部署和方案文档。
- [`docs/开源视频三维重建与动态高斯方案调研.md`](./docs/开源视频三维重建与动态高斯方案调研.md)：流式重建、动态 Gaussian 与当前 COLMAP + Brush 的选型对比。
- `scripts/`：已运行系统的更新重启脚本，以及新增模块的独立部署脚本。
- `docker/`：基于 CUDA runtime 的单镜像 GPU 容器定义。

## 建模流程

```text
上传视频/图片 → FastAPI 创建任务 → FFmpeg → COLMAP → Brush
→ output/final.ply → SSE 推送进度 → 前端下载模型
```

## Ubuntu 模块部署

现有 COLMAP、Brush、FastAPI 和前端已经由宿主机手动安装并运行，不再提供全链路安装脚本。新增 SuperSplat 时只执行对应模块脚本：

```bash
chmod +x scripts/setup-supersplat-ubuntu.sh
APP_DIR="$PWD" ./scripts/setup-supersplat-ubuntu.sh
```

代码更新和容器重启继续使用 `scripts/update-and-restart-ready.sh`。GPU 容器部署入口为：

```bash
docker compose -p gaussian -f docker/compose.yml up -d --build
```

详细说明：

- [`docs/ubuntu-deployment.md`](./docs/ubuntu-deployment.md)
- [`docs/architecture.md`](./docs/architecture.md)
- [`docs/folder-layout.md`](./docs/folder-layout.md)
- [`docs/视频重建Gaussian方案对比与推荐.md`](./docs/视频重建Gaussian方案对比与推荐.md)

当前服务器已有 CUDA 12.4.1 runtime 镜像时，容器部署入口为：

```bash
docker compose -p gaussian -f docker/compose.yml up -d --build
```

如果需要在容器内反复安装依赖、重试构建并封装成长期镜像，使用 [`docs/manual-container-build.md`](./docs/manual-container-build.md)；成功后通过 `docker/compose-ready.yml` 直接启动，不会重新构建。
