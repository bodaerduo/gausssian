# Ubuntu 部署指南

本文用于无法由本地代理直接登录服务器的场景：将整个 `gaussian/` 项目上传到 Ubuntu，然后在服务器终端执行脚本。

## 1. 部署前提

- Ubuntu 22.04/24.04。
- NVIDIA 驱动已安装，`nvidia-smi` 正常。
- 可使用 root 直接部署；普通用户需要拥有 `sudo` 权限。
- 服务器可访问 GitHub、PyPI、npm 和 Ubuntu 软件源。
- CUDA toolkit 可通过 `apt` 安装；如果服务器已有 toolkit，可执行 `INSTALL_CUDA=false`。

## 2. 上传后的目录

```text
gaussian/
├── front/
├── backend/
├── engines/colmap/
├── engines/brush/
├── docs/
└── scripts/
```

进入项目根目录：

```bash
export APP_DIR=/path/to/gaussian
cd "$APP_DIR"
chmod +x scripts/*.sh
```

部署到其他目录时，只需要将 `APP_DIR` 替换为实际路径；脚本源码本身不依赖固定路径。

## 3. 安装和构建引擎

### COLMAP

脚本会安装编译依赖，默认使用项目内 `engines/colmap` 源码，以 CUDA、无 GUI、Release 方式编译，并安装到 `/usr/local/bin/colmap`。

```bash
APP_DIR="$APP_DIR" ./scripts/setup-colmap-ubuntu.sh
```

可选参数：

```bash
COLMAP_REF=main                 # 分支、tag 或 commit
CUDA_ARCH=native                # 也可传 75、86、89 等目标架构
BUILD_JOBS=8
INSTALL_CUDA=false              # 已有 nvcc 时使用
```

如果没有随项目上传源码，脚本会按 `COLMAP_REPO` 和 `COLMAP_REF` 自动拉取到 `engines/colmap`。

### Brush

Brush 使用 Rust 构建 headless CLI，安装到 `/usr/local/bin/brush-cli`：

```bash
APP_DIR="$APP_DIR" ./scripts/setup-brush-ubuntu.sh
```

如未上传源码，脚本会从官方仓库拉取 `BRUSH_REPO`/`BRUSH_REF`；生产环境建议固定 `BRUSH_REF`，或直接随项目上传 `engines/brush`。

## 4. 部署后端 API/Worker

脚本会创建 `backend/.venv`，安装 Python 依赖，并注册 `gaussian-api` systemd 服务。任务数据默认放到项目内的 `runtime/data`，生产环境建议通过 `GAUSSIAN_DATA_ROOT` 指向独立数据盘。

```bash
GAUSSIAN_DATA_ROOT=/var/lib/gaussian/data \
GAUSSIAN_PORT=4178 \
APP_DIR="$APP_DIR" ./scripts/setup-backend-ubuntu.sh
```

检查：

```bash
curl -f http://127.0.0.1:4178/health
sudo systemctl status gaussian-api --no-pager
sudo journalctl -u gaussian-api -f
```

## 5. 部署前端

脚本在 `front/` 中执行 `npm ci`、lint 和生产构建，并注册 `gaussian-web` systemd 服务，默认监听 `127.0.0.1:4177`。

真实模式：

```bash
DEMO_MODE=false \
API_URL= \
APP_DIR="$APP_DIR" ./scripts/deploy-front-ubuntu.sh
```

`API_URL` 留空时，前端使用同源 `/api`；Nginx 需要把 `/api/` 代理到 `127.0.0.1:4178`。演示模式只适合验收前端界面：

```bash
DEMO_MODE=true APP_DIR="$APP_DIR" ./scripts/deploy-front-ubuntu.sh
```

检查：

```bash
curl -I http://127.0.0.1:4177/
sudo systemctl status gaussian-web --no-pager
```

## 6. 一键部署

确认驱动、sudo 和网络后，可以执行：

```bash
APP_DIR="$APP_DIR" DEMO_MODE=false ./scripts/deploy-all-ubuntu.sh
```

如果服务器已安装 CUDA toolkit，并且以下命令能正常输出版本：

```bash
nvcc --version
```

则推荐关闭脚本中的 CUDA toolkit 安装步骤：

```bash
APP_DIR="$PWD" INSTALL_CUDA=false DEMO_MODE=false \
./scripts/deploy-all-ubuntu.sh
```

如果使用 root 部署，直接执行：

```bash
APP_DIR="$PWD" INSTALL_CUDA=false DEMO_MODE=false \
./scripts/deploy-all-ubuntu.sh
```

root 模式会让 `gaussian-api` 和 `gaussian-web` systemd 服务以 root 运行。脚本同样兼容有 sudo 权限的普通用户。

该脚本依次执行 COLMAP、Brush、后端、前端四个步骤；任一步失败都会停止。

## 7. Nginx 反向代理

站点配置示例：

```nginx
server {
    listen 80;
    server_name _;

    client_max_body_size 2G;

    location /api/ {
        proxy_pass http://127.0.0.1:4178;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:4177;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

启用配置后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 8. 功能验收

1. 浏览器打开 Nginx 地址。
2. 上传一段有明显视差、光照稳定的视频，或上传同一物体的多张图片。
3. 确认任务经过 `extracting`、`reconstructing`、`training`、`exporting`。
4. 确认下载接口返回非空 `final.ply`。
5. 失败时查看：

```bash
sudo journalctl -u gaussian-api -n 200 --no-pager
sudo journalctl -u gaussian-web -n 100 --no-pager
```

## 9. 常见问题

- `nvidia-smi` 正常但 `nvcc` 不存在：安装 CUDA toolkit，或确认 `INSTALL_CUDA=false` 只在已有正确 toolkit 时使用。
- COLMAP 没有生成 `sparse/0`：检查输入图片数量、纹理、视差和特征匹配日志。
- Brush 找不到数据：确认 Worker 传入的是 `dataset/images` 和 `dataset/sparse/0`，不是原始 COLMAP 工作目录。
- SSE 页面不更新：检查 Nginx `proxy_buffering off` 和 `proxy_read_timeout`。
- 上传失败：检查 Nginx `client_max_body_size`、磁盘空间和 `GAUSSIAN_DATA_ROOT` 权限。
