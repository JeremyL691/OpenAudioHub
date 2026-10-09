#!/usr/bin/env python3
"""Long-audio flow for the Docker smoke stack.

Stages, run in order by `all` or one at a time:
  audio   synthesize a 12-minute recording: six 100 s speech blocks (macOS `say`)
          separated by 20 s of silence, encoded as AAC in .m4a
  setup   create a test user, enable auto-summary, and register the fake AI server
          as the transcription and summary provider
  run     upload the recording, queue transcription, poll the pipeline, and restart
          the audio-pipeline container once it is part-way through
  verify  check the job, the transcript timeline, the auto-summary, the audio range
          response, and the detail page in headless Chromium

Stdlib only, plus the repo's @playwright/test for the browser check. Everything is
written under .dev-artifacts/ (gitignored). Passwords, API keys, cookies and the
env file are never printed. Run with the stack up on 127.0.0.1:3100 and the fake AI
server on 127.0.0.1:3299 (see docker-smoke.sh for the stack).
"""

import argparse
import http.cookiejar
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / ".dev-artifacts"
SMOKE = ART / "smoke"
LOGS = ART / "logs"
BASE = os.environ.get("OAH_SMOKE_BASE_URL", "http://localhost:3100")
COMPOSE_FILE = ROOT / "scripts/dev/docker-smoke.compose.yml"
ENV_FILE = ART / "oah-e2e.env"
COMPOSE = [
    "docker", "compose", "-p", "oah-e2e",
    "-f", str(COMPOSE_FILE), "--env-file", str(ENV_FILE),
]
CREDS_FILE = SMOKE / "credentials.json"
AUDIO_FILE = SMOKE / "long-recording.m4a"
RUN_FILE = SMOKE / "run.json"
VERIFY_FILE = SMOKE / "verify.json"
DETAIL_SHOT = SMOKE / "detail.png"
PROGRESS_LOG = LOGS / "T7-4-progress.jsonl"
PIPELINE_LOG = LOGS / "T7-4-pipeline.log"
PROVIDER_BASE_URL = os.environ.get(
    "OAH_SMOKE_PROVIDER_URL", "http://host.docker.internal:3299/v1"
)

BLOCK_SECONDS = 100
SILENCE_SECONDS = 20
BLOCKS = 6
EXPECTED_SECONDS = BLOCKS * (BLOCK_SECONDS + SILENCE_SECONDS)  # 720
RUN_TIMEOUT_S = 40 * 60
TERMINAL = {"completed", "needs_alignment", "failed", "cancelled"}
RESTART_WINDOW = (0.2, 0.95)
# Start offsets of the four segments the fake provider returns for each chunk (E2E fixture).
FAKE_SEGMENT_OFFSETS = (0, 4, 9, 15)

SENTENCES = [
    "The weekly sync starts with the roadmap review for the audio pipeline.",
    "Priya reports that long recordings now split cleanly at natural pauses.",
    "Each chunk is transcribed on its own, then merged into one timeline.",
    "Silence between speakers is removed before the provider sees the audio.",
    "The team agreed to review the timeline output on Friday afternoon.",
    "Marcus raised a concern about retries when the sidecar restarts mid job.",
    "Restarts should resume from the last finished chunk instead of starting over.",
    "Summaries run only after the transcript is committed, never before.",
    "The export path uses the same timeline as the detail page, so they match.",
    "Playback follows the active segment, and clicking a line seeks the audio.",
    "Budget for the provider calls is tracked per user, with a rate limit.",
    "Action item: confirm the storage budget before the next release train.",
    "Lena will write the migration note and link it from the changelog draft.",
    "The fake provider returns fixed segments, so timing checks use offsets only.",
    "Any gap longer than the threshold becomes a boundary between two chunks.",
    "We keep the job state in the sidecar store so a restart can pick it up.",
    "Two open questions remain about the default preset for meeting notes.",
    "Next we look at the first load budget for the overview and library pages.",
    "The detail page keeps the transcript next to the player at wide widths.",
    "On phones the transcript sits below the player, and the mini bar stays.",
    "The compose file publishes the app only on the loopback interface.",
    "Database volumes are left alone unless the operator runs down with volumes.",
    "Thanks everyone, that closes the sync, and the notes go out this evening.",
    "We will reconvene next week to check the restart results and the timings.",
]


