#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-gaussian-ready}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose-ready.yml}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:8080/}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

cd "$APP_DIR"
[[ -f "$COMPOSE_FILE" ]] || die "找不到 Compose 文件：$APP_DIR/$COMPOSE_FILE"
command -v git >/dev/null 2>&1 || die "未找到 git"
command -v docker >/dev/null 2>&1 || die "未找到 docker"
command -v curl >/dev/null 2>&1 || die "未找到 curl"
command -v npm >/dev/null 2>&1 || die "未找到 npm，请先在宿主机安装 Node.js/npm"

log "拉取最新代码"
git pull --ff-only origin main

log "停止旧服务"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down

log "安装前端依赖"
(
  cd "$APP_DIR/front"
  npm install --no-audit --no-fund --package-lock=false --registry "$NPM_REGISTRY"
)

log "构建前端"
(
  cd "$APP_DIR/front"
  npm run build
)

log "启动服务"
GAUSSIAN_FRONT_AUTO_BUILD=false \
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate

log "等待服务健康检查"
elapsed=0
last_status=""
while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
  container_id="$(docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps -q app 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    status="missing"
  else
    running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || echo false)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || echo unavailable)"
    if [[ "$running" != "true" ]]; then
      status="stopped"
    elif [[ "$health" == "healthy" ]]; then
      if curl -fsS --max-time 5 "$PUBLIC_URL" >/dev/null 2>&1; then
        printf '\n'
        docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
        log "服务已就绪：容器健康，网页=$PUBLIC_URL"
        exit 0
      fi
      status="healthy-but-web-pending"
    else
      status="$health"
    fi
  fi

  if [[ "$status" != "$last_status" || "$status" == "starting" ]]; then
    log "健康检查状态：$status（已等待 ${elapsed}s/${HEALTH_TIMEOUT_SECONDS}s）"
    last_status="$status"
  fi
  sleep "$HEALTH_INTERVAL_SECONDS"
  elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
done

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=100 app
die "服务未在规定时间内通过健康检查（${HEALTH_TIMEOUT_SECONDS}s）：网页=$PUBLIC_URL"
