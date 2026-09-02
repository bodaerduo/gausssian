#!/usr/bin/env bash
set -Eeuo pipefail

cleanup() {
  kill -TERM "${FRONT_PID:-}" "${BACKEND_PID:-}" 2>/dev/null || true
  wait "${FRONT_PID:-}" "${BACKEND_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

PROJECT_ROOT="${GAUSSIAN_PROJECT_ROOT:-/app}"

cd "$PROJECT_ROOT/front"
if [[ "${GAUSSIAN_FRONT_AUTO_BUILD:-true}" == "true" ]]; then
  LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
  if [[ ! -d node_modules || ! -f node_modules/.gaussian-package-lock || "$(<node_modules/.gaussian-package-lock)" != "$LOCK_HASH" ]]; then
    npm ci
    printf '%s' "$LOCK_HASH" > node_modules/.gaussian-package-lock
  fi

  SOURCE_HASH="$({
    find app public -type f -print0 | sort -z | xargs -0 sha256sum
    for file in package.json package-lock.json next.config.ts tsconfig.json vite.config.ts; do
      [[ -f "$file" ]] && sha256sum "$file"
    done
  } | sha256sum | awk '{print $1}')"
  if [[ ! -f .next/.gaussian-source-hash || "$(<.next/.gaussian-source-hash)" != "$SOURCE_HASH" ]]; then
    npm run build
    mkdir -p .next
    printf '%s' "$SOURCE_HASH" > .next/.gaussian-source-hash
  fi
fi

cd "$PROJECT_ROOT/backend"
if [[ "${GAUSSIAN_AUTO_INSTALL_PYTHON_DEPS:-true}" == "true" ]]; then
  REQUIREMENTS_HASH="$(sha256sum requirements.txt | awk '{print $1}')"
  if [[ ! -f .gaussian-requirements-hash || "$(<.gaussian-requirements-hash)" != "$REQUIREMENTS_HASH" ]]; then
    python3 -m pip install --no-cache-dir -r requirements.txt
    printf '%s' "$REQUIREMENTS_HASH" > .gaussian-requirements-hash
  fi
fi
python3 -m uvicorn app:app --host 0.0.0.0 --port 4178 &
BACKEND_PID=$!

cd "$PROJECT_ROOT/front"
npm run start -- --hostname 0.0.0.0 --port 4177 &
FRONT_PID=$!

set +e
wait -n "$BACKEND_PID" "$FRONT_PID"
STATUS=$?
set -e
exit "$STATUS"
