# Environment variables

The server reads these variables once, when it starts. Set them in `.env`, and pass them into the container in `compose.yml`. See [The compose file](self-hosting.md#the-compose-file).

- An empty value counts as not set.
- Unknown variables are ignored.
- Numbers must be whole numbers inside the allowed range. Whether a wrong number stops the server or falls back to the default is noted in each table.
- True and false values accept `true`, `1`, `yes` or `on`, and `false`, `0`, `no` or `off`, in any case. Any other value stops the server at startup, unless the table says otherwise.

Values marked **secret** must not appear in logs, screenshots or support messages.

- [Required and common](#required-and-common)
- [Address and files](#address-and-files)
- [Storage](#storage)
- [Transcription and long recordings](#transcription-and-long-recordings)
- [Plaud sync](#plaud-sync)
- [Summaries](#summaries)
- [Email](#email)
- [Webhooks](#webhooks)
- [Providers](#providers)
- [Logging](#logging)
- [Mac app and testing only](#mac-app-and-testing-only)

## Required and common

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | none. Required. | **Secret.** 64 hex characters (32 bytes). Create it with `openssl rand -hex 32`. Encrypted fields use it. Do not change it once you have data. See [Encryption at rest](encryption-at-rest.md). |
| `API_TOKEN_HASH_SECRET` | Derived from `ENCRYPTION_KEY` when not set. | **Secret.** At least 32 characters. It keys the hashes of personal API keys. Set it yourself if you want to control the value. Changing it invalidates every API key. |
| `APP_URL` | `http://localhost:3000` | The public address people open in the browser, with scheme and port, for example `https://audio.example.com`. Trailing slashes are removed. When it starts with `https://`, the session cookie gets the `Secure` flag. Used in email links and webhook links too. |
| `DISABLE_REGISTRATION` | `false` | `true` hides and blocks sign-up. Create your account first if you want only you to use the server. |
| `RATE_LIMIT_TRUST_PROXY_HEADERS` | `false` | `true` makes the server take the client address from `cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`. Turn it on only behind a proxy that sets these headers. See [Reverse proxy](self-hosting.md#reverse-proxy). |

## Address and files

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `0.0.0.0` | The IP address to listen on. Must be an IP address. A wrong value stops the server. |
| `PORT` | `3000` | The port to listen on. A wrong value stops the server. |
| `OAH_DATA_DIR` | `./data` | The data folder. The container sets it to `/data`. |
| `OAH_DATABASE_PATH` | `<OAH_DATA_DIR>/openaudiohub.sqlite` | The SQLite database file. |
| `LOCAL_STORAGE_PATH` | `<OAH_DATA_DIR>/storage` | The folder for audio files stored on disk. |
| `FFMPEG_PATH` | `ffmpeg` | The ffmpeg program. The container includes it. Used to decode, split and re-encode audio. |
| `FFPROBE_PATH` | `ffprobe` | The ffprobe program. The container includes it. Used to read durations. |

## Storage

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_STORAGE_TYPE` | `local` | Where new audio goes: `local` or `s3`. Recordings keep the storage type they were saved with, so changing this never strands existing audio. A wrong value stops the server. |
| `S3_ENDPOINT` | none | The S3 API address, for example `https://s3.example.com`. Leave it empty for AWS S3. |
| `S3_BUCKET` | none | The bucket name. |
| `S3_REGION` | none | The region name. Some services use a fixed value such as `auto`. |
| `S3_ACCESS_KEY_ID` | none | **Secret.** The access key ID. |
| `S3_SECRET_ACCESS_KEY` | none | **Secret.** The secret access key. |

S3 settings are used only when a recording is stored in S3. If the bucket settings are incomplete, uploads and audio reads for S3 recordings fail. The server still starts. See [S3-compatible storage](storage-s3.md).

## Transcription and long recordings

| Variable | Default | Meaning |
|---|---|---|
| `AUDIO_PIPELINE_ENABLED` | `true` | `true` splits each recording into parts at pauses, and transcribes the parts one by one. `false` sends the whole file to the provider in one request. A wrong value stops the server. |
| `WHISPER_MAX_BYTES` | `25165824` (24 MiB) | The largest file sent to a provider without re-encoding. Allowed range is 1 to 26214400 (25 MiB). A wrong value uses the default. |
| `WHISPER_COMPRESS_BITRATE_KBPS` | `12` | The first bitrate, in kbps, used when a file is too large. The bitrate is halved until the file fits. |
| `WHISPER_REQUEST_TIMEOUT_MS` | `3600000` (1 hour) | How long one provider request may take, in milliseconds. |
| `OPENCODE_GO_SESSION_ID` | `openaudiohub` | Sent as the `x-opencode-session` header to OpenCode Go. Set it only if OpenCode asks for a specific session ID. |

## Plaud sync

| Variable | Default | Meaning |
|---|---|---|
| `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE` | `10` | How many times one account may start a sync by hand in one minute. Allowed range is 1 to 600. A wrong value returns an error when a sync is started. |
| `BACKGROUND_SYNC_ENABLED` | `true` | `false` turns off the background sync for every account. Accounts can still sync from the dashboard. A wrong value uses `true`. |
| `BACKGROUND_SYNC_INTERVAL_MS` | `300000` (5 minutes) | Time between background sync passes, in milliseconds. Allowed range is 60000 to 3600000. A wrong value uses the default. The first pass runs 30 seconds after start. |

## Summaries

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | `60` | How many automatic summaries one account may make in one hour. |

## Email

Email is on only when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are all set. See [Email (SMTP) setup](email-smtp.md).

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_HOST` | none | The mail server host name. |
| `SMTP_PORT` | `465` when `SMTP_SECURE=true`, otherwise `587` | The mail server port. A value that is not a port number stops the server. |
| `SMTP_SECURE` | `false` | `true` uses implicit TLS, usually on port 465. `false` uses STARTTLS, usually on port 587. Only the exact text `true` turns it on. |
| `SMTP_USER` | none | The login name for the mail server. |
| `SMTP_PASSWORD` | none | **Secret.** The mail server password or API key. |
| `SMTP_FROM` | `SMTP_USER`, or `OpenAudioHub <noreply@…>` built from the host of `APP_URL` | The From address. A bare address or `Name <address>`. An invalid value stops the server. |
| `SMTP_REPLY_TO` | none | The Reply-To address. A bare address or `Name <address>`. An invalid value stops the server. |

## Webhooks

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` | `false` | `true` allows only `https` URLs whose host resolves only to public IP addresses. Private, loopback and local names are refused. An invalid value makes webhook create and update requests fail. See [Automation API and webhooks](automation-and-webhooks.md#allowed-urls). |

## Providers

Provider keys and base addresses are set in the app, not in these variables. See [AI providers](providers.md).

## Logging

| Variable | Default | Meaning |
|---|---|---|
| `OAH_LOG` | `info` | The log level, using the standard filter syntax, for example `info`, `warn` or `oah=debug`. |

## Mac app and testing only

Do not set these on a server.

| Variable | Default | Meaning |
|---|---|---|
| `OAH_DESKTOP` | `false` | Starts the server in the mode the Mac app uses: local only, one account, registration off. |
| `OAH_DESKTOP_LAUNCH_SECRET` | none | The one-time code the Mac app uses to open its window. At least 32 characters. |
| `OAH_DESKTOP_USER_ID` | none | The local account the Mac app signs in to. |
| `OAH_WEB_DIR` | none | Serves the web app from this folder instead of the copy built into the server. |
| `OAH_PLAUD_API_BASE` | none | Replaces the Plaud API address. Used by the test suite. |
