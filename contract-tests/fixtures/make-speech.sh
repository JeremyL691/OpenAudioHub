#!/usr/bin/env bash
# Builds a long speech recording for the audio pipeline tests.
#   make-speech.sh <output> [sentences]
# Speech comes from espeak-ng so the file has no licence attached to it, and the
# silence between sentences makes the speech detection produce several runs.
# The audio is longer than the 120 s target chunk length, so a run has to be cut
# into more than one chunk, which is what the timestamp checks need.
set -euo pipefail

out="$1"
sentences="${2:-15}"
# The caller may name a folder that does not exist yet.
mkdir -p "$(dirname "$out")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ffmpeg -v error -y -f lavfi -i anullsrc=r=22050:cl=mono -t 2 "$tmp/silence.wav"
: > "$tmp/list.txt"
i=0
while [ "$i" -lt "$sentences" ]; do
  espeak-ng -v en-us -s 145 -w "$tmp/$i.wav" \
    "Recording number $i. OpenAudioHub turns a long recording into a transcript. The server decodes the audio, finds the speech, and sends each part to the provider."
  printf "file '%s'\nfile '%s'\n" "$tmp/$i.wav" "$tmp/silence.wav" >> "$tmp/list.txt"
  i=$((i + 1))
done
ffmpeg -v error -y -f concat -safe 0 -i "$tmp/list.txt" -ar 22050 -ac 1 "$out"
