#!/bin/sh
# Installs OpenAudioHub with Docker Compose on Linux or macOS.
#
#   curl -fsSL https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh | sh
#
# Environment variables (all optional):
#   OAH_DIR          install folder (default: ./openaudiohub)
#   OAH_VERSION      pin a release, for example 1.0.0 or v1.0.0 (default: latest)
#   APP_URL          public address written to a new .env (default: http://localhost:3000)
#
# The script never overwrites an existing .env. It downloads compose.yml on every run, so
# running it again refreshes the compose file and starts the stack.
set -eu

REPO="JeremyL691/OpenAudioHub"
BASE="https://github.com/$REPO/releases"
HEALTH_URL="http://127.0.0.1:3000/api/health"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "this installer supports Linux and macOS only" ;;
esac

for tool in curl openssl docker; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but was not found"
done
docker info >/dev/null 2>&1 || die "the Docker daemon does not answer. Start Docker and try again"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)"

OAH_DIR="${OAH_DIR:-./openaudiohub}"
APP_URL="${APP_URL:-http://localhost:3000}"

VERSION=""
if [ -n "${OAH_VERSION:-}" ]; then
  VERSION="${OAH_VERSION#v}"
  case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "OAH_VERSION must look like 1.0.0 or v1.0.0" ;;
  esac
  COMPOSE_URL="$BASE/download/v$VERSION/compose.yml"
else
  COMPOSE_URL="$BASE/latest/download/compose.yml"
fi

mkdir -p "$OAH_DIR"
OAH_DIR="$(cd "$OAH_DIR" && pwd)"
say "Install folder: $OAH_DIR"

# Download to a temporary file first, so a failed download never leaves a broken compose file.
tmp="$OAH_DIR/.compose.yml.tmp"
trap 'rm -f "$tmp"' EXIT
say "Downloading compose.yml"
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp" "$COMPOSE_URL" || die "could not download $COMPOSE_URL"
mv "$tmp" "$OAH_DIR/compose.yml"

if [ -e "$OAH_DIR/.env" ]; then
  say "Keeping the existing .env (it is never overwritten)"
else
  say "Creating .env with a new encryption key"
  # Written with restrictive permissions: the file holds the key that protects the data.
  ( umask 077
    {
      printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
      printf 'APP_URL=%s\n' "$APP_URL"
      if [ -n "$VERSION" ]; then
        printf 'OPENAUDIOHUB_VERSION=%s\n' "$VERSION"
      fi
    } > "$OAH_DIR/.env"
  )
  chmod 600 "$OAH_DIR/.env"
  say "Keep $OAH_DIR/.env safe. Without its ENCRYPTION_KEY, the stored data cannot be read."
fi

cd "$OAH_DIR"
# A version given to this run takes precedence over the value in .env.
if [ -n "$VERSION" ]; then
  export OPENAUDIOHUB_VERSION="$VERSION"
fi

say "Starting OpenAudioHub"
docker compose up -d

say "Waiting for the server to answer"
i=0
until curl -fsS -o /dev/null "$HEALTH_URL" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    die "the server did not answer at $HEALTH_URL after 60 seconds. Check: docker compose -f $OAH_DIR/compose.yml logs app"
  fi
  sleep 2
done

APP_URL_OUT="$(sed -n 's/^APP_URL=//p' "$OAH_DIR/.env" | tail -n 1)"
say ""
say "OpenAudioHub is running."
say "Open it in a browser: ${APP_URL_OUT:-$APP_URL}"
say "Local address: http://127.0.0.1:3000 (the container listens on 127.0.0.1 only)"
say "Open the address above to start. The server runs one local account. Add a reverse proxy for HTTPS when you open it to other people."
