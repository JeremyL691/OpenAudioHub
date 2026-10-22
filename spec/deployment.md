# Deployment

This file describes how the server is deployed as a container: the image, the compose file, the environment variables, the data volume, the health check, and the operating rules for upgrades, backups and secrets.

## 1. Deployment shape

- One container runs one process, `oah-server`. The process serves the HTTP API and the web app, and runs every background worker: transcription, the audio pipeline, summaries, webhook delivery, Plaud sync, automatic exports, and the waveform backfill.
- The web app is embedded in the server binary in release builds. The image has no Node runtime and no separate web server.
- Data is stored in SQLite, with the audio files in a folder, both under one data directory (`/data` in the image).
- There is no separate database container, no separate worker container, and no reverse proxy inside the image. A reverse proxy in front of the container is optional (see section 7).

## 2. The image

Built from `deploy/Dockerfile` in two stages:

1. The web app is built with pnpm, from `web/`.
2. The server is built with Cargo in release mode, with `--locked`, and the built web files are embedded.

The runtime image is `debian:trixie-slim`, with `ffmpeg`, `ca-certificates` and `curl` installed.

| Item | Value |
|---|---|
| Image name | `ghcr.io/jeremyl691/openaudiohub` |
| Tags | `<major>.<minor>.<patch>` and `<major>.<minor>`, and `latest`. Published for every `v*.*.*` release tag. |
| Platforms | `linux/amd64`, `linux/arm64` |
| User | `oah`, system user, uid `10001`, home `/data` |
| Environment defaults | `OAH_DATA_DIR=/data`, `HOST=0.0.0.0`, `PORT=3000` |
| Volume | `/data` |
| Exposed port | `3000` |
| Entrypoint | `oah-server`. With no argument it runs the server (`serve`). |
| Health check | Every 30 s, timeout 5 s, 3 retries: `curl -fsS http://127.0.0.1:3000/api/health` |

Command forms of the entrypoint:

- `oah-server` or `oah-server serve`: starts the server.
- `oah-server reset-password <email>`: see section 9.

## 3. Compose file

`deploy/compose.yml` defines one service, `app`, and one named volume, `data`.

- Image: `ghcr.io/jeremyl691/openaudiohub:${OPENAUDIOHUB_VERSION:-latest}`.
- `restart: unless-stopped`.
- Environment: `ENCRYPTION_KEY` (required), `APP_URL` (default `http://localhost:3000`), `RATE_LIMIT_TRUST_PROXY_HEADERS` (default `true`), `DISABLE_REGISTRATION` (default `false`), `OAH_MULTI_USER` (default `false`), `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` (default `true`).
- Port: `127.0.0.1:3000:3000`. The server is reachable from the host only through loopback, so a reverse proxy on the host is what serves clients. That is why the Compose defaults trust the proxy's headers and refuse private webhook targets.
- Volume: `data:/data`.

First start:

1. Create `.env` next to `compose.yml` with `ENCRYPTION_KEY` (64 hex characters, for example from `openssl rand -hex 32`) and `APP_URL` (the public address, for example `https://audio.example.com`).
2. Run `docker compose up -d`.

The compose file refuses to start when `ENCRYPTION_KEY` is not set.

## 4. Environment variables

The server reads its settings from the environment at start. A setting that is invalid stops the server at start with a message on stderr and exit code `2`. Exceptions are noted in the table.

Boolean settings accept `true`, `1`, `yes`, `on`, `false`, `0`, `no` and `off`, in any case. Other text is refused at start. Whole-number settings are given with the range shown.

### 4.1 Required

| Variable | Default | Meaning |
|---|---|---|
| `ENCRYPTION_KEY` | none | 32 bytes written as 64 hex characters. Encrypts stored titles, transcripts, summaries, provider keys and some settings values. |

### 4.2 Server and public address

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | TCP port to listen on. Must be a number. |
| `HOST` | `0.0.0.0` | IP address to listen on. |
| `APP_URL` | `http://localhost:<PORT>` | Public origin of the app, without a trailing slash. Cookie-carrying requests must send this exact origin (see `auth.md`). The session cookie is marked `Secure` when this starts with `https://`. |
| `OAH_LOG` | `info` | Log filter in the `tracing` format, for example `info` or `oah=debug`. |

### 4.3 Data and storage

| Variable | Default | Meaning |
|---|---|---|
| `OAH_DATA_DIR` | `./data` (`/data` in the image) | Base folder for the database and local storage. |
| `OAH_DATABASE_PATH` | `$OAH_DATA_DIR/openaudiohub.sqlite` | SQLite database file. |
| `LOCAL_STORAGE_PATH` | `$OAH_DATA_DIR/storage` | Folder for audio files when local storage is used. |
| `DEFAULT_STORAGE_TYPE` | `local` | `local` or `s3`. Any other value stops the server at start. |
| `S3_ENDPOINT` | none | Custom endpoint for S3-compatible services. Optional. |
| `S3_BUCKET` | none | Bucket name. Required for `s3`. |
| `S3_REGION` | none | Region. Required for `s3`. |
| `S3_ACCESS_KEY_ID` | none | Access key. Required for `s3`. |
| `S3_SECRET_ACCESS_KEY` | none | Secret key. Required for `s3`. |

