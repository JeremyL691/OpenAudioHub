# Self-hosting OpenAudioHub

This guide covers the self-hosted server. It runs as one Docker container with one data volume. The database is a single SQLite file. Audio files are stored in a folder in the same volume, or in an S3-compatible bucket if you set one up.

- [Requirements](#requirements)
- [Install](#install)
- [The compose file](#the-compose-file)
- [Settings](#settings)
- [Reverse proxy](#reverse-proxy)
- [Accounts](#accounts)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Health check](#health-check)
- [Reset a password](#reset-a-password)
- [Logs](#logs)

## Requirements

- Docker with the Compose plugin (`docker compose`).
- A domain name and a reverse proxy that serves HTTPS. Examples are nginx and Caddy.
- `openssl`, to create the encryption key. Any tool that makes 32 random bytes as hex works.

## Install

1. Create a folder for the install. Copy `deploy/compose.yml` from the repository into it.
2. Create the key and the public address in a file named `.env` in the same folder:

   ```sh
   printf 'ENCRYPTION_KEY=%s\nAPP_URL=https://audio.example.com\n' "$(openssl rand -hex 32)" > .env
   ```

   Replace `https://audio.example.com` with the address people will open in the browser.
3. Start the container:

   ```sh
   docker compose up -d
   ```

4. Check that it runs:

   ```sh
   docker compose ps
   curl -fsS http://127.0.0.1:3000/api/health
   ```

   The health check returns `{"status":"ok","version":"1.1.0"}`.

Keep `.env` safe. It holds `ENCRYPTION_KEY`. Without that key, the encrypted titles, transcripts and summaries in the database cannot be read. See [Backups](#backups).

## The compose file

`compose.yml` defines one service named `app` and one volume named `data`.

- The image is `ghcr.io/jeremyl691/openaudiohub`. The tag is set by `OPENAUDIOHUB_VERSION` in `.env`. If you do not set it, the tag is `latest`. Pin a version number for production.
- The port is published as `127.0.0.1:3000:3000`. Only programs on the same machine can reach it. Your reverse proxy must run on that machine.
- The volume `data` is mounted at `/data`. The compose project is named `openaudiohub`, so Docker names the volume `openaudiohub_data`. Run `docker volume ls` to check the name.
- `compose.yml` passes four variables into the container: `ENCRYPTION_KEY`, `APP_URL`, `RATE_LIMIT_TRUST_PROXY_HEADERS` and `DISABLE_REGISTRATION`. To set any other variable, add it under `environment:` in `compose.yml`, or set it on the image. The full list is in [Environment variables](environment-variables.md).

To build the image yourself, run this from the repository root:

```sh
docker build -f deploy/Dockerfile -t openaudiohub .
```

Then tag it with the name in `compose.yml`, or change the `image:` line to your image name.

## Settings

Every setting the server reads is in [Environment variables](environment-variables.md). The ones most people change are:

- [`APP_URL`](environment-variables.md#required-and-common): the public address.
- [`DISABLE_REGISTRATION`](environment-variables.md#required-and-common): set to `true` once your account exists.
- [`DEFAULT_STORAGE_TYPE`](environment-variables.md#storage) and the `S3_*` variables: store audio in an S3-compatible bucket. See [S3-compatible storage](storage-s3.md).
- `SMTP_*` variables: send email for notifications and password reset. See [Email (SMTP) setup](email-smtp.md).

Most other settings are about tuning and can stay at their defaults.

## Reverse proxy

Terminate HTTPS at the proxy. Forward requests to `127.0.0.1:3000`. The example below is for nginx. It is a starting point, not a full configuration.

```nginx
server {
    listen 443 ssl;
    server_name audio.example.com;

    # Uploads can be up to 500 MB per file.
    client_max_body_size 500m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Keep these points in mind:

- **APP_URL.** It must match the address in the browser. While you are signed in, the server checks the origin of every change you make. If the addresses differ, saving fails with an origin error.
- **Client addresses.** The server counts sign-in attempts per client address. Without a proxy setting, every user behind the proxy shares one count. Set `RATE_LIMIT_TRUST_PROXY_HEADERS=true` only when the proxy sets `cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`. If the server can be reached without the proxy, a client can fake these headers, so keep the port closed to the network.
- **Uploads.** One upload can be up to 500 MB. Set the proxy's body size limit to at least that value. The nginx example uses `client_max_body_size 500m;`.
- **Audio playback.** The player asks for parts of a file with HTTP range requests. The proxy must pass the `Range` header through. The nginx example does this by default.
- **Timeouts.** Uploads, downloads and backups can take minutes. If they fail with a gateway timeout, raise the proxy timeouts.
- **Sign-in limits.** The server allows 10 sign-in attempts per minute and 5 sign-ups per minute for each client address.

## Accounts

Open `APP_URL/register` in a browser to create the first account. Then open `APP_URL/login` to sign in.

If you want only one account on the server, create it first. Then set `DISABLE_REGISTRATION=true` in `.env`, add the variable to `compose.yml` as described in [The compose file](#the-compose-file), and run `docker compose up -d` again. With registration off, the sign-in page hides the link to sign-up, and `/register` redirects to sign-in.

If you forget your password, use the **Forgot password?** link on the sign-in page. That link sends an email, so it works only when SMTP is set up. See [Email (SMTP) setup](email-smtp.md). Without email, use [Reset a password](#reset-a-password).

## Backups

Your data is in the `data` volume:

- `openaudiohub.sqlite`: the database. It holds your account, recording rows, transcripts, summaries and settings.
- `storage/`: the audio files stored on disk. While a long recording is processed, a `storage/.pipeline/` folder holds temporary files.

Back up two things:

1. **The data volume.** Use one of the two methods below. If you use S3 storage, the audio is in your bucket, so back up the bucket too.
2. **`ENCRYPTION_KEY`.** Copy it from `.env` and store it apart from the backup. A backup without the key cannot read the encrypted fields.

For what the app can export, and the difference between the export and a server backup, see [Backup and restore](backup-and-restore.md).

### Full backup in the app

Open **Settings**, then **Export/Backup**, then choose **Create full backup**. The server builds a zip file with the audio, the transcripts, the summaries and a `manifest.json` file. Download it while it is ready. The server keeps the file for 7 days. If a full backup finished in the last 24 hours, the button shows that one instead of making a new one.

This backup holds your content but not the encryption key. Store the key apart from the backup.

### Copy the data volume

This method copies the database and the audio files together. Stop the container first, so the database is not changing during the copy.

```sh
docker compose stop app
docker run --rm \
  -v openaudiohub_data:/data:ro \
  -v "$PWD":/backup \
  debian:trixie-slim \
  tar -czf "/backup/openaudiohub-data-$(date +%F).tar.gz" -C /data .
docker compose start app
```

Check the volume name with `docker volume ls` if the command says the volume does not exist.

### Restore

1. Stop the container with `docker compose stop app`.
2. Restore the files into the volume. This deletes the current contents of the volume first. Replace the archive name with your file:

   ```sh
   docker run --rm \
     -v openaudiohub_data:/data \
     -v "$PWD":/backup \
     debian:trixie-slim \
     sh -c 'rm -rf /data/* && tar -xzf /backup/openaudiohub-data-2026-10-16.tar.gz -C /data'
   ```

3. Put the same `ENCRYPTION_KEY` in `.env`, then start the container with `docker compose start app`.

## Upgrading

Make a backup first. Then pull the new image and start it:

```sh
docker compose pull
docker compose up -d
```

To pin a version, put `OPENAUDIOHUB_VERSION=1.1.0` in `.env` before you run `docker compose up -d`.

The server updates the database when it starts. Do not start an older image on data that a newer image has opened. If you need to go back, restore the backup you made before the upgrade.

## Health check

The container checks `http://127.0.0.1:3000/api/health` every 30 seconds. The endpoint also checks the database. When the database answers, it returns:

```json
{"status":"ok","version":"1.1.0"}
```

Run `docker compose ps` to see the health state.

## Reset a password

Run this on the server:

```sh
docker compose exec app oah-server reset-password you@example.com
```

The command gives the account a new random password and prints it once. It also signs out every session of that account. Sign in with the new password, and store it in a password manager. This works with no email setup.

## Logs

```sh
docker compose logs -f app
```

Set `OAH_LOG` to change how much the server writes. See [Logging](environment-variables.md#logging).
