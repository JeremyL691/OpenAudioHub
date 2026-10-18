# Export and backup

This file covers three things: the quick export (`GET /api/export`), full backup jobs that build a zip archive (`/api/backup`), and scheduled backups and auto export on the desktop build.

Related files: [`recordings.md`](recordings.md) for uploads and deletes, [`settings.md`](settings.md) for the settings fields used here, [`errors.md`](errors.md) for the error envelope.

## Shared rules

- Every endpoint here needs a signed-in session. Without one the response is `401` with code `AUTH_SESSION_MISSING`.
- Only the signed-in user's own recordings and jobs are visible. Other users' job ids return `404` `NOT_FOUND`.
- Deleted recordings (soft-deleted, `deletedAt` set) are never exported and never included in an archive.
- Export content is plaintext. Summaries, transcripts, and filenames are decrypted before they are written, as the user's own data. Backup and export files carry the same care as an unencrypted database.
- Dates in file names use UTC.

## Export formats

### GET /api/export
Auth: session
Request: query `format` (optional). One of `json`, `txt`, `srt`, `vtt`.
- If `format` is missing or empty, the user's saved `defaultExportFormat` setting is used. If that saved value is not one of the four formats, `json` is used. A new account defaults to `json`.
- An explicit `format` always wins over the saved default.
- Any other value returns `400`.

Response: status `200`, body is the export text, headers:
- `Content-Type`: `application/json` (json), `text/plain` (txt, srt), `text/vtt` (vtt).
- `Content-Disposition: attachment; filename="recordings-YYYY-MM-DD.<ext>"`, where the date is the UTC date of the request.

JSON body: an array, one object per recording, pretty-printed with a 2-space indent. The newest recording comes first.
```json
[
  {
    "id": "rec_123",
    "filename": "Team sync",
    "duration": 3000,
    "startTime": "2026-10-16T08:00:00.000Z",
    "filesize": 48213,
    "transcription": "Hello everyone ...",
    "summary": {
      "summary": "Short summary",
      "actionItems": ["Send notes"],
      "keyPoints": ["Budget approved"]
    }
  }
]
```
- `transcription` is the transcript text, or `null` if there is none.
- `summary` is `null` if there is no AI summary. Otherwise it has `summary`, `actionItems`, and `keyPoints`.
- `duration` is in milliseconds. `filesize` is in bytes.

The `txt`, `srt` and `vtt` bodies list recordings oldest first.

Plain-text body (`txt`): for each recording, a block:
```
<filename>
<startTime as ISO-8601 UTC>
<transcript text, or "No transcription">

---

```
Blocks are concatenated with nothing between them beyond the trailing blank lines shown.

SRT body (`srt`): numbered cues, one per recording that has a transcript. Recordings without a transcript are skipped. Cue times are the recording start, and start plus `duration`, written as `HH:MM:SS,mmm` in UTC. With no transcripts the body is empty.

VTT body (`vtt`): starts with `WEBVTT` and a blank line, then one cue per recording with a transcript, times written as `HH:MM:SS.mmm`. With no transcripts the body is exactly `WEBVTT` followed by a blank line.

Errors:
- `400` `INVALID_INPUT`, `details: { field: "format" }`: unknown format.
- `401` `AUTH_SESSION_MISSING`: no session.

Side effects: none.

## Backup jobs

A backup job builds one zip archive of everything the user has: audio, transcripts, timelines, summaries, and a manifest. Jobs run in the background. The client starts a job, then polls its status, then downloads the archive.

### Job states

| `status` | Meaning |
|---|---|
| `pending` | Queued, not started yet. |
| `processing` | A worker is building the archive. |
| `completed` | The archive is ready to download. |
| `failed` | Building failed for good. `errorMessage` says why. |
| `expired` | Was completed, but its 7-day retention window has passed. Derived at read time; the archive is no longer offered. |

Job object (returned by every job endpoint):
```json
{
  "id": "job_abc",
  "status": "completed",
  "createdAt": "2026-10-16T08:00:00.000Z",
  "completedAt": "2026-10-16T08:01:12.000Z",
  "expiresAt": "2026-10-23T08:01:12.000Z",
  "recordingCount": 4,
  "fileSize": 1048576,
  "errorMessage": null
}
```
- `completedAt`, `expiresAt`, `recordingCount`, `fileSize` are `null` until the job completes. `errorMessage` is `null` unless the job failed.
- There is no progress percentage. Clients see only the state.
- `completedAt` plus 7 days (604800000 ms) is `expiresAt`. The archive is kept for 7 days.

