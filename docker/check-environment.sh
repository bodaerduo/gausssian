#!/usr/bin/env bash
set -u

PROJECT_ROOT="${GAUSSIAN_PROJECT_ROOT:-/workspace/gaussian}"
DATA_ROOT="${GAUSSIAN_DATA_ROOT:-/app/runtime/data}"
FAILURES=0
WARNINGS=0

pass() { printf '[PASS] %s\n' "$*"; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); printf '[FAIL] %s\n' "$*"; }
section() { printf '\n===== %s =====\n' "$*"; }

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    pass "$name: $(command -v "$name")"
  else
    fail "$name 不存在"
  fi
}

section "身份与系统"
if [[ "$(id -u)" == "0" ]]; then pass "当前用户是 root"; else warn "当前用户不是 root：$(id -un)"; fi
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  pass "系统：${PRETTY_NAME:-unknown}"
else
  warn "无法读取 /etc/os-release"
fi
printf '内核：%s\n' "$(uname -a)"

section "GPU 与 CUDA"
check_command nvidia-smi
if command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia-smi -L >/dev/null 2>&1; then
    pass "NVIDIA GPU 可见"
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || true
  else
    fail "NVIDIA GPU 不可见，请确认容器使用 --gpus all"
  fi
fi
check_command nvcc
if command -v nvcc >/dev/null 2>&1; then nvcc --version | tail -n 4; fi

section "编译工具"
for command_name in gcc g++ cmake ninja make pkg-config git curl; do check_command "$command_name"; done

section "运行时工具"
for command_name in python3 pip3 ffmpeg ffprobe node npm colmap brush-cli; do check_command "$command_name"; done

if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import importlib.util
import sys

packages = ("fastapi", "multipart", "uvicorn")
missing = [name for name in packages if importlib.util.find_spec(name) is None]
if missing:
    print("[FAIL] Python 包缺失：" + ", ".join(missing))
    raise SystemExit(1)
print("[PASS] Python 包：FastAPI、python-multipart、uvicorn")
PY
  if [[ "$?" != "0" ]]; then FAILURES=$((FAILURES + 1)); fi
fi

section "COLMAP 与 Brush"
if command -v colmap >/dev/null 2>&1; then
  if colmap -h >/dev/null 2>&1; then pass "COLMAP CLI 可执行"; else fail "COLMAP CLI 无法启动"; fi
  missing_libs="$(ldd "$(command -v colmap)" 2>/dev/null | awk '/not found/{print}')"
  if [[ -n "$missing_libs" ]]; then fail "COLMAP 动态库缺失：$missing_libs"; else pass "COLMAP 动态库完整"; fi
fi
if command -v brush-cli >/dev/null 2>&1; then
  if brush-cli --help >/dev/null 2>&1; then pass "Brush CLI 可执行"; else fail "Brush CLI 无法启动"; fi
fi

section "项目挂载与数据目录"
if [[ -d "$PROJECT_ROOT/backend" && -f "$PROJECT_ROOT/backend/app.py" ]]; then pass "后端代码：$PROJECT_ROOT/backend"; else fail "后端代码不存在：$PROJECT_ROOT/backend"; fi
if [[ -d "$PROJECT_ROOT/front" && -f "$PROJECT_ROOT/front/package.json" ]]; then pass "前端代码：$PROJECT_ROOT/front"; else fail "前端代码不存在：$PROJECT_ROOT/front"; fi
if [[ -w "$PROJECT_ROOT" ]]; then pass "项目挂载目录可写"; else warn "项目挂载目录不可写，前端无法保存 node_modules/.next"; fi
if [[ -d "$DATA_ROOT" && -w "$DATA_ROOT" ]]; then
  pass "数据目录可写：$DATA_ROOT"
elif [[ -e "$DATA_ROOT" ]]; then
  fail "数据目录不可写：$DATA_ROOT"
else
  warn "数据目录尚不存在：$DATA_ROOT；Compose 启动时应创建"
fi

if [[ -d "$PROJECT_ROOT/front/node_modules" ]]; then pass "前端 node_modules 已存在"; else warn "前端 node_modules 尚未安装，首次启动会执行 npm ci"; fi
if [[ -d "$PROJECT_ROOT/front/.next" ]]; then pass "前端构建目录 .next 已存在"; else warn "前端尚未构建，首次启动会执行 npm run build"; fi

section "服务端口"
if command -v ss >/dev/null 2>&1; then
  for port in 4177 4178; do
    if ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then pass "端口 $port 正在监听"; else warn "端口 $port 当前未监听"; fi
  done
else
  warn "ss 不存在，跳过端口检查"
fi

section "本地健康检查"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 http://127.0.0.1:4178/health >/dev/null 2>&1; then pass "FastAPI 4178 健康检查通过"; else warn "FastAPI 4178 尚未启动"; fi
  if curl -fsS --max-time 5 http://127.0.0.1:4177/api/health >/dev/null 2>&1; then pass "前端同源 API 4177 健康检查通过"; else warn "前端 4177 尚未启动"; fi
fi

section "结果"
printf 'FAIL=%s WARN=%s\n' "$FAILURES" "$WARNINGS"
if [[ "$FAILURES" == "0" ]]; then
  echo "基础环境检查通过。WARN 通常表示服务尚未启动或前端尚未首次构建。"
  exit 0
fi
echo "基础环境存在关键问题，请先修复 FAIL 项。"
exit 1
