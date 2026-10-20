# Webhooks

A webhook is an HTTP `POST` that OpenAudioHub sends to a URL the user chose when something happens to one of the user's recordings. This file covers endpoint management, which URLs are accepted, secrets, the events, the JSON body, the headers and signature, delivery attempts, retries, the delivery log, and manual redelivery.

The web app has no Webhooks settings page. Endpoints are managed through the API below only.

Contract tests: `contract-tests/tests/webhooks.spec.ts`.

## Endpoints

All endpoints use the session cookie `oah_session`. API keys (the `/api/v1` bearer tokens) are not accepted on these routes.

Every error has the shape `{ "error": "<message>", "code": "<CODE>" }`. Validation errors also carry `details.field`, the name of the field that failed.

Base path: `/api/settings/webhooks`.

### GET /api/settings/webhooks
Auth: session
Request: none
Response: status `200`
```json
{
  "webhooks": [
    {
      "id": "abc123",
      "url": "https://hooks.example.com/openaudiohub",
      "secret": "whsec_****x7Qa",
      "events": ["recording.updated", "transcription.completed"],
      "description": "Automation",
      "enabled": true,
      "lastDeliveryAt": "2026-10-16T18:50:25.000Z",
      "lastDeliveryStatus": "success",
      "createdAt": "2026-10-16T18:40:00.000Z",
      "updatedAt": "2026-10-16T18:40:00.000Z"
    }
  ],
  "events": ["recording.synced", "recording.updated", "recording.deleted", "transcription.completed", "transcription.failed", "summary.completed", "summary.failed"]
}
```
- `webhooks` holds only this user's endpoints, newest first (by `createdAt`).
- `events` is the full catalog, in the order shown. It is the same on every call.
- `lastDeliveryAt` and `lastDeliveryStatus` are `null` until the first attempt. `lastDeliveryStatus` is `"success"` or `"failed"`, set by the most recent attempt on the endpoint.

Errors: `401 AUTH_SESSION_MISSING` when not signed in.
Side effects: none.

