#!/usr/bin/env bash
set -Eeuo pipefail

# Create the Python venv and install the Gaussian API/Worker service.
# Prefer the deployment user; root requires ALLOW_ROOT=true.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"
BACKEND_DIR="${BACKEND_DIR:-$APP_DIR/backend}"
VENV_DIR="${VENV_DIR:-$BACKEND_DIR/.venv}"
DATA_ROOT="${GAUSSIAN_DATA_ROOT:-$APP_DIR/runtime/data}"
API_PORT="${GAUSSIAN_PORT:-4178}"
SERVICE_NAME="${SERVICE_NAME:-gaussian-api}"
ALLOW_ROOT="${ALLOW_ROOT:-false}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

if [[ "$(id -u)" == "0" && "$ALLOW_ROOT" != "true" ]]; then
  die "当前脚本默认禁止 root；如确需 root 执行，请设置 ALLOW_ROOT=true。"
fi
if [[ "$(id -u)" != "0" ]]; then
  command -v sudo >/dev/null 2>&1 || die "未找到 sudo。"
fi
[[ -f "$BACKEND_DIR/app.py" ]] || die "后端目录不存在：$BACKEND_DIR"
[[ -f "$BACKEND_DIR/requirements.txt" ]] || die "requirements.txt 不存在：$BACKEND_DIR"

log "安装 Python 运行时和 API 基础依赖"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-venv python3-pip ffmpeg

log "创建 Python 虚拟环境"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$BACKEND_DIR/requirements.txt"

mkdir -p "$DATA_ROOT"
if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi
sed -i \
  -e "s|^GAUSSIAN_DATA_ROOT=.*|GAUSSIAN_DATA_ROOT=$DATA_ROOT|" \
  -e "s|^GAUSSIAN_PORT=.*|GAUSSIAN_PORT=$API_PORT|" \
  "$BACKEND_DIR/.env"

PYTHON_BIN="$VENV_DIR/bin/python"
log "安装 systemd 服务 $SERVICE_NAME"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=gaussian GPU API and worker
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$BACKEND_DIR/.env
ExecStart=$PYTHON_BIN -m uvicorn app:app --host 127.0.0.1 --port $API_PORT
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
curl --fail --silent --show-error "http://127.0.0.1:${API_PORT}/health" || true

log "后端部署完成"
printf 'API:     http://127.0.0.1:%s\n' "$API_PORT"
printf '数据目录: %s\n' "$DATA_ROOT"
printf '日志:     sudo journalctl -u %s -f\n' "$SERVICE_NAME"
