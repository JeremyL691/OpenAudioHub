# Plaud

This module covers the Plaud connection: status, disconnect, the sign-in flows, the browser handoff, token storage and expiry, regions, manual and automatic sync, and the Plaud web API the app calls. The last section, "Plaud web API used", documents the third-party API as the app uses it, so a team can reimplement the client without the source.

Plaud's API is not public. Everything in the last section is what the app sends and reads today.

Environment variables are listed in [deployment.md](deployment.md). Error envelope and codes are in [errors.md](errors.md). Recording fields are in [recordings.md](recordings.md). Webhook events are in [webhooks.md](webhooks.md).

## Concepts

- **Connection.** One per user. It holds the encrypted long-lived Plaud user token, the API base, the Plaud account email (optional), the Plaud workspace id, a "needs reconnect" flag, and the last sync time.
- **Devices.** The Plaud devices seen when the account was connected. Stored per user, keyed by serial number.
- **Region.** The API base the connection talks to. Chosen at sign-in and stored with the connection.
- **Workspace token.** A short-lived token (about 24 hours) that the app mints from the user token for each sync run. It is never stored.

## Regions and API hosts

| Server key | Label | API base |
| --- | --- | --- |
| `global` | Global | `https://api.plaud.ai` (default) |
| `eu` | EU, Frankfurt | `https://api-euc1.plaud.ai` |
| `apse1` | Asia Pacific, Singapore | `https://api-apse1.plaud.ai` |
| `cn` | China mainland | `https://api.plaud.cn` |
| `custom` | Custom | any other allowed base |

An allowed base is an `https` URL whose host is `plaud.ai` or `plaud.cn`, or ends in `.plaud.ai` or `.plaud.cn`. Any other value is refused with `PLAUD_INVALID_API_BASE`.

Reported `server` in the connection status is the key that matches the stored base. Anything else reports `custom`, and the connection status then includes `apiBase`.

## GET /api/plaud/connection

Auth: session

Request: none

Response when not connected:

```json
{ "connected": false }
```

Response when connected:

```json
{
  "connected": true,
  "server": "global",
  "plaudEmail": "person@example.com",
  "needsReconnect": false,
  "tokenExpiresAt": "2026-08-01T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

- `plaudEmail` is `null` when no email was stored.
- `needsReconnect` is `true` after Plaud rejected the token during a sync, until the next successful sync or a reconnect.
- `tokenExpiresAt` is read from the token's expiry claim. It is `null` when the claim cannot be read or the stored token cannot be decrypted. The token itself is never returned.
- `apiBase` is included only when `server` is `custom`.

Errors: `401 AUTH_SESSION_MISSING` without a session. `403 ACCOUNT_SUSPENDED` for a suspended account.

Side effects: none.

## DELETE /api/plaud/connection

Auth: session

Request: none

Response: `200 {"success": true}`. Calling it when nothing is connected also succeeds.

Side effects: deletes the connection and all device rows for the user. Synced recordings stay in the library. The app does not call Plaud to revoke the token.

Errors: `401 AUTH_SESSION_MISSING`.

## Sign-in with an emailed code

Three steps, all against the signed-in account:

1. `POST /api/plaud/auth/send-code` with the email. The response carries an opaque `otpToken` and the `apiBase` that answered.
2. The user types the code from the email. The client sends `code`, `otpToken`, `apiBase`, and `email` to `POST /api/plaud/auth/verify`.
3. The connection is saved.

The app keeps nothing between steps 1 and 2 except what the client sends back.

### POST /api/plaud/auth/send-code

Auth: session

Request body:

| Field | Type | Rules |
| --- | --- | --- |
| `email` | string | Required. Trimmed. Must not be empty after trimming. |

Response: `200`

```json
{ "success": true, "otpToken": "string", "apiBase": "https://api-euc1.plaud.ai" }
```

The first request always goes to the global base. If Plaud answers that the account lives in another region, the app repeats the request on that region's base. It does this at most three times. `apiBase` is the base that finally answered.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_REQUIRED_FIELD` | `email` is missing, blank, or the body is not valid JSON. `details.field` is `"email"`. |
| 400 | `PLAUD_API_ERROR` | Plaud refused the request. The message is Plaud's message. `details.plaudStatus` holds Plaud's status. |
| 502 | `PLAUD_REGION_REDIRECT_LOOP` | Plaud redirected more than three times. |
| 502 | `PLAUD_UPSTREAM_ERROR` | Plaud returned a server error after retries, or could not be reached. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: Plaud sends the code to the email address. The app stores nothing.

