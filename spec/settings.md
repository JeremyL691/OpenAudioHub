# Settings

This module covers the user settings record, storage usage, the test email, the email
and Bark notification settings, personal API keys, and the public API under `/api/v1`
that those keys authenticate.

The web app has no pages for API keys or webhooks. The server still serves the API
routes for both; the settings paths `/settings/api-keys` and `/settings/webhooks`
give the not-found page. Webhook routes are described in `webhooks.md`. API keys are described in
"API keys" below.

## Common rules

- Errors use one envelope: `{ "error": "<message>", "code": "<CODE>", "details": { ... } }`.
  `details` is present only when there is something to add. Clients branch on `code`.
- Any response with status 500 or higher adds `details.errorId`, in the form `err_`
  followed by 8 hexadecimal characters.
- Routes under `/api/settings/*` use the session cookie unless a section says otherwise.
  API keys are not accepted on them.
- Unauthenticated calls get `401 AUTH_SESSION_MISSING`.

---

## User settings

### GET /api/settings/user

Auth: session. Response `200`, one flat object.

Every field in the table below is always present, with its stored value or its default.
These are also always present: `barkPushUrl` (null when unset), `barkPushUrlSet`,
`userEmail` and `lastScheduledBackupAt`. `summaryPrompt` is present only after it has
been set.

```json
{
  "autoTranscribe": false,
  "syncInterval": 300000,
  "theme": "system",
  "marketingEmailConsent": false,
  "barkPushUrl": null,
  "barkPushUrlSet": false,
  "userEmail": "person@example.com",
  "lastScheduledBackupAt": null
}
```

Read-only fields:

- `barkPushUrlSet`: `true` when a Bark push URL is stored.
- `userEmail`: the account email.
- `lastScheduledBackupAt`: completion time (ISO 8601) of the latest scheduled backup, or
  null.

Encrypted fields (`summaryPrompt`, `titleGenerationPrompt`, `barkPushUrl`) are returned
decrypted.

### PUT /api/settings/user

Auth: session. Request: a JSON object. Every field is optional. Omitted fields keep their
stored value. Unknown fields, including read-only ones, are ignored.

Response: `200 { "success": true }`. Read the new state with GET.

Errors:

- `400 INVALID_INPUT`, message `Request body must be a JSON object`, when the body is not
  a JSON object (including invalid JSON). No `details.field`.
- `400 INVALID_INPUT`, message `Invalid value for <field>`, `details.field` set to the
  field name, for each field rule below.
- `401 AUTH_SESSION_MISSING`.

Check order: the fields are checked in the order they appear in the body. Then
`autoGenerateTitle` is set from `recordingTitleMode` if that field is present. Then the
two folder fields are checked, then `autoExport`. The first failing rule gives the error.

Side effects: updates the settings record. Turning `autoExport` on in the desktop app
starts its export window at once (see `export-backup.md`). Settings are read by background
jobs on their next run.

#### Fields

Stored value types follow the JSON types in the table. "Any JSON" means the value is stored
as sent, without a check.

