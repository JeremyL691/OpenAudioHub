# Errors

This file describes the error response shape used by the `/api` routes and lists the codes the server sends. Clients branch on `code`. The `error` text is for people and can change between versions. Each area file says which codes its own routes can return, and this file gives the statuses and meanings for all of them.

## Envelope

Errors use one envelope:

```json
{ "error": "<message>", "code": "<CODE>", "details": { ... } }
```

- `details` is an object. It is left out when there is nothing to add. When present, it holds fields for the code, such as `field` (the request field at fault), `retryAfter` (seconds to wait), `plaudStatus` (the status Plaud returned), or `id` (the id that was not found).
- Any response with status 500 or higher adds `details.errorId`, in the form `err_` followed by 8 hexadecimal characters. The same id is written to the server log next to the cause. The cause is never sent to the client.
- The password reset routes also send the message in a `message` field, with the same text as `error`.

Some responses do not use the envelope:

- The audio pipeline action responses at `/api/recordings/{id}/audio-pipeline` send only `{ "error": "<message>" }`, with no `code` and no `details`. See `transcription.md`.
- The password reset link redirects with `?error=INVALID_TOKEN` in the query string when the token is not valid. It has no JSON body.

Background jobs also store a failure code on the job record. Those codes, such as `PIPELINE_RETRY` in `audio-pipeline.md`, are not error responses and are not listed here. A code that is also an error response is listed below.

## Codes

The table lists the status each code uses in an error response. A code can use more than one status. Codes are grouped by area, and a group with no codes of its own says where its codes come from.

### Auth

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `ACCOUNT_SUSPENDED` | 403 | The account is suspended. Sent for session calls and for API key calls. |
| `AUTH_SESSION_MISSING` | 401 | No signed-in session. |
| `INVALID_EMAIL_OR_PASSWORD` | 401 | Wrong password, or no account with this email. |
| `INVALID_HOST` | 403 | Desktop session exchange with a Host header that does not match `APP_URL`. |
| `INVALID_ORIGIN` | 403 | A session cookie is present and the `Origin` header is another site. |
| `INVALID_TOKEN` | 400 | Password reset token is unknown, used, or expired. |
| `MISSING_OR_NULL_ORIGIN` | 403 | A session cookie is present and `Origin` is missing or `null`. |
| `PASSWORD_TOO_LONG` | 400 | Password is more than 256 bytes. |
| `PASSWORD_TOO_SHORT` | 400 | Password has fewer than 8 characters. |
| `REGISTRATION_DISABLED` | 403 | Sign-up is turned off, or the server runs in desktop mode. |
| `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` | 422 | An account with this email already exists. |
| `VALIDATION_ERROR` | 400 | A required sign-up, sign-in, or password reset field is missing. |

### Recordings

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `FILE_TOO_LARGE` | 413 | Upload is over 500 MB. |
| `INVALID_FILE_FORMAT` | 400 | Upload extension is not an accepted audio format. |
| `INVALID_FILE_FORMAT` | 422 | Upload has no readable audio stream, or a recording in a merge has no readable audio. |
| `RECORDING_NOT_FOUND` | 404 | Recording is unknown, deleted, or not the caller's. Also used when the audio file is missing. |
| `STORAGE_ERROR` | 500 | Recording audio could not be deleted, for a reason other than the file already being missing. |

### Transcription

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `NO_TRANSCRIPTION_PROVIDER` | 400 | No transcription provider can be chosen. |
| `TRANSCRIPTION_FAILED` | 413 | The audio pipeline is on and the recording is over 24 hours. |
| `TRANSCRIPTION_FAILED` | 500 | A provider, conversion, or pipeline step failed. The message comes from the provider or the pipeline. |

### AI and providers

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `AI_PROVIDER_API_ERROR` | 401 | The provider rejected the API key while the models were being listed. |
| `AI_PROVIDER_API_ERROR` | 502 | The provider returned an error, could not be reached, sent an unreadable reply, or failed a summary run. |
| `AI_PROVIDER_API_ERROR` | 504 | The provider did not answer in time. |
| `AI_PROVIDER_NOT_CONFIGURED` | 400 | No AI provider can make summaries. |
| `UPSTREAM_BAD_RESPONSE` | 502 | A summary run got no usable text from the model. |

### Plaud

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `FORBIDDEN` | 403 | The Plaud sign-in handoff request came from another site. |
| `PLAUD_API_ERROR` | 400 | Plaud refused a request. `details.plaudStatus` carries its status. |
| `PLAUD_HANDOFF_EXPIRED` | 410 | The sign-in handoff code is unknown, expired, used, or already connected. |
| `PLAUD_INVALID_API_BASE` | 400 | The Plaud API address is not allowed. |
| `PLAUD_INVALID_TOKEN` | 400 | The Plaud token has expired at connect. |
| `PLAUD_INVALID_TOKEN` | 401 | Plaud rejected the token. |
| `PLAUD_OTP_INVALID` | 400 | Plaud refused the one-time code. |
| `PLAUD_RATE_LIMITED` | 429 | Plaud kept rate limiting after retries. |
| `PLAUD_REGION_REDIRECT_LOOP` | 502 | Plaud sent more than three regional redirects. |
| `PLAUD_UPSTREAM_ERROR` | 502 | Plaud returned a server error, or could not be reached, after retries. |
| `PLAUD_WORKSPACE_TOKEN_PASTED` | 400 | A workspace token was pasted. The account token is needed instead. |
| `PLAUD_WORKSPACE_TOKEN_PASTED` | 502 | Plaud returned a short-lived workspace token at verify. |
| `PLAUD_WORKSPACE_UNAVAILABLE` | 400 | Plaud refused the workspace token request during connect. |

### Export

This group has no codes of its own. Export routes use `INVALID_INPUT` from the General group. See `export.md`.

### Webhooks

This group has no codes of its own. Webhook routes use `CONFLICT`, `INVALID_INPUT` and `NOT_FOUND` from the General group. See `webhooks.md`.

### Settings and API keys

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `EMAIL_SEND_FAILED` | 500 | The test email failed for a reason other than login or setup. |
| `SMTP_AUTH_FAILED` | 500 | The SMTP server refused the login. |
| `SMTP_NOT_CONFIGURED` | 500 | SMTP is not set up. |
| `UNAUTHORIZED` | 401 | A `/api/v1` call that is not authenticated, including an unknown or revoked API key. |

### General

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `CONFLICT` | 409 | The action is not allowed in the current state: the webhook is disabled, a delivery is already in progress, or an audio pipeline job is active for the recording. |
| `DATABASE_UNAVAILABLE` | 503 | The health check cannot reach the database. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. The cause is logged, not sent. `details.errorId` is set. |
| `INVALID_INPUT` | 400 | A request value is malformed or out of range. `details.field` usually names the field. Upload parse errors use the status the multipart parser gives. |
| `INVALID_INPUT` | 416 | The requested audio range cannot be satisfied. |
| `INVALID_INPUT` | 422 | A merged recording would be longer than 24 hours. |
| `MISSING_REQUIRED_FIELD` | 400 | A required field is missing or blank. `details.field` names it. |
| `NOT_FOUND` | 404 | Unknown `/api` path, or the item is unknown or belongs to another user. The message says which. |
| `NOT_FOUND` | 410 | The recording was deleted while a summary was being made. |
| `RATE_LIMITED` | 429 | Too many requests in the window. `details.retryAfter` gives the wait in seconds. |
