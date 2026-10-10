#!/usr/bin/env bash
# Exports a Docker OpenAudioHub stack for the Mac app (PLAN T15.1, D-313). The App imports the result with
# `OpenAudioHub --import <dir>` or from its menu.
#
#   scripts/export-for-desktop.sh --project <compose project> [--out <dir>] [--dry-run] [--allow-live]
#
# Output in <dir> (none of it is printed):
#   db.dump            pg_dump -Fc of the application database
#   storage.tar        the audio volume (/app/audio), read through a read-only mount
#   pipeline-data.tar  the audio pipeline's data volume (/data), read-only
#   secrets.env        ENCRYPTION_KEY, BETTER_AUTH_SECRET, API_TOKEN_HASH_SECRET (0600)
#   config.env         the App's allow-listed settings (0600), from desktop/src/main/user-env.ts
#   manifest.json      sha256 and size of each file, the audio files' sha256 and size, row counts, migration
#                      hashes, an API credential digest, and an encryption check (a sample encrypted with the source key)
#
# The source is only read: no writes to its database, volumes, or containers. The app and the pipeline must be
# stopped for a real run (the database must not change during the dump). Real runs are refused for the live
# project name `openaudiohub` unless --allow-live is given (the gated cutover, docs/dev/DESKTOP_CUTOVER.md).
# --dry-run prints the plan and writes nothing.
set -euo pipefail

PROJECT=""
OUT=""
DRY_RUN=0
ALLOW_LIVE=0
LIVE_PROJECT="openaudiohub"

usage() {
    echo "usage: $0 --project <compose project> [--out <dir>] [--dry-run] [--allow-live]" >&2
    exit 2
}

die() {
    echo "export: $*" >&2
    exit 1
}

# sha256 of a file, or of stdin when no file is given. macOS has shasum, Linux has sha256sum.
sha256_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"; else sha256sum "$@"; fi | cut -d' ' -f1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --project) PROJECT="${2:-}"; shift 2 ;;
        --out) OUT="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --allow-live) ALLOW_LIVE=1; shift ;;
        -h | --help) usage ;;
        *) usage ;;
    esac
done

[ -n "$PROJECT" ] || usage
command -v docker >/dev/null || die "docker is not installed"
command -v jq >/dev/null || die "jq is not installed"
if [ "$DRY_RUN" -eq 0 ]; then
    [ -n "$OUT" ] || die "--out is required for a real run"
    if [ "$PROJECT" = "$LIVE_PROJECT" ]; then
        [ "$ALLOW_LIVE" -eq 1 ] || die "refusing a real run on the live project '$LIVE_PROJECT'; pass --allow-live for the cutover (docs/dev/DESKTOP_CUTOVER.md)"
        echo "== exporting the live project '$LIVE_PROJECT' (--allow-live)" >&2
    fi
fi

# The containers of the project, by compose service label. Names are read from docker, never typed here.
service_container() {
    docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -n 1
}

container_env() {
    docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}'
}

env_of() {
    # Unset keys print nothing and succeed, so callers test for an empty value (grep alone would exit 1).
    container_env "$1" | grep "^$2=" | head -n 1 | cut -d= -f2- || true
}

volume_at() {
    docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}"
}

APP="$(service_container app)"
DB="$(service_container db)"
PIPELINE="$(service_container audio-pipeline)"
[ -n "$APP" ] || die "no app container in project '$PROJECT'"
[ -n "$DB" ] || die "no db container in project '$PROJECT'"
[ -n "$PIPELINE" ] || die "no audio-pipeline container in project '$PROJECT'"

DB_USER="$(env_of "$DB" POSTGRES_USER)"
DB_NAME="$(env_of "$DB" POSTGRES_DB)"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-openaudiohub}"
AUDIO_VOLUME="$(volume_at "$APP" /app/audio)"
PIPELINE_VOLUME="$(volume_at "$PIPELINE" /data)"
[ -n "$AUDIO_VOLUME" ] || die "the app has no volume at /app/audio"
[ -n "$PIPELINE_VOLUME" ] || die "the pipeline has no volume at /data"

# Keys are checked before anything is stopped or written, so a dry run against the running stack finds a missing one.
# API_TOKEN_HASH_SECRET is optional: without it the app hashes API tokens with BETTER_AUTH_SECRET, and the importer
# makes the same choice (desktop/src/main/import/keys.ts), so existing API keys keep working.
for key in ENCRYPTION_KEY BETTER_AUTH_SECRET; do
    [ -n "$(env_of "$APP" "$key")" ] || die "the app has no $key"
done
if [ -n "$(env_of "$APP" API_TOKEN_HASH_SECRET)" ]; then
    token_key_note="set"
