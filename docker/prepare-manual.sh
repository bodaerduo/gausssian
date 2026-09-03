#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/workspace/gaussian}"
APP_ROOT="${APP_ROOT:-/app}"
SRC_ROOT="${SRC_ROOT:-/opt/src}"
IMAGE_ONLY="${IMAGE_ONLY:-false}"
CERES_REF="${CERES_REF:-2.2.0}"
CUDA_ARCH="${CUDA_ARCH:-89}"
SUPER_SPLAT_REF="${SUPER_SPLAT_REF:-main}"

if [[ "$(id -u)" != "0" ]]; then
  echo "请在 devel 容器内以 root 执行。" >&2
  exit 1
fi

mkdir -p "$APP_ROOT" "$SRC_ROOT"
if [[ "$IMAGE_ONLY" != "true" ]]; then
  tar -C "$PROJECT_ROOT" \
    --exclude=.git \
    --exclude=front/node_modules \
    --exclude=front/.next \
    --exclude=front/.vinext \
    --exclude=front/.wrangler \
    -cf - . | tar -C "$APP_ROOT" -xf -
fi

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git cmake ninja-build build-essential pkg-config \
  python3 python3-pip ffmpeg \
  libboost-program-options-dev libboost-graph-dev libboost-system-dev \
  libeigen3-dev libopenimageio-dev openimageio-tools libopenexr-dev libmetis-dev \
  libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev \
  libglew-dev libcgal-dev libsuitesparse-dev libgflags-dev libabsl-dev \
  libcurl4-openssl-dev libssl-dev libblas-dev liblapack-dev libvulkan-dev

if [[ ! -d "$SRC_ROOT/ceres/.git" ]]; then
  git clone --depth 1 --branch "$CERES_REF" \
    https://github.com/ceres-solver/ceres-solver.git "$SRC_ROOT/ceres"
fi
cmake -S "$SRC_ROOT/ceres" -B "$SRC_ROOT/ceres/build" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/opt/ceres-cuda \
  -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" \
  -DUSE_CUDA=ON -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
  -DBUILD_EXAMPLES=OFF -DBUILD_DOCUMENTATION=OFF
cmake --build "$SRC_ROOT/ceres/build" --target install --parallel "$(nproc)"

if [[ ! -d "$SRC_ROOT/colmap/.git" ]]; then
  git clone --depth 1 --branch "${COLMAP_REF:-main}" \
    https://github.com/colmap/colmap.git "$SRC_ROOT/colmap"
fi
mkdir -p /usr/include/opencv4
cmake -S "$SRC_ROOT/colmap" -B "$SRC_ROOT/colmap/build" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DCeres_DIR=/opt/ceres-cuda/lib/cmake/Ceres \
  -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" \
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

if ! command -v splat-transform >/dev/null 2>&1; then
  npm install --global --no-audit --no-fund @playcanvas/splat-transform@3.3.3
fi

CODE_ROOT="$APP_ROOT"
if [[ "$IMAGE_ONLY" == "true" ]]; then
  CODE_ROOT="$PROJECT_ROOT"
fi
SUPER_SPLAT_DIR="$SRC_ROOT/supersplat"
if [[ ! -d "$SUPER_SPLAT_DIR/.git" ]]; then
  git clone --depth 1 --branch "$SUPER_SPLAT_REF" https://github.com/playcanvas/supersplat.git "$SUPER_SPLAT_DIR"
fi
cd "$SUPER_SPLAT_DIR"
npm ci --no-audit --no-fund
npm run build
mkdir -p "$CODE_ROOT/front/public/supersplat"
cp -a dist/. "$CODE_ROOT/front/public/supersplat/"

CODE_ROOT="$APP_ROOT"
if [[ "$IMAGE_ONLY" == "true" ]]; then
  CODE_ROOT="$PROJECT_ROOT"
fi
REQUIREMENTS_HASH="$(sha256sum "$CODE_ROOT/backend/requirements.txt" | awk '{print $1}')"
mkdir -p /var/lib/gaussian
if [[ ! -f /var/lib/gaussian/requirements.sha256 || "$(< /var/lib/gaussian/requirements.sha256)" != "$REQUIREMENTS_HASH" ]]; then
  python3 -m pip install --no-cache-dir -r "$CODE_ROOT/backend/requirements.txt"
  printf '%s' "$REQUIREMENTS_HASH" > /var/lib/gaussian/requirements.sha256
else
  echo "Python requirements 未变化，跳过 pip 安装。"
fi
if [[ "$IMAGE_ONLY" != "true" ]]; then
  cd "$APP_ROOT/front"
  if [[ ! -d node_modules ]]; then
    npm ci
  fi
  NEXT_PUBLIC_GAUSSIAN_DEMO=false npm run build
fi

install -m 0755 "$PROJECT_ROOT/docker/start.sh" /usr/local/bin/gaussian-start
mkdir -p "$PROJECT_ROOT/runtime/data"

nvidia-smi
nvcc --version
colmap -h >/dev/null
brush-cli --help >/dev/null
splat-transform --version >/dev/null
if [[ "$IMAGE_ONLY" == "true" ]]; then
  rm -rf "$APP_ROOT" "$SRC_ROOT" /root/.cargo /root/.rustup
fi
echo "gaussian 手动构建准备完成。现在可以退出容器并执行 docker commit。"
