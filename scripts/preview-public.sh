#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"

# localhost does NOT work in Cursor Cloud — this script creates a public URL.

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/"; then
  echo "Starting dev server on port ${PORT}..."
  bash "$(dirname "$0")/start-meals.sh" dev &
  for i in $(seq 1 30); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" && break
    sleep 1
  done
fi

echo ""
echo "  NOTE: localhost will NOT work in Cursor Cloud."
echo "  A public preview URL will appear below (trycloudflare.com)."
echo "  Copy it and open in your browser."
echo ""

exec npx --yes cloudflared tunnel --url "http://127.0.0.1:${PORT}"
