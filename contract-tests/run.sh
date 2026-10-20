#!/usr/bin/env bash
# Runs the contract suite against a server.
#   run.sh server [playwright args]    build and start the server on a fresh data folder, run the suite, stop it
#   run.sh pipeline [playwright args]  the same, with the audio pipeline on and a short provider timeout
#   run.sh url [playwright args]       run the suite against an already running server at OAH_BASE_URL
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODE="${1:-url}"
shift || true

export OAH_BASE_URL="${OAH_BASE_URL:-http://localhost:3210}"
export OAH_FAKE_AI_URL="${OAH_FAKE_AI_URL:-http://127.0.0.1:3299/v1}"
# A local test account on a throwaway database.
export OAH_EMAIL="${OAH_EMAIL:-contract@openaudiohub.test}"
export OAH_PASSWORD="${OAH_PASSWORD:-contract-password-1}"

pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 600); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done
  echo "timed out waiting for $1" >&2; return 1
}

# A server left behind by an interrupted run would answer the health check and hide the
# build under test, which makes a failing test look like a passing one.
free_port() {
  local pids_here
  pids_here="$(lsof -ti:"$1" 2>/dev/null || true)"
  if [ -n "$pids_here" ]; then
    echo "port $1 is held by $pids_here; stopping it" >&2
    # shellcheck disable=SC2086
    kill $pids_here 2>/dev/null || true
    sleep 2
    # shellcheck disable=SC2086
    kill -9 $pids_here 2>/dev/null || true
    sleep 1
  fi
}

# Only the server mode owns the fake; url mode expects it to be running already,
# so a test run that exits never takes it down for other runs.
if [ "$MODE" != "url" ] && ! curl -sf -o /dev/null "$OAH_FAKE_AI_URL/models"; then
  fake_port="${OAH_FAKE_AI_URL%/v1}"
  node "$HERE/fakes/fake-ai.mjs" "${fake_port##*:}" >/dev/null &
  pids+=($!)
fi

if [ "$MODE" = "server" ] || [ "$MODE" = "pipeline" ]; then
  pipeline_enabled="false"
  provider_timeout=""
  if [ "$MODE" = "pipeline" ]; then
    port="${OAH_SERVER_PORT:-3212}"
    pipeline_enabled="true"
    # A short provider timeout keeps the "never answers" case inside a test's patience.
    provider_timeout="WHISPER_REQUEST_TIMEOUT_MS=3000"
  else
    port="${OAH_SERVER_PORT:-3211}"
  fi
  export OAH_BASE_URL="http://localhost:$port"
  free_port "$port"
  # Honor a shared cargo target dir (CARGO_TARGET_DIR) when one is set.
  target_dir="${CARGO_TARGET_DIR:-$ROOT/target}"
  mkdir -p "$ROOT/.dev-artifacts"
  # Each port gets its own data and session folders so parallel runs do not collide.
  data="$ROOT/.dev-artifacts/contract-server-data-$port"
  rm -rf "$data" "$ROOT/.dev-artifacts/contract-auth-$port"
  export OAH_SESSION_COOKIE=oah_session
  (cd "$ROOT" && cargo build -q --bin oah-server)
  # Each port builds the web app into its own folder, so parallel runs never overwrite each other.
  web_out="$ROOT/.dev-artifacts/web-dist-$port"
  (cd "$ROOT/web" && pnpm exec vite build --outDir "$web_out" --emptyOutDir >/dev/null)
  # Shared by parallel runs, like the fake AI: start it only when nothing answers.
  if ! curl -sf -o /dev/null "http://127.0.0.1:3298/__control/health"; then
    node "$HERE/fakes/fake-plaud.mjs" 3298 >/dev/null 2>&1 &
  fi
  env OAH_DATA_DIR="$data" PORT="$port" HOST=127.0.0.1 APP_URL="$OAH_BASE_URL" \
    ENCRYPTION_KEY="$(openssl rand -hex 32)" \
    RATE_LIMIT_TRUST_PROXY_HEADERS=true OAH_PLAUD_API_BASE="http://127.0.0.1:3298" \
    AUDIO_PIPELINE_ENABLED="$pipeline_enabled" WEBHOOKS_REQUIRE_PUBLIC_TARGETS=false \
    ${provider_timeout:+$provider_timeout} OAH_WEB_DIR="$web_out" \
    "$target_dir/debug/oah-server" >"$ROOT/.dev-artifacts/contract-server-$port.log" 2>&1 &
  pids+=($!)
fi

wait_for "$OAH_BASE_URL/api/health"
wait_for "$OAH_FAKE_AI_URL/models"

cd "$HERE"
# Each mode runs one project: the pipeline tests need a server started with the pipeline on,
# so they must never run inside the main suite.
if [ "$MODE" = "pipeline" ]; then
  exec pnpm --dir "$HERE" exec playwright test -c playwright.config.ts --project=pipeline "$@"
fi
pnpm --dir "$HERE" exec playwright test -c playwright.config.ts --project=contract "$@"
