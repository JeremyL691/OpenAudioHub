#!/usr/bin/env bash
# Migrate an existing Riffado stack into an OpenAudioHub deployment (PLAN §6 P8, T8.2).
#
#   1. preflight (read-only): the old database is healthy and no pipeline job is still active
#      (waits up to WAIT_JOBS_SECONDS, then exits). A combined run also needs the old app healthy.
#      An export-only run needs the old app stopped, so nothing can write during the export.
#   2. export: pg_dump -Fc of the old database; each old volume is tarred through a read-only mount
#   3. manifest: sha256 of every artifact, row counts, the old-side facts used by validation, and
#      file count and bytes per volume
#   4. restore into the target project: build, database first (pg_restore --no-owner), then the
#      volumes (refused unless empty), then app (runs its migrations) and audio-pipeline
#   5. validation: counts equal, source values migrated, api key hashes equal, encrypted fields
#      decrypt, sampled audio sha256 equal, health endpoints answer. Validation reads the saved
#      old-side facts, so it still works after the old stack has stopped.
#
# Modes:
#   (default)            preflight, export, restore, validate (rehearsal)
#   --export-only        preflight (old app stopped), export, manifest; then exit
#   --restore-from DIR   restore and validate from the artifacts of an earlier --export-only run
#   --dry-run            read-only preflight, then print the plan
#
# The old stack is only read: no writes to its database, its volumes, or its containers. The target
# is a separate Compose project (default openaudiohub-rehearsal, port from its env file).
#
# Usage:
#   scripts/migrate-from-riffado.sh --dry-run --out DIR
#   scripts/migrate-from-riffado.sh --export-only --out DIR
#   scripts/migrate-from-riffado.sh --restore-from DIR [--target-project NAME] [--target-env FILE] [--target-dir DIR]
#   scripts/migrate-from-riffado.sh --out DIR [--target-project NAME] [--target-env FILE] [--target-dir DIR]
#
# Environment overrides: OLD_DB_CONTAINER, OLD_APP_CONTAINER, OLD_DB_NAME, OLD_APP_HEALTH,
# HELPER_IMAGE, WAIT_JOBS_SECONDS. Secrets are read from the target env file and never printed.
set -euo pipefail

OLD_DB_CONTAINER="${OLD_DB_CONTAINER:-riffado-db}"
OLD_APP_CONTAINER="${OLD_APP_CONTAINER:-riffado-app}"
OLD_DB_NAME="${OLD_DB_NAME:-riffado}"
OLD_APP_HEALTH="${OLD_APP_HEALTH:-http://localhost:3000/api/health}"
OLD_VOLUMES=(riffado_audio riffado_storage riffado_audio-pipeline-data)
VOLUME_SUFFIXES=(audio storage audio-pipeline-data)
HELPER_IMAGE="${HELPER_IMAGE:-postgres:16-alpine}"
WAIT_JOBS_SECONDS="${WAIT_JOBS_SECONDS:-600}"
TARGET_DIR="${TARGET_DIR:-$HOME/Desktop/Projects/OpenAudioHub}"
TARGET_PROJECT="${TARGET_PROJECT:-openaudiohub-rehearsal}"
TARGET_ENV="${TARGET_ENV:-}"
TARGET_DB_NAME="openaudiohub"
OUT=""
RESTORE_FROM=""
DRY_RUN=0
EXPORT_ONLY=0
TERMINAL_JOB_STATES="'completed','failed','cancelled','needs_alignment','superseded'"

usage() {
    echo "usage: $0 [--dry-run | --export-only] --out DIR" >&2
    echo "       $0 --restore-from DIR [--target-project NAME] [--target-env FILE] [--target-dir DIR]" >&2
    echo "       $0 --out DIR [--target-project NAME] [--target-env FILE] [--target-dir DIR]" >&2
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --export-only) EXPORT_ONLY=1; shift ;;
        --out) OUT="${2:-}"; shift 2 ;;
        --restore-from) RESTORE_FROM="${2:-}"; shift 2 ;;
        --target-project) TARGET_PROJECT="${2:-}"; shift 2 ;;
        --target-env) TARGET_ENV="${2:-}"; shift 2 ;;
        --target-dir) TARGET_DIR="${2:-}"; shift 2 ;;
        -h|--help) usage ;;
        *) usage ;;
    esac
done
if [[ -n "$RESTORE_FROM" ]]; then
    OUT="$RESTORE_FROM"
fi
[[ -n "$OUT" ]] || usage
[[ -n "$TARGET_ENV" ]] || TARGET_ENV="$TARGET_DIR/.env.rehearsal"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

