#!/usr/bin/env bash
PORT="${PORT:-3000}"

if command -v lsof >/dev/null 2>&1; then
  lsof -ti:"${PORT}" | xargs -r kill -9 2>/dev/null || true
fi
pkill -f "next dev.*-p ${PORT}" 2>/dev/null || true
pkill -f "next start.*-p ${PORT}" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
echo "Stopped server on port ${PORT}"
