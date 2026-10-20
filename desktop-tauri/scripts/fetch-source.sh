#!/usr/bin/env bash
# Downloads one pinned source archive and verifies its checksum.
#
# Sourced by scripts/build-ffmpeg.sh, and tested on its own by tools/check/fetch-source.sh so a
# failing download is reported as a download and not as a checksum mismatch.
#
#   fetch_source <url> <sha256> <downloads dir>
#
# Prints the path of the verified archive. Exits non-zero when the archive could not be
# downloaded or does not match, and leaves no partial file behind in either case.

# Connection timeout, in seconds. A host that accepts the connection and then stalls is what
# a plain --retry loops on, so the transfer has a deadline too.
FETCH_CONNECT_TIMEOUT="${FETCH_CONNECT_TIMEOUT:-20}"
FETCH_TRANSFER_TIMEOUT="${FETCH_TRANSFER_TIMEOUT:-180}"
FETCH_ATTEMPTS="${FETCH_ATTEMPTS:-3}"
FETCH_RETRY_DELAY="${FETCH_RETRY_DELAY:-5}"

fetch_source() { # <url> <sha256> <downloads dir>
    local url="$1" sha="$2" dir="$3"
    local name file partial attempt
    name="$(basename "$url")"
    file="$dir/$name"
    partial="$dir/$name.partial"
    mkdir -p "$dir"

    if [ -f "$file" ] && [ "$(shasum -a 256 "$file" | cut -d' ' -f1)" = "$sha" ]; then
        printf '%s\n' "$file"
        return 0
    fi

    attempt=1
    while :; do
        rm -f "$partial"
        if curl -fsSL \
            --connect-timeout "$FETCH_CONNECT_TIMEOUT" \
            --max-time "$FETCH_TRANSFER_TIMEOUT" \
            -o "$partial" "$url"; then
            if [ "$(shasum -a 256 "$partial" | cut -d' ' -f1)" = "$sha" ]; then
                mv "$partial" "$file"
                printf '%s\n' "$file"
                return 0
            fi
            # A complete transfer of the wrong bytes is not a transient failure: the pinned
            # checksum and the host disagree, and retrying cannot fix that.
            rm -f "$partial"
            printf 'checksum mismatch for %s: %s does not match the pinned %s\n' \
                "$name" "$url" "$sha" >&2
            rm -f "$file"
            return 1
        fi
        rm -f "$partial"
        if [ "$attempt" -ge "$FETCH_ATTEMPTS" ]; then
            printf 'download failed for %s after %s attempts: %s\n' \
                "$name" "$attempt" "$url" >&2
            return 1
        fi
        printf 'download attempt %s of %s failed for %s; retrying in %ss\n' \
            "$attempt" "$FETCH_ATTEMPTS" "$name" "$FETCH_RETRY_DELAY" >&2
        attempt=$((attempt + 1))
        sleep "$FETCH_RETRY_DELAY"
    done
}