target_compose() {
    docker compose --project-directory "$TARGET_DIR" --env-file "$TARGET_ENV" \
        -p "$TARGET_PROJECT" -f "$TARGET_DIR/docker-compose.yml" "$@"
}

old_psql() {
    docker exec -i "$OLD_DB_CONTAINER" psql -U postgres -d "$OLD_DB_NAME" -At -F '|' "$@"
}

target_psql() {
    target_compose exec -T db psql -U postgres -d "$TARGET_DB_NAME" -At -F '|' "$@"
}

# ---------------------------------------------------------------- preflight (read-only)
preflight() {
    log "preflight: docker"
    docker info >/dev/null 2>&1 || die "Docker is not running"

    log "preflight: old database (read-only inspect)"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$OLD_DB_CONTAINER" 2>/dev/null || echo missing)"
    [[ "$health" == "healthy" ]] || die "$OLD_DB_CONTAINER is not healthy (state: $health)"

    if (( EXPORT_ONLY )); then
        log "preflight: old app must be stopped for a quiescent export"
        running="$(docker inspect -f '{{.State.Running}}' "$OLD_APP_CONTAINER" 2>/dev/null || echo missing)"
        [[ "$running" == "false" ]] || die "$OLD_APP_CONTAINER must be stopped before --export-only (running: $running)"
    else
        log "preflight: old app (read-only inspect and GET)"
        health="$(docker inspect -f '{{.State.Health.Status}}' "$OLD_APP_CONTAINER" 2>/dev/null || echo missing)"
        [[ "$health" == "healthy" ]] || die "$OLD_APP_CONTAINER is not healthy (state: $health)"
        curl -fsS -o /dev/null "$OLD_APP_HEALTH" || die "old app health check failed at $OLD_APP_HEALTH"
    fi

    log "preflight: waiting for active pipeline jobs to finish (limit ${WAIT_JOBS_SECONDS}s)"
    waited=0
    while :; do
        active="$(old_psql -c "select count(*) from audio_pipeline_jobs where status not in (${TERMINAL_JOB_STATES})")"
        if [[ "$active" == "0" ]]; then
            log "preflight: no active pipeline jobs"
            break
        fi
        if (( waited >= WAIT_JOBS_SECONDS )); then
            die "$active pipeline job(s) still active after ${WAIT_JOBS_SECONDS}s; not exporting a moving database"
        fi
        sleep 10
        waited=$((waited + 10))
    done
}

# ---------------------------------------------------------------- counts
COUNT_TABLES=(users recordings transcriptions ai_enhancements api_keys webhook_endpoints plaud_connections)

count_query() {
    local sql="" t
    for t in "${COUNT_TABLES[@]}"; do
        sql+="select '$t', count(*) from $t union all "
    done
    echo "${sql% union all }"
}

# ---------------------------------------------------------------- dry run
if (( DRY_RUN )); then
    preflight
    log "dry run: planned steps (no writes)"
    cat <<PLAN
  1. docker exec $OLD_DB_CONTAINER pg_dump -Fc -U postgres -d $OLD_DB_NAME > $OUT/riffado.dump
  2. for each of ${OLD_VOLUMES[*]}: docker run --rm -v <volume>:/src:ro $HELPER_IMAGE tar -C /src -cf $OUT/<volume>.tar .
  3. sha256 manifest, row counts and old-side facts written to $OUT
  4. target project $TARGET_PROJECT in $TARGET_DIR (env $TARGET_ENV):
       compose build app audio-pipeline; compose up --no-start; compose up -d --wait db
       pg_restore --no-owner into $TARGET_DB_NAME (refused if the database already has tables)
       unpack volumes (refused if a target volume is not empty)
       compose up -d --wait app audio-pipeline
  5. validation report: $OUT/validation.txt
PLAN
    exit 0
fi

# ---------------------------------------------------------------- export, or reuse saved artifacts
if [[ -z "$RESTORE_FROM" ]]; then
    mkdir -p "$OUT"
    OUT="$(cd "$OUT" && pwd -P)"
    preflight

    log "export: pg_dump -Fc of $OLD_DB_NAME (read-only)"
    docker exec "$OLD_DB_CONTAINER" pg_dump -Fc -U postgres -d "$OLD_DB_NAME" > "$OUT/riffado.dump"
    [[ -s "$OUT/riffado.dump" ]] || die "pg_dump produced an empty file"

    for volume in "${OLD_VOLUMES[@]}"; do
        docker volume inspect "$volume" >/dev/null 2>&1 || die "volume $volume not found"
        log "export: tar of volume $volume through a read-only mount"
        docker run --rm -v "$volume:/src:ro" -v "$OUT:/out" "$HELPER_IMAGE" \
            tar -C /src -cf "/out/$volume.tar" .
    done

    log "export: row counts and old-side facts"
    old_psql -c "$(count_query)" > "$OUT/counts-old.txt"
    old_riffado="$(old_psql -c "select count(*) from transcriptions where source='riffado'")"
    old_keys="$(old_psql -c "select encode(sha256(convert_to(coalesce(string_agg(key_hash, ',' order by key_hash), ''), 'UTF8')), 'hex') from api_keys")"
    printf 'source_riffado=%s\napi_keys_digest=%s\n' "$old_riffado" "$old_keys" > "$OUT/old-facts.txt"

    log "manifest: sha256 of every artifact, file count and bytes per volume"
    python3 - "$OUT" "${OLD_VOLUMES[@]}" <<'PYEOF'
