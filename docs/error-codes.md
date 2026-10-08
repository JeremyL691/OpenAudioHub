# Error codes

Every error response from the OpenAudioHub API has one shape:

```json
{
  "error": "Human-readable message, safe to display",
  "code": "MACHINE_READABLE_CODE",
  "details": { "optional": "structured context" }
}
```

## Exception: HTTP 416 on audio streaming

`GET /api/recordings/[id]/audio` returns a bare `416 Range Not Satisfiable` with a `Content-Range: bytes */<size>` header and no JSON body when a `Range` header is out of bounds. Media players read that header to recover, so this response is not wrapped in the envelope. No other failure from this route uses that exception.

## Contract

- **`error`** never contains stack traces, secrets, database details, or upstream payloads. It is safe to show to users. Its text can change between releases.
- **`code`** is stable, uses `SCREAMING_SNAKE_CASE`, and is grouped by domain. Never reuse a shipped value for something else. New values can be added, and an old value is deprecated before it is removed.
- **`details`** is optional, and it contains only named fields, never upstream objects. Examples are `{ "field": "email" }`, `{ "retryAfter": 30 }`, and `{ "plaudStatus": 422 }`.
- **`details.errorId`** is present on every response with a status of 500 or higher. It has the form `err_` followed by 8 hex characters, and it matches a `console.error` line in the server log. Show it to users so they can quote it in a bug report.

Clients should branch on `code`. Do not match on `error`.

## HTTP status

| Status | Meaning |
| ---: | --- |
| 400 | Invalid input, a missing field, or a rejection from Plaud |
| 401 | Not signed in, or upstream credentials were refused |
| 403 | Signed in, but not allowed |
| 404 | Resource not found |
| 409 | Conflict, or the resource already exists |
| 413 | Payload too large |
| 416 | Range not satisfiable (audio streaming) |
| 429 | Rate limited, by this server or by an upstream |
| 500 | Server error |
| 502 | An upstream returned a 5xx, or an unreadable body |
| 503 | Service unavailable, for example a background dependency is down |

## Auth

| Code | Status | When |
| --- | ---: | --- |
| `AUTH_SESSION_MISSING` | 401 | No session cookie was sent |
| `UNAUTHORIZED` | 401 | Alias of `AUTH_SESSION_MISSING`, kept for compatibility |
| `FORBIDDEN` | 403 | Signed in, but the resource is not yours or is not allowed |
| `ACCOUNT_SUSPENDED` | 403 | The account is suspended |

## Input

| Code | Status | `details` | When |
| --- | ---: | --- | --- |
| `INVALID_INPUT` | 400 | `{ field }` | A field is present but malformed |
| `MISSING_REQUIRED_FIELD` | 400 | `{ field }` | A required field is absent |
| `INVALID_FILE_FORMAT` | 400 | `{ field, expected }` | The uploaded file has the wrong format |

## Resource

| Code | Status | When |
| --- | ---: | --- |
| `NOT_FOUND` | 404 | The resource does not exist for this user |
| `CONFLICT` | 409 | The operation conflicts with the current state |
| `UNIQUE_CONSTRAINT_VIOLATION` | 409 | A unique database constraint rejected the write |

## Plaud

| Code | Status | `details` | When |
| --- | ---: | --- | --- |
| `PLAUD_NOT_CONNECTED` | 400 | | No Plaud connection is stored. The interface should start the connect flow. |
| `PLAUD_INVALID_TOKEN` | 401 | `{ plaudStatus, plaudMessage }` | Plaud rejected the access token. The user must reconnect. |
| `PLAUD_INVALID_API_BASE` | 400 | | The API base is not a `*.plaud.ai` HTTPS host |
| `PLAUD_REGION_REDIRECT_LOOP` | 502 | | The OTP request was redirected through more than three regional servers |
| `PLAUD_OTP_INVALID` | 400 | `{ plaudStatus }` | Plaud did not accept the code or the token |
| `PLAUD_OTP_EXPIRED` | 400 | | The code expired before it was submitted |
| `PLAUD_API_ERROR` | 400 | `{ plaudStatus }` | Plaud returned a 4xx other than 401 or 429, or a business-level rejection |
| `PLAUD_UPSTREAM_ERROR` | 502 | `{ plaudStatus, plaudMessage? }` | Plaud returned a 5xx after the retry budget, or the request could not be completed |
| `PLAUD_RATE_LIMITED` | 429 | `{ retryAfter? }` | Plaud rate-limited the request after the retry budget. `retryAfter` is the upstream value, in seconds. |
| `PLAUD_WORKSPACE_UNAVAILABLE` | 400 | `{ plaudStatus? }` | The workspace token could not be issued, for example because the workspace was deleted |

