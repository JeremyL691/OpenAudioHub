# Transcription

This file covers how a recording gets its transcript: starting a run, choosing a provider, what each provider receives and returns, how the transcript is stored and deleted, the audio pipeline status for a recording, and what happens after a transcript is saved (title, summary, events).

Related files:

- `recordings.md`: recording detail (which returns the transcript inline), upload, audio, and recording delete.
- `ai.md`: AI provider settings (the providers used here are configured there), summaries, titles, and prompt presets.
- `audio-pipeline.md`: how long audio is split into chunks, merged, repaired, and timed. This file only describes the hand-off.
- `workers.md`: automatic transcription after a sync, and the retry policy.
- `webhooks.md`: delivery of `transcription.completed` and `transcription.failed`.
- `settings.md`: user settings used here (language, speaker labels, title, auto-summary).
- `settings.md` also describes the public `/api/v1` transcript read.

Every endpoint in this file needs a session cookie unless it says otherwise. Errors use the envelope in [errors.md](errors.md): `error`, `code`, and optional `details`.

## Transcript data

A recording has at most one transcript per source. Source values:

| `source` | Meaning |
| --- | --- |
| `openaudiohub` | Produced by this server or by the browser. The default. |
| `plaud` | Imported from Plaud. Never created by a transcription run. |
| `mixed` | User-edited combination. |

Stored fields of a transcript, as returned inside the recording detail:

```json
{
  "id": "tr_abc",
  "recordingId": "rec_abc",
  "userId": "usr_abc",
  "text": "Hello from the meeting.",
  "detectedLanguage": "en",
  "transcriptionType": "server",
  "provider": "OpenAI",
  "model": "whisper-1",
  "timeline": null,
  "timelineSource": null,
  "source": "openaudiohub",
  "createdAt": "2026-10-16T10:00:00.000Z"
}
```

- `text`: plain text. It is stored encrypted and returned decrypted. Speaker turns, when present, are written into the text itself (see Speaker labels).
- `detectedLanguage`: ISO language code, or `null`. For the Whisper-style path it is the language the provider reports (verbose responses only). For chat-style and Gemini it is the language the user set, or `null`. For diarized output it is `null`.
- `transcriptionType`: `server` or `browser`.
- `provider`: the provider name as configured, or `browser` for browser transcripts.
- `model`: the model actually used for the run, after any override. For browser transcripts it is the browser model id.
- `timeline`, `timelineSource`: filled only by the audio pipeline (see `audio-pipeline.md`). They are `null` for synchronous runs and browser transcripts.
- Segments with start and end times are not stored on synchronous runs.

`timelineSource` is `native` when the timings are the provider's own, and `normalized` when some timings were corrected to fit the audio.

## Speaker labels

Speaker labels appear only in text from diarized output:

- Diarized output for OpenAI-style diarized models and for ElevenLabs with diarization on. Each turn is one line, `Speaker N: text` (ElevenLabs), or `[mm:ss] Speaker N` with the text on the next line (OpenAI diarized, timestamps are `hh:mm:ss` from one hour on).
- Speaker numbers start at 1 in order of first appearance within the run.
- Consecutive segments from the same speaker merge into one turn.
- When audio is split for diarization, each turn after the first chunk is labelled with `· Part N`, and chunks are joined with a blank line.

## Choosing a provider

Provider choice for `POST /api/recordings/{id}/transcribe`:

1. If the body has `providerId`, that configured provider is used. It must belong to the user. If it does not exist, the call fails with `NO_TRANSCRIPTION_PROVIDER`.
2. Otherwise, if the user's settings name a default transcription provider, that provider is used. If the named provider no longer exists, the call fails with `NO_TRANSCRIPTION_PROVIDER`. It does not fall back.
3. Otherwise the provider marked as the default for transcription is used.
4. If none is found, the call fails with `NO_TRANSCRIPTION_PROVIDER`.

The model is `model` from the body if given, else the provider's default model, else the preset's default model, else `whisper-1`.

Each provider has one transcription style. The style comes from the provider name (its preset):

