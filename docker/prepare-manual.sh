#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/workspace/gaussian}"
APP_ROOT="${APP_ROOT:-/app}"
SRC_ROOT="${SRC_ROOT:-/opt/src}"

if [[ "$(id -u)" != "0" ]]; then
  echo "请在 devel 容器内以 root 执行。" >&2
  exit 1
fi

mkdir -p "$APP_ROOT" "$SRC_ROOT"
tar -C "$PROJECT_ROOT" \
  --exclude=.git \
  --exclude=front/node_modules \
  --exclude=front/.next \
  --exclude=front/.vinext \
  --exclude=front/.wrangler \
  -cf - . | tar -C "$APP_ROOT" -xf -

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git cmake ninja-build build-essential pkg-config \
  python3 python3-pip ffmpeg \
  libboost-program-options-dev libboost-graph-dev libboost-system-dev \
  libeigen3-dev libopenimageio-dev libopenexr-dev libmetis-dev \
  libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev \
  libglew-dev libcgal-dev libceres-dev libsuitesparse-dev \
  libcurl4-openssl-dev libssl-dev libblas-dev liblapack-dev libvulkan-dev

if [[ ! -d "$SRC_ROOT/colmap/.git" ]]; then
  git clone --depth 1 --branch "${COLMAP_REF:-main}" \
    https://github.com/colmap/colmap.git "$SRC_ROOT/colmap"
fi
mkdir -p /usr/include/opencv4
cmake -S "$SRC_ROOT/colmap" -B "$SRC_ROOT/colmap/build" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH:-89}" \
  -DCUDA_ENABLED=ON -DGUI_ENABLED=OFF -DTESTS_ENABLED=OFF
cmake --build "$SRC_ROOT/colmap/build" --target install --parallel "$(nproc)"

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source /root/.cargo/env
if [[ ! -d "$SRC_ROOT/brush/.git" ]]; then
  git clone --depth 1 --branch "${BRUSH_REF:-main}" \
    https://github.com/ArthurBrussee/brush.git "$SRC_ROOT/brush"
fi
cargo build --manifest-path "$SRC_ROOT/brush/Cargo.toml" --release -p brush-cli
install -m 0755 "$SRC_ROOT/brush/target/release/brush-cli" /usr/local/bin/brush-cli

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get update
  apt-get install -y --no-install-recommends nodejs
fi

python3 -m pip install --no-cache-dir -r "$APP_ROOT/backend/requirements.txt"
cd "$APP_ROOT/front"
if [[ ! -d node_modules ]]; then
  npm ci
fi
NEXT_PUBLIC_GAUSSIAN_DEMO=false npm run build

install -m 0755 "$APP_ROOT/docker/start.sh" /usr/local/bin/gaussian-start
mkdir -p "$APP_ROOT/runtime/data"

nvidia-smi
nvcc --version
colmap -h >/dev/null
brush-cli --help >/dev/null
echo "gaussian 手动构建准备完成。现在可以退出容器并执行 docker commit。"