def log(stage: str, message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {stage}: {message}", flush=True)


def require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        sys.exit(f"missing tool: {name}")
    return path


def ffprobe_seconds(path: Path) -> float:
    out = subprocess.run(
        [require_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def stage_audio() -> None:
    say = require_tool("say")
    ffmpeg = require_tool("ffmpeg")
    SMOKE.mkdir(parents=True, exist_ok=True)
    work = SMOKE / "audio-parts"
    work.mkdir(exist_ok=True)

    parts: list[Path] = []
    for index in range(BLOCKS):
        # Rotate the sentences so each block reads differently.
        rotated = SENTENCES[index * 3:] + SENTENCES[:index * 3]
        aiff = work / f"block-{index}.aiff"
        wav = work / f"block-{index}.wav"
        subprocess.run([say, "-o", str(aiff), " ".join(rotated)], check=True)
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(aiff),
             "-af", "apad", "-t", str(BLOCK_SECONDS),
             "-ar", "16000", "-ac", "1", str(wav)],
            check=True,
        )
        parts.append(wav)
        silence = work / f"silence-{index}.wav"
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi",
             "-i", "anullsrc=r=16000:cl=mono", "-t", str(SILENCE_SECONDS), str(silence)],
            check=True,
        )
        parts.append(silence)

    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c:a", "aac", "-b:a", "64k", str(AUDIO_FILE)],
        check=True, cwd=work,
    )
    seconds = ffprobe_seconds(AUDIO_FILE)
    log("audio", f"{AUDIO_FILE.name}: {seconds:.1f} s (expected {EXPECTED_SECONDS} s), "
                 f"{AUDIO_FILE.stat().st_size / 1_000_000:.1f} MB")
    if abs(seconds - EXPECTED_SECONDS) > 1.0:
        sys.exit("audio duration is off by more than 1 s")


def make_opener():
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return opener, jar


def call(opener, method: str, path: str, body=None, raw: bytes | None = None,
         headers: dict | None = None, expect: tuple[int, ...] = (200,)):
    data = raw
    hdrs = {"Origin": BASE, **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=hdrs)
    try:
        with opener.open(req, timeout=600) as resp:
            status, payload = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, payload = err.code, err.read()
    if status not in expect:
        snippet = payload[:200].decode("utf-8", "replace")
        sys.exit(f"{method} {path} -> {status}: {snippet}")
    return status, payload


def load_creds() -> dict:
    return json.loads(CREDS_FILE.read_text(encoding="utf-8"))


def signed_in():
    creds = load_creds()
    opener, jar = make_opener()
    call(opener, "POST", "/api/auth/sign-in/email",
         body={"email": creds["email"], "password": creds["password"]})
    return opener, jar


def session_cookie(jar) -> tuple[str, str]:
    for cookie in jar:
        if "session_token" in cookie.name:
            return cookie.name, cookie.value
    sys.exit("no session cookie after sign-in")


def stage_setup() -> None:
    SMOKE.mkdir(parents=True, exist_ok=True)
    if CREDS_FILE.exists():
        creds = load_creds()
    else:
        # Test values for the local smoke stack only. Stored with mode 600, never printed.
        creds = {
            "email": f"smoke-{uuid.uuid4().hex[:10]}@example.test",
            "password": secrets.token_urlsafe(24),
            "name": "Smoke Test",
            "providerKey": secrets.token_urlsafe(16),
        }
        CREDS_FILE.write_text(json.dumps(creds), encoding="utf-8")
        os.chmod(CREDS_FILE, 0o600)
    opener, _ = make_opener()
    call(opener, "POST", "/api/auth/sign-up/email",
         body={"name": creds["name"], "email": creds["email"], "password": creds["password"]},
         expect=(200, 201, 400, 422))  # already exists on a re-run
    opener, jar = signed_in()
    log("setup", "signed in as the smoke user (credentials not printed)")
    # The smoke user skips the onboarding UI; the detail route redirects until it is done.
    call(opener, "PUT", "/api/settings/user",
         body={"autoSummarize": True, "autoSummarizePreset": "meeting-notes",
               "onboardingCompleted": True})
    _, raw = call(opener, "GET", "/api/settings/ai/providers")
    existing = json.loads(raw)
    shape = sorted(existing) if isinstance(existing, dict) else "list"
    log("setup", f"existing providers response shape: {shape}")
    rows = existing.get("providers") if isinstance(existing, dict) else existing
    if rows:
        log("setup", "a provider is already registered, skipping")
        return
    call(opener, "POST", "/api/settings/ai/providers", body={
        "provider": "OpenAI",
        "apiKey": creds["providerKey"],
        "baseUrl": PROVIDER_BASE_URL,
        "defaultModel": "fake-whisper-1",
        "isDefaultTranscription": True,
        "isDefaultEnhancement": True,
    }, expect=(200, 201))
    log("setup", f"registered the fake provider at {PROVIDER_BASE_URL}")


