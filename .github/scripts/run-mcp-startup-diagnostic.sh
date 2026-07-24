#!/usr/bin/env bash

set -euo pipefail

project="$1"

run_tests() {
  set +e
  "$@"
  local test_status=$?
  node .github/scripts/recover-mcp-chromium-traces.mjs
  local recovery_status=$?
  if [[ "$test_status" != "0" ]]; then
    return "$test_status"
  fi
  return "$recovery_status"
}

if [[ "$(uname)" != "Linux" ]]; then
  run_tests npm run test-mcp -- --project="$project" --workers=1 --timeout=60000
  exit $?
fi

health_dir="mcp-runner-health"
health_file="$health_dir/runner-health.tsv"
mkdir -p "$health_dir"

monitor_health() {
  printf 'timestamp\tload1\tmem_available_kb\tswap_free_kb\tdisk_available_kb\tprocesses\tnode_rss_kb\tchromium_rss_kb\txvfb_rss_kb\n'
  while true; do
    local timestamp load1 mem_available swap_free disk_available processes node_rss chromium_rss xvfb_rss
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    load1="$(awk '{ print $1 }' /proc/loadavg)"
    mem_available="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
    swap_free="$(awk '/^SwapFree:/ { print $2 }' /proc/meminfo)"
    disk_available="$(df -Pk . | awk 'NR == 2 { print $4 }')"
    processes="$(ps -e --no-headers | wc -l)"
    node_rss="$(ps -eo rss=,comm= | awk '$2 == "node" { sum += $1 } END { print sum + 0 }')"
    chromium_rss="$(ps -eo rss=,comm= | awk '$2 ~ /^(chrome|chromium)$/ { sum += $1 } END { print sum + 0 }')"
    xvfb_rss="$(ps -eo rss=,comm= | awk '$2 == "Xvfb" { sum += $1 } END { print sum + 0 }')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$timestamp" "$load1" "$mem_available" "$swap_free" "$disk_available" \
      "$processes" "$node_rss" "$chromium_rss" "$xvfb_rss"
    sleep 15
  done
}

monitor_health > "$health_file" &
monitor_pid=$!
cleanup() {
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
}
trap cleanup EXIT

set +e
run_tests timeout --signal=INT --kill-after=30s 35m npm run test-mcp -- --project="$project" --workers=1 --timeout=60000
status=$?
set -e

if [[ "$status" == "124" ]]; then
  echo "::error::Ubuntu MCP diagnostic exceeded 35 minutes; stopping before the hosted runner is lost."
fi
exit "$status"
