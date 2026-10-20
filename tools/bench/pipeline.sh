#!/usr/bin/env bash
# Measures the long-recording pipeline on this machine.
#   tools/bench/pipeline.sh [hours ...]      default: 1 6
#
# For each length it builds a speech recording, runs it through the pipeline against a
# local provider that answers instantly, and reports the wall time of each phase, the peak
# memory of the server process and the disk the work folder needed. The numbers describe
# this machine only; run it before and after a change to compare.
#
# Everything stays in .dev-artifacts/ on test ports. It never touches the app's data.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${OAH_BENCH_PORT:-3290}"
FAKE_PORT="${OAH_BENCH_FAKE_PORT:-3291}"
if [ "$#" -eq 0 ]; then
  set -- 1 6
fi

artifact="$ROOT/.dev-artifacts/bench"
mkdir -p "$artifact"
data="$artifact/data"
rm -rf "$data"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }; }
need ffmpeg
need espeak-ng
need curl
need openssl

echo "Building the server..."
(cd "$ROOT" && cargo build -q --bin oah-server)
pids=()
cleanup() { for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

node "$ROOT/contract-tests/fakes/fake-ai.mjs" "$FAKE_PORT" >/dev/null 2>&1 &
pids+=($!)

ENCRYPTION_KEY="$(openssl rand -hex 32)" OAH_DATA_DIR="$data" PORT="$PORT" HOST=127.0.0.1 \
  APP_URL="http://127.0.0.1:$PORT" RATE_LIMIT_TRUST_PROXY_HEADERS=true \
  WEBHOOKS_REQUIRE_PUBLIC_TARGETS=false AUDIO_PIPELINE_ENABLED=true OAH_WEB_DIR="$artifact/web" \
  "$ROOT/target/debug/oah-server" >"$artifact/server.log" 2>&1 &
server=$!
pids+=($server)

base="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do curl -sf -o /dev/null "$base/api/health" && break; sleep 0.5; done
curl -sf -o /dev/null "$base/api/health" || { echo "server did not start" >&2; exit 1; }

# One account, configured to use the local provider.
email="bench-$(date +%s)@openaudiohub.test"
password="bench-password-1"
jar="$artifact/cookies.txt"
rm -f "$jar"
api() { curl -sS -b "$jar" -c "$jar" -H "origin: $base" -H "content-type: application/json" "$@"; }
# Uploads send their own multipart content type, so they cannot go through `api`.
upload() { curl -sS -b "$jar" -c "$jar" -H "origin: $base" "$@"; }
api -X POST "$base/api/auth/sign-up/email" \
  -d "{\"name\":\"Bench\",\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
api -X PUT "$base/api/settings/user" -d '{"onboardingCompleted":true}' >/dev/null
api -X POST "$base/api/settings/ai/providers" -d "{
  \"provider\":\"Custom\",\"apiKey\":\"bench\",\"baseUrl\":\"http://127.0.0.1:$FAKE_PORT/v1\",
  \"defaultModel\":\"fake-whisper-1\",\"isDefaultTranscription\":true,\"isDefaultEnhancement\":true}" >/dev/null

peak_rss() {
  # Peak resident memory of the server, in megabytes.
  if [ -r "/proc/$1/status" ]; then
    awk '/VmHWM/ {print int($2/1024)}' "/proc/$1/status"
  else
    ps -o rss= -p "$1" | awk '{print int($1/1024)}'
  fi
}

field() { python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('job') or {}).get('$1') or '')"; }

printf '| Length | Decode and speech detection | Transcribe and merge | Total | Peak memory | Work folder |\n'
printf '|---|---|---|---|---|---|\n'

for hours in "$@"; do
  # Opus at 16 kHz keeps even 24 hours well under the 500 MB upload limit.
  wav="$artifact/speech-${hours}h.opus"
  if [ ! -f "$wav" ]; then
    echo "Building a ${hours} h recording..." >&2
    base_clip="$artifact/base.wav"
    if [ ! -f "$base_clip" ]; then
      # About four minutes of speech with pauses, so the speech detection has real input.
      tmp="$(mktemp -d)"
      ffmpeg -v error -y -f lavfi -i anullsrc=r=22050:cl=mono -t 2 "$tmp/silence.wav"
      : > "$tmp/list.txt"
      for i in $(seq 0 14); do
        espeak-ng -v en-us -s 145 -w "$tmp/$i.wav" \
          "Recording number $i. The benchmark measures how long a long recording takes. The server decodes the audio, finds the speech, and sends each part to the provider."
        printf "file '%s'\nfile '%s'\n" "$tmp/$i.wav" "$tmp/silence.wav" >> "$tmp/list.txt"
      done
      ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -ar 22050 -ac 1 "$base_clip"
      rm -rf "$tmp"
    fi
    # The same speech, repeated until the requested length is reached.
    ffmpeg -v error -y -stream_loop -1 -i "$base_clip" -t "$((hours * 3600))" \
      -ac 1 -ar 16000 -c:a libopus -b:a 24k "$wav"
  fi

  title="bench-${hours}h-$(date +%s)"
  upload -X POST "$base/api/recordings/upload" -F "file=@$wav;filename=$title.opus" >/dev/null
  id=$(api "$base/api/recordings" |
    python3 -c "import json,sys; print([r['id'] for r in json.load(sys.stdin)['recordings'] if r['filename']=='$title'][0])")

  work="$data/storage/.pipeline"
  rm -rf "$work"
  start=$(date +%s)
  api -X POST "$base/api/recordings/$id/transcribe" >/dev/null
  decode_done=""
  status=""
  peak_disk=0
  while :; do
    state=$(api "$base/api/recordings/$id/audio-pipeline")
    status=$(printf '%s' "$state" | field status)
    phase=$(printf '%s' "$state" | field phase)
    now=$(date +%s)
    if [ -z "$decode_done" ] && [ "$phase" = "transcribing" ]; then decode_done=$((now - start)); fi
    # Sampled while the run works: the folder is removed when the job finishes.
    current=$(du -sk "$work" 2>/dev/null | awk '{print int($1/1024)}' || echo 0)
    [ "${current:-0}" -gt "$peak_disk" ] && peak_disk=${current:-0}
    case "$status" in
      completed|needs_alignment) break ;;
      failed|cancelled) echo "job ended $status" >&2; break ;;
    esac
    sleep 1
  done
  total=$(( $(date +%s) - start ))
  decode=${decode_done:-$total}
  transcribe=$((total - decode))
  memory=$(peak_rss "$server")
  disk=$peak_disk
  printf '| %s h | %s s | %s s | %s s | %s MB | %s MB |\n' \
    "$hours" "$decode" "$transcribe" "$total" "$memory" "${disk:-0}"
  api -X DELETE "$base/api/recordings/$id" >/dev/null || true
done

echo
echo "Server log: $artifact/server.log"