def multipart(field: str, filename: str, content_type: str, data: bytes):
    boundary = uuid.uuid4().hex
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n").encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    return boundary, head + data + tail


def pipeline_container_id() -> str:
    cid = subprocess.run(COMPOSE + ["ps", "-q", "audio-pipeline"],
                         capture_output=True, text=True, check=True).stdout.strip()
    if not cid:
        sys.exit("audio-pipeline container not found")
    project = subprocess.run(
        ["docker", "inspect", "-f", '{{index .Config.Labels "com.docker.compose.project"}}', cid],
        capture_output=True, text=True, check=True).stdout.strip()
    if project != "oah-e2e":
        sys.exit(f"refusing to restart a container from project {project!r}")
    return cid


def normalize_progress(value) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    return value / 100 if value > 1.5 else float(value)


def stage_run() -> None:
    opener, _ = signed_in()
    data = AUDIO_FILE.read_bytes()
    boundary, body = multipart("file", AUDIO_FILE.name, "audio/mp4", data)
    _, raw = call(opener, "POST", "/api/recordings/upload", raw=body,
                  headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    uploaded = json.loads(raw)
    _, raw = call(opener, "GET", "/api/recordings")
    matches = [r for r in json.loads(raw)["recordings"]
               if r.get("filename") == uploaded.get("filename")]
    if not matches:
        sys.exit("uploaded recording not found in the list")
    recording = max(matches, key=lambda r: str(r.get("createdAt") or ""))
    rid = recording["id"]
    log("run", f"uploaded {AUDIO_FILE.name} as recording {rid} ({len(data)} bytes)")

    status, raw = call(opener, "POST", f"/api/recordings/{rid}/transcribe", body={},
                       expect=(200, 202))
    queued = json.loads(raw)
    log("run", f"transcribe -> {status}, keys {sorted(queued)}")

    PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_LOG.write_text("", encoding="utf-8")
    started = time.monotonic()
    restart: dict | None = None
    trail: list[dict] = []
    while True:
        elapsed = time.monotonic() - started
        if elapsed > RUN_TIMEOUT_S:
            sys.exit("timed out waiting for the pipeline job")
        _, raw = call(opener, "GET", f"/api/recordings/{rid}/audio-pipeline")
        job = json.loads(raw).get("job") or {}
        status = job.get("status")
        progress = normalize_progress(job.get("progress"))
        point = {"t": round(elapsed, 1), "status": status, "phase": job.get("phase"),
                 "progress": progress, "restarted": restart is not None}
        trail.append(point)
        with PROGRESS_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(point) + "\n")
        if status in TERMINAL:
            break
        if (restart is None and progress is not None
                and RESTART_WINDOW[0] <= progress <= RESTART_WINDOW[1]):
            cid = pipeline_container_id()
            t0 = time.monotonic()
            subprocess.run(["docker", "restart", cid], check=True, capture_output=True)
            restart = {"container": cid[:12], "progress_before": progress,
                       "at_seconds": round(elapsed, 1),
                       "restart_seconds": round(time.monotonic() - t0, 1)}
            log("run", f"restarted the audio-pipeline container at progress {progress:.2f}")
        time.sleep(1)

    statuses = sorted({p["status"] for p in trail if p["status"]})
    log("run", f"final status {status} after {round(time.monotonic() - started, 1)} s; "
               f"statuses seen {statuses}")
    PIPELINE_LOG.write_text(
        subprocess.run(COMPOSE + ["logs", "--no-color", "audio-pipeline"],
                       capture_output=True, text=True).stdout, encoding="utf-8")
    RUN_FILE.write_text(json.dumps({
        "recordingId": rid,
        "finalStatus": status,
        "statusesSeen": statuses,
        "restart": restart,
        "elapsedSeconds": round(time.monotonic() - started, 1),
        "firstProgressAfterRestart": next(
            (p["progress"] for p in trail if p["restarted"]), None),
        "maxProgressBeforeRestart": max(
            (p["progress"] or 0 for p in trail if not p["restarted"]), default=None),
    }, indent=2), encoding="utf-8")


