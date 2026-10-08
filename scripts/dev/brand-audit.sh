#!/usr/bin/env bash
# Fails when the legacy brand name appears outside the allowlist.
#
# Searches tracked and untracked text for riffado, openplaud, perier, and
# riffado.com. Hits are allowed only where the legacy identifier is kept on
# purpose: compatibility code, historical migrations, and the migration guide.
# Each exception below names its reason. See docs/dev/DECISIONS.md (D-126).

set -euo pipefail

cd "$(dirname "$0")/../.."

PATTERN='riffado|openplaud|perier|riffado\.com'

# Line of the first "## [Unreleased]" heading in CHANGELOG.md. The intro above
# it may name the upstream project.
changelog_intro_end=$(grep -n '^## \[Unreleased\]' CHANGELOG.md | head -n 1 | cut -d: -f1)

# Lines in the "## Attribution" section of README.md, as "start end".
readme_attribution=$(awk '
    /^## Attribution/ { start = NR; inside = 1; next }
    inside && /^## / { print start, NR - 1; found = 1; exit }
    END { if (inside && !found) print start, NR }
' README.md)

allowed() {
    local file=$1 line=$2 text=$3

    # The migration guide's file name is fixed by the plan, so any link to it is allowed.
    if [[ $text == *MIGRATION_FROM_RIFFADO.md* ]]; then
        return 0
    fi

    case "$file" in
        # This script has to name the pattern it searches for.
        scripts/dev/brand-audit.sh) return 0 ;;
        # Dev logs and planning documents are not published.
        docs/dev/*) return 0 ;;
        # Attribution and the migration guide.
        LICENSE | NOTICE | docs/MIGRATION_FROM_RIFFADO.md) return 0 ;;
        # Email render snapshots record the footer's attribution line, which is
        # BRAND.attribution from src/lib/brand/legacy.ts (the AGPL notice).
        src/tests/email/__snapshots__/templates.render.test.tsx.snap) return 0 ;;
        # Compatibility code: legacy names are read here, and written nowhere else.
        src/lib/brand/legacy.ts) return 0 ;;
        # Compatibility tests. Each one exercises a legacy value or header on purpose.
        src/tests/brand.test.ts | src/tests/transcription/source.test.ts) return 0 ;;
        src/tests/db/migration-smoke.integration.test.ts | src/tests/webhook-headers.test.ts) return 0 ;;
        audio-pipeline/tests/test_store_migration.py | audio-pipeline/tests/test_pipeline_api.py) return 0 ;;
        # Historical migrations are immutable, as are their snapshots (D-004).
        src/db/migrations/00[0-3][0-9]_* | src/db/migrations/0040_*) return 0 ;;
        src/db/migrations/meta/00[0-3][0-9]_snapshot.json | src/db/migrations/meta/0040_snapshot.json) return 0 ;;
        # The source rebrand migration and its snapshot.
        src/db/migrations/0041_rebrand_source_values.sql | src/db/migrations/meta/0041_snapshot.json) return 0 ;;
        # Rollback for migration 0041. It is not wired into the migrator.
        scripts/rollback/rebrand-source-values.down.sql) return 0 ;;
        # The migration tool names the old containers, volumes and source values it reads,
        # and it never writes them (D-162).
        scripts/migrate-from-riffado.sh) return 0 ;;
    esac

    case "$file" in
        CHANGELOG.md)
            # The intro names the upstream project. Entries below it do not.
            if [ -n "$changelog_intro_end" ] && [ "$line" -lt "$changelog_intro_end" ]; then
                return 0
            fi
            ;;
        README.md)
            local start end
            read -r start end <<< "$readme_attribution"
            if [ "$line" -ge "$start" ] && [ "$line" -le "$end" ]; then
                return 0
            fi
            ;;
        # The schema default stays at the legacy value until B-002 is resolved,
        # because changing it needs a migration whose snapshot is still in
        # dispute. Remove this exception with the B-002 fix.
        src/db/schema.ts)
            if [[ $text == *'default("riffado")'* ]]; then
                return 0
            fi
            ;;
        # Pipeline startup migration and request alias. Both read the legacy field.
        audio-pipeline/src/audio_pipeline/store.py | audio-pipeline/src/audio_pipeline/app.py)
            if [[ $text == *riffado_job_id* || $text == *_rename_legacy_job_column* ]]; then
                return 0
            fi
            ;;
    esac

    return 1
}

hits=$(rg --no-heading --line-number --ignore-case --color never \
    --glob '!**/node_modules/**' \
    --glob '!**/.git/**' \
    --glob '!**/.venv/**' \
    --glob '!**/.next/**' \
    --glob '!**/.source/**' \
    --glob '!**/.dev-artifacts/**' \
    --glob '!pnpm-lock.yaml' \
    --glob '!uv.lock' \
    -e "$PATTERN" . || true)

violations=0
while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    file=${hit%%:*}
    file=${file#./}
    rest=${hit#*:}
    line=${rest%%:*}
    text=${rest#*:}
    if allowed "$file" "$line" "$text"; then
        continue
    fi
    printf '%s:%s: %s\n' "$file" "$line" "$text"
    violations=$((violations + 1))
done <<< "$hits"

if [ "$violations" -gt 0 ]; then
    echo "brand-audit: $violations disallowed hit(s). Rename them, or add a documented exception here." >&2
    exit 1
fi

echo "brand-audit: no disallowed hits."