### POST /api/plaud/auth/verify

Auth: session

Request body:

| Field | Type | Rules |
| --- | --- | --- |
| `code` | string | Required, not empty. |
| `otpToken` | string | Required, not empty. From send-code. |
| `apiBase` | string | Required, not empty. Must be an allowed API base. |
| `email` | string | Optional. Stored lowercased. |

Response: `200 {"success": true, "devices": [...]}`. Each device is `{ "sn", "name", "model", "version_number" }`.

Order of work:

1. Plaud exchanges the code for a user token. Refused codes return `PLAUD_OTP_INVALID`.
2. If Plaud returned a workspace token instead, the request fails with `PLAUD_WORKSPACE_TOKEN_PASTED`.
3. The app validates the connection against Plaud (see "Connect checks" below). Nothing is saved if this fails.
4. The connection is saved or updated. Devices are upserted.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_REQUIRED_FIELD` | `code`, `otpToken`, or `apiBase` is missing or empty. |
| 400 | `PLAUD_INVALID_API_BASE` | `apiBase` is not an allowed base. |
| 400 | `PLAUD_OTP_INVALID` | Plaud refused the code. Message is Plaud's, or "Invalid verification code". |
| 502 | `PLAUD_WORKSPACE_TOKEN_PASTED` | Plaud returned a short-lived workspace token. |
| 401 | `PLAUD_INVALID_TOKEN` | Plaud rejected the new token during validation. |
| 502 | `PLAUD_UPSTREAM_ERROR` | Plaud is unavailable. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: creates or updates the connection. The stored email is the lowercased `email` from the request, or `null` when none was sent, so reconnecting without an email clears it. The "needs reconnect" flag is cleared. Devices are upserted by serial number.

### POST /api/plaud/auth/connect-token

Auth: session

Paste flow. The user copies an account token from the Plaud web app and submits it. Used by the desktop app and by users who cannot use the browser extension.

Request body:

| Field | Type | Rules |
| --- | --- | --- |
| `accessToken` | string | Required. A leading `Bearer ` is removed. Surrounding spaces are trimmed. |
| `apiBase` | string | Optional. Default is the global base. Must be an allowed base. |
| `source` | string | Optional. Written to the server log as sent. `unknown` is logged when it is absent. |

Checks, in this order. The first failure wins:

1. Empty value: `400 MISSING_REQUIRED_FIELD`, `details.field` is `"accessToken"`.
2. Not three dot-separated parts: `400 INVALID_INPUT`, `details.field` is `"accessToken"`. The message tells the user where to copy the token from.
3. Workspace token (its claims include `ut_ref` or `wid`): `400 PLAUD_WORKSPACE_TOKEN_PASTED`, with the message that points to the account cookie.
4. Expired (expiry claim in the past): `400 PLAUD_INVALID_TOKEN`.
5. `apiBase` not allowed: `400 PLAUD_INVALID_API_BASE`.

Then the app fetches the account email (best effort) and runs the same connect checks and save as verify.

Response: `200 {"success": true, "devices": [...]}`.

Errors: the codes above, plus `401 PLAUD_INVALID_TOKEN` when Plaud rejects the token during validation, and `401 AUTH_SESSION_MISSING`.

Side effects: as verify. The token signature is never checked locally.

### Browser handoff

Used by the desktop app and by the Web settings page. The app asks the server for a one-time code, opens the connect page with the code, and waits. The page receives the token from the browser extension and completes the handoff.

#### POST /api/plaud/auth/handoff

Auth: session

Request: none

Response: `200 {"code": "<43 characters>", "expiresAt": 1700000000000}`. `expiresAt` is epoch milliseconds, ten minutes from now. The code is 32 random bytes encoded as base64url.

Each user can hold five live codes. Creating a sixth drops the user's oldest code.

Errors: `401 AUTH_SESSION_MISSING`.

#### GET /api/plaud/auth/handoff?code=

Auth: session

Query: `code` (required, trimmed).

Response: `200 {"status": "pending" | "connected" | "expired"}`. When the last complete attempt failed, the response also has `"error": "<message>"`.

A code that belongs to another user, an unknown code, and an expired code all return `{"status": "expired"}`. Existence is not revealed.

Errors: `400 MISSING_REQUIRED_FIELD` when `code` is missing. `401 AUTH_SESSION_MISSING`.

#### DELETE /api/plaud/auth/handoff?code=

Auth: session

Query: `code` (required).

Response: `200 {"success": true}`. Only the owner's code is removed. Other codes are left alone and the response is the same.

Errors: `400 MISSING_REQUIRED_FIELD`. `401 AUTH_SESSION_MISSING`.

#### POST /api/plaud/auth/handoff/complete

Auth: none. The one-time code in the body is the authorization.

Headers: `sec-fetch-site` must be exactly `same-origin`. Anything else is refused, which is the CSRF guard.

Request body:

| Field | Type | Rules |
| --- | --- | --- |
| `code` | string | Required. |
| `accessToken` | string | Required, not blank. |
| `apiBase` | string | Optional. Same rules as connect-token. |

Checks, in this order:

1. Header not `same-origin`: `403 FORBIDDEN`, message "Cross-site requests are not allowed".
2. Code missing, unknown, expired, or already connected: `410 PLAUD_HANDOFF_EXPIRED`, message "This sign-in link has expired. Start again from the OpenAudioHub app."
3. `accessToken` missing or blank: `400 MISSING_REQUIRED_FIELD`, `details.field` is `"accessToken"`.
4. The token is connected for the code's owner, with the same checks and save as connect-token (source `browser-extension`). Errors from those checks are returned to the caller. The message is also stored on the code, and the code stays pending so the user can retry until it expires.

Response on success: `200 {"success": true}`. The code cannot be used again. Later status checks report `connected` until the code expires.

Side effects: the connection is created or updated for the code's owner.

### Connect page

#### GET /connect/plaud

Auth: none

Query: `code` (optional). The page reads the one-time code from it.

Response: `200` HTML. The title is "Connect Plaud | OpenAudioHub". The page is marked `noindex, nofollow`. The head contains `<meta name="openaudiohub-plaud-connect" content="1">`, which the browser extension checks before it delivers a sign-in.

The page has one of these views. Every view uses these test ids: `connect-start`, `connect-waiting`, `connect-success`, `connect-error`, `connect-error-text`, `connect-install-link`.

- **Missing code.** The error text "This sign-in link is missing the authorization code. Please start again from OpenAudioHub." No other view is shown.
- **Start.** The title is "Connect Plaud to OpenAudioHub". Two steps follow: "1. Click the OpenAudioHub icon in your browser toolbar. If you do not see it, open the extensions menu." and "2. Choose Connect, then sign in to Plaud if asked." Below them is "Do not have the extension yet?" with the link "Download the browser extension" and the link "follow the install steps". The download link, test id `connect-install-link`, points to `https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip` and saves the zip. The install steps link opens `/docs/guides/browser-extension` on the same origin in a new tab.
- **Waiting.** The text "Waiting for Plaud sign-in. Finish signing in in the Plaud tab." The start view is hidden.
- **Success.** The text "Plaud is connected. You can close this tab and return to OpenAudioHub."
- **Failure.** The server's error message, or the failure text for the reason from [browser-extension.md](browser-extension.md). The page adds "Click the OpenAudioHub icon to try again." unless the failure text already ends with that sentence. The code stays pending on the server, so the user can try again until it expires.

The page listens for messages from the extension. It accepts a message only when all of these are true: `event.source` is the page window, `event.origin` equals `location.origin`, `data.app` is `"openaudiohub-extension"`, and `data.protocol` is `1`. The message shapes and failure texts are in [browser-extension.md](browser-extension.md).

- A `waiting` message shows the waiting view.
- A `token` message posts `{ "code": "<code>", "accessToken": "<token>", "apiBase": "<base>" }` to `POST /api/plaud/auth/handoff/complete` on the same origin. The page handles one token at a time. After a success it ignores later messages.
- A `failed` message shows the failure view.

The page's Content Security Policy is `default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'`. The page has an inline script, so it allows inline scripts. It makes no request except the handoff complete call.

