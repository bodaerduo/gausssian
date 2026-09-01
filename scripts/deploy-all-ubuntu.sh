#!/usr/bin/env bash
set -Eeuo pipefail

# Run the complete Ubuntu deployment from the Gaussian project root.
# Override APP_DIR when the project is not the current package directory.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR:-$PROJECT_ROOT}"

cd "$APP_DIR"

"$APP_DIR/scripts/setup-colmap-ubuntu.sh"
"$APP_DIR/scripts/setup-brush-ubuntu.sh"
"$APP_DIR/scripts/setup-backend-ubuntu.sh"
DEMO_MODE="${DEMO_MODE:-false}" \
  APP_DIR="$APP_DIR" \
  "$APP_DIR/scripts/deploy-front-ubuntu.sh"

printf '\n全链路部署完成：%s\n' "$APP_DIR"
