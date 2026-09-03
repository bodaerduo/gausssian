#!/usr/bin/env bash
set -Eeuo pipefail

# Build the self-hosted SuperSplat editor into front/public/supersplat.
# Pin SUPER_SPLAT_REF to a tag or commit for production deployments.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"
SOURCE_DIR="${SUPER_SPLAT_SOURCE_DIR:-$APP_DIR/engines/supersplat}"
OUTPUT_DIR="${SUPER_SPLAT_OUTPUT_DIR:-$APP_DIR/front/public/supersplat}"
REPO="${SUPER_SPLAT_REPO:-https://github.com/playcanvas/supersplat.git}"
REF="${SUPER_SPLAT_REF:-main}"
NODE_VERSION="${SUPER_SPLAT_NODE_VERSION:-22.13.0}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }
as_root() { if [[ "$(id -u)" == "0" ]]; then "$@"; else sudo "$@"; fi; }

[[ -d "$APP_DIR" ]] || die "项目目录不存在：$APP_DIR"
command -v git >/dev/null 2>&1 || die "未找到 git"
if ! command -v npm >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || die "未找到 curl，无法安装 Node.js"
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash 2>/dev/null || true
  as_root apt-get install -y nodejs
fi
node --version

if [[ -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" fetch --tags origin
  git -C "$SOURCE_DIR" checkout "$REF"
else
  [[ ! -e "$SOURCE_DIR" ]] || die "已有目录不是 Git 仓库：$SOURCE_DIR"
  mkdir -p "$(dirname "$SOURCE_DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"
log "安装 SuperSplat 依赖"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
log "安装 SuperSplat 优化 CLI"
as_root apt-get update
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y libvulkan1
as_root npm install --global --no-audit --no-fund "@playcanvas/splat-transform@${SPLAT_TRANSFORM_VERSION:-3.3.3}"
command -v splat-transform >/dev/null 2>&1 || die "SplatTransform 安装后不可用"
log "构建 SuperSplat"
npm run build
[[ -f dist/index.html ]] || die "SuperSplat 构建没有生成 dist/index.html"

log "发布 SuperSplat 静态资源"
mkdir -p "$OUTPUT_DIR"
find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a dist/. "$OUTPUT_DIR/"
printf 'SuperSplat: %s\n' "$OUTPUT_DIR"