### Browser extension

The browser extension hands the Plaud sign-in to the page. It is built and released with the app. Its build, manifest, popup, flow, token rules and message contract are in [browser-extension.md](browser-extension.md).

The page does not talk to the extension directly. The extension posts the messages above with `window.postMessage`, and it can do that on any page that carries the connect page meta element.

## Token storage, expiry, and reconnect

- The account token is encrypted at rest with the server's encryption key. No endpoint returns it, and it is not written to logs.
- Plaud issues the account token with a 24-hour expiry (read from its `exp` claim). The server never refreshes it.
- The desktop build refreshes it in the background while the app runs (see [desktop.md](desktop.md) section 10.3): a hidden window loads the Plaud site on the web session saved by the interactive sign-in, and the token it hands out is posted to `connect-token` with source `desktop-refresh`. Other builds do not refresh; when Plaud refuses the stored token, the user reconnects.
- A 401 during sync stamps the connection as needing reconnect. Rows and recordings are kept. Reconnecting (any sign-in path) saves a new token and clears the flag.
- Workspace tokens are minted from the account token at the start of each sync run and kept in memory only. If minting fails for any reason, the run uses the account token instead.
- Pasted workspace tokens are refused everywhere, because they cannot be renewed.

## Connect checks

Run by every sign-in path before anything is saved.

