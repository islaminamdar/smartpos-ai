#!/usr/bin/env bash
# Start the local Supabase gateway only after two failed application readiness probes.
# This deliberately never restarts the database, auth, or REST containers.
set -euo pipefail

state_dir=/var/lib/internext-pos-gateway-guard
failure_file="$state_dir/failures"
health_url=http://127.0.0.1:3046/api/pos/health

mkdir -p "$state_dir"

if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url" | grep -q '"status":"ok"'; then
  rm -f "$failure_file"
  exit 0
fi

failures=0
if [[ -f "$failure_file" ]]; then
  failures=$(cat "$failure_file")
fi
failures=$((failures + 1))
printf '%s\n' "$failures" >"$failure_file"

# A brief deployment or dependency restart should not cause a recovery loop.
if (( failures < 2 )); then
  logger -t internext-pos-gateway-guard "POS readiness probe failed ($failures/2); waiting before recovery"
  exit 0
fi

if ! systemctl is-active --quiet container-internext-pos-auth.service ||
  ! systemctl is-active --quiet container-internext-pos-rest.service; then
  logger -t internext-pos-gateway-guard "POS dependencies are not ready; gateway recovery deferred"
  exit 0
fi

if systemctl is-active --quiet container-internext-pos-gateway.service; then
  logger -t internext-pos-gateway-guard "POS readiness stayed down; restarting gateway"
  systemctl restart container-internext-pos-gateway.service
else
  logger -t internext-pos-gateway-guard "POS gateway is inactive; starting gateway"
  systemctl start container-internext-pos-gateway.service
fi

rm -f "$failure_file"