| Field | Type | Default | Allowed values and rules |
|---|---|---|---|
| `autoTranscribe` | boolean | `false` | |
| `autoSummarize` | boolean | `false` | |
| `autoSummarizePreset` | any JSON | `null` | not checked |
| `syncInterval` | number (milliseconds) | `300000` | must be a number |
| `autoSyncEnabled` | boolean | `true` | |
| `syncOnMount` | boolean | `true` | |
| `syncOnVisibilityChange` | boolean | `true` | |
| `syncNotifications` | boolean | `true` | |
| `defaultPlaybackSpeed` | number | `1` | must be a number |
| `defaultVolume` | number | `75` | must be a number |
| `autoPlayNext` | boolean | `false` | |
| `playerScrubber` | string | `"waveform"` | `waveform`, `slider` |
| `defaultTranscriptionLanguage` | any JSON | `null` | not checked; a blank string means no language hint |
| `transcriptionQuality` | string | `"balanced"` | `fast`, `balanced`, `accurate` |
| `speakerDiarization` | boolean | `true` | boolean |
| `diarizationSpeakerCount` | integer or null | `null` | integer 1 to 32, or null. Non-integers such as `2.5` and strings are rejected |
| `dateTimeFormat` | string | `"relative"` | `relative`, `absolute`, `iso` |
| `recordingListSortOrder` | string | `"newest"` | `newest`, `oldest`, `name` |
| `itemsPerPage` | number | `50` | must be a number |
| `listDensity` | string | `"comfortable"` | `comfortable`, `compact` |
| `theme` | string | `"system"` | `light`, `dark`, `system` |
| `autoDeleteRecordings` | boolean | `false` | |
| `retentionDays` | number or null | `null` | number or null |
| `browserNotifications` | boolean | `true` | |
| `notificationSound` | boolean | `true` | |
| `defaultExportFormat` | string | `"json"` | `json`, `txt`, `srt`, `vtt` |
| `autoExport` | boolean | `false` | `true` only in the desktop app, and only when `autoExportFolder` is set |
| `autoExportFolder` | string or null | `null` | desktop app only. A string must name an existing, writable folder |
| `autoExportFormat` | string | `"mp3"` | `mp3`, `original` |
| `autoExportTitleMode` | string | `"original"` | `original`, `date`, `ai` |
| `backupFrequency` | string or null | `null` | any string or null; values not checked |
| `backupFolder` | string or null | `null` | desktop app only. A string must name an existing, writable folder |
| `defaultProviders` | object or null | `null` | object or null; contents not checked |
| `onboardingCompleted` | boolean | `false` | |
| `autoGenerateTitle` | boolean | `true` | boolean. Ignored when `recordingTitleMode` is in the same request |
| `recordingTitleMode` | string | `"ai"` | `original`, `date`, `ai`. Sets `autoGenerateTitle` to true only for `ai` |
| `syncTitleToPlaud` | boolean | `false` | |
| `aiOutputLanguage` | string or null | `null` | null, or one of `en`, `zh`, `ja`, `ko`, `fr`, `de`, `es`, `it`, `pt`, `ru`, `ar`, `hi`, `nl`, `sv`, `pl`, `tr`, `vi`, `th`, `id`. Stored lowercase |
| `importPlaudContent` | boolean | `false` | |
| `transcriptMode` | string | `"plaud_only"` | `plaud_only`, `keep_both` |
| `preferredTranscriptSource` | string | `"plaud"` | `plaud` or `openaudiohub` |
| `titleGenerationPrompt` | string or null | `null` | string or null. Stored encrypted |
| `summaryPrompt` | object or null | absent | object or null. An object may hold `selectedPrompt` (string) and `customPrompts` (array of objects with string `id`, `name`, `prompt` and `createdAt`). Other keys are kept. `null` removes the setting. Stored encrypted |
| `marketingEmailConsent` | boolean | `false` | boolean. A non-boolean value is ignored without an error. Stored in the settings record |
| `emailNotifications` | boolean | `false` | see "Notifications" |
| `notificationEmail` | string or null | `null` | string or null, not checked as an address. When empty or unset, the account email is used |
| `barkNotifications` | boolean | `false` | see "Notifications" |
| `barkPushUrl` | string or null | `null` | string or null. Stored encrypted. Null or a blank string clears it. Not checked as a URL here |

Errors for the rules above are `400 INVALID_INPUT` with `details.field` set to the field:

- a value outside the allowed set, or of the wrong JSON type;
- `titleGenerationPrompt` or `barkPushUrl` that is not a string or null;
- `summaryPrompt` that is not null and fails the shape check (a plain string fails);
- `aiOutputLanguage` that is not in the list above;
- `diarizationSpeakerCount` outside 1 to 32.

Folder and export rules (desktop app only):

- `autoExportFolder` or `backupFolder` set to a string on a server that is not the desktop
  app: `400`, `details.field` set to that field, `Invalid value for <field>`.
- The same fields on the desktop app: the folder must exist and not be read-only. Otherwise
  `400`, same shape.
- `autoExport: true` on a server that is not the desktop app: `400`, `details.field` =
  `autoExport`, message `Auto export is only available in the desktop app`.
- `autoExport: true` on the desktop app with no export folder stored: `400`,
  `details.field` = `autoExport`, message `Choose an export folder in the desktop app first`.

---

## Storage

### GET /api/settings/storage

Auth: session. Response `200`:

```json
{
  "storageType": "local",
  "usedBytes": 12608,
  "recordingCount": 1,
  "totalDurationMs": 3096,
  "largest": [
    {
      "id": "recording-id",
      "filename": "2026-10-16",
      "filesize": 12608,
      "duration": 3096,
      "startTime": "2026-10-16T18:43:10.841Z"
    }
  ],
  "diskFreeBytes": 123456789,
  "quotaBytes": null
}
```

- `storageType` is `local` or `s3`, from the server configuration.
- `usedBytes`, `recordingCount` and `totalDurationMs` cover the account's recordings that
  are not deleted. `usedBytes` is the sum of file sizes. `totalDurationMs` is the sum of
  durations in milliseconds.
