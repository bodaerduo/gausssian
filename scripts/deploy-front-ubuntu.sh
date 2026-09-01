#!/usr/bin/env bash
set -Eeuo pipefail

# gaussian Ubuntu deployment helper.
# Prefer the deployment user; root requires ALLOW_ROOT=true.
# Example:
#   chmod +x scripts/deploy-front-ubuntu.sh
#   DEMO_MODE=true ./scripts/deploy-front-ubuntu.sh
#   DEMO_MODE=false API_URL= ./scripts/deploy-front-ubuntu.sh

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"
FRONT_DIR="${FRONT_DIR:-$APP_DIR/front}"
APP_PORT="${APP_PORT:-4177}"
DEMO_MODE="${DEMO_MODE:-true}"
API_URL="${API_URL:-}"
INSTALL_SYSTEM_DEPS="${INSTALL_SYSTEM_DEPS:-true}"
INSTALL_SERVICE="${INSTALL_SERVICE:-true}"
SERVICE_NAME="${SERVICE_NAME:-gaussian-web}"
ALLOW_ROOT="${ALLOW_ROOT:-false}"

log() {
  printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "$(id -u)" == "0" && "$ALLOW_ROOT" != "true" ]]; then
  die "当前脚本默认禁止 root；如确需 root 执行，请设置 ALLOW_ROOT=true。"
fi

command -v sudo >/dev/null 2>&1 || die "未找到 sudo，请先安装 sudo 或使用有 sudo 权限的部署用户。"
[[ -d "$APP_DIR" ]] || die "项目目录不存在：$APP_DIR"
[[ -f "$FRONT_DIR/package.json" ]] || die "$FRONT_DIR/package.json 不存在，请确认前端目录已准备。"
[[ -f "$FRONT_DIR/package-lock.json" ]] || die "$FRONT_DIR/package-lock.json 不存在，生产部署需要锁文件。"
[[ -f "$FRONT_DIR/.nvmrc" ]] || die "$FRONT_DIR/.nvmrc 不存在，无法确定 Node.js 版本。"

NODE_VERSION="$(tr -d '[:space:]' < "$FRONT_DIR/.nvmrc")"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die ".nvmrc 不是完整的 Node.js 版本号：$NODE_VERSION"

if [[ "$INSTALL_SYSTEM_DEPS" == "true" ]]; then
  log "安装 Ubuntu 基础依赖"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl ca-certificates build-essential nginx ffmpeg
fi

if [[ ! -s "$HOME/.nvm/nvm.sh" ]]; then
  log "安装 nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh"

log "安装并启用 Node.js $NODE_VERSION"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION" >/dev/null
nvm use "$NODE_VERSION" >/dev/null

NODE_BIN_DIR="$(dirname "$(command -v node)")"
NPM_BIN="$(command -v npm)"
[[ -x "$NPM_BIN" ]] || die "npm 不可执行：$NPM_BIN"

log "Node 版本"
node --version
npm --version

cd "$FRONT_DIR"

if [[ ! -f .env ]]; then
  log "创建 .env（已有 .env 时脚本不会覆盖）"
  cp .env.example .env 2>/dev/null || true
  if [[ ! -f .env ]]; then
    touch .env
  fi
  sed -i \
    -e "s/^NEXT_PUBLIC_GAUSSIAN_DEMO=.*/NEXT_PUBLIC_GAUSSIAN_DEMO=$DEMO_MODE/" \
    -e "s|^# NEXT_PUBLIC_GAUSSIAN_API_URL=.*|NEXT_PUBLIC_GAUSSIAN_API_URL=$API_URL|" \
    .env
fi

log "安装锁定依赖"
npm ci

log "运行 lint"
npm run lint

log "构建生产版本"
npm run build

if [[ "$INSTALL_SERVICE" == "true" ]]; then
  command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl；如只需要构建，请设置 INSTALL_SERVICE=false。"

  log "安装 systemd 服务 $SERVICE_NAME"
  SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=gaussian vinext web
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$FRONT_DIR
Environment=NODE_ENV=production
Environment=PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-$FRONT_DIR/.env
ExecStart=$NPM_BIN run start -- --hostname 127.0.0.1 --port $APP_PORT
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
else
  log "跳过 systemd；手动启动命令："
  printf 'cd %q && source %q && nvm use %q && npm run start -- --hostname 127.0.0.1 --port %q\n' \
    "$FRONT_DIR" "$HOME/.nvm/nvm.sh" "$NODE_VERSION" "$APP_PORT"
fi

log "本机 HTTP 验收"
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --head "http://127.0.0.1:${APP_PORT}/" >/dev/null \
    && printf 'web-ok: http://127.0.0.1:%s/\n' "$APP_PORT" \
    || printf '提示：页面进程未返回 HTTP 响应，请查看：sudo journalctl -u %s -n 100 --no-pager\n' "$SERVICE_NAME"
fi

log "部署完成"
printf '项目目录: %s\n' "$APP_DIR"
printf 'Node.js:   %s\n' "$NODE_VERSION"
printf '监听端口: 127.0.0.1:%s\n' "$APP_PORT"
printf '演示模式: %s\n' "$DEMO_MODE"
printf '\n真实 GPU API 不在本仓库中；如切换到真实模式，请确保 Nginx/API 已提供 /api/v1/reconstructions 和 SSE 路由。\n'