1. Find the personal workspace: list workspaces and pick the one with type `"0"`, falling back to the first. If listing fails or the account has no workspace, continue without a workspace id.
2. Validate the account: when a workspace was found, mint a workspace token for it and fetch the device list with that token. Otherwise fetch the device list with the account token. If minting the workspace token fails, the request fails with `PLAUD_WORKSPACE_UNAVAILABLE`. A refusal of the device list is returned to the caller (`PLAUD_INVALID_TOKEN` when Plaud rejects the token). Nothing is saved.
3. Save the connection and upsert devices in one transaction.

## Manual sync

### POST /api/plaud/sync

Auth: session

Request: none

Rate limit: per user, fixed window of 60 seconds. Default 10 calls per window. The server setting `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE` changes it. Every call counts, including calls for users with no connection. The count is kept in process memory.

Response: `200`

```json
{
  "success": true,
  "newRecordings": 2,
  "updatedRecordings": 0,
  "errors": [],
  "needsReconnect": false
}
```

- `inProgress: true` is added when the call joined a sync for the same user that was already running in the same process. Its counts are that run's counts.
- Sync problems do not give an HTTP error. They appear in `errors` (see "Sync errors"). For example, a user with no connection gets `"errors": ["No Plaud connection found"]`.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 429 | `RATE_LIMITED` | Too many calls in the window. Body: `{"error", "code", "details": {"retryAfter", "limit", "remaining", "resetAt"}}` where `resetAt` is epoch seconds. Headers: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |
| 401 | `AUTH_SESSION_MISSING` | No session. |
| 403 | `ACCOUNT_SUSPENDED` | Suspended account. |

### What a sync run does

1. Load the connection. If there is none, stop with `"No Plaud connection found"`.
2. Load the user's sync settings. Defaults: `autoTranscribe` false, `importPlaudContent` false, `transcriptMode` `plaud_only`, `recordingTitleMode` `ai`, email and Bark notifications off.
3. Open a client to the stored base with the stored workspace id, or look up the personal workspace when none is stored. Mint a workspace token, or use the account token if minting fails.
4. Page through the recording list (see "Listing recordings"). Process each recording in batches of five at once. A failure on one recording does not stop the others. Each recording is deduplicated and written (see "Matching and dedupe"), and Plaud content is imported for it when `importPlaudContent` is on (see "Plaud content import").
5. Send notifications when new recordings arrived, if the user turned them on (see "Notifications").
6. If `autoTranscribe` is on, queue a transcription job for each new recording. Under `plaud_only`, recordings that already have a Plaud transcript are not queued. A job also skips any recording that already has a transcript of any source when it runs (`workers.md`, section 4).
7. Set the connection's last sync time to now, clear the "needs reconnect" flag, and update the stored workspace id if one was found. This step runs only when the list was read without a failure. Failed recordings do not prevent it.
8. Return the counts and errors.

Exporting is not part of the run. Recordings added by the run are marked for the automatic export schedule (see [export.md](export.md)); recordings that were already there are not.

