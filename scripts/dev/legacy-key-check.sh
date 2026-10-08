#!/usr/bin/env bash
# Checks that a legacy `op_` API key authenticates on a migrated instance (PLAN §12.5).
#
# A user's real key cannot be read here, and the source database held no legacy key
# rows at export time. So the check mints its own legacy-shaped key and hashes it inside
# the app container with that instance's function (HMAC-SHA256 keyed by
# API_TOKEN_HASH_SECRET, falling back to BETTER_AUTH_SECRET, as in src/lib/auth-request.ts).
# It stores the hash for a temporary test account, then calls the API over HTTP. The
# secret stays inside the container, and the key is never printed.
#
# Usage: legacy-key-check.sh <base-url> <app-container> <db-container>
# Accepts localhost base URLs only. Exits non-zero at the first unexpected status.
set -euo pipefail

BASE="${1:?usage: legacy-key-check.sh <base-url> <app-container> <db-container>}"
APP="${2:?app container name}"
DB="${3:?db container name}"

case "$BASE" in
    http://localhost:*|http://127.0.0.1:*) ;;
    *)
        echo "refusing a non-localhost base URL" >&2
        exit 2
        ;;
esac

STAMP="$(date +%s)"
EMAIL="op-check-${STAMP}@example.test"
PASSWORD="$(openssl rand -hex 16)"
ROW_ID="op-check-${STAMP}"

# Legacy keys are `op_` followed by a nanoid-style body (A-Za-z0-9_-) and no checksum.
new_legacy_key() {
    printf 'op_%s' "$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n' | cut -c1-32)"
}

# SQL on stdin, against the database of the instance under test.
db_sql() {
    docker exec -i "$DB" sh -c 'psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

status_of() {
    curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" "$BASE/api/v1/recordings"
}

KEY="$(new_legacy_key)"
WRONG="$(new_legacy_key)"

# 1. A temporary account, created through the app itself.
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/sign-up/email" \
    -H 'content-type: application/json' -H "origin: $BASE" \
    --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Legacy key check\"}")"
echo "sign-up -> $CODE"
[ "$CODE" = "200" ] || exit 1

USER_ID="$(printf "select id from users where email = '%s';" "$EMAIL" | db_sql)"
[ -n "$USER_ID" ] || {
    echo "temporary account not found"
    exit 1
}

# 2. The hash, computed inside the app container with that instance's secret.
HASH="$(printf '%s' "$KEY" | docker exec -i "$APP" node -e '
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
    const { createHmac } = require("node:crypto");
    const secret = process.env.API_TOKEN_HASH_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!secret) process.exit(3);
    process.stdout.write(createHmac("sha256", secret).update(input).digest("hex"));
});
')"
[ "${#HASH}" = "64" ] || {
    echo "hash computation failed"
    exit 1
}

# 3. The api_keys row a legacy key carries (key_prefix = first 12 characters).
PREFIX="${KEY:0:12}"
db_sql <<SQL
insert into api_keys (id, user_id, name, key_hash, key_prefix, source, scopes)
values ('$ROW_ID', '$USER_ID', 'Legacy key check', '$HASH', '$PREFIX', 'manual', '["read"]');
SQL
echo "legacy key row stored: $ROW_ID"

# 4. The legacy key authenticates.
CODE="$(status_of "$KEY")"
echo "legacy op_ key on /api/v1/recordings -> $CODE"
[ "$CODE" = "200" ] || exit 1

# 5. A key the instance never issued is refused.
CODE="$(status_of "$WRONG")"
echo "unknown op_ key on /api/v1/recordings -> $CODE"
[ "$CODE" = "401" ] || exit 1

# 6. Revocation applies to legacy keys as well.
db_sql <<SQL
update api_keys set revoked_at = now() where id = '$ROW_ID';
SQL
CODE="$(status_of "$KEY")"
echo "revoked legacy op_ key -> $CODE"
[ "$CODE" = "401" ] || exit 1

# 7. Remove the temporary account and its key row.
db_sql <<SQL
delete from api_keys where id = '$ROW_ID';
delete from users where id = '$USER_ID';
SQL
LEFT="$(printf "select count(*) from users where id = '%s';" "$USER_ID" | db_sql)"
echo "temporary account rows left: $LEFT"
[ "$LEFT" = "0" ] || exit 1
echo "legacy op_ key check: PASS"
