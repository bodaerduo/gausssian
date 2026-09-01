#!/usr/bin/env bash
set -Eeuo pipefail

cleanup() {
  kill -TERM "${FRONT_PID:-}" "${BACKEND_PID:-}" 2>/dev/null || true
  wait "${FRONT_PID:-}" "${BACKEND_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

python3 -m uvicorn app:app --host 0.0.0.0 --port 4178 &
BACKEND_PID=$!

cd /app/front
npm run start -- --hostname 0.0.0.0 --port 4177 &
FRONT_PID=$!

set +e
wait -n "$BACKEND_PID" "$FRONT_PID"
STATUS=$?
set -e
exit "$STATUS"