### POST /api/settings/webhooks
Auth: session
Request body:
- `url`: string, required. Validated as described in [URL rules](#url-rules).
- `events`: array of strings, required. Validated as described in [Events](#events).
- `description`: string, optional. Trimmed and cut to 200 characters. A blank string or a non-string value stores `null`.
- `enabled`: boolean, optional, default `true`. A non-boolean value is ignored and the default applies.

Response: status `201`
```json
{
  "webhook": { "id": "abc123", "url": "https://hooks.example.com/openaudiohub", "secret": "whsec_****x7Qa", "events": ["recording.updated"], "description": null, "enabled": true, "lastDeliveryAt": null, "lastDeliveryStatus": null, "createdAt": "2026-10-16T18:40:00.000Z", "updatedAt": "2026-10-16T18:40:00.000Z" },
  "secret": "whsec_<32 characters>"
}
```
- `secret` is the full signing secret. It is returned only in this response. Later reads show the masked form.
- The `url` in the response is the normalized URL the server stores (for example, a bare host gets a trailing `/`).
- `events` keeps the given order, with duplicates removed (first occurrence kept).

Errors:
- `400 INVALID_INPUT` with `details.field` = `url` when `url` is missing, not a string, empty, not an absolute URL, not HTTP or HTTPS, or contains a username or password. Also when the strict target rules reject it (see [URL rules](#url-rules)).
- `400 INVALID_INPUT` with `details.field` = `events` when `events` is missing, not an array, empty, or contains a value that is not in the catalog. The message lists the unknown names. The message text can change.
- `401 AUTH_SESSION_MISSING` when not signed in.

Side effects: one endpoint row is stored. The URL and secret are stored encrypted.

### PATCH /api/settings/webhooks/{id}
Auth: session
Request body (every field optional):
- `url`: string. Same rules as POST. `null` is rejected as "URL is required".
- `events`: array of strings. Same rules as POST. The stored list is replaced, not merged.
- `enabled`: boolean. Any other value (including `null`) gives `400 INVALID_INPUT` with `details.field` = `enabled`.
- `description`: string or `null`. A blank string or a non-string value clears it to `null`.

Fields not listed are ignored. The `secret` cannot be changed through this endpoint, and sending `secret` has no effect.

Response: status `200`
```json
{ "webhook": { "id": "abc123", "url": "https://hooks.example.com/two", "secret": "whsec_****x7Qa", "events": ["recording.deleted", "summary.failed"], "description": "moved", "enabled": false, "lastDeliveryAt": null, "lastDeliveryStatus": null, "createdAt": "...", "updatedAt": "..." } }
```

Errors:
- `400 INVALID_INPUT` for an invalid `url`, an invalid `events` value, or a non-boolean `enabled`.
- `404 NOT_FOUND` with message "Webhook not found" when the id is unknown or belongs to another user.
- `401 AUTH_SESSION_MISSING` when not signed in.

Side effects: the endpoint row is updated. Deliveries already queued are not changed. Each one is checked again before it is sent (see [Delivery attempts](#delivery-attempts)).

### DELETE /api/settings/webhooks/{id}
Auth: session
Request: none
Response: status `200`, body `{ "success": true }`

Errors: `404 NOT_FOUND` with message "Webhook not found" when the id is unknown or belongs to another user. `401 AUTH_SESSION_MISSING` when not signed in.

Side effects: the endpoint row and all of its delivery rows are removed. No further attempts are made for it.

### GET /api/settings/webhooks/{id}/deliveries
Auth: session
Request: none
Response: status `200`
```json
{
  "deliveries": [
    {
      "id": "d9Kq2",
      "event": "recording.updated",
      "status": "success",
      "attempts": 1,
      "lastAttemptAt": "2026-10-16T18:40:31.000Z",
      "nextAttemptAt": "2026-10-16T18:40:31.000Z",
      "lastResponseStatus": 200,
      "lastResponseBody": null,
      "lastError": null,
      "createdAt": "2026-10-16T18:40:30.000Z",
      "updatedAt": "2026-10-16T18:40:31.000Z"
    }
  ]
}
```
- Only deliveries of this endpoint, newest first (by `createdAt`), at most 100.
- `status` is one of `pending`, `processing`, `success`, `dead`.
- `lastResponseBody` is the first 4096 characters of the receiver's reply. It is stored only when `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true` (see [URL rules](#url-rules) and `workers.md`). Otherwise it is always `null`.
- The payload itself is not returned.

Errors: `404 NOT_FOUND` when the endpoint is unknown or belongs to another user. `401 AUTH_SESSION_MISSING` when not signed in.

### POST /api/settings/webhooks/{id}/deliveries/{deliveryId}/redeliver
Auth: session
Request: none
Response: status `200`, body `{ "success": true }`

Behavior:
- Sets the delivery to `pending` with `nextAttemptAt` now, and sends it right away. `attempts` is not reset.
- Works for any delivery that is not `processing`, including `success` and `dead`.
- The same delivery id is used in the header, and `delivered_at` keeps its original value. The `data` object is rebuilt from the recording as it is at send time.

Errors:
- `404 NOT_FOUND` with message "Webhook not found" when the endpoint is unknown or belongs to another user.
- `409 CONFLICT` with message "Webhook is disabled" when the endpoint is disabled. Nothing is sent.
- `409 CONFLICT` with message "Delivery is already processing" when an attempt is in progress.
- `404 NOT_FOUND` with message "Delivery not found" when the delivery is unknown, or belongs to a different endpoint or user.
- `401 AUTH_SESSION_MISSING` when not signed in.

Side effects: one delivery row is updated.

## URL rules

1. The value must be a string. It is trimmed, then parsed as an absolute URL. Anything else is `INVALID_INPUT`.
2. The scheme must be `http:` or `https:`.
3. The URL must not contain a username or password.
4. The stored and returned URL is the normalized form. Path and query are kept.
5. Redirects are not followed when delivering. A 3xx reply is a failed attempt.
6. Lenient policy (`WEBHOOKS_REQUIRE_PUBLIC_TARGETS=false`): any HTTP or HTTPS host is accepted, including `localhost`, loopback and private addresses. This is the default in the desktop app, and the shared contract-test server runs with it.
7. Strict policy (`WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true`), the default on a server, checked on create, on update, and again at each send:
   - The scheme must be `https:`.
   - The host must not be `localhost`, must not end in `.localhost`, `.local`, `.internal`, `.home.arpa` or `.lan`, and must not be an IP literal in a non-public range.
   - The host name must resolve, and every resolved address must be public. Otherwise create and update return `INVALID_INPUT` with `details.field` = `url`. At send time the attempt fails permanently and the delivery becomes `dead`.
   - The request is sent to the addresses checked at send time.
   - The request is sent directly, without an environment proxy, so the proxy cannot resolve the host a second time and reach a different address.
   - Non-public IPv4 ranges: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0.0/24, 192.0.2.0/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and above. Non-public IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`. IPv4-mapped IPv6 addresses use the IPv4 rules, and so does the IPv4 address inside NAT64 `64:ff9b::/96` and 6to4 `2002::/16`. Other addresses are public. A host name that cannot be resolved fails the check.
   - At startup the server counts the stored targets this policy refuses and logs one warning with the count when there are any. The startup check reads only the URL, so a name that resolves to a private address is not counted there.

## Secrets

- Each endpoint gets a secret when it is created. The form is `whsec_` followed by 32 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`.
- The full secret is returned once, by the create response.
- Every later read returns the masked form: `whsec_****` followed by the last 4 characters of the secret. Example: `whsec_****x7Qa`.
- PATCH cannot change the secret. There is no rotation endpoint. Rotating a secret means deleting the endpoint and creating a new one.
- DELETE removes the secret.

## Events

| Event | Fires when |
|---|---|
| `recording.synced` | A Plaud sync creates a new recording. |
| `recording.updated` | A recording is renamed through `PATCH /api/recordings/{id}`, or an existing recording is updated by a Plaud sync. |
| `recording.deleted` | `DELETE /api/recordings/{id}` marks a recording as deleted. |
| `transcription.completed` | A transcript is saved for a recording, by any transcription path. |
| `transcription.failed` | A transcription attempt fails with a provider error, or a background pipeline job fails. Its payload has an `error` object. |
| `summary.completed` | An automatic summary is saved. Summaries made by hand through the summary endpoint do not send this event. |
| `summary.failed` | An automatic summary fails, or the hourly automatic-summary limit is reached. Its payload has an `error` object. |

Rules:
- An event creates one delivery for each enabled endpoint of the recording's owner that subscribes to the event. Disabled endpoints and endpoints that do not list the event get nothing.
- Events are not replayed for endpoints created later.
- The event is recorded when it happens. The endpoint list is read at that moment, so a later change to an endpoint does not change deliveries already recorded.
- An event that cannot be recorded is logged and dropped. The request that caused it still succeeds.

## Payload

Every delivery body is one JSON object, sent as compact JSON (no extra whitespace). Top-level keys, in this order:

```json
{
  "event": "recording.updated",
  "delivered_at": "2026-10-16T18:40:30.512Z",
  "data": { "...recording detail, see below..." }
}
```

- `event`: the event name.
- `delivered_at`: the time the event was recorded, in UTC ISO 8601 with milliseconds. It is fixed when the event is recorded and does not change on retries or redelivery.
- `error`: present only for failure events, as `{ "message": "<text>" }`. Absent otherwise. The text is not part of the contract.

### `data` object

`data` is the recording detail. It is built when each attempt is sent. Keys, in this order:

| Key | Type | Notes |
|---|---|---|
| `id` | string | Recording id. |
| `title` | string | Recording name. |
| `created_at`, `updated_at`, `recorded_at` | ISO string | |
| `duration_ms`, `filesize_bytes` | integer | |
| `device` | object | `{ "serial_number", "name", "model" }`. `name` and `model` may be null. Always an object, even for recordings with no known device. |
| `has_transcription`, `has_summary` | boolean | |
| `links` | object | `self`, `transcript`, `audio`. Absolute URLs under the server's public URL (`APP_URL`), for example `http://localhost:3210/api/v1/recordings/{id}`, with `/transcript` and `/audio` appended. |
| `transcript` | object or null | See below. |
| `summary` | object or null | See below. |
| `api_url` | string | Same value as `links.self`. |
| `deleted_at` | ISO string | Present only for `recording.deleted`. |

Rules for `transcript`:
- It is `null` when the recording has no transcript.
- Otherwise: `{ "source", "preview", "truncated", "length", "language", "provider", "model", "created_at" }`. `source` is `"openaudiohub"`.
- `preview` is the first 500 characters of the full text. `length` is the length of the full text. `truncated` is `true` when `length` is greater than 500.
- The full transcript text is never sent.

Rules for `summary`:
- It is `null` when the recording has no summary.
- Otherwise: `{ "text", "action_items", "key_points", "provider", "model", "created_at" }`.
- `text` is the full summary text, not truncated.
- `action_items` and `key_points` are JSON arrays of strings. They are never objects.

For `recording.deleted`, `data.transcript` and `data.summary` are `null`, and `deleted_at` is set. Other fields are the recording as it was when the attempt was sent.

If the recording can no longer be read when the attempt is made, no request is sent. The delivery becomes `dead` with `lastError` "Recording is no longer available".

## Headers

Every attempt is a `POST` to the endpoint URL. The path and query are kept. These headers are sent, with these exact names:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Content-Length` | Byte length of the body. |
| `User-Agent` | `OpenAudioHub-Webhooks/1` |
| `X-OpenAudioHub-Event` | The event name. |
| `X-OpenAudioHub-Delivery` | The delivery id. Same value for every attempt and every redelivery of that delivery. |
| `X-OpenAudioHub-Timestamp` | Unix time in whole seconds, decimal, taken when this attempt is sent. |
| `X-OpenAudioHub-Signature` | Lowercase hex HMAC-SHA256 digest (see below). |

### Signature

- Algorithm: HMAC-SHA256.
- Key: the endpoint's full secret, as UTF-8 bytes (including the `whsec_` prefix).
- Signed string: the decimal timestamp from `X-OpenAudioHub-Timestamp`, then a `.` (0x2E), then the body bytes exactly as sent. Nothing is added or removed.
- The header value is the lowercase hex digest. There is no `t=` or `v1=` prefix.

Example of verification (pseudocode):
```
expected = hex( HMAC_SHA256(key = secret_utf8, message = ascii(timestamp) + "." + raw_body_bytes) )
valid    = |now - timestamp| <= 300 and constant_time_equal(expected, signature_header)
```

Receivers should:
- Verify over the raw bytes received, before parsing JSON.
- Reject timestamps more than 300 seconds from their clock.
- Compare in constant time.

## Delivery attempts

- The worker checks for due deliveries every 30 seconds. It also runs as soon as an event is recorded. A redelivery request sends the delivery at once.
- One run handles at most 50 deliveries, and at most 10 for any one user.
- A delivery is claimed for 15 minutes while it is being sent. A claim that is not finished in that time may be taken again.
- Before each send the endpoint must still be enabled. If it is disabled, the delivery goes back to `pending` with no request sent, and the worker tries it again on a later run.
- Success means the receiver replies with a status from 200 to 299. Anything else is a failed attempt.
- The timeout is 10 seconds from the start of the request. A request with no complete reply in that time fails with `lastError` "Webhook delivery timed out".
- Network errors fail the attempt. `lastError` holds the error text; the exact text is not part of the contract.
- Each attempt sets `lastAttemptAt` and increases `attempts` by 1.
- A successful attempt sets the delivery to `success`, clears `lastError`, and sets the endpoint's `lastDeliveryStatus` to `"success"`.
- A failed attempt sets `lastResponseStatus` (or `null` if there was no reply), sets `lastError` to `"HTTP <status>"` for a non-2xx reply (for example `"HTTP 500"`), and sets the endpoint's `lastDeliveryStatus` to `"failed"`.
- The first 4096 characters of the reply body are stored in `lastResponseBody` only under the strict policy. Under the lenient policy it stays `null`. The response body is kept only in strict mode so that a delivery to a private address cannot be used to read that address back through the API. See `workers.md`.

### Retry schedule

After a failed attempt number `n`, the next attempt is scheduled for:

| Failed attempt | Next attempt after |
|---|---|
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 10 minutes |
| 4 | 1 hour |
| 5 | 6 hours |
| 6 | No more attempts. Status becomes `dead`. |

- The delay is measured from the time of the failed attempt.
- A permanent failure sets `dead` at once. Permanent failures are: the recording is gone, the stored payload, URL or secret cannot be read or is invalid, the URL fails the strict-mode checks at send time, and a payload cannot be built.

### Auto-disable

There is no automatic disabling. Repeated failures never set `enabled` to `false`. Only the user can disable an endpoint.

## Deliveries

- A delivery is one event for one endpoint. Its `status` moves `pending` -> `processing` -> `success`, or `pending` -> `processing` -> `pending` (after a failure, with a later `nextAttemptAt`), or ends at `dead`.
- `pending` with `attempts` 0 is a delivery that has not been sent yet.
- `dead` deliveries are never sent again on their own. They can be redelivered by hand.
- Deleting an endpoint deletes its deliveries.

## Redelivery

Covered in [POST .../redeliver](#post-apisettingswebhooksiddeliveriesdeliveryidredeliver). Redelivery uses the same delivery id, so receivers that de-duplicate on `X-OpenAudioHub-Delivery` see it as a repeat.

## Tests

`contract-tests/tests/webhooks.spec.ts` checks:
- Create, list, patch, delete, validation, session checks, ownership checks.
- The signed headers and signature, and the `recording.deleted` payload, with a successful delivery to a local receiver.
- A `summary.completed` payload from an automatic summary, with `action_items` and `key_points` as JSON arrays.

Not covered by the contract tests:
- `recording.synced`, `recording.updated`, `transcription.completed`, `transcription.failed`.
- Event filtering and disabled endpoints.
- Retry schedule, `HTTP 500` and reply body capture, 3xx as a failure, 10-second timeout, dead after the sixth attempt.
- Redelivery, including its 409 and 404 cases.
- Strict-mode URL rules.
- The 100-delivery cap on the list and the per-run limits (50 and 10).
- The 15-minute claim lease.