S3 access uses path-style addressing, so S3-compatible services work with `S3_ENDPOINT`. When an S3 setting is missing, storage operations fail.

### 4.4 Secrets

| Variable | Default | Meaning |
|---|---|---|
| `API_TOKEN_HASH_SECRET` | derived from `ENCRYPTION_KEY` | Secret for hashing personal API keys. At least 32 characters when set. Changing it invalidates existing personal API keys. |

When `API_TOKEN_HASH_SECRET` is not set, a stable value is derived from `ENCRYPTION_KEY`, so keys survive restarts.

### 4.5 Accounts and sign-in

| Variable | Default | Meaning |
|---|---|---|
| `OAH_MULTI_USER` | `false` | `true` turns on separate accounts, with the landing page, sign-up, sign-in and password reset. `false` runs one local account that opens without sign-in (see `auth.md`). |
| `DISABLE_REGISTRATION` | `false` | `true` refuses new accounts and hides the sign-up page. It matters only with `OAH_MULTI_USER=true`. |
| `RATE_LIMIT_TRUST_PROXY_HEADERS` | `false` | `true` takes the client address from `CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For`. Set it only behind a proxy that sets these headers. When `false` the address is the connection's, so every client behind a proxy shares one budget (see `auth.md`). |

### 4.6 Email (SMTP)

Email is enabled when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are all set. It is used for password reset and other notification emails. Password reset is offered only when email is enabled.

| Variable | Default | Meaning |
|---|---|---|
| `SMTP_HOST` | none | SMTP server host name. |
| `SMTP_PORT` | `465` when `SMTP_SECURE=true`, else `587` | Port. Must be a number. |
| `SMTP_SECURE` | `false` | Only the exact text `true` turns it on. `true` uses implicit TLS. `false` uses STARTTLS. |
| `SMTP_USER` | none | Login name. |
| `SMTP_PASSWORD` | none | Login password. |
| `SMTP_FROM` | none | Sender, as `address` or `Name <address>`. Checked at start. |
| `SMTP_REPLY_TO` | none | Reply-to address, in the same form. Checked at start. |

### 4.7 Transcription and audio

| Variable | Default | Meaning |
|---|---|---|
| `AUDIO_PIPELINE_ENABLED` | `true` | Long and large recordings go through the in-process audio pipeline. |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg program. The image has it on the default path. |
| `FFPROBE_PATH` | `ffprobe` | Path to the ffprobe program. |
| `WHISPER_MAX_BYTES` | `25165824` (24 MiB), range 1 to `26214400` (25 MiB) | Largest audio file sent to a transcription provider as is. Larger files are first re-encoded. |
| `WHISPER_COMPRESS_BITRATE_KBPS` | `12`, minimum 1 | Bitrate used when re-encoding an oversized file. |
| `WHISPER_REQUEST_TIMEOUT_MS` | `3600000`, minimum 1 | Timeout for one transcription request to a provider. |

Recording uploads are refused above 500 MiB per file.

### 4.8 Summaries

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | `60`, range 1 to 4294967295 | Automatic summaries per user per hour (see `ai.md`). |
| `OPENCODE_GO_SESSION_ID` | `openaudiohub` | Value of the `x-opencode-session` header sent to OpenCode Go (see `ai.md`). |

### 4.9 Plaud sync and webhooks

| Variable | Default | Meaning |
|---|---|---|
| `BACKGROUND_SYNC_ENABLED` | `true` | Turns the background Plaud sync on or off. |
| `BACKGROUND_SYNC_INTERVAL_MS` | `300000`, range 60000 to 3600000 | Interval of the background sync. The first run starts 30 seconds after the server starts. |
| `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE` | `10`, range 1 to 600 | Sync starts allowed per user per minute. |
| `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` | `true` on a server, `false` in the desktop app | `true` allows only `https` targets that resolve to public addresses (see `webhooks.md`). Unset or empty follows the default of the mode; an explicit value wins in both modes. Any other value stops startup. |

### 4.10 Desktop app only

The desktop app builds its server configuration itself, so the app does not need these settings. A web or container deployment does not set them. Setting `OAH_DESKTOP=true` with a launch secret runs the plain server in desktop mode.

| Variable | Meaning |
|---|---|
| `OAH_DESKTOP` | `true` starts the plain server in desktop mode. The desktop app does not set it. |
| `OAH_DESKTOP_LAUNCH_SECRET` | Launch secret of at least 32 characters. Required in desktop mode. |
| `OAH_DESKTOP_USER_ID` | Account the desktop app signs in to. Optional. |

Desktop mode also turns off registration. See `desktop.md` and `auth.md`.