## Storage

| Code | Status | When |
| --- | ---: | --- |
| `STORAGE_ERROR` | 500 | The storage adapter failed, and there is no more specific code |
| `STORAGE_QUOTA_EXCEEDED` | 413 | The quota check failed before a write |
| `FILE_TOO_LARGE` | 413 | The upload is larger than the allowed size |
| `PATH_TRAVERSAL_DETECTED` | 400 | The local storage path check rejected a path |

## Transcription and AI

| Code | Status | When |
| --- | ---: | --- |
| `TRANSCRIPTION_FAILED` | 500 | The server-side transcription pipeline failed |
| `NO_TRANSCRIPTION_PROVIDER` | 400 | No transcription provider is configured |
| `AI_PROVIDER_NOT_CONFIGURED` | 400 | An AI feature was requested, but no provider is configured |
| `AI_PROVIDER_API_ERROR` | 4xx or 502 | The provider returned an error. The status matches the upstream failure: 4xx for a client-side problem, 502 for a provider 5xx after retries. |
| `AI_RATE_LIMITED` | 429 | The provider rate-limited the request |

## Recordings

| Code | Status | When |
| --- | ---: | --- |
| `RECORDING_NOT_FOUND` | 404 | The recording does not exist for this user |
| `RECORDING_STREAM_INVALID_RANGE` | 416 | The `Range` header is malformed or out of bounds |

## Notifications

| Code | Status | When |
| --- | ---: | --- |
| `EMAIL_SEND_FAILED` | 500 | The email transport failed for a reason other than configuration |
| `SMTP_NOT_CONFIGURED` | 500 | An email was requested, but SMTP is not configured |
| `SMTP_AUTH_FAILED` | 500 | The SMTP credentials were refused |

## Database

| Code | Status | When |
| --- | ---: | --- |
| `UNIQUE_CONSTRAINT_VIOLATION` | 409 | A unique constraint rejected the write. See also Resource. |

Other database failures are reported as `INTERNAL_ERROR`.

## Generic

| Code | Status | When |
| --- | ---: | --- |
| `INTERNAL_ERROR` | 500 | An unmapped server error. `error` is always "An unexpected error occurred". |
| `SERVICE_UNAVAILABLE` | 503 | A background dependency is down |
| `RATE_LIMITED` | 429 | The request exceeded a limit of this server, such as the `/api/v1/*` quota |
| `UPSTREAM_BAD_RESPONSE` | 502 | An upstream returned a body that could not be parsed, such as an HTML page where JSON was expected |

## Raw `SyntaxError`

A bare `SyntaxError` from `JSON.parse` or `Request.json()` is not mapped automatically, because a malformed upstream body and a malformed client body throw the same error. Helpers that read upstream JSON wrap parsing and throw a typed error such as `UPSTREAM_BAD_RESPONSE`. Route handlers that read client bodies use `request.json().catch(() => null)` and return `INVALID_INPUT` or `MISSING_REQUIRED_FIELD`. An unwrapped `SyntaxError` becomes `INTERNAL_ERROR`, by design.

## Versioning

New codes can appear in any release. Existing codes are not removed or repurposed without a deprecation period. The code list in `src/lib/errors.ts` is the source of truth. This page can lag behind it, so check there when you need the exact set.