def stage_verify() -> None:
    run = json.loads(RUN_FILE.read_text(encoding="utf-8"))
    rid = run["recordingId"]
    opener, jar = signed_in()
    checks: dict[str, bool] = {}
    notes: dict[str, object] = {}

    _, raw = call(opener, "GET", f"/api/recordings/{rid}/audio-pipeline")
    body = json.loads(raw)
    job = body.get("job") or {}
    checks["pipeline completed"] = job.get("status") == "completed"
    timeline = body.get("timeline") or []
    starts = [seg["start_ms"] for seg in timeline]
    ends = [seg["end_ms"] for seg in timeline]
    checks["timeline not empty"] = len(timeline) > 0
    checks["timeline starts non-decreasing"] = starts == sorted(starts)
    checks["no duplicate segment starts"] = len(set(starts)) == len(starts)
    # The fake provider returns the same four segments per chunk, so each speech block
    # should give one chunk anchored at its start. Anchors are every fourth start.
    block_starts = [i * (BLOCK_SECONDS + SILENCE_SECONDS) * 1000 for i in range(BLOCKS)]
    anchors = starts[::len(FAKE_SEGMENT_OFFSETS)]
    checks["one chunk per speech block"] = (
        len(timeline) == len(FAKE_SEGMENT_OFFSETS) * BLOCKS
        and len(anchors) == BLOCKS
        and all(abs(a - b) <= 3000 for a, b in zip(anchors, block_starts)))
    checks["timeline ends are valid"] = all(
        seg["end_ms"] > seg["start_ms"] and seg["end_ms"] <= EXPECTED_SECONDS * 1000 + 1000
        for seg in timeline)
    checks["timeline covers the second half"] = any(s >= EXPECTED_SECONDS * 1000 / 2 for s in starts)
    notes["chunkAnchorsMs"] = anchors
    notes["segments"] = len(timeline)
    notes["lastEndMs"] = max(ends) if ends else None
    notes["timestampSource"] = body.get("timestampSource")

    checks["restart happened"] = run["restart"] is not None
    if run["restart"] is not None and run["maxProgressBeforeRestart"] is not None:
        first = run["firstProgressAfterRestart"]
        checks["resumed without losing progress"] = (
            first is not None and first >= run["restart"]["progress_before"] - 0.05)
        notes["progressBeforeRestart"] = run["restart"]["progress_before"]
        notes["firstProgressAfterRestart"] = first

    _, raw = call(opener, "GET", f"/api/recordings/{rid}/summary")
    summary = json.loads(raw).get("summary")
    checks["auto-summary present"] = summary is not None
    checks["auto-summary is the fixture summary"] = (
        summary is not None and "roadmap" in json.dumps(summary))

    range_status, range_total = audio_range_total(opener, rid)
    checks["audio range returns 206 with the full size"] = (
        range_status == 206 and range_total == AUDIO_FILE.stat().st_size)
    notes["audioRangeStatus"] = range_status

    name, value = session_cookie(jar)
    detail = ART / "smoke" / "detail.json"
    proc = subprocess.run(
        ["node", str(ROOT / "scripts/dev/docker-smoke-detail.mjs")],
        cwd=ROOT, capture_output=True, text=True,
        env={**os.environ, "SMOKE_BASE_URL": BASE, "SMOKE_RECORDING_ID": rid,
             "SMOKE_COOKIE_NAME": name, "SMOKE_COOKIE_VALUE": value,
             "SMOKE_OUT": str(detail), "SMOKE_SHOT": str(DETAIL_SHOT)},
    )
    checks["detail page plays and seeks"] = proc.returncode == 0
    detail_json = json.loads(detail.read_text(encoding="utf-8")) if detail.exists() else {}
    if detail_json:
        notes["detail"] = detail_json
    checks["detail page has no sideways overflow at 1280 px"] = detail_json.get("overflowPx", 1) <= 0
    checks["Analyzing audio label clears"] = detail_json.get("analyzingCleared") is True
    if proc.returncode != 0:
        notes["detailStderr"] = proc.stderr[-800:]

    ok = all(checks.values())
    for name_, passed in checks.items():
        log("verify", f"{'PASS' if passed else 'FAIL'}  {name_}")
    VERIFY_FILE.write_text(json.dumps({"ok": ok, "checks": checks, "notes": notes},
                                      indent=2, ensure_ascii=False), encoding="utf-8")
    if not ok:
        sys.exit(1)


def audio_range_total(opener, rid: str) -> tuple[int, int | None]:
    req = urllib.request.Request(
        BASE + f"/api/recordings/{rid}/audio",
        headers={"Origin": BASE, "Range": "bytes=0-1023"})
    with opener.open(req, timeout=120) as resp:
        status = resp.status
        content_range = resp.headers.get("Content-Range", "")
    total = int(content_range.rsplit("/", 1)[1]) if "/" in content_range else None
    return status, total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("stage", choices=["audio", "setup", "run", "verify", "all"])
    args = parser.parse_args()
    LOGS.mkdir(parents=True, exist_ok=True)
    stages = ["audio", "setup", "run", "verify"] if args.stage == "all" else [args.stage]
    for stage in stages:
        {"audio": stage_audio, "setup": stage_setup,
         "run": stage_run, "verify": stage_verify}[stage]()


if __name__ == "__main__":
    main()
