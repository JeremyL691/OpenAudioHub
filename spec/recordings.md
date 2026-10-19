# Recordings

This file covers recordings as a client sees them over HTTP: the list, one
recording, edits, deletion, starring, upload, audio streaming, waveform peaks,
batch download, and merge. Transcripts and summaries live in
`transcription.md` and `ai.md`. The detail response includes a `transcription`
field; its shape is described there.

Tests: `contract-tests/tests/recordings.spec.ts`.

## Conventions

- Every route needs a session cookie (`Auth: session`). Without one the route
  answers `401` with code `AUTH_SESSION_MISSING`.
- A recording belongs to one user. Every route only sees the caller's own
  recordings. For another user's id, the route answers `404` with code
  `RECORDING_NOT_FOUND`. It never answers `403`, so the id of someone else's
  recording cannot be told apart from an unknown id.
- Soft-deleted recordings (see DELETE) are treated as not found everywhere.
- Error body: `{ "error": "<message>", "code": "<CODE>", "details"?: {...} }`.
- Ids are strings of 1 to 64 characters from `A-Z a-z 0-9 _ -`. An id outside
  that set in a batch or merge request is a `400`. In a path, an unknown id is
  a `404`.
- Timestamps are ISO 8601 strings in UTC. `duration` is in milliseconds.
  `filesize` is in bytes.
- Recording rows are returned with all stored columns, so a client also sees
  `userId`, `storagePath`, `fileMd5`, and similar fields. Clients should ignore
  the ones they do not use.

Recording row fields (used by list, detail, and merge results):

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | |
| `userId` | string | Owner. Always the caller. |
| `deviceSn` | string | `"local"` for uploads and merges. |
| `plaudFileId` | string | Upload and merge ids look like `uploaded-<nanoid>` and `merged-<nanoid>`. |
| `filename` | string | Plaintext title. |
| `duration` | integer | Milliseconds. |
| `startTime` | string | ISO time. Uploads use the upload time. |
| `endTime` | string | `startTime` plus `duration`. |
| `filesize` | integer | Bytes of the stored audio. |
| `fileMd5` | string | 32 hex characters. MD5 of the stored bytes. |
| `storageType` | string | `"local"` or `"s3"`. |
| `storagePath` | string | Storage key of the audio file. |
| `autoExportPath` | string or null | |
| `downloadedAt` | string or null | Set on upload and merge. |
| `plaudVersion` | string | `"1"` for uploads and merges. |
| `timezone`, `zonemins`, `scene` | integer or null | |
| `isTrash` | boolean | `false` for uploads and merges. |
| `waveformPeaks` | number[] or null | See POST peaks. |
| `deletedAt` | string or null | Always null for recordings a client can read. |
| `starredAt` | string or null | Null when not starred. |
| `createdAt`, `updatedAt` | string | |

## Endpoints

### GET /api/recordings
Auth: session
Request: no query parameters are read. Any query string is ignored.
Response: `200`
```json
{ "recordings": [ { "id": "abc", "filename": "Standup", "duration": 3096, "starredAt": null } ] }
```
The list holds every non-deleted recording of the caller, sorted by `startTime`,
newest first. The list has no paging and no filter parameters. Each row has the full
field set above. The list is empty for a new account.

Each list row also has three fields for the library status badges and filters:
`hasTranscript` (boolean), `hasSummary` (boolean), and `processing` — `null`, or
`{ "kind": "transcribe" | "pipeline" | "summary", "progress": 0..1 }` while a background
job for the recording is queued or running.
Errors: `401` `AUTH_SESSION_MISSING`
Side effects: none

