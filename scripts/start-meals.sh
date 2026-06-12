#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

free_port() {
  # Kill whatever is listening on the port (fuser not available on all systems).
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"${PORT}" | xargs -r kill -9 2>/dev/null || true
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
  pkill -f "next dev.*-p ${PORT}" >/dev/null 2>&1 || true
  pkill -f "next start.*-p ${PORT}" >/dev/null 2>&1 || true
  pkill -f "next-server" >/dev/null 2>&1 || true
  sleep 1
}

cd "$(dirname "$0")/../myhealthymeals"

if [ "${1:-}" = "dev" ]; then
  free_port
  echo ""
  echo "  MyHealthyMeals →  http://localhost:${PORT}"
  echo ""
  exec pnpm exec next dev -H "$HOST" -p "$PORT"
fi

echo "Building MyHealthyMeals..."
pnpm build

free_port
echo ""
echo "  MyHealthyMeals →  http://localhost:${PORT}"
echo ""
exec pnpm exec next start -H "$HOST" -p "$PORT"
