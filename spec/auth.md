# Auth

This module covers accounts, sign-up, sign-in, sign-out, the session cookie, the desktop session exchange, password reset, rate limits, origin checks, suspended accounts, and the auth pages.

Account endpoints live under `/api/auth/*`. The desktop exchange lives under `/api/desktop/session`.

## Overview

| Topic | Rule |
|---|---|
| Accounts | Email and password. Anyone can create an account unless registration is disabled. |
| Email verification | None. New accounts are not verified, and no verification email is sent. New accounts can sign in at once. |
| Session | Cookie `oah_session`, server-side lifetime 7 days, `HttpOnly`. See [Session cookie](#session-cookie). |
| Sign-out | Deletes the session and clears the cookie. |
| Password reset | By email when SMTP is configured. See [Password reset](#password-reset). |
| Rate limits | Fixed 60-second windows per client address on auth routes, and per email on reset requests. See [Rate limits](#rate-limits). |
| Origin | Requests that carry the session cookie and change data must send an `Origin` header equal to `APP_URL`. See [Origin checks](#origin-checks). |
| Desktop | One local account, signed in through a launch secret. Sign-up and sign-out are not offered. See [Desktop mode](#desktop-mode). |
| Administrator | No administrator role. The only account management is the `oah-server reset-password` command. |

## Error shape

Auth endpoints and every other `/api/*` route return errors as:

```json
{ "error": "Human-readable text", "code": "MACHINE_CODE", "details": { } }
```

- `code` is stable. Clients branch on `code`. The `error` text can change.
- `details` is present only when there is extra data, such as `retryAfter` on a rate-limit answer.
- A `5xx` answer has `details.errorId` (`err_` plus 8 hex characters). The same id is in the server log. The `error` text is generic and the cause is never sent to the client.
- The password reset routes (`/api/auth/request-password-reset`, `/api/auth/reset-password/{token}`, `/api/auth/reset-password`) also repeat the text in a `message` field.

Common codes used by the auth module:

| Code | Status | Meaning |
|---|---|---|
| `AUTH_SESSION_MISSING` | 401 | An API route needs a session and the request has no valid one. Message `Unauthorized`. |
| `ACCOUNT_SUSPENDED` | 403 | The session belongs to a suspended account. Message `Account suspended`. |
| `NOT_FOUND` | 404 | Unknown `/api/*` path, or a desktop route on a web server. Message `Not found`. |
| `RATE_LIMITED` | 429 | See [Rate limits](#rate-limits). |
| `INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN` | 403 | See [Origin checks](#origin-checks). |

## Session cookie

| Property | Value |
|---|---|
| Name | `oah_session`, on plain HTTP and HTTPS alike. |
| Value | Random token of 32 bytes, written as 64 hex characters. The server stores only its SHA-256 hash. |
| Set by | Sign-up, sign-in, `POST` and `GET /api/desktop/session`. |
| Attributes | `Path=/`, `Max-Age=604800` (7 days), `HttpOnly`, `SameSite=Lax`. `Secure` when `APP_URL` starts with `https://`. No `Domain`, so the cookie is host-only. |
| Server-side lifetime | 7 days from creation. A session that was last extended more than 24 hours ago is extended to 7 days from the current request. The extension updates the server only, and the cookie is not sent again. |
| Cleared by | Sign-out, which sends `oah_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`. |

Reading the cookie:

- The server uses the first `oah_session` cookie with a non-empty value. The cookie can be sent on any `/api/*` request.
- An unknown, tampered, or expired token is treated as signed out. It is never an error on its own. `GET /api/auth/get-session` answers `null`, and an API route answers `401 AUTH_SESSION_MISSING`.
- A session row is deleted when it is found expired. Expired rows are also purged when a new session is created.

## Endpoints

### POST /api/auth/sign-up/email

Auth: none. An `Origin` check applies only if the request carries a session cookie.

Checks run in this order:

1. Rate limit: 5 requests per 60 seconds per client address (see [Rate limits](#rate-limits)).
2. Registration disabled: refused with `403 REGISTRATION_DISABLED` when `DISABLE_REGISTRATION=true` or the server runs in desktop mode.
3. `name` and `email`: `name` must be non-empty after trimming. `email` is trimmed and lowercased, and must look like an address: a non-empty local part, a domain containing a dot that does not start or end with a dot, no whitespace, at most 254 characters.
4. `password`: at least 8 characters, and at most 256 bytes.
5. Uniqueness of `email`.

Request (JSON):

- `name` string, required.
- `email` string, required.
- `password` string, required.
- `callbackURL` string, optional. The server ignores it. The web form sends `/dashboard`.

Response: `200 OK`, with the session cookie set.

```json
{
  "user": {
    "id": "EQFrWLJHZmO2gVQa9clrjFtDT423",
    "name": "Probe",
    "email": "probe@example.test",
    "emailVerified": false,
    "createdAt": "2026-10-16T18:42:12.044Z",
    "updatedAt": "2026-10-16T18:42:12.044Z"
  }
}
```

Errors:

| Status | Code | When |
|---|---|---|
| 403 | `REGISTRATION_DISABLED` | Registration is disabled on this server, or desktop mode. Message `Registration is disabled`. |
| 400 | `VALIDATION_ERROR` | `name` is empty, or `email` is missing or not an address. Message `Name and a valid email are required`. |
| 400 | `PASSWORD_TOO_SHORT` | `password` has fewer than 8 characters. |
| 400 | `PASSWORD_TOO_LONG` | `password` is more than 256 bytes. |
| 422 | `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` | An account with this email already exists. |
| 403 | `INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN` | Origin check fails, when the request carries a session cookie. |
| 429 | `RATE_LIMITED` | Rate limit exceeded. |

Side effects: creates one user row with `emailVerified: false`, one credential row (argon2id hash of the password), and one session row. No email is sent.

### POST /api/auth/sign-in/email

Auth: none. An `Origin` check applies only if the request carries a session cookie.

Request (JSON):

- `email` string, required. Trimmed and lowercased before lookup. No format check.
- `password` string, required.

Response: `200 OK`, with the session cookie set.

```json
{
  "redirect": false,
  "user": {
    "id": "EQFrWLJHZmO2gVQa9clrjFtDT423",
    "name": "Probe",
    "email": "probe@example.test",
    "emailVerified": false,
    "createdAt": "2026-10-16T18:42:12.044Z",
    "updatedAt": "2026-10-16T18:42:12.044Z"
  }
}
```

Errors:

| Status | Code | When |
|---|---|---|
| 401 | `INVALID_EMAIL_OR_PASSWORD` | Wrong password, or no account with this email. Both give the same message, `Invalid email or password`. |
| 400 | `VALIDATION_ERROR` | `email` or `password` is missing. Message `Email and password are required`. |
| 403 | `INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN` | Origin check fails, when the request carries a session cookie. |
| 429 | `RATE_LIMITED` | Rate limit exceeded. |

Rules:

- A password longer than 256 bytes is never checked against a stored hash. It gets the same `401` as a wrong password.
- For an unknown email the server still runs one password hash check, so the response time does not reveal whether an account exists.
- Older password hash formats are accepted and replaced with argon2id after a successful sign-in.
- Sign-in does not check whether the account is suspended. The session is created. Every API route then answers `403 ACCOUNT_SUSPENDED` (see [Suspended accounts](#suspended-accounts)).

Side effects: creates one session row. The user row is not changed.

### GET /api/auth/get-session

Auth: the session cookie is optional.

Response: `200 OK`. The body is `null` when there is no valid session. Otherwise:

```json
{
  "session": {
    "userId": "EQFrWLJHZmO2gVQa9clrjFtDT423",
    "expiresAt": "2026-10-23T18:42:12.187Z",
    "createdAt": "2026-10-16T18:42:12.187Z"
  },
  "user": {
    "id": "EQFrWLJHZmO2gVQa9clrjFtDT423",
    "name": "Probe",
    "email": "probe@example.test",
    "emailVerified": false,
    "createdAt": "2026-10-16T18:42:12.044Z",
    "updatedAt": "2026-10-16T18:42:12.044Z"
  }
}
```

Errors: none. An invalid or expired cookie answers `200` with `null`.

Side effects: a session that is due for extension is extended (see [Session cookie](#session-cookie)). The response does not reveal suspension.

### POST /api/auth/sign-out

Auth: none required. Signing out without a session is allowed and answers the same way.

Response: `200 OK` with `{ "success": true }`. The response clears the session cookie.

Side effects: if the request carries a session cookie, its session row is deleted. The token stops working everywhere at once.

Errors: `403 INVALID_ORIGIN` or `MISSING_OR_NULL_ORIGIN` when the request carries a session cookie and the `Origin` check fails. In that case the session is kept.

### GET /api/auth/config

Auth: none. Facts the sign-in pages need.

```json
{ "registrationEnabled": true, "passwordResetEnabled": false }
```

- `registrationEnabled` is `false` when `DISABLE_REGISTRATION=true` or desktop mode is on.
- `passwordResetEnabled` is `true` when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are all set.

### GET and POST /api/desktop/session

Desktop mode only. On a web server both methods answer `404 NOT_FOUND`.

`GET /api/desktop/session?code=<launch secret>` is the first URL the desktop window opens:

- The code must equal the launch secret. The comparison uses SHA-256 digests in constant time.
- A correct code works once per server process. A second use answers `401 AUTH_SESSION_MISSING`. A wrong code does not use up the one-time code.
- On success it answers `303 See Other` to `/dashboard`, and sets the session cookie.

`POST /api/desktop/session` is used for a later reconnect:

- The `Host` header must equal the host of `APP_URL`, including the port. Otherwise `403 INVALID_HOST`, message `Invalid host`.
- The request must send `Authorization: Bearer <launch secret>`. The secret is compared as in the GET form. Otherwise `401 AUTH_SESSION_MISSING`.
- On success it answers `204 No Content`, with the session cookie set and an empty body.

Account used by both forms:

- If `OAH_DESKTOP_USER_ID` is set, that user is used. If it does not exist, the request fails with `500 INTERNAL_ERROR`.
- Otherwise the earliest-created user is used.
- If there are no users, a local account is created with email `local@openaudiohub.localhost`, name `Local user`, `emailVerified: true`, and no password. Concurrent first requests create only one account.

Side effects: creates one session row for that account. The session has no recorded IP address.

### Other /api/auth/* paths

Any other path under `/api/` answers `404 NOT_FOUND`. In particular there is no `send-verification-email` route, because verification is not used.

## Rate limits

Every limit is a fixed window of 60 seconds. Counters are held in memory of one server process and reset when the process restarts.

The client address comes from the connection. When `RATE_LIMIT_TRUST_PROXY_HEADERS=true`, it is taken from `CF-Connecting-IP`, else `X-Real-IP`, else the last entry of `X-Forwarded-For`, else the TCP peer; only trust this setting behind a proxy that sets these headers itself. When the setting is `false` the headers are ignored, so a client cannot choose its own bucket by sending them. A request with neither a header nor a peer address is counted under the address `unknown`, so it still meets the limit instead of skipping it.

| Route | Per client address, per 60 s | Per email, per 60 s |
|---|---|---|
| `POST /api/auth/sign-in/email` | 10 | none |
| `POST /api/auth/sign-up/email` | 5 | none |
| `POST /api/auth/request-password-reset` | 3 | 3 |
| `GET /api/auth/reset-password/{token}` | 10 | none |
| `POST /api/auth/reset-password` | 10 | none |

Order of checks:

- The per-address check runs before the body is read.
- The per-email check runs after the email is validated. It counts every valid request for that address, whether or not an account exists. The key is the trimmed, lowercased email.

Behind a proxy with the setting at its default, every client appears with the proxy's address and shares the row's budget. A server started that way that receives forwarding headers logs one warning at the first such request.

A refused request answers `429`:

```json
{
  "error": "Too many attempts. Please wait 42s and try again.",
  "code": "RATE_LIMITED",
  "details": { "retryAfter": 42 }
}
```

The reset routes also repeat the text in `message`. Each `429` carries these headers:

| Header | Meaning |
|---|---|
| `Retry-After` | Seconds until the window resets. At least 1. |
| `X-RateLimit-Limit` | Requests allowed per window. |
| `X-RateLimit-Remaining` | Requests left in the window after this one. `0` on a refusal. |
| `X-RateLimit-Reset` | Unix time in seconds when the window resets. |

The public API (see [settings.md](settings.md)) uses the same client address. Without trusted proxy headers it is the connection's address, and a request that has neither a header nor a peer address shares one bucket named `unknown`.

## Origin checks

A request that carries a non-empty `oah_session` cookie and uses any method other than `GET`, `HEAD` or `OPTIONS` must send an `Origin` header equal to `APP_URL` exactly (scheme, host and port, no trailing slash). This blocks cross-site form posts.

| Request | Result |
|---|---|
| Cookie present, `Origin` equal to `APP_URL` | Allowed. |
| Cookie present, `Origin` is another site | `403 INVALID_ORIGIN`, message `Invalid origin`. |
| Cookie present, `Origin` missing or `null` | `403 MISSING_OR_NULL_ORIGIN`, message `Missing or null Origin`. |
| No cookie, any `Origin` or none | Not checked. Sign-in, sign-up, sign-out and the reset routes accept it. |
| `GET`, `HEAD`, `OPTIONS` | Not checked. |

The web app's own requests carry the app origin, so they pass.

## Desktop mode

Desktop mode is set by the desktop app's server process (`OAH_DESKTOP=true`, with a launch secret of at least 32 characters in `OAH_DESKTOP_LAUNCH_SECRET`). In desktop mode:

- Sign-up is refused with `403 REGISTRATION_DISABLED`. `GET /api/auth/config` reports `registrationEnabled: false`.
- The login page shows only the title `Reconnecting…` and the subtitle `Signing in to your local account.`. It has no form. It calls the desktop shell's `reconnect()`. On success it opens `/dashboard`. On failure it shows `OpenAudioHub could not sign this window in. Quit and reopen the app.`
- The account menu shows no sign-out.
- Session and user come from the desktop session routes described above.

## Registration and accounts

- Anyone can register through `/api/auth/sign-up/email` unless registration is disabled. Registration is disabled by `DISABLE_REGISTRATION=true` and in desktop mode. See [deployment.md](deployment.md).
- Accounts are not verified. There is no verification email.
- There is no administrator role. Creation order gives no privileges.
- No route or command sets or clears the suspension flag. See [Suspended accounts](#suspended-accounts).

## Suspended accounts

An account is suspended when its `users.suspended_at` column is set. No HTTP route or command in this server sets it, so an operator sets it directly in the database.

For a suspended account:

- Sign-in succeeds and creates a session. Every route that needs a session answers `403 ACCOUNT_SUSPENDED`, message `Account suspended`.
- Public API keys of the account are refused as well (see [settings.md](settings.md)).
- Page loads for a suspended visitor are sent to `/suspended` (see [Page redirects](#page-redirects)).
- Plaud background sync skips the account (see [workers.md](workers.md)).

The `/suspended` page says that access is paused and asks the user to contact the administrator. It does not show a reason, because none is stored.

## Password reset

Password reset by email requires SMTP. Outgoing mail is configured by environment variables (see [deployment.md](deployment.md)).

### POST /api/auth/request-password-reset

Auth: none.

Request (JSON):

- `email` string, required. Trimmed and lowercased. Must look like an address.
- `redirectTo` string, optional. The path the reset link opens. The web form sends `/reset-password`. Only a same-site path is accepted: it must start with `/`, must not start with `//`, and must not contain a backslash or control characters. Anything else becomes `/reset-password`.

Response: `200 OK`, for any valid and not rate-limited request, whether or not an account exists:

```json
{ "status": true, "message": "If this email exists in our system, check your email for the reset link" }
```

Errors:

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `email` is missing or not an address. Message `A valid email is required`. |
| 429 | `RATE_LIMITED` | More than 3 requests per 60 seconds from the address, or for the email (see [Rate limits](#rate-limits)). |

Side effects, only when SMTP is configured and an account with this email exists:

- A reset token of 32 random bytes is created. Only its SHA-256 hash is stored, in the `verifications` table. The token is valid for 1 hour.
- One email is sent to the account address. It contains the link `<APP_URL>/api/auth/reset-password/<token>?callbackURL=<redirectTo, percent-encoded>`.
- Requesting again creates another token. Earlier tokens stay valid until they expire or are used.
- The mail is sent in the background. A failed send does not change the response.

When SMTP is not configured, or the email has no account, nothing is sent and the response is the same.

### GET /api/auth/reset-password/{token}

Auth: none. This is the link in the reset email.

Behavior: `302 Found`, with `Location` set to the callback path:

- Live token: `Location: <callback>?token=<token>` (`&` is used if the callback already has a query).
- Unknown, used or expired token: `Location: <callback>?error=INVALID_TOKEN`.

The callback is the `callbackURL` query value, validated the same way as `redirectTo`. The default is `/reset-password`. The token is not used up by this request.

A `429 RATE_LIMITED` is returned when the address exceeds 10 requests per 60 seconds.

### POST /api/auth/reset-password

Auth: none. The token in the body is the proof of ownership.

Request (JSON):

- `newPassword` string, required. At least 8 characters, and at most 256 bytes.
- `token` string, required.

Checks run in this order:

1. Rate limit: 10 requests per 60 seconds per client address.
2. `newPassword` missing: `400 VALIDATION_ERROR`, message `New password is required`.
3. `newPassword` under 8 characters: `400 PASSWORD_TOO_SHORT`. This is checked before the token.
4. `newPassword` over 256 bytes: `400 PASSWORD_TOO_LONG`, message `Password must be at most 256 bytes`.
5. `token` missing or empty: `400 VALIDATION_ERROR`, message `Token is required`.
6. `token` unknown, used, or expired: `400 INVALID_TOKEN`, message `Invalid token`.

Response: `200 OK` with `{ "status": true }`. No session is created, and no cookie is set.

Side effects, in one transaction:

- The token is deleted, so it cannot be used again.
- The password is replaced.
- Every session of the account is deleted. Other browsers and desktop sessions of that account stop working.

### Administrator reset from the command line

`oah-server reset-password <email>` sets a new random password of 24 hex characters for the account, deletes all its sessions, and prints the new password once. It works without SMTP. The account must exist.

## Pages

The auth pages share one layout. Titles below are the visible headings. Page titles in the browser tab are `<title> | OpenAudioHub`.

### /login

- Title `Sign in`. Subtitle `Sign in to your OpenAudioHub instance.`
- Fields: `email` (type email, placeholder `you@example.com`, required), `password` (type password, required).
- Link `Forgot password?` above the password field, shown when `passwordResetEnabled` is true. Links to `/forgot-password`.
- Button `Sign In` (`Signing in...` while sending).
- Link `Register`, shown when `registrationEnabled` is true. Links to `/register`.
- Success: toast `Logged in successfully`, then `/dashboard`.
- Failure: toast with the server's `error` text, or `Invalid email or password` when there is none.
- Signed-in visitors are redirected to `/dashboard`.
- In desktop mode, see [Desktop mode](#desktop-mode).

### /register

- Title `Create your account`. Subtitle `Create the account you will use to sign in to this instance.`
- Fields, in order: `name` (placeholder `John Doe`), `email`, `password` (minimum 8), `confirmPassword` (label `Confirm Password`). All required.
- Client checks before sending: toast `Passwords do not match`, or `Password must be at least 8 characters`.
- Button `Create Account` (`Creating account...` while sending).
- Success: toast `Account created successfully`, then `/dashboard`. The new account is signed in.
- `REGISTRATION_DISABLED`: toast `Registration is disabled on this instance`, then `/login`. When the server reports registration as disabled, the page redirects to `/login` without a form.
- Other failures: toast with the server's `error` text, or `Failed to create account`.
- Link `Sign in` to `/login`.

### /forgot-password

- Title `Reset password`.
- When SMTP is configured: subtitle `Enter your email and we'll send a link to choose a new password.`, field `email` (required), button `Send reset link` (`Sending...` while sending). The request sends `redirectTo: "/reset-password"`.
- After a successful request, whatever the email: title `Check your email`, subtitle `If an account exists for that email, a reset link is on its way.`, and a link `Back to sign in`.
- When SMTP is not configured: subtitle `Password reset needs a mail server to be set up.` and a notice `Reset emails are turned off on this server.` There is no form.
- If the server config cannot be loaded: subtitle `We could not check whether password reset is available.` with a `Retry` button.
- Failure: toast with the server's `error` text, or `Could not send the reset email. Try again.`
- Link `Back to sign in` to `/login`.

### /reset-password

Mode `invalid`, when the `token` query parameter is missing or an `error` parameter is present:

- Title `Invalid reset link`. Subtitle `This link is missing or has expired.`
- With `error=INVALID_TOKEN`: `This reset link has expired or was used already. Request a new link to continue.`
- Otherwise: `Use the link in your latest reset email, or ask for a fresh one.`
- Link `Request a new link` to `/forgot-password`. No form.

Mode `set`, when `token` is present and there is no `error`:

- Title `Set a new password`. Subtitle `Pick a password that's unique to this account.`
- Fields: `password` (label `New password`, minimum 8, required), `confirmPassword` (label `Confirm password`, required).
- Client checks: the same messages as on `/register`.
- Button `Reset password` (`Resetting password...` while sending).
- Success: toast `Password reset. You can sign in now.`, then `/login`.
- Failure: toast with the server's `error` text, or `Could not reset password. The link may have expired.`
- Link `Back to sign in` to `/login`.

### /suspended

- Title `Your account is suspended`. The text says that access to recordings, sync, and transcription is paused while the account is reviewed, and asks the user to contact the instance administrator.
- Button `Sign out` (`Signing out...` while sending). It calls `POST /api/auth/sign-out`, then loads `/login`.
- The page checks the account with `GET /api/settings/user`. A `403 ACCOUNT_SUSPENDED` keeps the page. Any other answer sends the visitor to `/recordings`.

### Page redirects

These rules are applied by the server to page loads (`307 Temporary Redirect`):

| Visitor | Page | Result |
|---|---|---|
| Signed in, active | `/login`, `/register`, `/forgot-password`, `/reset-password` | `/dashboard` |
| Anonymous | `/suspended` | `/login` |
| Anonymous | Pages that need a session | `/login` |
| Suspended | Pages that need a session | `/suspended` |
| Suspended | `/suspended` | The page is shown. |
| Active, not suspended | `/suspended` | `/recordings` |

## Tests

The contract tests are in `contract-tests/tests/auth.spec.ts`, with a browser sign-in check in the same folder. They cover:

- sign-up, sign-in, the session read, sign-out and the cookie;
- a tampered cookie reading as signed out;
- equal errors for a wrong password and an unknown email, and `422` for a duplicate email;
- short passwords and malformed input;
- origin checks, with and without a cookie;
- the sign-in burst limit;
- reset request answers and the per-email limit, a bogus token, a short new password, and the `INVALID_TOKEN` redirect;
- `404` for unknown `/api/auth` paths and for the desktop route on a web server;
- API routes requiring a session;
- page redirects and page rendering.

Not covered by the contract tests: HTTPS cookie attributes, registration disabled, the desktop exchange, suspended accounts, and a successful password reset with a live token.