else
    token_key_note="not set (API tokens use BETTER_AUTH_SECRET, as in the app)"
fi

psql_db() {
    docker exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -X -A -t -v ON_ERROR_STOP=1 -c "$1"
}

app_state="$(docker inspect "$APP" --format '{{.State.Status}}')"
pipeline_state="$(docker inspect "$PIPELINE" --format '{{.State.Status}}')"
active_jobs="$(psql_db "select count(*) from audio_pipeline_jobs where status in ('queued','submitted','running','paused')" 2>/dev/null || echo "unknown")"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "plan for project '$PROJECT' (dry run: nothing is written)"
    echo "  app container:       $APP (state: $app_state)"
    echo "  database container:  $DB (database $DB_NAME, user from its environment)"
    echo "  pipeline container:  $PIPELINE (state: $pipeline_state)"
    echo "  audio volume:        $AUDIO_VOLUME -> storage.tar"
    echo "  pipeline volume:     $PIPELINE_VOLUME -> pipeline-data.tar"
    echo "  active pipeline jobs: $active_jobs (must be 0 for a real run)"
    echo "  keys:                ENCRYPTION_KEY and BETTER_AUTH_SECRET set; API_TOKEN_HASH_SECRET $token_key_note"
    echo "  outputs:             db.dump, storage.tar, pipeline-data.tar, secrets.env, config.env, manifest.json"
    if [ "$app_state" = "running" ] || [ "$pipeline_state" = "running" ]; then
        echo "  note: stop the app and the pipeline before a real run (docker compose -p $PROJECT stop app audio-pipeline)"
    fi
    exit 0
fi

# Preflight for a real run: the app and the pipeline are stopped, and no pipeline job is active.
[ "$app_state" != "running" ] || die "the app is running; stop it first (docker compose -p $PROJECT stop app audio-pipeline)"
[ "$pipeline_state" != "running" ] || die "the audio pipeline is running; stop it first"
[ "$active_jobs" = "0" ] || die "pipeline jobs are still active ($active_jobs); wait for them to finish"

mkdir -p "$OUT"
chmod 700 "$OUT"
TMP="$(mktemp -d "$OUT/.export.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "== database"
docker exec "$DB" pg_dump -Fc --no-owner --no-privileges -U "$DB_USER" -d "$DB_NAME" > "$TMP/db.dump"
chmod 600 "$TMP/db.dump"

echo "== volumes (read-only mounts)"
tar_volume() {
    docker run --rm -v "$1":/src:ro postgres:16-alpine tar -C /src -cf - . > "$2"
}
tar_volume "$AUDIO_VOLUME" "$TMP/storage.tar"
tar_volume "$PIPELINE_VOLUME" "$TMP/pipeline-data.tar"
chmod 600 "$TMP/storage.tar" "$TMP/pipeline-data.tar"

echo "== audio file list (sha256 and size of each file, read-only)"
docker run --rm -v "$AUDIO_VOLUME":/src:ro postgres:16-alpine sh -c 'cd /src && find . -type f | sort | while IFS= read -r f; do printf "%s\t%s\t%s\n" "$(sha256sum "$f" | cut -d" " -f1)" "$(stat -c %s "$f")" "$f"; done' > "$TMP/storage-files.tsv"
storage_files_json="$(jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {sha256: .[0], bytes: (.[1] | tonumber), path: (.[2] | ltrimstr("./"))})' "$TMP/storage-files.tsv")"

echo "== settings and keys (values are not printed)"
umask 077
{
    for key in ENCRYPTION_KEY BETTER_AUTH_SECRET API_TOKEN_HASH_SECRET; do
        value="$(env_of "$APP" "$key")"
        # Only the optional API_TOKEN_HASH_SECRET can be empty here (checked above); it is left out of the file.
        if [ -n "$value" ]; then echo "$key=$value"; fi
    done
} > "$TMP/secrets.env"

# The App's allow-list is the single source in desktop/src/main/user-env.ts.
ALLOWLIST="$(sed -n '/USER_ENV_ALLOWLIST/,/\]);/p' "$(dirname "$0")/../desktop/src/main/user-env.ts" | grep -o '"[A-Z0-9_]*"' | tr -d '"')" || ALLOWLIST=""
[ -n "$ALLOWLIST" ] || die "could not read the settings allow-list from desktop/src/main/user-env.ts"
{
    while IFS= read -r key; do
        [ -n "$key" ] || continue
        value="$(env_of "$APP" "$key")"
        if [ -n "$value" ]; then echo "$key=$value"; fi
    done <<< "$ALLOWLIST"
} > "$TMP/config.env"

