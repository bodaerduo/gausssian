#!/usr/bin/env bash
set -Eeuo pipefail

# Build the headless Brush CLI from the project-local source checkout.
# Runs directly as root or through sudo when started by a normal user.

BRUSH_REPO="${BRUSH_REPO:-https://github.com/ArthurBrussee/brush.git}"
BRUSH_REF="${BRUSH_REF:-main}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"
BRUSH_SRC_DIR="${BRUSH_SRC_DIR:-$APP_DIR/engines/brush}"
BRUSH_BIN="${BRUSH_BIN:-/usr/local/bin/brush-cli}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

as_root() { if [[ "$(id -u)" == "0" ]]; then "$@"; else sudo "$@"; fi; }
if [[ "$(id -u)" != "0" ]]; then
  command -v sudo >/dev/null 2>&1 || die "未找到 sudo。"
fi
[[ -f "$BRUSH_SRC_DIR/Cargo.toml" ]] || die "Brush 源码不存在：$BRUSH_SRC_DIR"

log "安装 Brush 编译和 Vulkan 运行依赖"
as_root apt-get update
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl git build-essential pkg-config libvulkan1 libvulkan-dev mesa-vulkan-drivers

if [[ -d "$BRUSH_SRC_DIR/.git" ]]; then
  if [[ -n "$(git -C "$BRUSH_SRC_DIR" status --porcelain)" ]]; then
    die "Brush 源码目录有未提交修改，请先处理：$BRUSH_SRC_DIR"
  fi
  git -C "$BRUSH_SRC_DIR" fetch --tags origin
  git -C "$BRUSH_SRC_DIR" checkout "$BRUSH_REF"
  git -C "$BRUSH_SRC_DIR" pull --ff-only origin "$BRUSH_REF" 2>/dev/null || true
elif [[ -f "$BRUSH_SRC_DIR/Cargo.toml" ]]; then
  log "使用项目内已有 Brush 源码（无 Git 元数据，不执行更新）"
else
  [[ ! -e "$BRUSH_SRC_DIR" ]] || die "已有 Brush 路径不是完整源码：$BRUSH_SRC_DIR"
  mkdir -p "$(dirname "$BRUSH_SRC_DIR")"
  git clone "$BRUSH_REPO" "$BRUSH_SRC_DIR"
  git -C "$BRUSH_SRC_DIR" checkout "$BRUSH_REF"
fi

if ! command -v cargo >/dev/null 2>&1; then
  log "安装 Rust toolchain"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi

# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustup toolchain install stable --profile minimal
rustup default stable

cd "$BRUSH_SRC_DIR"
log "构建 Brush headless CLI"
cargo build --release -p brush-cli

[[ -x target/release/brush-cli ]] || die "Brush 编译完成但没有找到 target/release/brush-cli"
as_root install -m 0755 target/release/brush-cli "$BRUSH_BIN"

"$BRUSH_BIN" --help >/dev/null
log "Brush 安装完成"
printf 'Brush: %s\n' "$BRUSH_BIN"
printf '命令:  %s --help\n' "$BRUSH_BIN"