### Listing recordings

- Plaud's recording list is requested sorted by edit time, newest first, with trashed recordings excluded.
- Pages of 50 recordings. Stop when a page has fewer than 50 recordings, or a page is empty.
- Stop after two consecutive pages that have no new recording, no updated recording and no imported content.
- A failure to read a page stops the run with the error text in `errors`. The last sync time is not updated in that case.

### Field mapping

Plaud recording to the OpenAudioHub recording row:

| Plaud field | Recording field | Notes |
| --- | --- | --- |
| `id` | `plaudFileId` | Unique per user. |
| `filename` | `filename` | Stored encrypted, returned decrypted. On insert, replaced by `YYYY-MM-DD` (server local time) when `recordingTitleMode` is `date`, and kept as Plaud's name when the recording has no start time. On update, set to Plaud's name only while the stored title is still the original one; a date, generated, hand-edited or unknown title is kept. |
| `duration` (ms) | `duration` | Milliseconds. |
| `start_time` (epoch ms) | `startTime` | |
| `end_time` (epoch ms) | `endTime` | |
| `filesize` | `filesize` | Plaud's value, not the size of the stored file. |
| `file_md5` | `fileMd5` | |
| `serial_number` | `deviceSn` | Not joined to the devices table. |
| `version_ms` | `plaudVersion` | Stored as a string. Used for change detection. |
| `timezone` | `timezone` | |
| `zonemins` | `zonemins` | |
| `scene` | `scene` | |
| `is_trash` | `isTrash` | |
| `is_trans`, `is_summary` | not stored | Used only to decide whether content import is needed. |

Set on every write: `downloadedAt` (now), `storageType` (the configured default), and `storagePath` (the audio object key).

Not stored: `keywords`, `filetag_id_list`, `edit_time`, `ori_ready`, `version`, `fullname`, `filetype`, `edit_from`.

The audio is downloaded in its original form (`is_opus=0`, see the Plaud web API section). The file extension and content type come from sniffing the bytes. Plaud often labels Ogg/Opus files as `.mp3`, so the sniffed type wins.

The audio is downloaded when the recording is first added. A later Plaud version only refreshes metadata: the stored audio object, its path, `downloadedAt` and the waveform are kept, so a rename or an edit in Plaud never re-downloads or replaces the file. The one exception is a stored object that is gone: the audio is downloaded again, because otherwise the recording stays unplayable.

The object key is `<userId>/<plaudFileId>.<ext>`. If another recording of the same user already holds that key, ` (2)`, ` (3)`, and so on are added before the extension, up to 100 tries.

### Matching and dedupe

Each Plaud recording matches an existing row by `(user, plaudFileId)`.

1. **Deleted here.** If the row is deleted (tombstoned), skip it. No download happens, even when Plaud's version changed. A recording deleted in OpenAudioHub is never imported again.
2. **Unchanged.** If `version_ms` equals the stored `plaudVersion`, skip it. No download happens. Content import can still fill gaps for it (see below).
3. **Changed.** Overwrite the row's metadata with Plaud's values. The stored audio is not downloaded again. The row keeps its id and its title unless the title is still the original one (see "Field mapping"). The recording is counted under `updatedRecordings`.
4. **New.** Download the audio, store it, and insert the row. Counted under `newRecordings`.

A concurrent delete during a download wins. The row is not revived, and the downloaded object is removed.

Sync never deletes rows and never deletes audio. A recording removed or trashed in Plaud stays in the library.

### Devices

Devices are written when the account is connected (every sign-in path). Sync does not change them. Disconnect removes them. The device list is not refreshed during sync.

### Plaud content import

When `importPlaudContent` is on, sync also fills gaps from Plaud's own transcript and summary. It never overwrites an existing transcript or summary.

- A transcript is imported when the recording has no Plaud transcript yet. It is stored with source `plaud`, provider `plaud`, model `plaud-native`. No webhook event is sent for it. When the import adds a transcript and auto-summarize is on with no summary yet, an automatic summary job is queued once (`workers.md`, section 5). A repeated sync does not queue another.
- A summary is imported when the recording has no summary with content yet. It is stored with source `plaud`. The inline copy is preferred over the presigned link.
- Items must be ready (`task_status` equal to 1) and have a link.
- If the account token is refused during this pass, the pass stops. Other failures skip one item. Audio already synced is kept.

