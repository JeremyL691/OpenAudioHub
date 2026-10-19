# Export

This file covers the quick export (`GET /api/export`) and the automatic export of new recordings on the desktop build.

Related files: [`recordings.md`](recordings.md) for uploads and deletes, [`settings.md`](settings.md) for the settings fields used here, [`errors.md`](errors.md) for the error envelope.

## Shared rules

- Every endpoint here needs a signed-in session. Without one the response is `401` with code `AUTH_SESSION_MISSING`.
- Only the signed-in user's own recordings are visible. Another user's recording is treated as missing.
- Deleted recordings (soft-deleted, `deletedAt` set) are never exported.
- Export content is plaintext. Summaries, transcripts, and filenames are decrypted before they are written, as the user's own data.
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

## Auto export of recordings (desktop build only)

Auto export runs only in the desktop build, and only while the app is running. Settings are in [`settings.md`](settings.md): `autoExport`, `autoExportFolder`, `autoExportFormat`, and `autoExportTitleMode`.

- Which recordings qualify is decided when a recording is first added: the row is marked eligible only when auto export is on and a folder is set at that moment. Recordings that existed before it was switched on are never exported, and switching it off and on again does not mark them.
- Each eligible recording is written into the folder once. The stored export path (`recordings.auto_export_path`, encrypted at rest) is the marker.
- Format: `mp3` (transcoded), `ogg` (Ogg container with Opus audio), or `original` (the stored audio file as is, keeping its real extension). An existing MP3 or Ogg/Opus file is copied without re-encoding when it already is the chosen format; a conversion failure leaves no file.
- Name: `original` (the recording's filename), `date` (`YYYY-MM-DD`, the recording's start in local time), or `ai` (starts as the date name and is renamed to the AI title once one exists).
- The AI rename happens only when the title's source is `ai`. A title kept from Plaud or the upload, a date title, and a manually edited title keep the date name.
- Names: control characters are dropped, `/ \ : * ? " < > |` become `-`, whitespace runs collapse to one space, the result is trimmed and capped at 200 characters, and reserved Windows names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) get a `_` prefix. If nothing is left, the recording id is used. A title already ending in the export extension loses it first, so a name never reads `x.mp3.mp3`.
- Name clashes never overwrite: `name.mp3`, `name (2).mp3`, and so on.
- Written under a temporary name first, then renamed, so a partial file never looks finished. The target path is reserved in `recordings.auto_export_target` before the write, so a restart adopts that file instead of writing a second copy.
- A failed write is retried on the next pass. After three failures the recording is left alone until the folder or format changes, which resets the count.
- A file this app exported in a format that no longer matches the setting is re-exported in the current format: the new file is written first, then the old one is removed. Only files still at the recorded path and still under the automatic name (the date, the AI title, or their ` (2)`-style variants) are replaced, so a name the user chose is never touched.
- A recording whose file the user moved or deleted stays marked as exported; it is not written again.
- Failures are logged and the same recording is retried on the next pass.

Test coverage: unit tests in `crates/oah/src/export/auto.rs`. The contract tests do not cover auto export; the folder behavior needs the desktop build and a writable local folder.

## Removed backup routes

The former full backup archives (`/api/backup`, its job routes and downloads) and scheduled backups are gone; those addresses answer `404`. Existing archive files and `export_jobs` rows are left untouched, and the retired `backupFrequency` and `backupFolder` settings are ignored.

## Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `INVALID_INPUT` (`field: "format"`) | Unknown export format. |
| 401 | `AUTH_SESSION_MISSING` | No session. |
