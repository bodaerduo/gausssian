# 持久化 devel 容器构建

本文用于服务器网络不稳定、需要进入容器反复安装依赖和重试构建的场景。构建容器不会删除，成功后提交为本地镜像；长期运行使用不带 `build:` 的 `compose-ready.yml`，不会再次构建。

## 1. 创建并进入准备容器

在项目根目录执行：

```bash
cd /mnt/data/tk-koc1/tk-server/gaussian

IMG=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04

docker run --name gaussian-build --gpus all -it \
  -v "$PWD":/workspace/gaussian \
  -w /workspace/gaussian \
  "$IMG" bash
```

如果网络中断或某一步失败，重新进入原容器，不要重新 `docker run`：

```bash
docker start -ai gaussian-build
```

## 2. 在容器内安装依赖和构建

以下命令都在容器内执行。重复执行时，已存在的源码和已安装的软件会复用：

```bash
set -eux

mkdir -p /app /opt/src
tar -C /workspace/gaussian \
  --exclude=.git \
  --exclude=front/node_modules \
  --exclude=front/.next \
  --exclude=front/.vinext \
  --exclude=front/.wrangler \
  -cf - . | tar -C /app -xf -

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git cmake ninja-build build-essential pkg-config \
  python3 python3-pip ffmpeg \
  libboost-program-options-dev libboost-graph-dev libboost-system-dev \
  libeigen3-dev libopenimageio-dev libopenexr-dev libmetis-dev \
  libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev \
  libglew-dev libcgal-dev libceres-dev libsuitesparse-dev \
  libcurl4-openssl-dev libssl-dev libblas-dev liblapack-dev libvulkan-dev

if [ ! -d /opt/src/colmap/.git ]; then
  git clone --depth 1 --branch main https://github.com/colmap/colmap.git /opt/src/colmap
fi
mkdir -p /usr/include/opencv4
cmake -S /opt/src/colmap -B /opt/src/colmap/build -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DCUDA_ENABLED=ON -DGUI_ENABLED=OFF -DTESTS_ENABLED=OFF
cmake --build /opt/src/colmap/build --target install --parallel "$(nproc)"

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source /root/.cargo/env
if [ ! -d /opt/src/brush/.git ]; then
  git clone --depth 1 --branch main https://github.com/ArthurBrussee/brush.git /opt/src/brush
fi
cargo build --manifest-path /opt/src/brush/Cargo.toml --release -p brush-cli
install -m 0755 /opt/src/brush/target/release/brush-cli /usr/local/bin/brush-cli

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get update && apt-get install -y --no-install-recommends nodejs
fi

python3 -m pip install --no-cache-dir -r /app/backend/requirements.txt
cd /app/front
npm ci
NEXT_PUBLIC_GAUSSIAN_DEMO=false npm run build

install -m 0755 /app/docker/start.sh /usr/local/bin/gaussian-start
mkdir -p /app/runtime/data

nvidia-smi
nvcc --version
colmap -h >/dev/null
brush-cli --help >/dev/null
```

某一步失败时，只重新执行该步骤即可。不要退出并重新创建 `gaussian-build`。

## 3. 提交为长期镜像

在容器内完成上一步后退出：

```bash
exit
```

在宿主机执行：

```bash
docker commit gaussian-build gaussian:ready
docker image inspect gaussian:ready --format '{{.Id}}'
```

## 4. Compose 一键启动

`compose-ready.yml` 不包含 `build:`，只启动已经封装好的镜像：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml up -d
```

检查服务：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml ps
docker compose -p gaussian-ready -f docker/compose-ready.yml logs -f app
curl http://127.0.0.1:8080/api/health
```

访问：`http://服务器地址:8080/`。

项目目录以只读方式挂载到容器 `/workspace/gaussian` 供查看；模型数据写入宿主机项目下的 `runtime/data`，容器删除后数据仍保留。以后启动只需执行：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml start
```

不要执行 `docker compose ... build`、`docker builder prune` 或 `docker system prune`。
