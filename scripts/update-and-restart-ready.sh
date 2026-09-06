#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-gussian}"
BASE_COMPOSE_FILE="${COMPOSE_FILE:-docker/compose-gussian.yml}"
ABOT_COMPOSE_FILE="${ABOT_COMPOSE_FILE:-docker/compose-abot.yml}"
PUBLIC_URL="${PUBLIC_URL:-https://127.0.0.1:8080/}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-3}"
ABOT_HOST_PORT=8081
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="${LOG_FILE:-$APP_DIR/runtime/logs/update-$RUN_ID.log}"
COMPOSE=()
SERVICES=()

mkdir -p "$(dirname -- "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"; }

fail() {
  log "ERROR: $*"
  log "输出 Compose 状态和最近日志"
  if ((${#COMPOSE[@]})); then
    "${COMPOSE[@]}" ps -a || true
    for service in "${SERVICES[@]}"; do
      "${COMPOSE[@]}" logs --no-color --tail 120 "$service" || true
    done
  fi
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "未找到命令：$1"
}

wait_for_container() {
  local service="$1" elapsed=0 last_status=""
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    local container_id running health status
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      status="missing"
    else
      running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || echo false)"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || echo unavailable)"
      if [[ "$running" != "true" ]]; then
        status="stopped"
      elif [[ "$health" == "healthy" || "$health" == "no-healthcheck" ]]; then
        log "$service 容器已运行（health=$health）"
        return 0
      else
        status="$health"
      fi
    fi
    if [[ "$status" != "$last_status" || "$status" == "starting" ]]; then
      log "$service 容器状态：$status（${elapsed}s/${HEALTH_TIMEOUT_SECONDS}s）"
      last_status="$status"
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
    elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
  done
  fail "$service 容器未在 ${HEALTH_TIMEOUT_SECONDS}s 内正常运行"
}

wait_for_http() {
  local label="$1" url="$2" elapsed=0
  local curl_args=(--max-time 5 -fsS)
  [[ "$url" == https://* ]] && curl_args=(-k "${curl_args[@]}")
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    if curl "${curl_args[@]}" "$url" >/dev/null 2>&1; then
      log "$label 健康检查通过：$url"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
    elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
  done
  fail "$label 健康检查超时：$url"
}

wait_for_worker_from_app() {
  local elapsed=0
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    if "${COMPOSE[@]}" exec -T app curl -fsS --max-time 5 http://abot-worker:8091/health >/dev/null 2>&1; then
      log "app → abot-worker:8091 容器间健康检查通过"
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
    elapsed=$((elapsed + HEALTH_INTERVAL_SECONDS))
  done
  fail "app → abot-worker:8091 容器间健康检查超时"
}

cd "$APP_DIR"
[[ -f "$BASE_COMPOSE_FILE" ]] || fail "找不到 Compose 文件：$APP_DIR/$BASE_COMPOSE_FILE"
require_command git
require_command docker
require_command curl
require_command npm
require_command python3

log "项目目录：$APP_DIR"
log "部署日志：$LOG_FILE"
log "拉取最新代码（fast-forward only）"
git pull --ff-only origin main || fail "代码更新失败，工作区可能存在本地修改或远端发生分叉"

COMPOSE=(docker compose -p "$COMPOSE_PROJECT" -f "$BASE_COMPOSE_FILE")
if [[ -f "$ABOT_COMPOSE_FILE" ]]; then
  COMPOSE+=(-f "$ABOT_COMPOSE_FILE")
  HAS_ABOT=true
else
  HAS_ABOT=false
fi
mapfile -t SERVICES < <("${COMPOSE[@]}" config --services)
(( ${#SERVICES[@]} > 0 )) || fail "Compose 没有解析出服务"

log "Compose 项目：$COMPOSE_PROJECT"
log "Compose 服务：${SERVICES[*]}"

log "安装前端依赖"
(
  cd "$APP_DIR/front"
  npm install --no-audit --no-fund --package-lock=false --registry "$NPM_REGISTRY"
) || fail "前端依赖安装失败"

log "构建前端"
(
  cd "$APP_DIR/front"
  npm run build
) || fail "前端构建失败"

log "拉起全部 Compose 服务（不执行 down，不删除现有数据卷）"
GAUSSIAN_FRONT_AUTO_BUILD=false \
  "${COMPOSE[@]}" up -d --force-recreate || fail "Compose 服务启动失败"

log "等待所有服务容器运行"
for service in "${SERVICES[@]}"; do
  wait_for_container "$service"
done

log "检查主 API 和网页入口"
wait_for_http "主 API/网页" "$PUBLIC_URL"
if "${COMPOSE[@]}" exec -T app curl -fsS --max-time 5 http://127.0.0.1:4178/health >/dev/null; then
  log "app 容器内 FastAPI 健康检查通过"
else
  fail "app 容器内 FastAPI 健康检查失败"
fi

if [[ "$HAS_ABOT" == true ]]; then
  log "检查 ABot Worker（宿主机端口 ${ABOT_HOST_PORT}）"
  wait_for_http "ABot Worker 宿主机" "http://127.0.0.1:${ABOT_HOST_PORT}/health"
  wait_for_worker_from_app

  log "检查 ABot 产品路线开关"
  products="$("${COMPOSE[@]}" exec -T app curl -fsS --max-time 5 http://127.0.0.1:4178/api/v1/products)" || fail "无法读取产品路线配置"
  if ! printf '%s' "$products" | python3 -c '
import json, sys
items = json.load(sys.stdin).get("products", [])
route = next((item for item in items if item.get("id") == "abot_recon_poc"), None)
if not route or route.get("enabled") is not True:
    raise SystemExit(1)
print("abot_recon_poc enabled=true")
'; then
    printf '%s\n' "$products"
    fail "ABot-Recon 产品路线未启用"
  fi
fi

log "最终 Compose 状态"
"${COMPOSE[@]}" ps
log "部署完成，详细日志已保存：$LOG_FILE"
