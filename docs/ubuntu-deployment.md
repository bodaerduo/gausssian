# Ubuntu 部署说明

当前服务器上的 COLMAP、Brush、FastAPI 和前端服务由宿主机手动安装并已正常运行。本仓库不再提供会重复安装或重注册这些服务的全链路脚本。

## 新增 SuperSplat 模块

只执行对应模块脚本：

```bash
cd /path/to/gaussian
chmod +x scripts/setup-supersplat-ubuntu.sh
APP_DIR="$PWD" ./scripts/setup-supersplat-ubuntu.sh
```

脚本会：

1. 拉取或更新 `engines/supersplat`。
2. 使用 `npm ci` 安装 SuperSplat 自身依赖。
3. 安装 `@playcanvas/splat-transform` CLI 和 Vulkan runtime。
4. 构建 SuperSplat 到 `front/public/supersplat`。

生产环境请固定版本：

```bash
SUPER_SPLAT_REF=<commit-or-tag> \
SPLAT_TRANSFORM_VERSION=3.3.3 \
APP_DIR="$PWD" ./scripts/setup-supersplat-ubuntu.sh
```

构建完成后重启现有前端服务，使静态资源生效：

```bash
sudo systemctl restart gaussian-web
```

## 更新代码并重启容器

继续使用现有脚本：

```bash
./scripts/update-and-restart-ready.sh
```

该脚本只负责拉取代码、构建前端和重启 Compose，不负责安装 COLMAP、Brush、FastAPI 或 SuperSplat。

## GPU 容器

需要重新构建完整镜像时执行：

```bash
SUPER_SPLAT_REF=<commit-or-tag> \
docker compose -p gussian -f docker/compose-gussian.yml up -d --build
```

容器 Dockerfile 会在构建阶段准备 SuperSplat 和 SplatTransform；这与宿主机模块脚本互相独立。