### POST /api/backup
Auth: session
Request: no body.
Response:
- `202` with `{ "job": <job> }`: a new job was queued (status `pending`), or the user already has an active job (`pending` or `processing`), in which case that job is returned.
- `200` with `{ "job": <job> }`: the user's most recent completed job finished less than 24 hours ago (the cooldown). That job is returned and no new job is made. This is also the case when the user just called again after completion.

Rules:
- At most one active job per user. Two requests at the same time both get the same job.
- Cooldown: a new archive is built at most once per 24 hours per user, measured from the last completion.
- A job that failed or expired does not block a new one.

Errors: `401` `AUTH_SESSION_MISSING`.

Side effects: inserts one job row with kind `manual`. No email is sent.

### GET /api/backup
Auth: session
Response: `200`
```json
{ "jobs": [ <job>, <job>, ... ] }
```
Most recent first (by `createdAt`), at most 10 jobs. Includes jobs of every status. Jobs that have expired and been cleaned up are not listed.

Errors: `401` `AUTH_SESSION_MISSING`.

### GET /api/backup/{jobId}
Auth: session
Response: `200` with `{ "job": <job> }`. Use this to poll.

Errors:
- `404` `NOT_FOUND`: no such job, or the job belongs to another user.
- `401` `AUTH_SESSION_MISSING`.

Side effects: none.

