# Docker GPU 容器部署

## 为什么使用容器

当前服务器宿主机 APT 存在依赖版本混杂，直接安装 COLMAP 编译依赖会失败。容器将 Python、FFmpeg、COLMAP、Brush 和 Node 依赖隔离在一个镜像内，避免继续修改宿主机用户态包。

运行时只有一个容器：FastAPI、GPU Worker 和 vinext 前端都在同一容器中；前端通过同源 rewrite 转发 `/api/*` 到容器内的 FastAPI，不需要 Nginx。

## 已有 CUDA 镜像

当前运行时镜像：

```text
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04
```

它作为最终后端运行镜像使用。由于 `runtime` 镜像不包含 `nvcc` 和完整编译链，构建阶段会使用同版本的：

```text
swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04
```

该 `devel` 镜像只用于构建 COLMAP/Brush，最终运行仍回到 `runtime` 镜像。COLMAP 和 Brush 源码在 Docker 构建阶段从官方仓库拉取，不进入本项目 Git。

## 前置检查

```bash
docker --version
docker compose version
docker info
docker run --rm --gpus all \
  swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
  nvidia-smi
```

最后一条应能看到 RTX 4090。Compose 文件使用兼容旧版 Compose 的 `runtime: nvidia`，不使用新版 `gpus:` 字段。若最后一条失败，需要先配置 NVIDIA Container Toolkit；不要在有业务容器运行时直接重启 Docker。NVIDIA 官方配置方式见 [Container Toolkit 安装指南](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。

## 构建和启动

在项目根目录执行：

```bash
docker compose -p gaussian -f docker/compose.yml up -d --build
```

首次构建会拉取 `devel` 镜像、编译 COLMAP、编译 Brush、构建前端，预计 30–90 分钟；后续只启动已有镜像通常为数秒到数分钟。

COLMAP 构建依赖已包含 Ubuntu 22.04 对应的 `libopenexr-dev`，用于满足 OpenImageIO 的 CMake 配置检测。

Dockerfile 已启用 APT、Cargo 和 npm 缓存，并将 COLMAP/Brush 源码下载层与依赖安装层分开。后续只要不执行 `docker builder prune` 或更换镜像标签，修正构建依赖时通常不会重新下载源码和已有软件包。首次采用新版 Dockerfile 会因 Dockerfile 本身变化重新计算一次构建层，这是正常的。

访问地址：

```text
http://服务器地址:8080/
```

API 健康检查：

```bash
docker compose -p gaussian -f docker/compose.yml exec -T backend \
  curl -f http://127.0.0.1:4178/health
docker compose -p gaussian -f docker/compose.yml ps
docker compose -p gaussian -f docker/compose.yml logs -f backend
```

## 参数

- `CUDA_ARCH=89`：RTX 4090 对应架构；换 GPU 时按实际算力调整。
- `COLMAP_REF=main`：COLMAP 分支或 tag，生产环境建议固定 tag/commit。
- `BRUSH_REF=main`：Brush 分支或 tag，生产环境建议固定 tag/commit。
- `HTTP_PORT=8080`：容器唯一对外端口；如果被占用可改成 `18080`。
- `GAUSSIAN_MAX_WORKERS=1`：单张 RTX 4090 建议保持 1，避免任务抢占显存。

## 隔离边界

- 不使用宿主机 Python venv、Node、Rust 或 COLMAP。
- 不执行宿主机 `apt install` 来编译引擎。
- 只创建名为 `gaussian` 的 Compose 项目、一个后端容器和 `gaussian-data` 数据卷。
- 不执行 `docker system prune`、`docker rm` 或停止其它 Compose 项目。
- `docker compose down` 只应在确认项目名为 `gaussian` 时使用。

首次安装 NVIDIA Container Toolkit 或修改 Docker runtime 仍属于宿主机级变更，可能需要重启 Docker daemon；这一步可能短暂影响其它容器。
