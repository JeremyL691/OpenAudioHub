#!/usr/bin/env bash
# Local Postgres for integration tests (PLAN T0.5).
#   up      start postgres:16 on 127.0.0.1:54329 and wait until healthy
#   down    stop and remove the stack and its data
#   status  show container state
#   env     print an export line for TEST_DATABASE_URL (eval "$(scripts/dev/test-stack.sh env)")
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/scripts/dev/test-stack.compose.yml"
PROJECT="oah-test"
TEST_DATABASE_URL="postgres://oah_test:oah_test@127.0.0.1:54329/postgres"

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

case "${1:-}" in
  up)
    compose up -d --wait
    echo "test stack '$PROJECT' is up on 127.0.0.1:54329"
    echo "load it with: eval \"\$($0 env)\""
    ;;
  down)
    compose down -v --remove-orphans
    ;;
  status)
    compose ps
    ;;
  env)
    printf 'export TEST_DATABASE_URL=%s\n' "$TEST_DATABASE_URL"
    ;;
  *)
    echo "usage: $0 up|down|status|env" >&2
    exit 2
    ;;
esac
