#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-gaussian-ready}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose-ready.yml}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:8080/}"

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

FRONT_SOURCE_HASH="$(
  {
    find front/app front/public -type f -print0 | sort -z | xargs -0 sha256sum
    for file in package.json package-lock.json next.config.ts tsconfig.json vite.config.ts; do
      [[ -f "front/$file" ]] && sha256sum "front/$file"
    done
  } | sha256sum | awk '{print $1}'
)"
FRONT_HASH_FILE="$APP_DIR/front/.next/.gaussian-source-hash"
if [[ ! -f "$FRONT_HASH_FILE" || "$(<"$FRONT_HASH_FILE")" != "$FRONT_SOURCE_HASH" ]]; then
  log "前端源码已变化，重新构建"
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" run --rm \
    --entrypoint bash app -lc '
      cd /workspace/gaussian/front
      npm run build
    '
  mkdir -p "$APP_DIR/front/.next"
  printf '%s' "$FRONT_SOURCE_HASH" > "$FRONT_HASH_FILE"
else
  log "前端源码未变化，跳过 npm run build"
fi

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
