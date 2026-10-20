#!/usr/bin/env bash
# Tests scripts/fetch-source.sh against a local server, so the download path is exercised
# without touching the network or the real ffmpeg build.
#
# The cases are the failures that turned into a misleading "sha256 mismatch" in CI:
# a transfer that never starts, a host that answers with an error, a stall, and a good
# download whose bytes are not the ones that were pinned.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../desktop-tauri/scripts/fetch-source.sh
. "$HERE/desktop-tauri/scripts/fetch-source.sh"

# A short retry budget keeps the failure cases quick.
export FETCH_ATTEMPTS=2
export FETCH_RETRY_DELAY=0
export FETCH_CONNECT_TIMEOUT=3
export FETCH_TRANSFER_TIMEOUT=5

work="$(mktemp -d)"
server_pid=""
cleanup() {
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

failures=0
ok() { printf 'ok: %s\n' "$1"; }
no() {
    printf 'FAIL: %s\n' "$1" >&2
    failures=$((failures + 1))
}

# Every assertion goes through one of these, so a false result is a reported failure rather
# than the end of the script under `set -e`.
holds() { # <description> <command...>
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then ok "$desc"; else no "$desc"; fi
}

no_partial() { # <description> <dir>
    if find "$2" -name '*.partial' -print -quit 2>/dev/null | grep -q .; then
        no "$1"
    else
        ok "$1"
    fi
}

# A payload with a known digest, and a different digest to pin against it.
payload="$work/payload.tar.gz"
printf 'pinned source archive\n' > "$payload"
good_sha="$(shasum -a 256 "$payload" | cut -d' ' -f1)"
wrong_sha="$(printf 'another archive\n' | shasum -a 256 | cut -d' ' -f1)"

# A local server that serves the payload at /good.tar.gz, wrong bytes at /wrong.tar.gz, a stall
# at /stall.tar.gz, and an error anywhere else.
port="$(( 34571 + RANDOM % 1000 ))"
python3 - "$payload" "$port" <<'PY' &
import http.server, socketserver, sys, time

payload, port = sys.argv[1], int(sys.argv[2])
good = open(payload, "rb").read()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.endswith("/good.tar.gz"):
            self.send_response(200)
            self.send_header("Content-Length", str(len(good)))
            self.end_headers()
            self.wfile.write(good)
        elif self.path.endswith("/wrong.tar.gz"):
            body = b"not the pinned archive\n"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.endswith("/stall.tar.gz"):
            time.sleep(30)
        else:
            self.send_response(500)
            self.end_headers()

socketserver.ThreadingTCPServer.allow_reuse_address = True
# The stall case holds its connection open. A threading server keeps every other case
# answerable, so one case cannot make another fail.
with socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler) as httpd:
    httpd.daemon_threads = True
    httpd.serve_forever()
PY
server_pid=$!

for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$port/good.tar.gz" && break
    sleep 0.25
done

base="http://127.0.0.1:$port"

# 1. A good download is verified and kept.
if fetch_source "$base/good.tar.gz" "$good_sha" "$work/dl-good" >/dev/null 2>"$work/err1"; then
    ok "a matching archive downloads"
else
    no "a matching archive downloads"
fi
holds "a matching archive is kept" test -f "$work/dl-good/good.tar.gz"
no_partial "no partial file is left after success" "$work/dl-good"

# 2. A cached, verified archive is reused without asking the server.
if fetch_source "$base/good.tar.gz" "$good_sha" "$work/dl-good" >/dev/null 2>&1; then
    ok "a verified cached archive is reused"
else
    no "a verified cached archive is reused"
fi

# 3. Wrong bytes are a checksum failure, not a download failure.
if fetch_source "$base/wrong.tar.gz" "$good_sha" "$work/dl-wrong" >/dev/null 2>"$work/err3"; then
    no "wrong bytes fail"
else
    ok "wrong bytes fail"
fi
holds "wrong bytes are reported as a checksum mismatch" grep -q "checksum mismatch" "$work/err3"
holds "wrong bytes are not kept" test ! -f "$work/dl-wrong/wrong.tar.gz"
no_partial "wrong bytes leave no partial file" "$work/dl-wrong"

# 4. A server error is reported as a download failure, not as a checksum mismatch.
if fetch_source "$base/missing.tar.gz" "$good_sha" "$work/dl-err" >/dev/null 2>"$work/err4"; then
    no "a server error fails"
else
    ok "a server error fails"
fi
holds "a server error is reported as a download failure" grep -q "download failed" "$work/err4"
if grep -q "checksum mismatch" "$work/err4"; then
    no "a server error is not reported as a checksum mismatch"
else
    ok "a server error is not reported as a checksum mismatch"
fi
no_partial "a server error leaves no partial file" "$work/dl-err"

# 5. A host that never answers fails within the deadline instead of hanging.
start=$SECONDS
if fetch_source "$base/stall.tar.gz" "$good_sha" "$work/dl-stall" >/dev/null 2>"$work/err5"; then
    no "a stalled transfer fails"
else
    ok "a stalled transfer fails"
fi
elapsed=$((SECONDS - start))
holds "a stalled transfer fails within the deadline (${elapsed}s)" test "$elapsed" -lt 40
holds "a stalled transfer is reported as a download failure" grep -q "download failed" "$work/err5"

# 6. A host that cannot be reached at all fails, and says so.
dead_port="$(( port + 1 ))"
if fetch_source "http://127.0.0.1:$dead_port/x.tar.gz" "$good_sha" "$work/dl-dead" >/dev/null 2>"$work/err6"; then
    no "an unreachable host fails"
else
    ok "an unreachable host fails"
fi
holds "an unreachable host is reported as a download failure" grep -q "download failed" "$work/err6"

# 7. A cached file that no longer matches its pin is replaced, not trusted.
printf 'tampered\n' > "$work/dl-good/good.tar.gz"
if fetch_source "$base/good.tar.gz" "$good_sha" "$work/dl-good" >/dev/null 2>&1; then
    ok "a tampered cached archive is downloaded again"
else
    no "a tampered cached archive is downloaded again"
fi
holds "the tampered archive is replaced by the pinned bytes" \
    test "$(shasum -a 256 "$work/dl-good/good.tar.gz" | cut -d' ' -f1)" = "$good_sha"

# 8. A pinned digest that can never match is reported as a checksum mismatch.
if fetch_source "$base/good.tar.gz" "$wrong_sha" "$work/dl-pin" >/dev/null 2>"$work/err8"; then
    no "a digest that cannot match fails"
else
    ok "a digest that cannot match fails"
fi
holds "a digest that cannot match is reported as a checksum mismatch" grep -q "checksum mismatch" "$work/err8"

if [ "$failures" -ne 0 ]; then
    printf '\n%s check(s) failed\n' "$failures" >&2
    exit 1
fi
printf '\nfetch-source: every case behaved as expected\n'