echo "== encryption check (one sample, encrypted with the source key by the app's own image)"
# The sample is encrypted in a one-off container from the app's image, so the key never leaves Docker's env file (0600)
# and the cipher is the one the app uses (aes-256-gcm, iv:tag:ciphertext in hex). Only the ciphertext and the sha256 of
# the plaintext are stored; the App decrypts the sample with the imported key to prove the key matches the data.
ENC_PLAIN="oah-desktop-export-check"
ENC_ENV="$TMP/enc.env"
# Both values go through the env file: the image's `node` is Bun, which does not pass `-e` arguments through argv.
{
    echo "ENCRYPTION_KEY=$(env_of "$APP" ENCRYPTION_KEY)"
    echo "ENC_PLAIN=$ENC_PLAIN"
} > "$ENC_ENV"
ENC_CIPHER="$(docker run --rm --env-file "$ENC_ENV" --entrypoint node "$(docker inspect "$APP" --format '{{.Config.Image}}')" -e '
const { createCipheriv, randomBytes } = require("node:crypto");
const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
const iv = randomBytes(16);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const body = Buffer.concat([cipher.update(process.env.ENC_PLAIN, "utf8"), cipher.final()]);
process.stdout.write(`${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`);
')"
rm -f "$ENC_ENV"
[ -n "$ENC_CIPHER" ] || die "the encryption check could not be made"
ENC_SHA="$(printf '%s' "$ENC_PLAIN" | sha256_of)"

echo "== manifest"
counts_json="{"
first=1
for table in $(psql_db "select table_name from information_schema.tables where table_schema = 'public' order by table_name"); do
    n="$(psql_db "select count(*) from \"$table\"")"
    if [ "$first" -eq 0 ]; then counts_json+=","; fi
    counts_json+="\"$table\":$n"
    first=0
done
counts_json+="}"

migrations_json="$(psql_db "select coalesce(json_agg(hash order by id), '[]'::json) from drizzle.__drizzle_migrations")" \
    || die "could not read the applied migrations"
# A missing api_credentials table is recorded as "none"; any other failure stops the export.
has_api_credentials="$(psql_db "select to_regclass('public.api_credentials') is not null")" \
    || die "could not check for the API credentials table"
if [ "$has_api_credentials" = "t" ]; then
    api_digest="$(psql_db "select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from api_credentials t")" \
        || die "could not compute the API credential digest"
else
    api_digest="none"
fi

file_entry() {
    local path="$1" bytes
    bytes="$(wc -c < "$path" | tr -d ' ')"
    jq -n --arg sha "$(sha256_of "$path")" --argjson bytes "$bytes" \
        '{sha256: $sha, bytes: $bytes}'
}

jq -n \
    --arg project "$PROJECT" \
    --arg exported "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg image "$(docker inspect "$APP" --format '{{.Config.Image}}')" \
    --arg revision "$(docker inspect "$APP" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" \
    --argjson counts "$counts_json" \
    --argjson migrations "$migrations_json" \
    --arg apiDigest "$api_digest" \
    --argjson storageFiles "$storage_files_json" \
    --argjson encryptionCheck "$(jq -n --arg c "$ENC_CIPHER" --arg s "$ENC_SHA" '{ciphertext: $c, plaintextSha256: $s}')" \
    --argjson db "$(file_entry "$TMP/db.dump")" \
    --argjson storage "$(file_entry "$TMP/storage.tar")" \
    --argjson pipeline "$(file_entry "$TMP/pipeline-data.tar")" \
    --argjson secrets "$(file_entry "$TMP/secrets.env")" \
    --argjson config "$(file_entry "$TMP/config.env")" \
    '{
        format: "openaudiohub-desktop-export",
        version: 2,
        exportedAt: $exported,
        sourceProject: $project,
        sourceImage: $image,
        sourceRevision: $revision,
        migrations: {count: ($migrations | length), hashes: $migrations},
        counts: $counts,
        apiCredentialsDigest: $apiDigest,
        storageFiles: $storageFiles,
        encryptionCheck: $encryptionCheck,
        files: {
            "db.dump": $db,
            "storage.tar": $storage,
            "pipeline-data.tar": $pipeline,
            "secrets.env": $secrets,
            "config.env": $config
        }
    }' > "$TMP/manifest.json"
chmod 600 "$TMP/manifest.json"

# Move the finished files in one step, so a partial export never looks complete.
for file in db.dump storage.tar pipeline-data.tar secrets.env config.env manifest.json; do
    mv "$TMP/$file" "$OUT/$file"
done
echo "export written to $OUT"
echo "files: $(jq -r '.files | keys | join(", ")' "$OUT/manifest.json")"
echo "tables counted: $(jq -r '.counts | length' "$OUT/manifest.json")"
