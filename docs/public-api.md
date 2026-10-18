# Public API

The public API lets your own scripts and tools read your library. It is read-only. It covers recordings, their transcripts, their summaries and their audio. It does not change anything.

- Base URL: `https://<your-host>/api/v1`. The host is the one you set as `APP_URL`.
- Keys: created through the settings API. See [Personal API keys](automation-and-webhooks.md#personal-api-keys).
- The Mac app serves the API only on your Mac. Programs on other machines cannot reach it.

- [Authentication](#authentication)
- [Rate limits](#rate-limits)
- [Errors](#errors)
- [Endpoints](#endpoints)
- [Recording fields](#recording-fields)

## Authentication

Send your key as a Bearer token on every request:

```http
Authorization: Bearer oah_...
```

A key is rejected with `401 UNAUTHORIZED` when it is missing, mistyped, revoked or expired. A suspended account gets `403 ACCOUNT_SUSPENDED`.

A signed-in browser session also works on this API. Scripts should use a key.

## Rate limits

Every request counts against two limits:

- **Per client address:** 1,200 requests per minute.
- **Per key:** 600 requests per minute. A signed-in session has its own limit of the same size.

When a limit is hit, the server answers `429 RATE_LIMITED` with these headers:

| Header | Meaning |
|---|---|
| `Retry-After` | Seconds to wait before you try again. |
| `X-RateLimit-Limit` | The limit that was hit. |
| `X-RateLimit-Remaining` | `0`. |
| `X-RateLimit-Reset` | The time the window resets, in Unix seconds. |

The client address comes from the connection. If the server is behind a proxy, see [Reverse proxy](self-hosting.md#reverse-proxy).

## Errors

Every error has the same shape:

```json
{
  "error": "Recording not found",
  "code": "RECORDING_NOT_FOUND",
  "details": { "id": "rec_123" }
}
```

`details` appears only when there is more to say. For a 500 error, `details.errorId` is the ID to quote when you report the problem. The server logs the same ID.

| Code | HTTP status | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | The key is missing, mistyped, revoked or expired. |
| `ACCOUNT_SUSPENDED` | 403 | The account is suspended. |
| `INVALID_INPUT` | 400 | A query parameter failed validation. `details.field` names it. |
| `RECORDING_NOT_FOUND` | 404 | The recording does not exist, was deleted, or is not yours. |
| `NOT_FOUND` | 404 | The recording has no transcript. |
| `RATE_LIMITED` | 429 | You hit a rate limit. |

## Endpoints

### List recordings

`GET /api/v1/recordings`

Lists your recordings, newest update first. Deleted recordings are not listed.

All query parameters are optional:

| Parameter | Values | Meaning |
|---|---|---|
| `limit` | 1 to 100 | Page size. Default 50. |
| `cursor` | the `next_cursor` from the last page | Starts the next page. |
| `created_since` | ISO timestamp | Only recordings created at or after this time. |
| `updated_since` | ISO timestamp | Only recordings updated at or after this time. |
| `has_transcription` | `true` or `false` | Only recordings with, or without, a transcript. |

The response:

```json
{
  "data": [
    {
      "id": "rec_123",
      "title": "Team standup",
      "created_at": "2026-10-16T18:00:00.000Z",
      "updated_at": "2026-10-16T18:55:40.000Z",
      "recorded_at": "2026-10-16T17:30:00.000Z",
      "duration_ms": 1820000,
      "filesize_bytes": 1234567,
      "device": { "serial_number": "ABC123", "name": "My recorder", "model": "Plaud Note" },
      "has_transcription": true,
      "has_summary": false,
      "links": {
        "self": "/api/v1/recordings/rec_123",
        "transcript": "/api/v1/recordings/rec_123/transcript",
        "audio": "/api/v1/recordings/rec_123/audio"
      }
    }
  ],
  "next_cursor": "5b...",
  "has_more": true
}
```

When `has_more` is `true`, pass `next_cursor` as `cursor` to get the next page. Stop when `has_more` is `false`. Treat the cursor as opaque.

```sh
curl -H "Authorization: Bearer oah_..." \
  "https://audio.example.com/api/v1/recordings?limit=20&has_transcription=true"
```

To read only what changed, keep the newest `updated_at` you have seen and send it as `updated_since` on the next run.

### Get a recording

`GET /api/v1/recordings/{id}`

Returns one recording with the same fields as the list, plus:

- `transcript`: the preferred transcript, or `null`. The preferred one is the source you choose in your settings, if the recording has it. Otherwise the server uses the OpenAudioHub transcript, then any other.
- `transcripts`: every transcript the recording has. Each one has `source`, `language`, `text`, `provider`, `model` and `created_at`.
- `summary`: the summary with `text`, `action_items`, `key_points`, `provider`, `model` and `created_at`, or `null`.

### Get the transcript

`GET /api/v1/recordings/{id}/transcript`

Returns only the preferred transcript. The response is one transcript object, or `404 NOT_FOUND` when the recording has none.

### Recording audio

`GET /api/v1/recordings/{id}/audio`

Returns the audio file as it is stored. Two cases:

- **Stored on disk.** The server sends the file. Range requests work, so you can fetch part of the file. The response can be cached privately for 5 minutes.
- **Stored in S3.** The server answers with a redirect to a signed link. The link works for 5 minutes, so follow it at once.

```sh
curl -L -H "Authorization: Bearer oah_..." -o standup.audio \
  "https://audio.example.com/api/v1/recordings/rec_123/audio"
```

## Recording fields

| Field | Meaning |
|---|---|
| `id` | The recording ID. |
| `title` | The current title. |
| `created_at`, `updated_at` | When the row was created, and last changed. |
| `recorded_at` | When the recording started. |
| `duration_ms` | Length of the audio in milliseconds. |
| `filesize_bytes` | Size of the stored audio file. |
| `device` | The Plaud device that made it. `null` when the device is not known, for example for uploads and merged recordings. |
| `has_transcription`, `has_summary` | Whether a transcript or summary exists. |
| `links` | Paths to the recording, its transcript and its audio. |