import hashlib, json, pathlib, sys, tarfile
out = pathlib.Path(sys.argv[1])
volumes = sys.argv[2:]
manifest = {}
for path in sorted(out.glob("*")):
    if path.is_file() and path.name != "manifest.sha256":
        manifest[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
stats = {}
for volume in volumes:
    with tarfile.open(out / f"{volume}.tar") as archive:
        members = [m for m in archive.getmembers() if m.isfile()]
        stats[volume] = {"files": len(members), "bytes": sum(m.size for m in members)}
(out / "manifest.sha256").write_text(
    "".join(f"{digest}  {name}\n" for name, digest in manifest.items()), encoding="utf-8")
(out / "volume-stats-old.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")
print(json.dumps(stats, indent=2))
PYEOF
    cat "$OUT/counts-old.txt"

    if (( EXPORT_ONLY )); then
        log "export-only: artifacts written to $OUT; restore later with --restore-from"
        exit 0
    fi
else
    OUT="$(cd "$OUT" && pwd -P)"
    for artifact in riffado.dump counts-old.txt old-facts.txt manifest.sha256; do
        [[ -f "$OUT/$artifact" ]] || die "missing $artifact in $OUT"
    done
    for volume in "${OLD_VOLUMES[@]}"; do
        [[ -f "$OUT/$volume.tar" ]] || die "missing $volume.tar in $OUT"
    done
    log "restore-from: reusing the artifacts in $OUT"
fi

# ---------------------------------------------------------------- restore
[[ -f "$TARGET_DIR/docker-compose.yml" ]] || die "no compose file at $TARGET_DIR"
[[ -f "$TARGET_ENV" ]] || die "no env file at $TARGET_ENV"

log "restore: build target images"
target_compose build app audio-pipeline
log "restore: create target volumes and containers (not started)"
target_compose up --no-start
log "restore: database first"
target_compose up -d --wait db
tables="$(target_psql -c "select count(*) from information_schema.tables where table_schema='public'")"
[[ "$tables" == "0" ]] || die "target database already has $tables table(s); refusing to restore over it"
target_compose exec -T db pg_restore --no-owner --no-privileges -U postgres -d "$TARGET_DB_NAME" < "$OUT/riffado.dump"

log "restore: volumes (each must be empty)"
for i in "${!OLD_VOLUMES[@]}"; do
    volume="${TARGET_PROJECT}_${VOLUME_SUFFIXES[$i]}"
    docker run --rm -v "$volume:/dst" "$HELPER_IMAGE" sh -c 'test -z "$(ls -A /dst)"' \
        || die "target volume $volume is not empty"
    docker run --rm -v "$volume:/dst" -v "$OUT:/in:ro" "$HELPER_IMAGE" \
        tar -C /dst -xf "/in/${OLD_VOLUMES[$i]}.tar"
done

log "restore: app (runs its migrations) and audio-pipeline"
target_compose up -d --wait app audio-pipeline

# ---------------------------------------------------------------- validation
VALIDATION="$OUT/validation.txt"
: > "$VALIDATION"
failures=0
check() {
    local name="$1" ok="$2" detail="$3"
    if [[ "$ok" == "1" ]]; then
        printf 'PASS  %s  %s\n' "$name" "$detail" | tee -a "$VALIDATION"
    else
        printf 'FAIL  %s  %s\n' "$name" "$detail" | tee -a "$VALIDATION"
        failures=$((failures + 1))
    fi
}

old_fact() {
    grep -m1 "^$1=" "$OUT/old-facts.txt" | cut -d= -f2-
}

target_psql -c "$(count_query)" > "$OUT/counts-new.txt"
counts_equal=1
while IFS= read -r line; do
    if ! grep -qx "$line" "$OUT/counts-new.txt"; then counts_equal=0; fi
done < "$OUT/counts-old.txt"
check "row counts equal" "$counts_equal" "$(paste -sd' ' "$OUT/counts-old.txt")"

old_riffado="$(old_fact source_riffado)"
new_riffado="$(target_psql -c "select count(*) from transcriptions where source='riffado'")"
new_openaudiohub="$(target_psql -c "select count(*) from transcriptions where source='openaudiohub'")"
check "source values migrated (0041)" "$([[ "$new_riffado" == "0" && "$new_openaudiohub" == "$old_riffado" ]] && echo 1 || echo 0)" \
    "riffado remaining=$new_riffado, openaudiohub=$new_openaudiohub (old riffado=$old_riffado)"

old_keys="$(old_fact api_keys_digest)"
new_keys="$(target_psql -c "select encode(sha256(convert_to(coalesce(string_agg(key_hash, ',' order by key_hash), ''), 'UTF8')), 'hex') from api_keys")"
check "api key hashes identical" "$([[ "$old_keys" == "$new_keys" ]] && echo 1 || echo 0)" \
    "set digest ${new_keys:0:16}…"

ENC_KEY="$(grep -m1 '^ENCRYPTION_KEY=' "$TARGET_ENV" | cut -d= -f2-)"
target_psql -c "select 'filename', filename from recordings where filename like 'v1:%' limit 20; select 'text', text from transcriptions where text like 'v1:%' limit 20; select 'api_key', api_key from api_credentials where api_key like 'v1:%' limit 20" > "$OUT/encrypted-sample.txt"
decrypt_result="$(ENCRYPTION_KEY="$ENC_KEY" node -e '
const { createDecipheriv } = require("node:crypto");
const fs = require("node:fs");
const key = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
let ok = 0, bad = 0;
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  const parts = line.split("|");
  if (parts.length < 2 || !parts[1].startsWith("v1:")) continue;
  const [iv, tag, data] = parts[1].slice(3).split(":");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    d.update(data, "hex", "utf8"); d.final("utf8");
    ok++;
  } catch { bad++; }
}
console.log(ok + " " + bad);
' "$OUT/encrypted-sample.txt")"
dec_ok="${decrypt_result%% *}"
dec_bad="${decrypt_result##* }"
check "encrypted fields decrypt" "$([[ "$dec_ok" -gt 0 && "$dec_bad" == "0" ]] && echo 1 || echo 0)" \
    "decrypted=$dec_ok failed=$dec_bad"