- `largest` lists up to 5 of those recordings, largest file first (ties by id, descending).
  `filename` is decrypted. `startTime` is ISO 8601.
- `diskFreeBytes` is the free space on the local storage volume. It is `null` for `s3`,
  and also when the free space cannot be read.
- `quotaBytes` is always `null`.
- An account with no recordings reads zero counts, `largest: []`.

Side effects: none.

### Storage configuration

Set in the environment only:

| Variable | Meaning | Default |
|---|---|---|
| `DEFAULT_STORAGE_TYPE` | `local` or `s3`. Any other value stops startup | `local` |
| `LOCAL_STORAGE_PATH` | Folder for recording files and work files | `<data dir>/storage` |
| `S3_ENDPOINT` | Optional endpoint for S3-compatible services. Leave unset for AWS | unset |
| `S3_BUCKET` | Bucket name | unset |
| `S3_REGION` | Region | unset |
| `S3_ACCESS_KEY_ID` | Access key | unset |
| `S3_SECRET_ACCESS_KEY` | Secret key | unset |

With `DEFAULT_STORAGE_TYPE=s3`, the S3 client is created only when `S3_BUCKET`,
`S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are all set. Without it,
storage operations fail. The settings GET still answers, with `storageType: "s3"`.
Requests use path-style addressing.

---

## Notifications

Email and Bark notifications are sent by the sync worker (see `workers.md`). The settings
that control them are the fields in the table above.

- `emailNotifications` turns email on. The address is `notificationEmail`, or the account
  email when that is empty.
- `barkNotifications` turns Bark push on. The push URL is `barkPushUrl`, stored encrypted.
  It must be an absolute `http` or `https` URL, or the push is not sent. Requests have a
  3-second timeout. The URL is never logged, because it holds the device key.
- `barkPushUrlSet` tells the client whether a push URL is stored.

### POST /api/settings/test-email

Auth: session. Request: `{ "email": "address@example.com" }`.

- The address is trimmed. It must not be empty, and it must be a plain address: at most
  254 characters, no whitespace, exactly one `@`, a non-empty local part, and a domain with
  a dot and no empty labels.
- Each account may send 5 test emails per 10 minutes. The limit is checked after the
  address check, so every valid request counts, whether or not the mail is sent.

Response: `200 { "success": true }` when the SMTP server accepts the message. Nothing is
stored.

Errors:

- `400 MISSING_REQUIRED_FIELD`, `details.field` = `email`: missing, not a string, blank
  after trimming, or the body is not JSON.
- `400 INVALID_INPUT`, `details.field` = `email`: the address is not a plain address.
- `401 AUTH_SESSION_MISSING`.
- `429 RATE_LIMITED`: the limit above is reached. The body and headers follow the rate
  limit shape in "Rate limits" below.
- `500 SMTP_NOT_CONFIGURED`: SMTP is not configured.
- `500 SMTP_AUTH_FAILED`: the SMTP server refused the login.
- `500 EMAIL_SEND_FAILED`: any other send failure.

SMTP configuration, from the environment:

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | Server host |
| `SMTP_PORT` | Port number. Default 465 when `SMTP_SECURE` is `true`, otherwise 587 |
| `SMTP_SECURE` | Exactly `true` for implicit TLS. Otherwise STARTTLS is used |
| `SMTP_USER` | Login name |
| `SMTP_PASSWORD` | Login password |
| `SMTP_FROM` | Sender, `user@example.com` or `Name <user@example.com>`. Default: `SMTP_USER`, else `OpenAudioHub <noreply@host>` with the host of `APP_URL` |
| `SMTP_REPLY_TO` | Optional Reply-To, same formats as `SMTP_FROM` |

Email counts as configured when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are all set.
Sending times out after 30 seconds.

---

## API keys

Personal API keys are bearer credentials for `/api/v1`. They grant read access only.
Keys are created and revoked only through the routes below. The web app has no page for
them.

### GET /api/settings/api-keys

Auth: session. Response `200 { "apiKeys": [ ... ] }`, newest first by `createdAt` (ties by
id, descending). Revoked keys stay in the list.

Each item:

```json
{
  "id": "string",
  "name": "string",
  "keyPrefix": "oah_9HqIjU87",
  "source": "manual",
  "scopes": ["read"],
  "lastUsedAt": "2026-10-16T18:43:11.126Z",
  "expiresAt": null,
  "revokedAt": null,
  "createdAt": "2026-10-16T18:43:10.676Z"
}
```

- `keyPrefix` is the first 12 characters of the key.
- The full key and its stored hash are never returned after creation.
- `lastUsedAt` is set when the key authenticates on `/api/v1`, before that response is
  sent.

### POST /api/settings/api-keys

Auth: session. Request (JSON object):

| Field | Rules |
|---|---|
| `name` | Required. Trimmed. Must not be empty. At most 120 characters |
| `expiresAt` | Optional. An ISO 8601 timestamp in the future. `null` or `""` means no expiry |

A `scopes` field is ignored. Every key has the scope `["read"]`.

Response: `201`

```json
{
  "key": "oah_9HqIjU870dHRkCMnX0LBT45uMw7jfq1HUS",
  "apiKey": {
    "id": "string",
    "name": "string",
    "keyPrefix": "oah_9HqIjU87",
    "source": "manual",
    "scopes": ["read"],
    "lastUsedAt": null,
    "expiresAt": null,
    "revokedAt": null,
    "createdAt": "2026-10-16T18:43:10.676Z"
  }
}
```

`key` is returned only in this response. `source` is `manual` for keys created here.

Errors:

- `400 MISSING_REQUIRED_FIELD`, `details.field` = `name`: missing or blank.
- `400 INVALID_INPUT`, `details.field` = `name`: longer than 120 characters.
- `400 INVALID_INPUT`, `details.field` = `expiresAt`: not a string, not a timestamp, or not
  in the future.
- A body that is not JSON is refused before the handler runs, with a plain-text 400 or 415.

Side effects: one key row. Only the keyed hash and the prefix are stored.

### DELETE /api/settings/api-keys/{id}

Auth: session. Response `200 { "success": true }`. The key stops working at once: `/api/v1`
calls with it get `401 UNAUTHORIZED`. The key stays in the list with `revokedAt` set. A
second delete of the same key also returns `200`, and `revokedAt` keeps its first value.

Errors:

- `404 NOT_FOUND`, `details.id`, message `API key not found`: no key with that id belongs
  to the signed-in account. Another account's key gets the same response.
- `401 AUTH_SESSION_MISSING`.

### Key format

- A key is `oah_` followed by 34 characters: 30 random base62 characters, then a 4-character
  checksum. Total length 38.
- Base62 alphabet, in this order: `0-9`, `A-Z`, `a-z`. Random characters are drawn uniformly
  from it (random bytes of 248 or more are discarded).
- Checksum: take the CRC-32 (IEEE, reflected, polynomial `0xEDB88320`, initial value all
  ones, final bit inversion) of the ASCII text `oah_` plus the 30 random characters. Write
  the unsigned 32-bit result in base62, most significant digit first. Pad with leading `0`
  to 4 characters, or keep only the first 4 characters if longer. Those 4 characters are
  the checksum.
- Authentication does not check the checksum. It is for format checks by clients.

### Key storage

- The server stores `HMAC-SHA256(secret, key)` as 64 lowercase hexadecimal characters,
  where `key` is the full key text including `oah_`. The key itself is never stored.
- The secret is `API_TOKEN_HASH_SECRET`, which must be at least 32 characters when set.
  An empty value counts as unset.
- When it is unset, the secret is derived from `ENCRYPTION_KEY`. Keys therefore keep
  working across restarts.
- Changing the secret makes every stored key stop authenticating.
- The server also accepts an alternative variable name for this setting. It is not
  documented here.

---

## Public API: /api/v1

Base URL: `{host}/api/v1`. All routes are `GET`. Any other method on these paths gets
`405` with an empty body.

### Authentication

Send the key in a header:

```http
Authorization: Bearer oah_...
```

- The scheme word is matched without regard to case, and the token is trimmed.
- A token that starts with `oah_` or `op_` is checked as an API key. If it is unknown,
  revoked or expired, the response is `401 UNAUTHORIZED`, message `Unauthorized`.
- If the key's account is suspended, the response is `403 ACCOUNT_SUSPENDED`, message
  `Account suspended`.
- Without a key, a valid session cookie is accepted. It sees the same data as the account.
- Otherwise: `401 UNAUTHORIZED`, message `Unauthorized`.

Keys only ever grant read access.

### Rate limits

Three buckets, each a fixed 60-second window that starts with its first request:

- Per client IP: 1200 requests per minute. Counted for every `/api/v1` request, before
  authentication.
- Per key: 600 requests per minute, counted after the key is authenticated.
- Per signed-in account (session): 600 requests per minute.

The client IP comes from forwarding headers only when `RATE_LIMIT_TRUST_PROXY_HEADERS` is
`true`. Otherwise all clients share the bucket for the IP `unknown`.

When a bucket is full:

- status `429`, `code` `RATE_LIMITED`, message `Rate limit exceeded`;
- `details`: `{ "retryAfter": <seconds>, "limit": <number>, "remaining": 0, "resetAt": <unix seconds> }`;
- headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
  with the same values.

### GET /api/v1/recordings

Auth: key or session. Query parameters:

| Name | Type | Rules |
|---|---|---|
| `limit` | integer | 1 to 100. Default 50. Otherwise `400`, `details.field` = `limit` |
| `cursor` | string | Value from `next_cursor`. Anything else is `400`, `details.field` = `cursor` |
| `created_since` | ISO 8601 timestamp | Only recordings created at or after this time |
| `updated_since` | ISO 8601 timestamp | Only recordings updated at or after this time |
| `has_transcription` | `true` or `false` | Filters on whether a transcript exists. Otherwise `400` |

Invalid timestamps give `400 INVALID_INPUT` with `details.field` set to the parameter name.

Response: `200`

```json
{
  "data": [ { "id": "string", "...": "recording objects" } ],
  "next_cursor": "string or null",
  "has_more": true
}
```

- Order: `updated_at` descending, then `id` descending. Deleted recordings are never listed.
- To get the next page, send `next_cursor` back as `cursor`. It is `null` on the last page.

Recording object:

```json
{
  "id": "string",
  "title": "string",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "recorded_at": "ISO 8601",
  "duration_ms": 3096,
  "filesize_bytes": 12608,
  "device": { "serial_number": "string", "name": "string or null", "model": "string or null" },
  "has_transcription": false,
  "has_summary": false,
  "links": {
    "self": "/api/v1/recordings/{id}",
    "transcript": "/api/v1/recordings/{id}/transcript",
    "audio": "/api/v1/recordings/{id}/audio"
  }
}
```

- `title` is the decrypted recording title. `recorded_at` is the recording's start time.
- `device` is null when the recording has no known device, meaning neither a name nor a
  model is recorded for it.

### GET /api/v1/recordings/{id}

Auth: key or session. Response `200`: the recording object, plus:

- `transcript`: the primary transcript, or null.
- `transcripts`: every transcript of the recording, newest first, possibly `[]`.
- `summary`: null, or `{ "text", "action_items", "key_points", "provider", "model", "created_at" }`.
  `action_items` and `key_points` are arrays of strings, or null.

Primary transcript: the one whose source equals the account's `preferredTranscriptSource`
(default `plaud`). If there is none, the account's own (`openaudiohub`) transcript. If there
is none, the newest one.

Transcript object: `{ "source", "language", "text", "provider", "model", "created_at" }`.
`language` may be null.

Errors: `404 RECORDING_NOT_FOUND`, message `Recording not found`, `details.id`, when the
recording does not exist, is deleted, or belongs to another account.

### GET /api/v1/recordings/{id}/transcript

Auth: key or session. Response `200` with the primary transcript object.

Errors:

- `404 RECORDING_NOT_FOUND`, as above.
- `404 NOT_FOUND`, message `Transcript not found`, `details.id`, when the recording has no
  transcript.

### GET /api/v1/recordings/{id}/audio

Auth: key or session. Response, local storage: `200` with the file bytes.

- `Content-Type` from the file extension, `Content-Length` the file size,
  `Accept-Ranges: bytes`, and `Cache-Control: private, max-age=300`.
- A `Range` header of the form `bytes=START-END` or `bytes=START-` returns `206` with that
  part, `Content-Length` of the part, and `Content-Range: bytes START-END/SIZE`. An END past
  the end of the file is clamped to the last byte.
- A start at or past the file size returns `416`, `Content-Range: bytes */SIZE`, and the body
  `{ "error": "Invalid range", "code": "INVALID_INPUT", "details": { "range", "fileSize" } }`.
- A range of any other form (for example `bytes=-500`, several ranges, or a malformed
  value) is ignored, and the whole file is returned with `200`.

Response, object storage: `302` redirect to a pre-signed GET URL valid for 300 seconds, with
`Cache-Control: private, max-age=300`. The storage provider then serves the bytes.

Errors: `404 RECORDING_NOT_FOUND`, as above.

---

## Not covered by tests

- SMTP delivery and Bark pushes. The test server has no SMTP server and no push endpoint.
  The contract suite checks only the test email's error responses and its address rules.
- Desktop-app behaviour of the folder fields and auto export.
- S3 storage, including presigned audio redirects.
- The values accepted for `backupFrequency`, and the contents of `defaultProviders`.