### GET /api/backup/{jobId}/download
Auth: session
Response when the job is `completed` and not expired: `200`, body is the zip archive.
- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="openaudiohub-export-{jobId}.zip"`
- `Content-Length` equals the job's `fileSize`.

The archive bytes are streamed from the server's storage folder.

Errors:
- `404` `NOT_FOUND`: no such job for this user.
- `409` `CONFLICT`: the job is not `completed` yet (message "Export is not ready for download").
- `404` (message "Export has expired"): the archive is past its 7-day window, even if it has not been deleted from storage yet. Clients see status `expired` on the job.
- `401` `AUTH_SESSION_MISSING`.

## Archive layout

The archive is a zip file. Audio is stored without compression. Other files are deflated (level 6).

```
manifest.json
<folder>/audio.<ext>          one per recording with audio
<folder>/transcript.txt       when the recording has a transcript
<folder>/timeline.json        when the recording has an own-source timeline
<folder>/summary.json         when the recording has an AI summary
```

Folder name: the recording's start time in ISO-8601 UTC with `:` and `.` replaced by `-`, then `_`, then the recording id. Example: `2026-10-16T08-00-00-000Z_rec_123`.

`<ext>` is `mp3` for uploads. For other stored audio it is the stored file's extension, and `mp3` if there is none.

Audio bytes are copied as stored. The archive does not transcode audio.

### manifest.json
```json
{
  "version": "2.0",
  "createdAt": "2026-10-16T08:01:00.000Z",
  "userId": "usr_1",
  "audio_complete": true,
  "missing_audio_count": 0,
  "recordings": [
    {
      "id": "rec_123",
      "filename": "Team sync",
      "startTime": "2026-10-16T08:00:00.000Z",
      "endTime": "2026-10-16T08:50:00.000Z",
      "duration": 3000000,
      "filesize": 48213,
      "deviceSn": "local",
      "audio":      { "included": true,  "path": "2026-10-16T08-00-00-000Z_rec_123/audio.mp3" },
      "transcript": { "included": true,  "path": "2026-10-16T08-00-00-000Z_rec_123/transcript.txt" },
      "timeline":   { "included": false, "path": null },
      "summary":    { "included": false, "path": null }
    }
  ]
}
```
- Plaintext fields: everything in the manifest, the transcript text, the timeline, and the summary files.
- `audio.included: false` entries have an extra `reason` string, for example `Audio file not found in storage`.
- Soft-deleted recordings are omitted.
- With no recordings, `recordings` is `[]` and the archive holds only `manifest.json`.

### timeline.json
```json
{
  "schema_version": 1,
  "timestamp_source": "<source>",
  "processing": { "...": "pipeline configuration snapshot, or null" },
  "segments": [ ]
}
```
Written only for recordings whose transcript has a timeline from the app's own pipeline.

### summary.json
```json
{
  "summary": "Short summary",
  "actionItems": ["Send notes"],
  "keyPoints": ["Budget approved"],
  "provider": "<provider>",
  "model": "<model>",
  "createdAt": "2026-10-16T08:05:00.000Z"
}
```

### Missing or unreadable audio
If a recording's audio is missing from storage or cannot be read, that recording's manifest entry has `audio.included: false`, and the archive still builds. Then:
- If one or more recordings lack audio, the job fails at once (no retry). The message is `Export incomplete: audio was missing or unreadable for N recording(s). The archive was discarded.` No archive is kept.

Not covered by HTTP tests: this failure path.

## Size limits

No size cap is enforced by the export or backup code. Archive size is limited only by the storage backend. Archives are built as a stream, so memory use does not grow with library size.

## Jobs, failures, retries, and cleanup

Jobs are run by a background worker. One job is built at a time. A worker claims a job with a lease of 120 seconds and renews the lease while it builds. If the worker stops, the lease runs out and another claim takes the job. A worker that finds no job waits for a new-job signal or checks again after 5 seconds, so delayed retries run when due.

- Stall timeout: if a build makes no progress (no bytes written and no recording finished) for 5 minutes, it is aborted. The error is `Export job stalled: no progress for 300000ms`.
- Hard ceiling: any single build stops after 3 hours (`Export job exceeded max duration of 10800000ms`).
- Retries: a failed build is put back to `pending` and retried after a delay that starts at 30 seconds, doubles with each attempt, is capped at one hour, and gets up to 20% random extra time. A job gets 3 attempts in total. After the third failure the job is `failed` and `errorMessage` holds the last error.
- Cleanup: a maintenance pass runs every 30 seconds on every build. For each completed archive past `expiresAt`, the stored file is deleted (a file already missing counts as deleted), then the job row is removed. If the file delete fails, the row is kept and the delete is tried again on a later pass.

Not covered by HTTP tests: the retry, stall, crash, and cleanup paths. They need a 7-day wait or internal faults.

## Scheduled backups (desktop build only)

Scheduled backups run only in the desktop build. On the web build the schedule settings are stored but nothing is queued.

Settings (see [`settings.md`](settings.md)):
- `backupFrequency`: `daily`, `weekly`, `monthly`, or `never`. Anything else, and `null`, means no schedule.
- `backupFolder`: absolute path. `null` means `Documents/OpenAudioHub Backups` in the user's home folder. A path that is not an existing, writable folder is refused with `400` `INVALID_INPUT`, `details: { field: "backupFolder" }`. This check runs on every platform.

Schedule rules:
- A backup is due when the time since the later of (the last copied backup, the newest scheduled job) is more than the interval (1, 7, or 30 days).
- A due backup is queued as a job with kind `scheduled`, unless the user already has an active job.
- When a scheduled job completes, the archive is copied into the backup folder as `OpenAudioHub-backup-YYYY-MM-DD.zip` (local date). A second file on the same day gets `-2`, `-3`, and so on.
- The copy is written to a temporary file and renamed into place only when complete.
- Only the newest 5 backup files in the folder are kept, by modification time. Files whose names do not match the pattern are never touched.
- A copy failure does not fail the job. The job is still `completed` and downloadable.
- No "export ready" email is sent for scheduled jobs.

Test coverage: one test, `@desktop-only`. It runs only against a desktop-mode server (`OAH_DESKTOP_TARGET`). The shared test server does not run the desktop build, so the test is skipped there.

## Auto export of recordings (desktop build only)

When the desktop build has auto export on and a folder set:
- Each new recording is written into the folder, once. The file is never exported twice; the
  stored export path (`recordings.auto_export_path`, encrypted at rest) is the marker. The window
  opens at the settings save that turns auto export on, so a recording that arrives before the
  next maintenance pass is still exported. A state row that is missing falls back to the settings
  row's timestamp.
- Format: `mp3` (transcoded) or `original` (the stored audio file as is, keeping its extension).
- Name: `original` (the recording's filename), `date` (`YYYY-MM-DD`, the recording's start in
  local time), or `ai` (starts as the date name and is renamed to the AI title once one exists).
- Names: control characters are dropped, `/ \ : * ? " < > |` become `-`, whitespace runs collapse
  to one space, the result is trimmed and capped at 200 characters, and reserved Windows names
  (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) get a `_` prefix. If nothing is left,
  the recording id is used. A title already ending in the export extension loses it first, so a
  name never reads `x.mp3.mp3`.
- Name clashes never overwrite: `name.mp3`, `name (2).mp3`, and so on.
- Written under a temporary name first, then renamed, so a partial file never looks finished.
- With `ai` titles, a file still named by its date is renamed once the title exists; a rename
  the user made themselves stays.
- Failures are logged and the same recording is retried on the next pass.

Test coverage: unit tests in `crates/oah/src/backup/schedule.rs`. The contract tests do not cover
auto export; the folder behavior needs the desktop build and a writable local folder.

## Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_INPUT` (`field: "format"`) | Unknown export format. |
| 400 | `INVALID_INPUT` (`field: "backupFolder"`) | Backup folder missing or not writable. |
| 401 | `AUTH_SESSION_MISSING` | No session on any endpoint. |
| 404 | `NOT_FOUND` | Unknown job, another user's job, or an expired archive. |
| 409 | `CONFLICT` | Download requested before the job completed. |