### Sync errors

Entries in `errors` are plain text. They can include a recording's name.

| Text | When |
| --- | --- |
| `No Plaud connection found` | No connection. |
| `Failed to sync <filename>: <error>` | One recording failed. The name is the recording's Plaud name, or its Plaud id when it has none. |
| `Plaud rejected the stored token. Reconnect your Plaud account.` | Plaud refused the token. `needsReconnect` is `true`. The connection is stamped and the run stops. |
| `Sync failed: Plaud is temporarily unavailable. Please try again later.` | Plaud server errors after retries. The connection's last sync time is not updated. |
| `Sync failed: Too many requests to Plaud. Please try again later.` | Plaud rate limit after retries. Last sync not updated. |
| `Sync failed: <message>` | Any other failure of the run. Last sync not updated. |
| `Plaud content import stopped: access token expired` | Token refused during content import. |
| `Plaud content import failed for <fileId>: <error>` | One content item failed. |

### Notifications

When new recordings arrived and the user turned them on (`emailNotifications` and `barkNotifications` settings):

- Email to the notification address (the user's setting, or the account email), with the count and the new names.
- Bark push to the user's Bark URL, with the count and the new names.

A failed email or Bark push is logged only. It does not appear in `errors`, and the sync result is not changed.

The open page also reports the recordings a sync added, with a toast, a system notification and a chime (see [workers.md](workers.md)).

### Events

For each new recording: `recording.synced`. For each updated recording: `recording.updated`. See webhooks.md.

## Auto sync

Two mechanisms run the same routine as manual sync.

### Server worker

- Starts with the server. The first tick runs 30 seconds after start. Later ticks run every `BACKGROUND_SYNC_INTERVAL_MS` (default 300000, allowed range 60000 to 3600000).
- Turned off by `BACKGROUND_SYNC_ENABLED=false`. Default on.
- Each tick claims up to 20 users. A user is claimed when they have a connection, the account is not suspended, and their last sync is null or more than 4 minutes old. The oldest last sync goes first, and never-synced users come first.
- Each claimed user is synced one after another. A run for one user that takes longer than 10 minutes is abandoned, and an error for one user is logged. The tick then continues. A tick never overlaps the previous one in the same process.
- The worker skips users whose connection needs reconnect. They are picked up again once a reconnect clears the flag. A manual sync for such a user still runs. If Plaud still rejects the token, the response is `200` with the rejection text in `errors` and `needsReconnect` true.

Unattended sync works without any browser open.

### Browser poller

The web app's shell calls `POST /api/plaud/sync` while a page is open and the connection is set up. Its behavior, from the client:

| Option | Default | Behavior |
| --- | --- | --- |
| sync on mount | on | One quiet sync when the app shell loads. Off when `syncOnMount` is `false`. |
| interval | 5 minutes | Sync at this interval. The settings offer 1, 2, 5, 10, 15 and 30 minutes. The value is never less than 1 minute. Ticks are skipped while the page is hidden. |
| enabled | on | Off when `autoSyncEnabled` is `false`. |

Quiet syncs show no toast on success or failure. A sync is not started while another sync from the same page is running.

The interval and on/off are saved as user settings: `syncInterval` (milliseconds), `autoSyncEnabled`, `syncOnMount`, `syncOnVisibilityChange`, `syncNotifications`. The client does not act on `syncOnVisibilityChange`; it is stored only. Browser storage is not used for these settings.

The worker skips users synced in the last 4 minutes, so a recent browser sync also keeps the worker from running for that user.

## Rate limits

| Limit | Value | Scope |
| --- | --- | --- |
| Manual sync | 10 calls per 60 seconds (`PLAUD_SYNC_RATE_LIMIT_PER_MINUTE`, range 1 to 600) | Per user |
| Plaud calls | Up to 3 retries (see below) | Per request |
| Sync listing | 50 per page | Per run |
| Recordings processed at a time | 5 | Per run |
| Worker | 20 users per tick | Per process |

Retries against Plaud: a 429 waits the `Retry-After` seconds, or 1, 2, then 4 seconds. A 5xx or a network failure waits 1, 2, then 4 seconds. After three retries a 429 becomes `PLAUD_RATE_LIMITED`, and a 5xx or network failure becomes `PLAUD_UPSTREAM_ERROR`.

## Errors

Every error uses the standard envelope (see [errors.md](errors.md)). Codes used by this module:

| Code | Status | `details` | When |
| --- | --- | --- | --- |
| `AUTH_SESSION_MISSING` | 401 | | No session. |
| `ACCOUNT_SUSPENDED` | 403 | | Account suspended. |
| `FORBIDDEN` | 403 | | Handoff complete from another site. |
| `MISSING_REQUIRED_FIELD` | 400 | `field` | A required field is missing or blank. |
| `INVALID_INPUT` | 400 | `field` | Token is not a JWT shape. |
| `PLAUD_API_ERROR` | 400 | `plaudStatus` | Plaud refused a request. |
| `PLAUD_OTP_INVALID` | 400 | `plaudStatus` | Plaud refused the code. |
| `PLAUD_INVALID_API_BASE` | 400 | | Base not allowed. |
| `PLAUD_INVALID_TOKEN` | 401 (400 for expired at connect) | `plaudStatus`, `plaudMessage` | Plaud rejected the token. |
| `PLAUD_WORKSPACE_TOKEN_PASTED` | 400 (502 at verify) | `field` | Workspace token given. |
| `PLAUD_WORKSPACE_UNAVAILABLE` | 400 | `plaudStatus` | Plaud refused the request for a workspace token during connect. |
| `PLAUD_REGION_REDIRECT_LOOP` | 502 | | More than three regional redirects. |
| `PLAUD_UPSTREAM_ERROR` | 502 | | Plaud server error or unreachable. |
| `PLAUD_RATE_LIMITED` | 429 | `retryAfter` | Plaud rate limit after retries. |
| `PLAUD_HANDOFF_EXPIRED` | 410 | | Handoff code unknown, expired, or used. |
| `RATE_LIMITED` | 429 | `retryAfter`, `limit`, `remaining`, `resetAt` | Manual sync limit. |

## Test-only override: OAH_PLAUD_API_BASE

`OAH_PLAUD_API_BASE` is a server environment variable for contract tests. It is not for production. When it is set to an origin such as `http://127.0.0.1:3298`:

- That origin replaces the global base for sign-in, so send-code starts there.
- That origin is accepted as an allowed base in verify, connect-token, handoff complete, and the stored connection. Plain `http` is accepted for that origin only.
- Regional redirects on that origin keep working.
- The connection status reports `custom` for it.

When it is not set, behavior is exactly as described above.

The Plaud contract tests run against a fake Plaud API (`contract-tests/fakes/fake-plaud.mjs`). The test run starts it on a fixed local port and points the server at it with this variable. The fake has test-only control routes.

## Plaud web API used

The app calls Plaud over HTTPS. Plaud is the third-party service. Hosts are the regional bases in the table above, plus the presigned download hosts Plaud returns (for example `resource.plaud.ai`). Paths below are relative to the stored API base unless a full URL is given.

### Headers on Plaud calls

- `User-Agent`: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`. Set on API calls. Presigned downloads and content links send no User-Agent from the app.
- `Content-Type: application/json` on JSON API calls.
- `Authorization: Bearer <token>` on calls that need auth. The token is the workspace token when one is in use, otherwise the account token. Sign-in calls and presigned downloads have no `Authorization` header.

### Plaud status convention

Most JSON responses carry a `status` field alongside HTTP 200. `status: 0` means success. Any other value is a business error with a `msg`. The one exception is `status: -302` on the OTP send, which means "try this regional base" (see below).

HTTP errors are mapped as: 401 means the token is rejected, 429 means rate limited, 5xx means upstream, other 4xx means an API error with Plaud's `msg`. A body that is not JSON is mapped the same way by status.

### 1. POST {global}/auth/otp-send-code

- Host: `https://api.plaud.ai` on the first attempt; then the regional base from the redirect.
- Body: `{"username": "<email>"}`
- Reads: `status`, `msg`, `token`, `data.domains.api`.
- Region: `status: -302` with `data.domains.api` means repeat the request on that base, with the same body. At most three repeats.
- Success: `status: 0` with `token`.
- Failure: `status` not 0, or no `token`, gives `PLAUD_API_ERROR` with `msg`.
- Retries: none. Errors from this call are not retried.

### 2. POST {base}/auth/otp-login

- Body: `{"code": "<6 digits>", "token": "<otpToken>"}`
- Reads: `access_token`, or `data.access_token` when the first is missing.
- Failure: no token gives `PLAUD_OTP_INVALID` with `msg`.
- Retries: none.

### 3. GET {base}/user/me

- Auth: account token.
- Reads: `email`, or `data.email`. Lowercased.
- Best effort. Any failure leaves the email empty.

### 4. GET {base}/team-app/workspaces/list?need_personal_workspace=true

- Auth: account token.
- Reads: `status`, `msg`, `data.workspaces[]` with `workspace_id` and `workspace_type`. `"0"` is the personal workspace.
- Failure during connect: continues without a workspace id.
- Failure during a sync: the workspace is looked up again on the next run.

### 5. POST {base}/user-app/auth/workspace/token/{workspace_id}

- Auth: account token.
- Body: `{}`
- Reads: `status`, `msg`, `data.workspace_token`. The token is about 24 hours.
- Failure: a 401 is never stale and leads to using the account token. Other 4xx lead to a fresh workspace lookup. Any failure during a run leads to the account token for that run.

### 6. GET {base}/device/list

- Auth: workspace token when one is in use, otherwise the account token.
- Reads: `status`, `msg`, `data_devices[]` with `sn`, `name`, `model`, `version_number`.
- Validation: `status` must be 0 and `data_devices` must be an array. Otherwise `PLAUD_API_ERROR`.
- Used at connect time to validate the token.

### 7. GET {base}/file/simple/web?skip={n}&limit={n}&is_trash=0&sort_by=edit_time&is_desc=true

- Auth: workspace token when one is in use.
- Paging: `skip` is page index times 50. `limit` is 50.
- Reads: `data_file_total`, `data_file_list[]`. Each recording has `id`, `filename`, `duration`, `start_time`, `end_time`, `filesize`, `file_md5`, `serial_number`, `version_ms`, `timezone`, `zonemins`, `scene`, `is_trash`, `is_trans`, `is_summary`, `edit_time`.
- Retries: 429, 5xx, and network failures, as described above.

### 8. GET {base}/file/temp-url/{file_id}?is_opus=0

- Auth: workspace token when one is in use.
- Sync always asks for the original format (`is_opus=0`).
- Reads: `temp_url`. The optional `temp_url_opus` is used only when `is_opus=1`, which the app does not request during sync.
- Retries: as for other API calls.

### 9. GET {temp_url} (presigned download)

- No `Authorization` header.
- Reads the response body as the audio file.
- One attempt. Any non-2xx response fails that recording with `PLAUD_UPSTREAM_ERROR`.

### 10. GET {base}/file/detail/{file_id}

- Auth: workspace token when one is in use.
- Used only when content import is on and something is missing.
- Reads: `data.content_list[]` with `data_id`, `data_type`, `task_status`, `data_link`. Transcript items have `data_id` starting `source_transaction:` or type `transaction`. Summary items have `data_id` starting `auto_sum:` or type `auto_sum_note`. Also reads `data.pre_download_content_list[]` with `data_id` and `data_content` (a JSON string holding the summary inline).
- Retries: as for other API calls.

### 11. GET {data_link} (presigned content)

- No `Authorization` header. One attempt.
- The body may be gzip-compressed. It is detected by its first two bytes.
- Transcript body: a JSON array of segments with `start_time`, `end_time`, `speaker`, `content`. Each segment becomes a line of text, prefixed with `Speaker <n>:` when speaker is a number.
- Summary body: an object with `ai_content` (or `summary`, or `content`), and optionally `key_points` (or `keyPoints`, `highlights`) and `action_items` (or `actionItems`, `todos`).
- Not checked against a live Plaud response: the transcript segment body shape. The fake Plaud API used by the contract tests follows this description.

### 12. PATCH {base}/file/{file_id}

- Auth: workspace token when one is in use.
- Body: `{"filename": "<title>"}`
- Used only when the user chooses to send an AI-generated title back to Plaud. Failure is logged and does not change the local title.
- Reads: `status`.

### Direct calls

All Plaud calls go directly from the server to the Plaud host. The app has no outbound proxy for Plaud calls.
