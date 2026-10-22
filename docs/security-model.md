# Security model

This page explains how OpenAudioHub protects accounts and data, where the trust boundaries are, and what you are responsible for. For the encryption details, see [Encryption at rest](encryption-at-rest.md).

- [Accounts and passwords](#accounts-and-passwords)
- [Sign-in sessions](#sign-in-sessions)
- [Cross-site protection](#cross-site-protection)
- [API keys](#api-keys)
- [Webhooks](#webhooks)
- [Rate limits](#rate-limits)
- [Browser security headers](#browser-security-headers)
- [Plaud tokens](#plaud-tokens)
- [Uploads and files](#uploads-and-files)
- [The Mac app](#the-mac-app)
- [Trust boundaries](#trust-boundaries)
- [Your part](#your-part)
- [Reporting a problem](#reporting-a-problem)

## Accounts and passwords

- A new server has one local account, and the dashboard opens without sign-in. Set `OAH_MULTI_USER=true` for separate accounts with sign-in.
- On a single-account server, the local account opens only for requests whose `Host` header matches `APP_URL`. This blocks DNS rebinding from other sites.
- Passwords must be 8 characters or more, and at most 256 bytes.
- Passwords are hashed with Argon2id. The server never stores or shows the password.
- With `OAH_MULTI_USER=true`, sign-up can be turned off with `DISABLE_REGISTRATION=true`. The sign-up page then redirects to sign-in, and the sign-up request is refused. Sign-up is refused on a single-account server.
- Password reset by email sends a link that expires after 1 hour and works once. The link's return address must be a path on the same site.
- The `reset-password` command, run on the server, sets a new password and signs out every session of the account.
- A suspended account is refused on every request, including its API keys.

## Sign-in sessions

- A sign-in sets a cookie named `oah_session`. The cookie is `HttpOnly`, so page scripts cannot read it, and `SameSite=Lax`.
- When `APP_URL` starts with `https://`, the cookie also has the `Secure` flag, so browsers send it only over HTTPS.
- A session lasts 7 days. Using the app extends it: when a session is used more than a day after it was last extended, it gets 7 more days.
- The server stores only a hash of the session token. Signing out deletes the session.

## Cross-site protection

A change made with a session cookie must come from the app's own origin. The server checks the `Origin` header of each state-changing request against `APP_URL`. A request from another site is refused. This blocks forged requests from other web pages.

If you see an origin error when saving, check that `APP_URL` matches the address in your browser. See [Reverse proxy](self-hosting.md#reverse-proxy).

## API keys

- Keys are read-only. They work only on the [public API](public-api.md), and they cannot change anything.
- A key is shown once. The server stores a keyed hash, so a leaked database does not reveal usable keys.
- You can set an expiry date, and you can revoke a key at any time. The key list response shows when each key was last used.
- Keys are checked on every request. A revoked or expired key is refused at once.

See [Personal API keys](automation-and-webhooks.md#personal-api-keys).

## Webhooks

- Each endpoint has its own signing secret. Each delivery is signed with HMAC-SHA256 over a timestamp and the body. Your receiver should check the signature and reject old timestamps. See [Verify a signature](automation-and-webhooks.md#verify-a-signature).
- The server does not follow redirects. A redirect counts as a failed delivery.
- A webhook URL cannot contain a user name or password.
- A server refuses webhook targets that use plain `http` or resolve to private addresses, so a signed-up user cannot use the server to reach your network. It refuses local and private addresses in every form, including the IPv4 address inside a NAT64 or 6to4 address, and it connects to the address it checked without an environment proxy. The Mac app keeps allowing local targets because it is single-user. See `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` in [Environment variables](environment-variables.md#address-and-files) and [Allowed URLs](automation-and-webhooks.md#allowed-urls).

## Rate limits

The server counts requests in fixed time windows. These are the main limits:

| Action | Limit (default) |
|---|---|
| Sign-in attempts | 10 per minute for each client address |
| Sign-up | 5 per minute for each client address |
| Password reset requests | 3 per minute for each client address, and 3 per minute for each email address |
| Manual Plaud sync | 10 per minute for each account |
| Automatic summaries | 60 per hour for each account |
| Public API | 1,200 per minute for each client address, and 600 per minute for each key |

The counters are kept in memory. They reset when the server restarts. See [Limits of one process](architecture.md#limits-of-one-process).

The client address comes from the connection. Proxy headers are used only when `RATE_LIMIT_TRUST_PROXY_HEADERS=true`. Turn that on only behind a proxy that sets the headers, and keep the server port closed to other machines. Without it, every client behind a proxy shares one budget for each limit.

## Browser security headers

Every page carries these headers:

- A content security policy. Scripts, workers and connections come only from the app itself. The only other sites the app may connect to are the Hugging Face hub, for the browser transcription model. Embedded objects are blocked, and the app cannot be placed in a frame on another site.
- `X-Frame-Options: DENY`, and `frame-ancestors 'none'` in the policy.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Strict-Transport-Security`, when `APP_URL` starts with `https://`.

## Plaud tokens

- The Plaud account token is encrypted at rest. No endpoint returns it, and it is not written to the log.
- The server does not refresh the token. When Plaud rejects it, the connection shows that sign-in has expired and you connect again.
- Workspace tokens are used only in memory during a sync. They are not stored.
- Pasted workspace tokens are refused, because they cannot be renewed.

See [Connect your Plaud account](connect-plaud-account.md).

## Uploads and files

- Uploads must be 500 MB or less. The extension must be one of the supported audio types, and the file must parse as audio.
- Storage object names are checked. Names that try to leave the storage folder are refused.
- Audio files and exports are not encrypted. Protect the storage folder, the bucket and the backups. See [What is not encrypted](encryption-at-rest.md#what-is-not-encrypted).

## The Mac app

- The server listens on `127.0.0.1` only. Other computers cannot reach it.
- The window signs in with a one-time launch code, which works once.
- Sign-up is off, and there is one local account with no password.
- The encryption key is in `secrets.json`. Keep a copy of it, and keep the data folder private. See [Keep a copy of your keys](desktop.md#keep-a-copy-of-your-keys).

## Trust boundaries

Some of your data leaves the server by design:

- **Plaud** is where the server signs in and syncs. Your recordings come from Plaud to the server.
- **AI providers** receive the audio or text you send to them for transcription and summaries. Their own terms apply. A local model keeps the data on your machine.
- **The mail server** receives the notification and reset emails.
- **Bark** receives the count and the first few titles of a notification.
- **Your webhook receivers** receive the event data for the events you chose.
- **The Hugging Face hub** provides the browser transcription model. Only the model is downloaded from there. Your audio stays in your browser.

## Your part

- Keep `ENCRYPTION_KEY` and a copy of it, apart from your backups.
- Use HTTPS for the public address, and keep the server port closed to the internet except through the proxy.
- Keep `APP_URL` exact, so the origin check works.
- Keep `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` at its default on a server that other people can use. Set it to `false` only to deliver to a machine on your own network.
- Set `OAH_MULTI_USER=true` only when separate accounts should sign in. Turn off sign-up when only your accounts should use the server.
- On a single-account server, put a reverse proxy with its own authentication in front before you open the server to a network. Anyone who reaches the port uses the account.
- Protect backups, exports and the storage folder, because they are not encrypted.
- Keep the server and the image up to date.

## Reporting a problem

If you find a security problem, report it privately to the project maintainers, not in a public issue. Include the version, the steps to reproduce, and what you expected.