### GET /api/recordings/{id}
Auth: session
Request: path `id`.
Response: `200`
```json
{
  "recording": { "id": "abc", "filename": "Standup", "duration": 3096 },
  "transcription": null
}
```
`recording` has the full field set above. `transcription` is the caller's
transcript row for this recording, with its text in plaintext, or `null` when
none exists. See `transcription.md` for its fields.
Errors: `401` `AUTH_SESSION_MISSING`; `404` `RECORDING_NOT_FOUND` (unknown, deleted, or not the caller's)
Side effects: none

### PATCH /api/recordings/{id}
Auth: session
Request: JSON body `{ "filename": string }`.
- The name is stripped of control characters (code points below 32 and 127),
  then trimmed at both ends. Inner spaces are kept as they are.
- After cleanup the name must be 1 to 200 characters.
Response: `200`
```json
{ "filename": "Renamed Title" }
```
The response is the cleaned name. The detail route shows the same name.
Errors:
- `400` `INVALID_INPUT`, `details: { field: "filename" }`, message `filename must be a string`: body is not an object with a string `filename`.
- `400` `INVALID_INPUT`, `details: { field: "filename" }`, message `Name cannot be empty`: empty after cleanup.
- `400` `INVALID_INPUT`, `details: { field: "filename", maxLength: 200 }`, message `Name must be 200 characters or fewer`.
- `401` `AUTH_SESSION_MISSING`; `404` `RECORDING_NOT_FOUND`.
Side effects: the stored name changes and `updatedAt` is set. A `recording.updated` webhook event is sent to the caller's endpoints (see `webhooks.md`).

### DELETE /api/recordings/{id}
Auth: session
Request: path `id`. No body.
Response: `200`
```json
{ "success": true }
```
Order of work:
1. The stored audio file is removed from storage. If it is already missing, the delete continues.
2. In one transaction: the recording's transcript rows and AI enhancement rows are removed. The recording is marked deleted (`deletedAt` set).
3. A `recording.deleted` webhook event is sent. It is sent only by the request that changed the row. Deliveries already queued for the recording are kept; their payload is built from the recording when each attempt is sent (see `webhooks.md`).

The row is kept as a marker because sync from Plaud keys on `plaudFileId`. A later Plaud sync must not bring the recording back. The Plaud server is not changed.

After a delete, the recording is gone for every route in this file. It is absent from the list, and detail, audio, PATCH, star, peaks, batch download, and merge all answer `404`.

Errors:
- `401` `AUTH_SESSION_MISSING`.
- `404` `RECORDING_NOT_FOUND`: unknown, already deleted, or not the caller's. Deleting twice gives `404` the second time.
- `500` `STORAGE_ERROR`, message `Failed to delete recording audio. Please retry.`: the storage delete failed for a reason other than "already missing". Nothing is changed. The client may retry.

### PUT /api/recordings/{id}/star
Auth: session
Request: JSON body `{ "starred": boolean }`. Other bodies are rejected.
Response: `200`
```json
{ "id": "abc", "starred": true }
```
- Starring sets `starredAt` to the current time when the recording was not starred. Starring a starred recording keeps the original `starredAt`.
- Unstarring sets `starredAt` to null.
- `updatedAt` is set on every call.
Errors:
- `400` `INVALID_INPUT`, `details: { field: "starred" }`, message `starred must be a boolean`. A body that is not a JSON object, or a missing or non-boolean `starred`, gives this error.
- `401` `AUTH_SESSION_MISSING`; `404` `RECORDING_NOT_FOUND`.
Side effects: `starredAt` and `updatedAt` change. No webhook is sent.

### POST /api/recordings/upload
Auth: session
Request: `multipart/form-data` with one file part named `file`.
- Accepted extensions (matched without regard to case): `.mp3`, `.mp4`, `.m4a`, `.wav`, `.ogg`, `.opus`, `.webm`, `.aac`, `.flac`.
- Maximum size: 500 MB (524288000 bytes). A larger file is refused with `413`.
- The audio must be readable. Its duration must be greater than 0. The file is parsed as audio without using the extension; a file with an accepted name that is not audio is refused.
- The title is the file name without its extension, unless the user's title mode is `date`, in which case the title is the date `YYYY-MM-DD` of the upload, in server local time.
- Checks run in this order: file part present, size, extension, audio readable. The first failure wins.

Response: `200`
```json
{ "success": true, "filename": "tone-3s" }
```
The response has no recording id. Find the new recording in the list. In a test, use a unique file name and find the row by its `filename`.

Errors:
- `400` `MISSING_REQUIRED_FIELD`, `details: { field: "file" }`, message `No file provided`: no `file` part, or the part is not a file.
- `413` `FILE_TOO_LARGE`, message `File exceeds the 500 MB size limit`. Not covered by tests: it needs a 500 MB body.
- `400` `INVALID_FILE_FORMAT`, message `Unsupported format. Accepted: .mp3, .mp4, .m4a, .wav, .ogg, .opus, .webm, .aac, .flac`: extension not in the list.
- `422` `INVALID_FILE_FORMAT`, message `File does not contain a valid audio stream`: the audio has no readable duration.
- `401` `AUTH_SESSION_MISSING`.

Side effects: the audio is stored under the user's storage area with the file's own extension (lower case). A recording row is created with:
- `deviceSn` `"local"`, `plaudFileId` `"uploaded-<id>"`, `plaudVersion` `"1"`, `isTrash` false.
- `duration` from the probe, `startTime` set to the upload time, `endTime` = `startTime` + `duration`.
- `filesize` and `fileMd5` of the bytes received.
- `downloadedAt` set to the upload time.

If the row cannot be saved, the stored audio is removed and the error is returned. Otherwise the recording is queued for automatic transcription when that setting is on. Automatic export picks it up on the desktop build (see [export.md](export.md)).

### GET /api/recordings/{id}/audio
Auth: session
Request: path `id`. Optional query `download=1` (also `true` or `yes`, any case). Optional header `Range`.

**Streaming (no `download` flag)**

- The content type comes from the stored extension:

| Extension | Content-Type |
|-----------|--------------|
| `.mp3` | `audio/mpeg` |
| `.mp4`, `.m4a` | `audio/mp4` |
| `.wav` | `audio/wav` |
| `.ogg`, `.opus` | `audio/ogg` |
| `.webm` | `audio/webm` |
| `.aac` | `audio/aac` |
| `.flac` | `audio/flac` |
| other | `audio/mpeg` |

- Without `Range`: `200`, the whole file, headers `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: private, max-age=31536000, immutable`.
- `Range: bytes=<start>-<end>`: `206` with the bytes from `start` to `end` inclusive, `Content-Range: bytes <start>-<end>/<size>`, `Content-Length` of the slice, `Accept-Ranges: bytes`, and the same `Cache-Control` as above.
- `Range: bytes=<start>-`: `206` from `start` to the last byte.
- Any other range form, such as a suffix `bytes=-N`, is ignored. The response is `200` with the whole file.
- A range is unsatisfiable when `start` is at or past the end, when `start` is after `end`, or when `end` is at or past the last byte. The response is `416` with `Content-Range: bytes */<size>` and no body. An `end` past the last byte is not clamped.

**Download (`download=1`)**

- For an `.mp3` source the file is sent as it is.
- For any other source the file is converted to MP3 while it streams. The converted audio is not stored.
- Response headers: `Content-Type: audio/mpeg`, `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded name>`, `Cache-Control: private, no-store`. The name is the recording title with `.mp3` as the extension. Characters `/ \ : * ? " < > |` become `-`. Runs of whitespace become one space. Names are capped at 200 characters. A title that is empty after cleanup falls back to the recording id.
- No `Content-Length` is sent. The body length is not known in advance.

Errors: `401` `AUTH_SESSION_MISSING`; `404` `RECORDING_NOT_FOUND` (unknown, deleted, or not the caller's). The `404` body is returned before any audio is read.
Side effects: none

### POST /api/recordings/{id}/peaks
Auth: session
Request: JSON body `{ "peaks": number[] }`. The client computes the peaks from the decoded audio. Peaks are for display only.
- Length: 32 to 2048 values.
- Each value: a finite number from 0 to 1. Values are rounded to 3 decimal places before saving.

Response: `200`
- `{ "stored": true }` when this request saved the peaks.
- `{ "stored": false }` when the recording already has peaks. The stored peaks are kept. This is write-once: the first save wins.

The saved peaks show up as `waveformPeaks` in the recording row.
Errors:
- `400` `INVALID_INPUT`, message `Expected { peaks: number[] }`: `peaks` is missing or not an array.
- `400` `INVALID_INPUT`, message `peaks must contain between 32 and 2048 values`.
- `400` `INVALID_INPUT`, message `peaks must be finite numbers in [0, 1]`: a value is not a number, is not finite, or is outside 0 to 1.
- `400` `INVALID_INPUT`, message `Expected { peaks: number[] }`: the body is not JSON.
- `401` `AUTH_SESSION_MISSING`; `404` `RECORDING_NOT_FOUND`.
Side effects: `waveformPeaks` and `updatedAt` are set on the first save.

### GET /api/recordings/title-repair

Auth: session.

Response: `200` with `{ "candidates": [...] }`, newest first. Each candidate is `{ "id", "filename", "suggestedFilename", "startTime" }`.

- A candidate is a live recording whose title starts with the recording's own day (`YYYY-MM-DD` in server local time) followed by a time, which is the shape earlier versions wrote for a date title.
- Recordings with a `manual` or `ai` title are never candidates. A recording without a start time is not one either.
- Nothing changes.

### POST /api/recordings/title-repair

Auth: session. Request: `{ "picks": [{ "id": "...", "expectedFilename": "..." }] }`.

Response: `200` with `{ "renamed": [{ "id", "filename" }], "skipped": [{ "id", "reason" }] }`.

- Each pick is applied only when the stored name still equals `expectedFilename`, the title is still a date-time title of that recording's day, and the title is not `manual` or `ai`. Otherwise the pick is skipped with `renamed`, `not found`, or `not a date title`.
- A renamed title is stored as the date and marked with title source `date`.
- An empty `picks` list answers `200` with empty results. A body without a `picks` list is `400 INVALID_INPUT`.

### GET /api/recordings/download
Auth: session
Request: query `ids` (required): comma-separated recording ids. Duplicates are ignored. Optional query `format`: `mp3` (default) or `original`.
- Between 1 and 100 distinct ids.
- Each id must match the id pattern above.
- `format` must be `mp3` or `original`.

Response:
- One id with `format=original`: `200`, the stored file as it is, `Content-Type` from the extension (see the streaming table), `Content-Disposition: attachment` with the title and its stored extension, `Cache-Control: private, no-store`.
- Anything else: `200` with a ZIP archive, `Content-Type: application/zip`, `Content-Disposition: attachment; filename="OpenAudioHub-<YYYY-MM-DD>.zip"`, `Cache-Control: private, no-store`. The archive stores each file without compression. Each entry is one recording:
  - `format=mp3` (default): the recording as MP3. Entry name is the title plus `.mp3`.
  - `format=original`: the stored file, with its stored extension.
  - Names inside one archive are unique. A repeated name becomes `<name> (2).<ext>`, then `(3)`, and so on, compared without regard to case.
  - An id that is unknown, deleted, or not the caller's is left out silently.
  - An id whose audio file is missing from storage, or whose audio cannot be converted to MP3, is listed in a text entry `errors.txt` in the archive, one line per recording: `<entry name>: audio file is missing` or `<entry name>: could not be converted`. The other entries are still included.
  - A failure in the middle of the archive ends the download early. The client sees a broken archive. Nothing else is reported.

Errors:
- `400` `INVALID_INPUT`, message `ids must be 1 to 100 recording ids`: missing, empty, too many, or a malformed id.
- `400` `INVALID_INPUT`, message `format must be mp3 or original`.
- `401` `AUTH_SESSION_MISSING`.
- `404` `RECORDING_NOT_FOUND`, message `Recording not found`: none of the ids is the caller's live recording. A single-id `format=original` request whose audio file is missing also gets `404` with message `Audio file is missing`.
Side effects: none

### POST /api/recordings/merge
Auth: session
Request: JSON body `{ "ids": string[], "title"?: string }`.
- `ids`: 2 to 100 distinct recording ids. The order in the array is the order of the audio.
- `title`: optional. Must be a string of at most 255 characters after trimming. An empty string is treated as no title.

Response: `201`
```json
{ "id": "xyz" }
```
The new recording is the concatenation of the inputs in the given order.
- Title: the trimmed `title` if one was given. Otherwise the first input's title with ` (merged)` added.
- `startTime`: the earliest `startTime` of the inputs.
- `duration`: measured from the joined audio. It is about the sum of the inputs.
- Content type of the merged audio: `audio/ogg`. Its stored extension is `.ogg`.
- `plaudFileId` `"merged-<id>"`, `deviceSn` `"local"`, `plaudVersion` `"1"`.
- Originals are not changed or removed. Deleting an original later does not affect the merged recording.
- A merged recording longer than 24 hours is refused.

Transcripts: if every input has a transcript, their texts are joined in order with time offsets. The joined transcript is saved on the merged recording. Saving it does not run the after-transcript steps, so no `transcription.completed` event is sent for it. Not covered by tests: this needs a transcript on each input.

Errors:
- `400` `INVALID_INPUT`, message `ids must be 2 to 100 distinct recording ids`: fewer than two, more than 100, duplicates, or a malformed id. `ids` missing or not an array gives the same error.
- `400` `INVALID_INPUT`, message `title must be at most 255 characters`: `title` not a string, or longer than 255 after trimming.
- `404` `RECORDING_NOT_FOUND`, message `Recording not found`: any id is unknown, deleted, or not the caller's. Nothing is created.
- `422` `INVALID_FILE_FORMAT`, message `"<title>" has no readable audio`: an input has no readable duration. Not covered by tests.
- `422` `INVALID_INPUT`, message `Merged recording would be longer than 24 hours`. Not covered by tests.
- `401` `AUTH_SESSION_MISSING`.
Side effects: a new recording row and a new stored audio file. Automatic export picks the merged recording up on the desktop build (see [export.md](export.md)). The original recordings are not changed.

The option to delete the originals is not part of this route. A client that wants it calls DELETE for each original after the merge succeeds.

## Per-user isolation

Every route in this file treats another user's recording as if it did not exist:

- detail, PATCH, DELETE, star, audio, peaks: `404`
- batch download: the id is left out. If no id is the caller's, `404`.
- merge: `404`, and no recording is created
- list: never includes another user's recordings

A change made by one user never shows in another user's list or detail.

## Not covered by tests

- The 500 MB upload limit.
- Automatic export of uploaded and merged recordings.
- Merge's transcript carry-over, and merge's errors for unreadable inputs and the 24-hour limit.