### 4.11 Test hooks

`OAH_PLAUD_API_BASE` replaces the Plaud API host, and `OAH_WEB_DIR` serves the web app from a folder on disk. Both exist for the contract tests. Operators do not set them.

## 5. Container layout

| Item | Layout |
|---|---|
| Processes | One `oah-server` process. |
| Listening | `HOST:PORT` inside the container, `0.0.0.0:3000` by default. |
| Published port | `127.0.0.1:3000` on the host, from the compose file. |
| Data | `/data`, the `data` volume. |
| Files | `/usr/local/bin/oah-server`. The web app is embedded in it. |

## 6. Volumes and data

Everything the server keeps is under `OAH_DATA_DIR` (`/data`):

| Path | Content |
|---|---|
| `openaudiohub.sqlite` | The database. SQLite runs in WAL mode with `synchronous=FULL`, so `openaudiohub.sqlite-wal` and `openaudiohub.sqlite-shm` sit next to it while the server runs. |
| `storage/` | Audio files and derived files, when local storage is used. |

Encrypted fields in the database can be read only with the same `ENCRYPTION_KEY`. Losing the key loses those values.

## 7. Health check and monitoring

`GET /api/health` answers `200 OK`:

```json
{ "status": "ok", "version": "<version>" }
```

- The answer means the server is up and the database answers a query.
- When the database does not answer, the answer is `503` with the code `DATABASE_UNAVAILABLE`.
- The container health check uses this endpoint (section 2).
- Logs go to standard output and standard error, through the `tracing` format. Server errors (`5xx`) are logged with the `errorId` that the client receives in `details.errorId`.

## 8. Reverse proxy

A reverse proxy in front of the container must:

- terminate TLS, when the public address is `https://`;
- forward requests to `127.0.0.1:3000` on the host, or to the container's port;
- keep the public origin equal to `APP_URL`, because cookie-carrying writes must send that origin (see `auth.md`);
- pass the public host name in the `Host` header. With `RATE_LIMIT_TRUST_PROXY_HEADERS=true`, the server reads `X-Forwarded-Host` instead when that header is present, so the proxy must set it to the public host name in that case. A single-account server opens its account only for that host name (see `auth.md`);
- allow request bodies up to 500 MiB for recording uploads;
- pass `Range` requests and response bodies through unchanged, because audio playback uses byte ranges;
- set the client address header (`CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For`) only when `RATE_LIMIT_TRUST_PROXY_HEADERS=true`, and only when the proxy sets it itself.

A server that other people can reach over a network needs the proxy to authenticate them. A single-account server has no sign-in of its own, so anyone who reaches the server uses the account. Put a proxy with its own authentication in front, such as single sign-on or HTTP basic authentication.

The server sends these headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a Content-Security-Policy that allows only the app's own files and the model hub used for in-browser transcription. When `APP_URL` starts with `https://`, it also sends `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

## 9. Operating the instance

### 9.1 Upgrades

1. Take a backup (section 10).
2. Set the new version and start the new image:

```sh
OPENAUDIOHUB_VERSION=<version> docker compose pull
OPENAUDIOHUB_VERSION=<version> docker compose up -d
```

- Database migrations are built into the server and run at start, in order, before the server listens.
- The encryption key must stay the same across upgrades.

### 9.2 Account password reset from the command line

This command applies to multi-account servers (`OAH_MULTI_USER=true`). A single-account server has no sign-in to reset.

```sh
docker compose exec app oah-server reset-password <email>
```

The command sets a new random password of 24 hex characters, deletes all sessions of the account, and prints the password once. The account must exist. This works without SMTP.

### 9.3 Secrets

- `ENCRYPTION_KEY` has no rotation procedure. The server decrypts stored values only with the key it starts with. Starting with a different key makes the stored values unreadable.
- `API_TOKEN_HASH_SECRET` can be changed, but that invalidates every personal API key.
- Keep `ENCRYPTION_KEY` in a place other than the data volume.

## 10. Backups

- To back up a stopped instance, copy the whole data volume.
- To back up a running instance, take an online copy of the database file with SQLite's backup mechanism (for example the `.backup` command of the `sqlite3` program), and copy the `storage/` folder after that.
- Store the backup together with the `ENCRYPTION_KEY` in a separate place. A backup without the key cannot be read.

The in-app export of user data (the Export page, and auto export in the desktop app) is separate from these server backups. See `export.md`.

## 11. Limits and behaviour summary

| Item | Value |
|---|---|
| Recording upload size | 500 MiB per file |
| Transcription upload without re-encoding | `WHISPER_MAX_BYTES` (default 24 MiB) |
| Session length | 7 days, extended on use (see `auth.md`) |
| Rate limits | Per client address and per email, in memory, reset on restart (see `auth.md`) |
| Background sync | Every `BACKGROUND_SYNC_INTERVAL_MS`, first run 30 s after start |
| Platforms | `linux/amd64`, `linux/arm64` |
