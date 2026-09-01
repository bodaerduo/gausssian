#!/usr/bin/env bash
set -Eeuo pipefail

# Install/build a CUDA-enabled, headless COLMAP for the Gaussian worker.
# Run as a normal user with passwordless-or-interactive sudo access.
# Example:
#   chmod +x setup-colmap-ubuntu.sh
#   COLMAP_REF=main ./setup-colmap-ubuntu.sh
#
# For a reproducible production build, pin COLMAP_REF to a release tag or
# commit instead of using the default main branch.

COLMAP_REPO="${COLMAP_REPO:-https://github.com/colmap/colmap.git}"
COLMAP_REF="${COLMAP_REF:-main}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"
COLMAP_SRC_DIR="${COLMAP_SRC_DIR:-$APP_DIR/engines/colmap}"
COLMAP_PREFIX="${COLMAP_PREFIX:-/usr/local}"
CUDA_ARCH="${CUDA_ARCH:-native}"
BUILD_JOBS="${BUILD_JOBS:-$(nproc)}"
INSTALL_CUDA="${INSTALL_CUDA:-true}"

log() {
  printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" != "0" ]] || die "请使用普通部署用户执行，不要直接使用 root。"
command -v sudo >/dev/null 2>&1 || die "未找到 sudo。"

log "检查 NVIDIA 驱动"
command -v nvidia-smi >/dev/null 2>&1 || die "未找到 nvidia-smi，请先安装 NVIDIA 驱动。"
nvidia-smi

log "安装 COLMAP 编译依赖"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git cmake ninja-build build-essential \
  libboost-program-options-dev libboost-graph-dev libboost-system-dev \
  libeigen3-dev libopenimageio-dev openimageio-tools libmetis-dev \
  libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev \
  libglew-dev qt6-base-dev libqt6opengl6-dev libqt6openglwidgets6 \
  qt6-svg-dev libcgal-dev libceres-dev libsuitesparse-dev \
  libcurl4-openssl-dev libssl-dev libmkl-full-dev

# COLMAP's Ubuntu installation guide documents this workaround for the
# OpenImageIO CMake config.
sudo mkdir -p /usr/include/opencv4

if [[ "$INSTALL_CUDA" == "true" ]]; then
  log "安装 Ubuntu CUDA toolkit"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nvidia-cuda-toolkit nvidia-cuda-toolkit-gcc
fi

if [[ -f /etc/os-release ]]; then
  # COLMAP's documented workaround for Ubuntu 22.04 + the distro CUDA package.
  # Ubuntu 24.04 does not normally provide gcc-10, so only request it on 22.04.
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${VERSION_ID:-}" == "22.04" ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gcc-10 g++-10
  fi
fi

command -v nvcc >/dev/null 2>&1 || die "未找到 nvcc，请确认 CUDA toolkit 已安装并在 PATH 中。"
nvcc --version

log "准备 COLMAP 源码：$COLMAP_REF"
sudo mkdir -p "$(dirname "$COLMAP_SRC_DIR")"
sudo chown -R "$(id -un):$(id -gn)" "$(dirname "$COLMAP_SRC_DIR")"

if [[ -d "$COLMAP_SRC_DIR/.git" ]]; then
  if [[ -n "$(git -C "$COLMAP_SRC_DIR" status --porcelain)" ]]; then
    die "COLMAP 源码目录有未提交修改，请先处理：$COLMAP_SRC_DIR"
  fi
  git -C "$COLMAP_SRC_DIR" fetch --tags origin
  git -C "$COLMAP_SRC_DIR" checkout "$COLMAP_REF"
  git -C "$COLMAP_SRC_DIR" pull --ff-only origin "$COLMAP_REF" 2>/dev/null || true
else
  if [[ -e "$COLMAP_SRC_DIR" ]]; then
    # This supports source copied into the project without its nested .git.
    [[ -f "$COLMAP_SRC_DIR/CMakeLists.txt" ]] || die "已有 COLMAP 路径不是完整源码：$COLMAP_SRC_DIR"
    log "使用项目内已有 COLMAP 源码（无 Git 元数据，不执行更新）"
  else
    # Clone first, then checkout so COLMAP_REF may be a branch, tag, or commit.
    git clone "$COLMAP_REPO" "$COLMAP_SRC_DIR"
    git -C "$COLMAP_SRC_DIR" checkout "$COLMAP_REF"
  fi
fi

BUILD_DIR="$COLMAP_SRC_DIR/build"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

log "配置 CUDA-enabled headless COLMAP"
CUDA_HOST_CXX_ARGS=()
if [[ -f /usr/bin/g++-10 && -f /usr/bin/gcc-10 ]]; then
  # Required by the documented Ubuntu 22.04 + distro CUDA workaround.
  CUDA_HOST_CXX_ARGS+=(
    -DCMAKE_C_COMPILER=/usr/bin/gcc-10
    -DCMAKE_CXX_COMPILER=/usr/bin/g++-10
    -DCMAKE_CUDA_HOST_COMPILER=/usr/bin/g++-10
  )
fi

cmake .. -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$COLMAP_PREFIX" \
  -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" \
  -DCUDA_ENABLED=ON \
  -DGUI_ENABLED=OFF \
  -DTESTS_ENABLED=OFF \
  "${CUDA_HOST_CXX_ARGS[@]}"

log "编译 COLMAP（并行数：$BUILD_JOBS）"
ninja -j "$BUILD_JOBS"

log "安装 COLMAP 到 $COLMAP_PREFIX"
sudo ninja install
sudo ldconfig

command -v colmap >/dev/null 2>&1 || die "安装后仍找不到 colmap。"
colmap -h >/dev/null

log "COLMAP 安装完成"
printf 'COLMAP:     %s\n' "$(command -v colmap)"
if [[ -d "$COLMAP_SRC_DIR/.git" ]]; then
  printf '源码版本:    %s\n' "$(git -C "$COLMAP_SRC_DIR" rev-parse --short HEAD)"
else
  printf '源码版本:    copied-source\n'
fi
printf 'CUDA 架构:   %s\n' "$CUDA_ARCH"
printf '\n注意：该脚本只安装 COLMAP；FFmpeg 和 Brush 仍需由 GPU API/Worker 使用相同服务用户调用。\n'