| Provider name | Style | Default base URL |
| --- | --- | --- |
| `OpenAI`, `Groq`, `Together AI`, `SiliconFlow (China)`, `LM Studio`, `Ollama`, `Custom` | whisper | preset URL, or the stored base URL |
| `OpenRouter` | chat | preset URL |
| `Google Gemini` | gemini | Google's own API address (no override) |
| `ElevenLabs` | elevenlabs | `https://api.elevenlabs.io/v1` |

A provider name that is not a preset uses the whisper style. A stored base URL overrides the preset URL for the whisper and chat styles. For ElevenLabs it must be an `http` or `https` URL without credentials in it. `OpenCode Go` is not a transcription provider and cannot be chosen for transcription.

Settings that affect every run (from the user's settings):

- `defaultTranscriptionLanguage`: when set, passed as the language hint to the provider. Not set means automatic detection.
- `speakerDiarization` (default `true`): used only by ElevenLabs and by diarized OpenAI models. A long recording reads it when its pipeline job runs. With it off, a diarizing model uses the whisper-style request and returns no speaker labels.
- `diarizationSpeakerCount`: optional speaker count hint, used only with diarization. A long recording reads it when its pipeline job runs.
- `transcriptionQuality`: stored, but it does not change the request.

## Whisper style (OpenAI-compatible)

Request, sent to `{baseUrl}/audio/transcriptions` as `multipart/form-data`, with `Authorization: Bearer <apiKey>`:

- `file`: the recording audio. The filename is the recording title with an extension that matches the detected format (mp3, wav, m4a, and so on). The content type matches that format.
- `model`: the model chosen above.
- `response_format`: `json` when the model name starts with `gpt-4o`, `verbose_json` otherwise.
- `language`: only when a language hint is set.

Response parsing:

- `verbose_json`: text is the `text` field; `detectedLanguage` is the `language` field, or `null` when absent.
- `json`: text is the `text` field; `detectedLanguage` is `null`.
- `diarized_json`: see Diarized output below.

Size handling. Before upload, audio larger than 24 MiB (the `WHISPER_MAX_BYTES` setting, which cannot exceed 25 MiB) is re-encoded to mono Opus in an Ogg container (content type `audio/ogg`), starting at 12 kbit/s (`WHISPER_COMPRESS_BITRATE_KBPS`). If the result is still over 25 MiB, the bitrate is halved and the encode repeated until it fits or reaches 6 kbit/s. If it still does not fit, the run fails with `TRANSCRIPTION_FAILED`. Audio at or under the limit is sent unchanged.

Timeout. Each request waits up to `WHISPER_REQUEST_TIMEOUT_MS` (default 3,600,000 ms).

### Diarized output

Used when the model name contains `diarize` and `speakerDiarization` is on. The request
sends `response_format` = `diarized_json` and also `chunking_strategy` = `auto`:

1. The audio is converted to mp3 first.
2. If the audio is longer than 1,199 seconds, it is cut into equal parts of at most 1,199 seconds. Each part is sent separately as `diarized_json` with its own file name (`<name>-part-N.mp3`).
3. Each response's segments are merged into turns and labelled as described under Speaker labels. Part offsets are added to the timestamps.
4. The parts are joined with a blank line. `detectedLanguage` is `null`.

## Chat style (OpenRouter and OpenCode Go)

Request, sent as JSON to `{baseUrl}/chat/completions`:

```json
{
  "model": "google/gemini-2.5-flash-lite",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Transcribe the attached audio verbatim. Output only the transcript text ... The audio language is fr." },
        { "type": "input_audio", "input_audio": { "data": "<base64 audio>", "format": "mp3" } }
      ]
    }
  ]
}
```

- The text instruction ends with `The audio language is <code>.` only when a language hint is set.
- `format` is `mp3` or `wav`. Audio in any other format is first converted to mp3. If conversion fails, the run fails with a message that asks for mp3 or wav audio.
- The response text is `choices[0].message.content`, trimmed. An empty or missing answer fails the run.
- `detectedLanguage` is the language hint, or `null`.

## Gemini style

Request: a generate-content call to Google's Generative Language API, with the instruction text and the audio as base64 `inlineData`. The MIME type is mapped from the audio content type (mp3, mp4, wav, ogg, opus, flac, aac, webm).

- Audio over 20 MB is refused with a failure (no file upload path yet).
- Unsupported audio types are refused.
- An empty answer fails the run.
- `detectedLanguage` is the language hint, or `null`.

Gemini calls the official endpoint directly and does not use the stored base URL.

## ElevenLabs style

Request: `multipart/form-data` to `{baseUrl}/speech-to-text` with header `xi-api-key: <apiKey>`:

- `file`: the recording audio.
- `model_id`: the model.
- `timestamps_granularity`: `word`.
- `tag_audio_events`: `false`.
- `diarize`: `true` or `false`, from the diarization setting.
- `language_code`: the language hint, when set. It must look like a language code (two or three letters, optional subtags).
- `num_speakers`: the speaker count hint, only when diarization is on and a count is set. It must be 1 to 32.

Limits:

- Recordings larger than 128 MB are refused with `FILE_TOO_LARGE` (413) before upload.
- Responses larger than 32 MB are a failure.
- A response is read as JSON. Invalid JSON or a response that does not match the expected shape is a failure (`ElevenLabs returned an unreadable reply.`).

Retries: up to 2 retries after a 429, 500, 502, 503, 504, or 524 response, and after network errors and timeouts. The wait is 1 second before the first retry and 2 seconds before the second.

Failures:

- 401 or 403: the API key was rejected. The run fails.
- 422: the request was invalid. The run fails.
- Other statuses: the run fails.

Response parsing:

- With diarization on and word timings returned, the text is `Speaker N: text` lines. Consecutive words from one speaker form one line. Spaces come from the provider's spacing tokens, which are joined as given.
- Otherwise the text is the `text` field, trimmed.
- An empty result fails the run.
- `detectedLanguage` is the `language_code` field, normalized, or `null`.

The ElevenLabs preset has fixed audio models `scribe_v2` and `scribe_v1`. Its URL may be overridden only with an HTTP or HTTPS URL without embedded credentials. It is transcription-only and cannot be selected as the enhancement default.

## Starting a run

### POST /api/recordings/{id}/transcribe

Auth: session

Request:
- Path: `id`, the recording id.
- Body (JSON, optional; an empty or non-JSON body is treated as `{}`):
  - `providerId`: string. Optional. A configured provider id of this user.
  - `model`: string. Optional. Overrides the model for this run.

Every manual run is forced. An existing transcript is always replaced, even when a transcript is already present.

Response:

- `200` when the transcript is produced in the request:

  ```json
  { "transcription": "Hello from the meeting.", "detectedLanguage": "en" }
  ```

  `detectedLanguage` is `null` when the provider gave no language.

- `202` when the audio pipeline accepted the work as a background job (only when the server enables the pipeline):

  ```json
  { "jobId": "job_abc", "status": "queued" }
  ```

  Poll `GET /api/recordings/{id}/audio-pipeline` until the job reaches a final state. See `audio-pipeline.md`.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 401 | `AUTH_SESSION_MISSING` | No session. |
| 400 | `NO_TRANSCRIPTION_PROVIDER` | No provider can be chosen (see Choosing a provider). |
| 404 | `RECORDING_NOT_FOUND` | Recording missing, owned by another user, or deleted. |
| 413 | `FILE_TOO_LARGE` | ElevenLabs style and the recording is over 128 MB. |
| 413 | `TRANSCRIPTION_FAILED` | The audio pipeline is enabled and the recording is over 24 hours. Message `Recordings over 24 hours cannot be transcribed`. |
| 500 | `TRANSCRIPTION_FAILED` | Any other failure: provider unreachable, provider error, bad response, or conversion failure. The message is the provider's or the pipeline's message, so it can contain provider text. `details.errorId` is present. |

Side effects on success:

1. The user's transcript row with source `openaudiohub` is replaced (or created). The recording's last-changed time is updated.
2. If a transcript of any source existed before this run, the recording's summary is deleted.
3. `transcription.completed` is emitted.
4. The title is generated if automatic title is on, and automatic summary runs if it is on (see After a transcript is saved).

Side effects on failure: the previous transcript and summary, if any, are left unchanged. `transcription.failed` is emitted with the error text.

Concurrent manual runs for the same recording and mode share one run in the same server process.

## Reading a transcript

There is no separate read endpoint on `/api/recordings/{id}/transcription`. A transcript is read through:

- `GET /api/recordings/{id}`: returns the transcript as `transcription` (see `recordings.md`). It is `null` when there is none.
- `GET /api/recordings/{id}/audio-pipeline`: see below.
- The public `/api/v1` transcript read: see `settings.md`.

GET and PATCH on `/api/recordings/{id}/transcription` return `405`. Transcript text cannot be edited: the API has no edit route, and the interface has no edit mode.

## Deleting a transcript

### DELETE /api/recordings/{id}/transcription

Auth: session

Request:
- Query `source` (optional): `openaudiohub` (default), `plaud`, or `mixed`. Any other value fails.

Response: `200` with `{ "success": true }`.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 401 | `AUTH_SESSION_MISSING` | No session. |
| 400 | `INVALID_INPUT` | `source` is not one of the values above. This is checked before the recording is looked up. |
| 404 | `RECORDING_NOT_FOUND` | Recording missing, owned by another user, or deleted. |
| 409 | `CONFLICT` | An audio pipeline job for this recording is queued or running. |
| 404 | `NOT_FOUND` | No transcript of that source exists. |

Side effects: the transcript of that source is removed. The recording's summary is removed as well, whatever the source, because the summary was written from a transcript. The recording's last-changed time is updated.

## Browser transcription

The browser transcribes the audio on the user's device. The server never runs a provider for these, and it does not need an AI provider. The browser downloads the audio from `GET /api/recordings/{id}/audio`, runs a Whisper model locally (`whisper-base`, downloaded once from the Hugging Face hub), and posts the text here.

### POST /api/recordings/{id}/transcription/from-browser

Auth: session

Request (JSON):

```json
{ "text": "Hello from the meeting.", "model": "whisper-base", "detectedLanguage": "en" }
```

- `text`: string, 1 to 200,000 characters after trimming. Required.
- `model`: string, 1 to 100 characters after trimming. Required. Stored as given.
- `detectedLanguage`: string, up to 10 characters after trimming. Optional. An empty value is stored as `null`.
- Other fields (including `provider`) are ignored. The stored provider is always `browser`.

Response: `200`:

```json
{ "transcription": "Hello from the meeting.", "detectedLanguage": "en" }
```

`transcription` is the trimmed text.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 401 | `AUTH_SESSION_MISSING` | No session. |
| 400 | `MISSING_REQUIRED_FIELD` | The body is not valid JSON, or a field fails the rules above. `details.issues` lists the problems. |
| 404 | `RECORDING_NOT_FOUND` | Recording missing, owned by another user, or deleted. |

Side effects: the user's transcript row is replaced (or created) with `provider` `browser`, `transcriptionType` `browser`, and the given `model`. The recording's last-changed time is updated. `transcription.completed` is emitted.

After the save, the same steps run as for a server transcript (see After a transcript is saved), including the title and automatic summary when those settings are on.

## Audio pipeline status

The audio pipeline is an optional server-side step for long recordings. See `audio-pipeline.md`.

### GET /api/recordings/{id}/audio-pipeline

Auth: session

Response: `200`:

```json
{
  "job": {
    "id": "job_abc",
    "status": "running",
    "phase": "running",
    "progress": 0.4,
    "errorType": null,
    "error": null,
    "updatedAt": "2026-10-16T10:00:00.000Z"
  },
  "timeline": null,
  "timestampSource": null,
  "transcription": null
}
```

- `job` is the newest job for the recording, or `null` when none has ever been started. Recordings of other users behave as having no job.
- `timeline` and `timestampSource` come from the user's own transcript for this recording. They are `null` when there is none.
- `transcription` is `null` while a job is active or failed. It is `{ "text", "language", "source": "openaudiohub" }` when there is no job (and an own transcript exists), or when the job is `completed` or `needs_alignment`. `language` is omitted when unknown.
- Each job field is copied from the job record; `error` is the job's error message.

The endpoint returns `200` even when the recording does not exist or belongs to someone else. In that case every field is `null`.

Job status values:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to be processed. |
| `running` | Processing. `phase` and `progress` show where it is. |
| `paused_disk` | Waiting for free disk space. Resumes automatically. |
| `completed` | Transcript saved with timings. |
| `needs_alignment` | Transcript saved without usable timings. |
| `failed` | Stopped with `errorType` and `error`. |
| `cancelled` | Stopped by the user, or replaced by a manual run. |

Active statuses (block delete, retry and cancel): `queued`, `running`, `paused_disk`. Cancel is refused for any other status, and also for a job whose transcript was already saved but has not recorded its outcome yet.

Transitions:

- A new job starts as `queued`. Starting a manual run cancels the recording's active job first, which becomes `cancelled`, has its work folder deleted, and is replaced by the new one. A job whose transcript was already saved keeps its result and is recorded as done.
- `queued` → `running` → `completed`, `needs_alignment`, or `failed`.
- `running` ↔ `paused_disk`.
- `queued`, `running`, or `paused_disk` → `cancelled` on cancel.
- `failed` → `queued` on retry.

The worker sets `phase` to one of `queued`, `decode`, `vad`, `transcribing`, `paused_disk`, `completed`, `needs_alignment`, `failed` or `cancelled`.

### POST /api/recordings/{id}/audio-pipeline

Auth: session

Request (JSON): `{ "action": "retry" | "cancel" }`.

Response:
- `200` with `{ "jobId": "job_abc", "status": "queued" }` after a retry, or `{ "jobId": "job_abc", "status": "cancelled" }` after a cancel.

Errors (these responses carry only `error`, without `code`):

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "error": "Invalid action" }` | `action` is not `retry` or `cancel`. |
| 404 | `{ "error": "Audio job not found" }` | The recording has no job. |
| 409 | `{ "error": "Audio job cannot be changed" }` | Retry on a job that is not `failed`, or cancel on a job that is not active, including a job whose transcript was already saved. |

Retry requeues the job with its completed chunk results kept. Cancel stops the job.

## After a transcript is saved

These steps run after a transcript is saved, in this order, for manual runs, automatic runs, and browser transcripts. They are recorded in the same transaction that saves the transcript, as a queue job that names that transcript, so a process that stops before they run leaves them queued instead of losing them, and a transcript that is replaced or deleted before they run does not apply them to the newer text.

1. `transcription.completed` is emitted.
2. Title. If automatic title is on (default on), a short title is generated from the first part of the transcript (about 2,000 characters) by the default AI provider for enhancement. The title is cleaned: surrounding quotes removed, colons and semicolons removed, and cut to 60 characters (57 characters and `...`). It replaces the recording's name. If the generation fails or returns nothing, the name is left as it was and the transcript is kept. If the setting that syncs titles to Plaud is on and the recording came from Plaud, the new title is sent to Plaud. A Plaud failure is logged and does not fail the run. If the auto-export setting uses AI titles, the exported copy is renamed too.
3. Automatic summary runs when `autoSummarize` is on (default off). It uses `autoSummarizePreset` if set. It is limited to `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` summaries per user per hour (default 60). Over the limit, `summary.failed` is emitted with a message and no summary is written. A summary failure emits `summary.failed` and does not undo the transcript.

Events are described in `webhooks.md`. `summary.completed` and `summary.failed` are described in `ai.md`.

## Errors and retries

- A failed run never leaves a partial transcript. The previous transcript remains.
- Provider errors are not retried by the manual endpoint, except the ElevenLabs retries listed above.
- Automatic transcription and its retry policy are in `workers.md`.
