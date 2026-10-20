# Audio pipeline

This file describes how a transcription job for a long recording runs inside the
server: source access, decoding, speech detection, chunk planning, chunk
transcription with retries, merging, saving, cancel and retry, and the routes that
report and change a job.

The pipeline is part of the server process. It has no separate service and no
internal HTTP interface.

Related files: `transcription.md` (transcription requests and provider list),
`workers.md` (background queue and automatic transcription), `recordings.md`
(recording audio), `settings.md` (transcription settings), `deployment.md`
(environment variables), `ai.md` (provider configuration and summaries).

---

## 1. Modes and configuration

| Setting | Default | Meaning |
|---------|---------|---------|
| `AUDIO_PIPELINE_ENABLED` | `true` | `true`, `1`, `yes`, `on` enable the pipeline; `false`, `0`, `no`, `off` disable it. Any other value stops startup. |
| `FFMPEG_PATH` | `ffmpeg` | Decoder executable. |
| `FFPROBE_PATH` | `ffprobe` | Probe executable, used for the duration. |
| `LOCAL_STORAGE_PATH` | `<data dir>/storage` | Recording storage root. Work files are kept under `.pipeline/` in this folder. |
| `WHISPER_REQUEST_TIMEOUT_MS` | `3600000` | Timeout of one provider request, in milliseconds (shared with the synchronous path). |

- With the pipeline enabled, every transcription run (manual or automatic) becomes a
  pipeline job.
- With the pipeline disabled, a run is transcribed in the request (manual) or in the
  transcription worker (automatic) without chunking. The status route then reports
  no job for any recording.
- Speech detection uses a Silero VAD v5 model built into the server binary. It runs
  with ONNX Runtime and one intra-op thread. There is no setting for the model.

---

## 2. Fixed limits

| Item | Value |
|------|-------|
| Working format | 16 000 Hz, mono, signed 16-bit little-endian (32 000 bytes per second) |
| Maximum recording length | 24 hours = 86 400 000 ms |
| Maximum decoded samples | 1 382 400 320 (checked as "more than") |
| Speech detection frame | 512 samples = 32 ms |
| Speech detection context | 64 samples before each frame |
| Speech detection block | 1024 frames; a checkpoint is written after each block |
| Speech detection sections | at least 300 s each (9375 frames); at most 16 sections |
| Target chunk length | 120 s (1 920 000 samples) |
| Lower cut bound | 78 s (1 248 000 samples) |
| Maximum chunk length | 170 s (2 720 000 samples) |
| Maximum chunk WAV size | 50 MiB (52 428 800 bytes); a 170 s chunk is 5 440 044 bytes |
| Gap that separates runs | 1.5 s (24 000 samples) |
| Timestamp guard after a run | 50 ms (800 samples) |
| Speech padding around each span | 250 ms (4000 samples) |
| Timestamp overshoot accepted | up to 50 ms |
| Pipeline jobs at once | 1 per server process |
| Chunk requests at once | 2 per job |
| Attempts per chunk per run | 6 |
| Claims per job (queue) | 3 |
| Job lease | 120 s, renewed every 40 s |
| Disk reserve for decoding | 64 MiB above the PCM size |
| Disk reserve to resume a paused decode | 512 MiB above the PCM size |
| Disk re-check interval while paused | 30 s |
| Stored error text | first 1000 characters |

---

## 3. Starting a job

### 3.1 Manual run

`POST /api/recordings/{id}/transcribe` (see `transcription.md`). With the pipeline
enabled, the request:

1. Finds the recording. A missing, deleted or other user's recording gives
   `404 RECORDING_NOT_FOUND`.
