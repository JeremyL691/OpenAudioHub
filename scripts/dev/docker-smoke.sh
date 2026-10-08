#!/usr/bin/env bash
# Docker smoke stack for the long-audio run.
#   env     create .dev-artifacts/oah-e2e.env with generated secrets (values are not printed)
#   up      build and start the stack on 127.0.0.1:3100 and wait until healthy
#   down    stop the stack and remove its volumes (oah-e2e_* only)
#   ps      show container state
#   logs    show logs, optionally for one service (logs audio-pipeline)
# The fake AI server runs on the host, outside this script:
#   FAKE_AI_PORT=3299 bun scripts/dev/fake-ai-server.ts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/scripts/dev/docker-smoke.compose.yml"
ENV_FILE="$ROOT/.dev-artifacts/oah-e2e.env"
PROJECT="oah-e2e"

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

case "${1:-}" in
  env)
    mkdir -p "$ROOT/.dev-artifacts"
    if [ -f "$ENV_FILE" ]; then
      echo "kept existing $ENV_FILE"
      exit 0
    fi
    umask 077
    {
      echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
      echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
      echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
      echo "AUDIO_PIPELINE_TOKEN=$(openssl rand -hex 32)"
    } > "$ENV_FILE"
    echo "wrote $ENV_FILE (values not printed)"
    ;;
  up)
    compose up -d --build --wait
    echo "smoke stack '$PROJECT' is up on 127.0.0.1:3100"
    ;;
  down)
    compose down -v --remove-orphans
    ;;
  ps)
    compose ps
    ;;
  logs)
    shift
    compose logs --no-color "$@"
    ;;
  *)
    echo "usage: $0 env|up|down|ps|logs [service]" >&2
    exit 2
    ;;
esac
