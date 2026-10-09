#!/usr/bin/env bash
# Rehearsal stack for the Docker → App import (PLAN T15.1). It runs the Compose project openaudiohub-rehearsal on
# loopback ports that the live stack does not use (app 3310, database 54340, fake AI 3311). Secrets are generated
# into an env file outside the repository (0600) and are never printed.
#
#   rehearsal.sh env      write the env file if it is missing
#   rehearsal.sh up       start the database, then the app and the pipeline, and wait for /api/health
#   rehearsal.sh seed     seed the E2E account and recordings through the app, then copy the audio into the volume
#   rehearsal.sh stop     stop the app and the pipeline (the export needs them stopped)
#   rehearsal.sh down     remove the containers and keep the volumes
#   rehearsal.sh status   list the project's containers and their states
#
# The live project openaudiohub is never named here. Nothing in this script writes outside .dev-artifacts/rehearsal.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
WORK="$REPO/.dev-artifacts/rehearsal"
ENV_FILE="$WORK/rehearsal.env"
COMPOSE_FILE="$HERE/docker-compose.rehearsal.yml"
PROJECT="openaudiohub-rehearsal"
APP_PORT=3310
DB_PORT=54340
FAKE_AI_PORT=3311

mkdir -p "$WORK"
chmod 700 "$WORK"

compose() {
    REHEARSAL_ENV_FILE="$ENV_FILE" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

hex() {
    openssl rand -hex "$1"
}

write_env() {
    if [ -f "$ENV_FILE" ]; then
        echo "env file exists: $ENV_FILE"
        return 0
    fi
    local db_password
    db_password="$(hex 24)"
    umask 077
    {
        echo "POSTGRES_PASSWORD=$db_password"
        echo "DATABASE_URL=postgresql://postgres:$db_password@db:5432/openaudiohub"
        echo "BETTER_AUTH_SECRET=$(hex 32)"
        echo "ENCRYPTION_KEY=$(hex 32)"
        echo "API_TOKEN_HASH_SECRET=$(hex 32)"
        echo "AUDIO_PIPELINE_TOKEN=$(hex 32)"
        echo "AUDIO_PIPELINE_ENABLED=true"
        echo "AUDIO_PIPELINE_BASE_URL=http://audio-pipeline:8100"
        echo "APP_URL=http://127.0.0.1:$APP_PORT"
        echo "DISABLE_REGISTRATION="
        echo "DISABLE_UPDATE_CHECK=true"
        echo "OPENCODE_GO_SESSION_ID="
        echo "E2E_EMAIL=rehearsal@openaudiohub.localhost"
        echo "E2E_PASSWORD=Rehearsal-$(hex 12)"
        echo "FAKE_AI_BASE_URL=http://host.docker.internal:$FAKE_AI_PORT/v1"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "wrote env file: $ENV_FILE (values not shown)"
}

env_value() {
    grep "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2-
}

wait_for() {
    local description="$1" seconds="$2"
    shift 2
    local deadline=$((SECONDS + seconds))
    until "$@" >/dev/null 2>&1; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            echo "timed out waiting for $description" >&2
            return 1
        fi
        sleep 2
    done
}

cmd_up() {
    write_env
    compose up -d db
    wait_for "the database" 120 compose exec -T db pg_isready -U postgres -d openaudiohub
    compose up -d app audio-pipeline
    wait_for "the app health check" 240 curl -fsS "http://127.0.0.1:$APP_PORT/api/health"
    echo "rehearsal app: http://127.0.0.1:$APP_PORT (database port $DB_PORT)"
}

cmd_seed() {
    write_env
    local password fake_pid seed_dir
    password="$(env_value POSTGRES_PASSWORD)"
    seed_dir="$WORK/audio-seed"
    rm -rf "$seed_dir"
    mkdir -p "$seed_dir"

    (cd "$REPO" && FAKE_AI_PORT="$FAKE_AI_PORT" exec bun scripts/dev/fake-ai-server.ts) \
        > "$WORK/fake-ai.log" 2>&1 &
    fake_pid=$!
    trap 'kill "$fake_pid" 2>/dev/null || true' RETURN

    wait_for "the fake AI server" 60 curl -fsS "http://127.0.0.1:$FAKE_AI_PORT/v1/models"

    # The seed runs on the host with the app's settings from the env file (the app validates them at import).
    # The database and storage URLs are then overridden for the host: the database is on 127.0.0.1.
    (
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        cd "$REPO"
        APP_URL="http://127.0.0.1:$APP_PORT" \
            DATABASE_URL="postgres://postgres:$password@127.0.0.1:$DB_PORT/openaudiohub" \
            LOCAL_STORAGE_PATH="$seed_dir" \
            bun scripts/dev/seed-e2e.ts
    )

    # Copy the seeded audio into the app's audio volume. The source is mounted read-only.
    docker run --rm \
        -v "$PROJECT"_audio:/dst \
        -v "$seed_dir":/src:ro \
        postgres:16-alpine sh -c 'cp -a /src/. /dst/'
    echo "seeded: $(find "$seed_dir" -type f | wc -l | tr -d ' ') audio file(s) copied into $PROJECT"_audio
}

cmd_stop() {
    compose stop app audio-pipeline
}

cmd_down() {
    compose down
}

cmd_status() {
    compose ps
}

case "${1:-}" in
    env) write_env ;;
    up) cmd_up ;;
    seed) cmd_seed ;;
    stop) cmd_stop ;;
    down) cmd_down ;;
    status) cmd_status ;;
    *)
        echo "usage: rehearsal.sh env|up|seed|stop|down|status" >&2
        exit 2
        ;;
esac
