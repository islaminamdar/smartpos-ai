#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

free_port() {
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
  pkill -f "next dev.*${PORT}" >/dev/null 2>&1 || true
  pkill -f "next start.*${PORT}" >/dev/null 2>&1 || true
  sleep 1
}

cd "$(dirname "$0")/../myhealthymeals"

if [ "${1:-}" = "dev" ]; then
  free_port
  echo "Starting MyHealthyMeals dev server on http://${HOST}:${PORT}"
  exec pnpm exec next dev -H "$HOST" -p "$PORT"
fi

echo "Building MyHealthyMeals..."
pnpm build

free_port
echo "Starting MyHealthyMeals on http://${HOST}:${PORT}"
exec pnpm exec next start -H "$HOST" -p "$PORT"