sample_list="$(python3 - "$OUT" "${OLD_VOLUMES[0]}" <<'PYEOF'
import random, sys, tarfile
out, volume = sys.argv[1], sys.argv[2]
with tarfile.open(f"{out}/{volume}.tar") as archive:
    names = [m.name for m in archive.getmembers() if m.isfile()]
random.seed(20261008)
print("\n".join(random.sample(names, min(10, len(names)))))
PYEOF
)"
sample_ok=1
checked=0
while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    old_sum="$(docker run --rm -v "${OLD_VOLUMES[0]}:/src:ro" "$HELPER_IMAGE" sha256sum "/src/$rel" | cut -d' ' -f1)" || old_sum=""
    new_sum="$(docker run --rm -v "${TARGET_PROJECT}_${VOLUME_SUFFIXES[0]}:/src:ro" "$HELPER_IMAGE" sha256sum "/src/$rel" | cut -d' ' -f1)" || new_sum=""
    checked=$((checked + 1))
    [[ -n "$old_sum" && "$old_sum" == "$new_sum" ]] || sample_ok=0
done <<< "$sample_list"
check "sampled audio sha256 equal" "$([[ "$checked" -gt 0 ]] && echo "$sample_ok" || echo 0)" "checked=$checked"

api_status="$(target_compose exec -T app bun -e "fetch('http://localhost:3000/api/health').then((r) => console.log(r.ok ? 'ok' : 'fail'), () => console.log('fail'))" 2>/dev/null || echo fail)"
check "app health" "$([[ "$api_status" == "ok" ]] && echo 1 || echo 0)" "/api/health inside the app container"
pipe_status="$(target_compose exec -T audio-pipeline python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health', timeout=5); print('ok')" 2>/dev/null || echo fail)"
check "pipeline health" "$([[ "$pipe_status" == "ok" ]] && echo 1 || echo 0)" "/health inside the pipeline container"

log "validation written to $VALIDATION (failures: $failures)"
(( failures == 0 )) || exit 1

# The launcher refuses to start a project that sits beside a Riffado install until this marker
# exists, so a first start cannot come up on an empty database by accident.
MARKER="$TARGET_DIR/.migrated-$TARGET_PROJECT"
printf 'migrated_at=%s\nartifacts=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OUT" > "$MARKER"
log "marker written to $MARKER"
