#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-gaussian-ready}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose-ready.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

cd "$APP_DIR"
[[ -f "$COMPOSE_FILE" ]] || die "找不到 Compose 文件：$APP_DIR/$COMPOSE_FILE"
command -v git >/dev/null 2>&1 || die "未找到 git"
command -v docker >/dev/null 2>&1 || die "未找到 docker"
command -v curl >/dev/null 2>&1 || die "未找到 curl"

log "拉取最新代码"
git pull --ff-only origin main

log "停止旧服务"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down

if [[ ! -x "$APP_DIR/front/node_modules/.bin/vinext" ]]; then
  die "缺少 front/node_modules/.bin/vinext；请先完成前端依赖安装，再重新执行本脚本"
fi

log "构建前端"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" run --rm \
  --entrypoint bash app -lc '
    cd /workspace/gaussian/front
    npm run build
  '

log "启动服务"
GAUSSIAN_FRONT_AUTO_BUILD=false \
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate

log "等待服务健康检查"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 "$HEALTH_URL"; then
    printf '\n'
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
    log "服务已就绪：$HEALTH_URL"
    exit 0
  fi
  sleep 2
done

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=100 app
die "服务未在规定时间内通过健康检查：$HEALTH_URL"