2. Resolves the transcription provider (the requested one, else the user's default).
   If none is available, it gives `400 NO_TRANSCRIPTION_PROVIDER` and creates no job.
3. Refuses a recording whose stored duration is over 24 hours with
   `413 TRANSCRIPTION_FAILED`, message `Recordings over 24 hours cannot be transcribed`.
4. Cancels the recording's queued or running pipeline job and deletes its work folder
   (section 13.3). A job whose transcript was already saved keeps its result and is
   recorded as done.
5. Creates the new pipeline job and answers `202 { "jobId": "<id>", "status": "queued" }`.

Concurrent identical manual requests for the same recording and provider share one run.

### 3.2 Automatic run

When automatic transcription is on (`autoTranscribe`) and a recording is added by an
upload or a Plaud sync, a `transcribe` job is queued (see `workers.md`). When that job
runs, it:

- does nothing if the recording still exists and already has a transcript;
- otherwise creates the pipeline job (no cancel step) and finishes.

For an automatic run, a recording that already has an active pipeline job gets that job back
instead of a second one.

### 3.3 Job payload

A pipeline job stores:

| Field | Value |
|-------|-------|
| `providerId` | The provider chosen when the job was created. |
| `model` | The model chosen for that provider (the request's model, or the provider's default). |
| `language` | The `defaultTranscriptionLanguage` setting when the job was created, or null. |
| `trigger` | `manual` or `auto`. |

Speaker settings (`speakerDiarization`, `diarizationSpeakerCount`) are not stored in the
payload. The worker reads them from the user's effective settings when the job runs, the
same way a synchronous run does (section 10.3).

### 3.4 Provider and model at run time

- If the stored provider still exists, it is used with the stored model.
- If it was deleted, the user's current default transcription provider is used with that
  provider's default model.
- A retry clears the stored provider, so every retry uses the current default provider
  and its default model. The stored language is kept.

---

## 4. Status values

The job has a queue state and a phase. The API reports one status value, computed as
follows (first matching row wins):

| Queue state | Phase | API status |
|-------------|-------|------------|
| any | `cancelled` | `cancelled` |
| `cancelled` | any | `cancelled` |
| `failed` | any | `failed` |
| `done` | `completed` | `completed` |
| `done` | `needs_alignment` | `needs_alignment` |
| `queued` | any | `queued` |
| not `queued` | `paused_disk` | `paused_disk` |
| any other | any | `running` |

Phase values written by the pipeline: `queued`, `decode`, `vad`, `transcribing`,
`paused_disk`, `completed`, `needs_alignment`, `failed`, `cancelled`.

### 4.1 Progress

Progress is a number from 0 to 1. The value only goes up, except that a retry resets it to 0.

| Step | Progress |
|------|----------|
| Decoding starts | 0.05 |
| Speech detection starts | 0.10, then rises with each block to 0.65 |
| Chunk transcription starts | 0.68 |
| Each finished chunk | 0.68 + 0.30 × (finished chunks ÷ total chunks) |
| Job done (`completed` or `needs_alignment`) | 1.0 |

A failed job keeps the progress it had. A step that is skipped because its work already
exists (reused decoded audio or speech probabilities) sets no progress.

---

## 5. Queue, leases and queue retries

- One pipeline job runs at a time per server process. Pipeline jobs and transcription
  jobs use separate workers.
- A worker claims the oldest due job and holds a lease of 120 s, renewed every 40 s. Every
  claim gives the job a new lease generation, a counter that only grows. The phase write, the
  progress write, the disk-pause error fields, the lease renewal, the outcome write and the
  transcript save all match on that generation, so a worker that lost its lease writes
  nothing and cannot overwrite the run that replaced it. If the lease is lost, the job's
  handler is stopped and its result is discarded.
- The retry counter (`attempts`) and the lease generation are separate. An explicit retry
  resets the retry counter, so the counter repeats; the generation never does, which is why
  the generation is what identifies a claim.
- Chunk rows are shared between runs of the same job, so their writes follow the same rule as
  the transcript save: marking a chunk as sending, storing its result and recording its
  failure each apply only while the job is still running under the generation this worker
  claimed. A worker whose lease was taken over writes no chunk state, so the run that replaced
  it cannot read a result that belongs to a claim it never held. Chunk results that were fully
  stored before a takeover stay reusable (section 11).
- A job whose lease has expired (for example after a crash or restart) is claimed again.
  Stored work is reused (section 11).
- A transient failure (a database or file error, or a failed save) returns the job to
  `queued` with error code `PIPELINE_RETRY`. The next claim waits 30 s × 2^(n−1) (n is
  the claim number), capped at 1 hour, plus up to 20 % random extra.
- After the third claim, a transient failure makes the job `failed` with code
  `PIPELINE_RETRY`.
- A manual retry resets the claim counter to 0, so the retried job gets its three claims
  again (section 13.2).
- Terminal failures (section 12) are never retried by the queue.

---

## 6. Source access, duration and limits

### 6.1 Source

- The recording row must exist and not be deleted. Otherwise the job fails with
  `RECORDING_NOT_FOUND`, message `Recording is missing or deleted`.
- A local recording is read in place.
- An object-storage recording is downloaded for the run to `<storage root>/.materialized/`
  and removed when the run ends. The download checks that the file size fits the free
  space on that volume.
- A missing file fails the job with `FileNotFoundError`, message `Audio file is missing`.
  Other storage errors fail it with `STORAGE_ERROR`.

### 6.2 Duration

- The duration is the larger of the recording's stored duration and the probed duration.
  The probed duration is the container's format duration, rounded to milliseconds. A
  probe that fails counts as 0.
- If the duration is 0 or less, the job fails with `AudioError`, message
  `Unable to determine source audio duration for disk budgeting`.
- If the duration is over 86 400 000 ms, the job fails with `LimitError`, message
  `Source audio exceeds the 24-hour pipeline limit`.

---

## 7. Decoding and disk budget

### 7.1 Decoding

- Command: ffmpeg with quiet logging, no input from stdin, overwrite allowed. It reads
  the first audio stream (`0:a:0`), drops video, and writes 16 kHz mono signed 16-bit
  little-endian raw samples with no container.
- Output goes to `audio.pcm.partial` in the job's work folder and is renamed to
  `audio.pcm` when complete.
- The sample count is the file size divided by 2. An empty output is valid: the job has
  no speech and no chunks, and completes with an empty transcript.
- A decoded sample count above 1 382 400 320 fails the job with `LimitError`, message
  `Decoded audio exceeds the 24-hour pipeline limit`.
- If ffmpeg fails and free space is still enough for the decode, the job fails with
  `AudioError`, message `ffmpeg decode failed: ` followed by the trimmed error output. The
  partial file is deleted.

### 7.2 Disk budget (decoding only)

PCM bytes = ceil(duration_ms × 32 000 ÷ 1000). Free space is measured on the volume that
holds the storage root.

| Point | Requirement | When not met |
|-------|-------------|--------------|
| Before decoding | free ≥ PCM bytes + 64 MiB | pause, message `Waiting for disk space to decode the source audio` |
| Decode fails and free space is short | free < PCM bytes + 64 MiB | pause, message `Waiting for disk space to finish decoding audio` |
| While paused | free ≥ PCM bytes + 512 MiB | keep waiting; re-check every 30 s |

- A pause sets the phase `paused_disk` and error type `DiskBudgetError` with the message
  above. The job keeps its worker slot while it waits.
- A cancel is noticed within 1 second while paused.
- When space is enough, the error fields are cleared and the job continues.

---

## 8. Speech detection

### 8.1 Model and layout

- The model runs on 512-sample frames. Each frame gets one probability. Each frame is
  fed 64 samples of context before it.
- The recording is split into sections of equal length. The number of sections is the
  number of whole 300-second spans in the recording, between 1 and 16. Each section starts with
  a zero model state and zero context.
- The sections run together, one frame step at a time. Frames are processed in blocks of
  1024 per section.

### 8.2 Probability bytes

- Each probability is stored as one byte: `floor(p × 255 + 0.5)`, limited to 0 to 255.
- The probabilities are kept in `vad-probabilities.u8`, one byte per frame.

### 8.3 Checkpoints and resume

- After each block, the probabilities, model state and context are written to
  `vad-checkpoint.bin` (atomic write).
- A checkpoint is used only if its header matches the recording (sample count, section
  count and section length) and its size is exact. Otherwise the run starts at block 0.
- When speech detection finishes, the checkpoint is deleted, and two files are written:
  `vad-probabilities.u8` and `vad.complete` (text: the sample count).
- A later run reuses the probabilities when `vad.complete` holds the same sample count
  and the probability file has exactly ceil(samples ÷ 512) bytes.
- A cancel is checked after each block. The run then stops without a result.

### 8.4 Speech spans

Thresholds in bytes: start at 128 (probability 0.5); quiet below 89 (probability 0.35).

- A span starts at the first frame at or above 128 after silence.
- A span ends at the first frame below 89 that is followed by another frame below 89 at
  least 13 frames later, with no frame at or above 128 in between. The span ends at the
  first of those quiet frames.
- A span with fewer than 4 frames is dropped.
- A span still open at the end of the recording ends at the last frame.
- Each span is widened by 250 ms on both sides. The start is not below 0, and the end is
  not after the last sample. Spans that overlap or touch after widening are merged.
- Frames between 89 and 127 do not start or end a span.

---

## 9. Chunk plan

Chunks are slices of the decoded audio. Chunk audio is the exact source audio, so each
timestamp maps directly to the recording.

### 9.1 Runs

- Spans separated by 1.5 s or less form one run. A longer gap starts a new run.
- A run starts at its first span's start. It ends at its last span's end plus the 50 ms
  guard, but never after the start of the next run or the end of the recording.
- Audio outside all runs is not part of any chunk. Silence longer than 1.5 s is removed
  from the audio sent to the provider.

### 9.2 Cutting a run

Inside a run, chunks are cut from the start in order. `cursor` is where the current chunk
starts.

1. If the rest of the run is 170 s or less, the chunk runs to the end of the run.
2. Otherwise the cut lies between `lower` = cursor + 78 s and `upper` = cursor + 170 s
   (or the run end, if sooner).
3. Pause cut: among the gaps between neighboring spans inside the run whose next span
   starts between `lower` and `upper` (inclusive), choose the longest gap. A tie goes to
   the cut nearest cursor + 120 s, then to the earlier cut. The cut is at the start of the
   next span, so the pause stays in the earlier chunk.
4. Quiet cut: if there is no pause cut, choose the frame with the lowest probability
   between cursor + 120 s and `upper` (the first one on a tie). The cut is just after
   that frame.
5. Fallback: if there is no probability data, the cut is at `upper`. If a cut would not
   be after the cursor, the cut is the earlier of the run end and cursor + 170 s.

Chunks are adjacent, with no overlap and no minimum length. The last chunk of a run can
be short.

### 9.3 Identity

- Each chunk has an index counted from 0 across all runs, and a start and end sample.
- Chunk id: the first 24 hexadecimal characters of the SHA-256 of
  `<job id>:<index>:<start>:<end>:<PCM digest>`. The PCM digest is the SHA-256 of the
  chunk's raw samples.

### 9.4 Plan storage

- The plan is written once per job, when the job has no chunk rows yet.
- Later runs keep the stored rows and their positions. The plan is never recalculated for
  a job.
- A recording with no speech has no chunks. The job then completes with an empty transcript.

---

## 10. Chunk transcription

### 10.1 Send

For each chunk that is not completed, in index order, with two chunks at a time:

1. Read the chunk's samples and build a 16 kHz mono 16-bit WAV with a 44-byte header.
2. If the chunk is longer than 170 s, it is recorded as failed with `LimitError`, message
   `Chunk exceeds provider duration limit`. It is not sent.
3. If the WAV is larger than 50 MiB, it is recorded as failed with `LimitError`, message
   `Chunk exceeds provider file-size limit`. It is not sent.
4. Otherwise the WAV is written to `chunk-<5-digit index>.wav` in the work folder, and the
   chunk is sent through the same provider call as a synchronous run (section 10.3). Each
   attempt sets the chunk to `running` with its attempt number.
5. A completed chunk stores its response as JSON (`text`, `language`, `segments`) and
   state `completed`.
6. The WAV file is removed after the chunk ends, whatever its result.

A chunk's state is one of `queued`, `running`, `completed`, `failed`.

### 10.2 Retries

| Outcome of an attempt | Next step |
|-----------------------|-----------|
| Success | Stored as `completed`. |
| Network error, timeout, or an answer body that is not JSON | Retried. |
| HTTP 429 or 5xx from the provider | Retried. |
| Any other HTTP error, or an empty answer | Not retried; the chunk is `failed` with the provider's code and message. |

- A chunk gets at most 6 attempts in one run. Attempts restart at 1 on each run.
- Delay after attempt n: min(2 × 2^(n−1), 120) seconds, plus a random extra of up to
  min(1, 0.2 × delay) seconds. Delays are 2, 4, 8, 16 and 32 seconds before jitter.
- A cancel is checked before each chunk and after each retry delay.
- A failed chunk does not stop the other chunks. After all chunks have finished, any
  failed chunk fails the job (section 12).

### 10.3 Provider routing

The provider is called with the job's model and language, and with the user's speaker
settings read when the job runs. `speakerDiarization` off means no speaker labels are
requested: a diarizing model then uses the whisper-style request instead of the diarized
one. `diarizationSpeakerCount` is sent as the speaker count hint when it is set and
diarization is on; a style that has no such field ignores it. Routing depends on the
provider's style:

| Style | Request | What the pipeline gets back |
|-------|---------|-----------------------------|
| Google Gemini | Text transcription request with the WAV, 20 MB limit | Text only, no timings. The language is the job's language. |
| ElevenLabs | Speech-to-text request with word timings, speaker labels when diarization is on, and the speaker count hint when one is set. The request itself retries up to 2 times on 429, 500, 502, 503, 504 and 524, waiting 1 s and then 2 s. | Segments from word timings. With diarization on, speaker labels are `Speaker N`, numbered by first appearance in the chunk. Words without a speaker continue the previous speaker, or `Unknown speaker`. |
| Chat-based transcription | Chat request with the audio as base64 (mp3 or wav) | Text only, no timings. |
| Diarizing model (model name contains `diarize`) | Diarized JSON request, only when diarization is on; with it off the whisper-style request is used | Segments with speaker labels `Speaker N`, numbered per chunk. |
| Whisper-style (default) | Multipart request. `verbose_json` for most models, `json` for `gpt-4o` models | With `verbose_json`: text, language and segments. With `json`: text only. |

- The chunk WAV is well below the provider upload limits, so no re-encoding happens.
- Errors use the provider's code `AI_PROVIDER_API_ERROR` with these messages: `The provider
  could not be reached.` and `The provider did not answer in time.` (network and timeout),
  `The provider rejected the API key.` (401, 403), `The provider is rate limiting
  requests.` (429), and `The provider answered with HTTP <code>.` (other statuses).
  An empty answer gives `AI_EMPTY_RESPONSE`, message `The provider returned an empty
  answer.`.

### 10.4 Chunk responses

Each stored response has:

- `text`: the provider text, trimmed;
- `language`: the language reported by the provider, or null;
- `segments`: a list of `{ start, end, text, speaker }`, with `start` and `end` in seconds
  from the start of the chunk, and `speaker` a string or null.

---

## 11. Merging and timestamps

### 11.1 Text

- Chunk texts are trimmed, empty texts are skipped, and the rest are joined with a blank
  line (`\n\n`) in chunk order. The text is kept even when timestamps are missing.
- The language is the one value all chunks report. If the chunks disagree, or any has no
  language, the language is null.

### 11.2 Timestamps of one chunk

Segments with blank text are dropped first.

- If no segments remain, the chunk is valid only if its text is also blank. Otherwise the
  chunk is invalid.
- Each segment needs finite `start` and `end` values, `start` not below 0, `end` above
  `start`, and `start` not before the previous segment's `start`.
- If `end` is more than the chunk length, the overshoot must be 50 ms or less. Then the end
  is set to the chunk's real end, and the segment gets a correction. Otherwise the chunk is
  invalid.
- Absolute times in milliseconds: `start_ms` = round((chunk start + start) × 1000), and
  `end_ms` = round((chunk start + end) × 1000), except for a corrected end, which is the
  chunk's real end. The end must be after the start in whole milliseconds.
- Rounding is round-half-to-even.

If any chunk is invalid, the whole job is `needs_alignment`: the text is saved, the
timeline is not, and no timeline is estimated. A chunk that has text but no segments
(for example Gemini or chat output) therefore always gives `needs_alignment`.

### 11.3 Timeline

When all chunks are valid:

- Items from all chunks are sorted by start, then end.
- Each item has `start_ms`, `end_ms`, `text`, `timestamp_source` (`native`, or
  `normalized` when that item's end was corrected), `chunk_index`, and optionally
  `speaker_id` and `timestamp_correction`.
- `timestamp_correction` is `{ reason: "chunk_end_guard", original_end_ms, normalized_end_ms,
  chunk_index }`.
- The result's `timestamp_source` is `normalized` if any item was corrected, `native`
  otherwise, and null when there are no items.
- Speaker labels are chunk-local. `Speaker 1` in one chunk and `Speaker 1` in another are
  not matched to each other.

Chunks never overlap, so no text is removed or merged.

---

## 12. Result, completion and failures

### 12.1 Saving

On a successful merge, the server stores one transcript row:

- source `openaudiohub`, transcription type `server`, the provider's name and the model;
- text and timeline stored encrypted; the timeline is kept only when there is one, with
  its source;
- the previous `openaudiohub` transcript is replaced. If the recording had any earlier
  transcript, its summary is removed;
- the recording's `updated_at` changes;
- then the `transcription.completed` event is emitted and the after-transcript steps run
  (automatic title and summary, as set in the settings; see `ai.md` and `workers.md`).

The job then becomes `needs_alignment` (no timeline) or `completed`, its progress is 1,
and its work folder is deleted. The terminal phase is written in the same database
transaction as the transcript, so a stored transcript and the phase shown to users always
agree (section 13.1).

### 12.2 Terminal failures

A terminal failure stops the job at once. The job becomes `failed` with the error code and
message below, the phase `failed`, and the `transcription.failed` event is emitted. The work
folder is kept, so a retry can reuse it.

| Code | Message | Cause |
|------|---------|-------|
| `RECORDING_NOT_FOUND` | `Recording is missing or deleted` | Recording gone at run time. |
| `FileNotFoundError` | `Audio file is missing` | Source file missing. |
| `STORAGE_ERROR` | storage error text | Other storage failure. |
| `NO_TRANSCRIPTION_PROVIDER` | `No transcription provider is configured` | No provider at run time. |
| `AudioError` | `Unable to determine source audio duration for disk budgeting` | No usable duration. |
| `AudioError` | `ffmpeg decode failed: <stderr>` | Decoder failure. |
| `LimitError` | `Source audio exceeds the 24-hour pipeline limit` | Duration over 24 hours. |
| `LimitError` | `Decoded audio exceeds the 24-hour pipeline limit` | Decoded samples over the limit. |
| `LimitError` | `Chunk exceeds provider duration limit` | Chunk over 170 s (chunk level). |
| `LimitError` | `Chunk exceeds provider file-size limit` | Chunk WAV over 50 MiB (chunk level). |
| `ChunkFailed` | message of the first failed chunk, in index order | At least one chunk failed. |
| `ChunkFailed` | `Stored chunk result is unreadable` | A stored response cannot be read. |
| `INTERNAL_ERROR` | `Pipeline job has no recording` | Job without a recording. |

Chunk-level codes (`AI_PROVIDER_API_ERROR`, `AI_EMPTY_RESPONSE`, `LimitError`) are stored
on the chunk. The job reports them as `ChunkFailed` with the first failed chunk's message.

Errors are stored cut to 1000 characters.

---

## 13. Cancel, retry and restart

### 13.1 Cancel

`POST /api/recordings/{id}/audio-pipeline` with `{ "action": "cancel" }` is allowed when
the status is `queued`, `running` or `paused_disk`.

- A queued job becomes `cancelled` at once, and its work folder is deleted.
- A running or paused job gets phase `cancelled`. The worker notices it at its next check
  and deletes the work folder. Checks happen before each chunk send, between retries,
  after each speech-detection block, and every second while paused.
- A cancel is checked again when the transcript is saved. If it committed before the
  save, nothing is stored, the work folder is deleted, and the status is `cancelled`. If
  the save committed first, the cancel is refused with `409` and the transcript stays.
  The status then reads `running` until the worker records the outcome, and `completed`
  or `needs_alignment` after that (section 4).
- Cancelling a `failed` job is not allowed (`409`).

### 13.2 Retry

`POST ... { "action": "retry" }` is allowed only when the status is `failed`.

- The job becomes `queued` with progress 0, its error fields are cleared, and its claim
  counter is reset to 0 (section 5).
- Chunks that are not completed go back to `queued` with 0 attempts. Completed chunks are
  kept and are not sent again.
- The stored provider is cleared (section 3.4).
- Decoded audio, speech probabilities and the chunk plan are reused when they exist.

### 13.3 Restart

- Queued jobs, and running jobs whose lease has expired, are claimed again by the worker.
- Paused jobs resume when their disk space check passes.
- A job whose provider call was in progress during a crash is sent again, with its attempt
  count restarting at 1. The provider may therefore receive the same chunk twice, and bill
  for it twice.
- A forced manual run (section 3.1) cancels the superseded job and deletes its work
  folder before the new job is queued. A superseded job whose transcript was already
  saved is recorded as done instead.

---

## 14. Status and actions

### 14.1 GET /api/recordings/{id}/audio-pipeline

Auth: session. Returns `200` with:

```json
{
  "job": {
    "id": "string",
    "status": "queued",
    "phase": "transcribing",
    "progress": 0.7,
    "errorType": null,
    "error": null,
    "updatedAt": "2026-10-17T10:00:00.000Z"
  },
  "timeline": null,
  "timestampSource": null,
  "transcription": null
}
```

- `status` is one of `queued`, `running`, `paused_disk`, `completed`, `needs_alignment`,
  `failed`, `cancelled` (section 4).
- `errorType` is the error code and `error` the message, both null when there is none.
- `job` is null when the recording has no pipeline job.
- `timeline` is the stored timeline (array), or null. It is returned whenever the recording
  has a transcript, whatever the job status.
- `timestampSource` is `native`, `normalized`, or null.
- `transcription` is `{ "text", "language"?, "source": "openaudiohub" }`, or null. It is
  returned only when there is no job or the job's status is `completed` or
  `needs_alignment`. `language` is present only when known.
- A recording that is missing, deleted or belongs to another user gets `200` with all four
  fields null. No `404` is returned.

### 14.2 POST /api/recordings/{id}/audio-pipeline

Auth: session. Body: `{ "action": "retry" | "cancel" }`.

| Result | Status | Body |
|--------|--------|------|
| Retry accepted | `200` | `{ "jobId": "<id>", "status": "queued" }` |
| Cancel accepted | `200` | `{ "jobId": "<id>", "status": "cancelled" }` |
| Action other than `retry` or `cancel`, or body not JSON | `400` | `{ "error": "Invalid action" }` |
| No pipeline job for the recording | `404` | `{ "error": "Audio job not found" }` |
| Status does not allow the action | `409` | `{ "error": "Audio job cannot be changed" }`. A cancel after the transcript was saved is refused the same way. |

These responses have no `code` field. The `error` text is the only detail.

---

## 15. Not covered by tests

- The contract suite covers the status route (no job, sync transcript, other user's
  recording), the action validation, and the not-found cases. Browser tests wait for a
  pipeline job to reach `completed`.
- The pipeline contract run (`contract-tests/run.sh pipeline`) drives the whole path over
  HTTP with the pipeline on: a generated speech recording goes through ffmpeg, the speech
  detection, chunk planning, two or more provider calls, the merge and the save. It checks
  a stored timeline that spans more than one chunk, cancel during a run, a provider that
  fails a few times, a provider that never answers, and a retry after a failed run that
  keeps the chunks that already succeeded. The recording is generated from `espeak-ng` at
  test time, so the repository holds no audio file and no licence applies; a machine
  without it skips these tests with that reason.
- Chunk planning, merging, the checkpoint format and the job queue have unit tests in
  the server code. One test compares speech spans with a reference file, and runs only
  with fixtures that are not in the repository.
- A restart is covered by an ignored unit test that runs with a fixture: it stops a run
  after some chunks were answered, claims the job again, and checks that the saved speech
  detection is reused and the finished chunks are not sent again.
- Cancel and save against the same job, the status table, the speaker settings read by the
  pipeline (including a diarizing model with speaker labels off), the retry claim counter
  and the superseded work folder have unit tests in the server code.
- The lease generation has unit tests: a chunk write from a replaced claim changes nothing, and
  a claim that was replaced cannot renew, write
  progress, record its outcome, change the phase or save a transcript, including after an
  explicit retry reset the retry counter.
- Not tested: disk-budget pauses and resume, cancel during decoding and speech detection,
  and `needs_alignment` results.
