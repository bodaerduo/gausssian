#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="${SPLAT_TRANSFORM_VERSION:-3.3.3}"
INSTALL_PREFIX="${SPLAT_TRANSFORM_PREFIX:-/usr/local}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
as_root() { if [[ "$(id -u)" == "0" ]]; then "$@"; else sudo "$@"; fi; }
if ! command -v npm >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || die "未找到 curl，无法安装 Node.js"
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash -
  as_root apt-get install -y nodejs
fi
as_root apt-get update
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y libvulkan1
as_root npm install --global --prefix "$INSTALL_PREFIX" "@playcanvas/splat-transform@$VERSION"
command -v splat-transform >/dev/null 2>&1 || die "splat-transform 安装后不可用"
splat-transform --version
