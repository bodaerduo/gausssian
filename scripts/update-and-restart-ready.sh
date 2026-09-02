#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-gaussian-ready}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose-ready.yml}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:8080/}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

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

log "安装前端依赖"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" run --rm \
  -e NPM_REGISTRY="$NPM_REGISTRY" --entrypoint bash app -lc '
    cd /workspace/gaussian/front
    npm install --no-audit --no-fund --package-lock=false --registry "$NPM_REGISTRY"
  '

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
  if docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T app sh -c \
    'curl -fsS --max-time 5 http://127.0.0.1:4178/health >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:4177/ >/dev/null' \
    && curl -fsS --max-time 5 "$PUBLIC_URL" >/dev/null; then
    printf '\n'
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
    log "服务已就绪：API=http://127.0.0.1:4178/health，网页=$PUBLIC_URL"
    exit 0
  fi
  sleep 2
done

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=100 app
die "服务未在规定时间内通过健康检查：API=http://127.0.0.1:4178/health，网页=$PUBLIC_URL"
