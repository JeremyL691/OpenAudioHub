#!/usr/bin/env bash
# Regenerates docs/images/*.png from demo data on a throwaway server.
#   tools/screenshots/run.sh
# Uses its own ports and data folder; stops everything it started on exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${SCREENSHOT_PORT:-3290}"
FAKE_PORT="${SCREENSHOT_FAKE_PORT:-3291}"
BASE_URL="http://127.0.0.1:$PORT"
FAKE_AI_URL="http://127.0.0.1:$FAKE_PORT/v1"
DATA="$ROOT/.dev-artifacts/screenshots-data"
WEB_OUT="$ROOT/.dev-artifacts/screenshots-web"
WORK="$ROOT/.dev-artifacts/screenshots-work"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
BIN="$CARGO_TARGET_DIR/debug/oah-server"

pids=()
cleanup() {
    for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done
    for p in ${pids[@]+"${pids[@]}"}; do wait "$p" 2>/dev/null || true; done
    rm -rf "$DATA" "$WEB_OUT" "$WORK"
}
on_error() {
    for log in "$WORK/server.log" "$WORK/demo-ai.log"; do
        [ -f "$log" ] && { echo "--- $(basename "$log") (tail)" >&2; tail -n 30 "$log" >&2; }
    done
}
trap on_error ERR
trap cleanup EXIT

for port in "$PORT" "$FAKE_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "port $port is already in use; set SCREENSHOT_PORT or SCREENSHOT_FAKE_PORT" >&2
        exit 1
    fi
done

rm -rf "$DATA" "$WEB_OUT" "$WORK"
mkdir -p "$DATA" "$WORK"
(cd "$ROOT" && cargo build -q --bin oah-server)
(cd "$ROOT/web" && pnpm exec vite build --outDir "$WEB_OUT" --emptyOutDir >/dev/null)

node "$HERE/demo-ai.mjs" "$FAKE_PORT" >"$WORK/demo-ai.log" 2>&1 &
pids+=($!)

OAH_DATA_DIR="$DATA" PORT="$PORT" HOST=127.0.0.1 APP_URL="$BASE_URL" \
    ENCRYPTION_KEY="$(openssl rand -hex 32)" \
    RATE_LIMIT_TRUST_PROXY_HEADERS=true OAH_PLAUD_API_BASE="http://127.0.0.1:9" \
    AUDIO_PIPELINE_ENABLED=false OAH_WEB_DIR="$WEB_OUT" \
    "$BIN" >"$WORK/server.log" 2>&1 &
pids+=($!)

wait_for() {
    for _ in $(seq 1 600); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done
    echo "timed out waiting for $1" >&2
    return 1
}
wait_for "$BASE_URL/api/health"
wait_for "$FAKE_AI_URL/models"

BASE_URL="$BASE_URL" FAKE_AI_URL="$FAKE_AI_URL" \
    OUT_DIR="$ROOT/docs/images" WORK_DIR="$WORK/audio" \
    node "$HERE/capture.mjs"

echo "done: $(ls -1 "$ROOT"/docs/images/{dashboard,library,recording,settings}.png | wc -l | tr -d ' ') images in docs/images"
