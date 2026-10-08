# Deployment guide

This guide covers running OpenAudioHub in production with Docker Compose. For a first install, the [installer](../content/docs/self-hosting/install.mdx) is the quickest route. For upgrades, see [Upgrading](../content/docs/self-hosting/upgrading.mdx).

## Prerequisites

- Docker with Compose v2.
- A domain name and a TLS certificate, for example from Let's Encrypt, if other machines will reach the instance.
- A reverse proxy such as nginx or Caddy.
- Optional: S3-compatible storage for audio, and an SMTP server for email notifications.

## Configure

Copy `.env.example` to `.env`. Set `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `AUDIO_PIPELINE_TOKEN`, and `APP_URL`. Generate each secret separately with `openssl rand -hex 32`. Every variable and its default is listed in the [environment variables reference](../content/docs/self-hosting/environment-variables.mdx).

A typical production configuration with S3 storage and email:

```env
APP_URL=https://openaudiohub.example.com

DEFAULT_STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.example.com
S3_BUCKET=openaudiohub
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=<key-id>
S3_SECRET_ACCESS_KEY=<secret>

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<user>
SMTP_PASSWORD=<password>
SMTP_FROM="OpenAudioHub <noreply@example.com>"

WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true
```

Keep `ENCRYPTION_KEY` in a secure location outside the database backups. Without it, encrypted content cannot be recovered.

## Start the stack

```bash
docker compose pull
docker compose up -d
docker compose ps
```

The app runs its database migrations when its container starts, and it stops if a migration fails.

## Reverse proxy

The app listens on port 3000. Put a proxy in front of it for TLS.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name openaudiohub.example.com;

    ssl_certificate /etc/letsencrypt/live/openaudiohub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openaudiohub.example.com/privkey.pem;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}

server {
    listen 80;
    server_name openaudiohub.example.com;
    return 301 https://$server_name$request_uri;
}
```

The example sets `X-Forwarded-For` to the connecting address, so the client cannot supply its own value. Only set `RATE_LIMIT_TRUST_PROXY_HEADERS=true` when your proxy overwrites this header in the same way.

### Caddy

```caddyfile
openaudiohub.example.com {
    reverse_proxy localhost:3000

    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    request_body {
        max_size 100MB
    }
}
```

### TLS with Certbot

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d openaudiohub.example.com
sudo certbot renew --dry-run
```

## Backups

The Compose project is named `openaudiohub`, so its volumes are named `openaudiohub_*`. Back up three things: the database, the audio volume (unless you use S3), and the pipeline data volume if the pipeline is enabled.

Dump the database in custom format:

```bash
docker compose exec -T db pg_dump -U postgres -Fc openaudiohub > openaudiohub-$(date +%Y%m%d).dump
```

Archive the audio volume without changing it:

```bash
docker run --rm -v openaudiohub_audio:/data -v "$PWD":/backup alpine \
  tar czf /backup/audio-$(date +%Y%m%d).tar.gz -C /data .
```

Keep the dump, the archive, and `.env` in a location with restricted access. Keep `ENCRYPTION_KEY` apart from them. Test a restore before you rely on the backups. For the full operations procedure, including the pipeline data, see [docs/audio-pipeline-operations.md](audio-pipeline-operations.md).

Do not run `docker compose down -v` as a routine restart. It deletes the volumes.

## Rotating the bundled database password

Postgres reads `POSTGRES_PASSWORD` only when it creates the volume. To change the password of an existing database:

```bash
NEW_PW="$(openssl rand -hex 24)"
docker compose exec db psql -U postgres -c "ALTER USER postgres WITH PASSWORD '${NEW_PW}'"
# Write the same value to .env as POSTGRES_PASSWORD, then recreate the app:
docker compose up -d --force-recreate app
```

## Health and monitoring

- `GET /api/health` returns `"status":"ok"` when the app is ready.
- `docker compose ps` shows the state of each container.
- `docker compose logs -f app` follows the application log. Background worker messages are tagged, for example `[background-sync]`.

Set up an external uptime check against `/api/health`.

## Scaling

The default Compose file runs one app container and one database. The background workers claim their work in the database, so several app processes can share one database. That configuration has not been load tested for this release.

## Troubleshooting

- **The app exits at startup.** The log names the invalid or missing variable. Fix `.env`, then run `docker compose up -d`.
- **Migrations fail.** The app does not start. The log shows the failing migration. Restore from your backup if the database is in a partial state, then fix the cause and start again.
- **The pipeline does not start.** `AUDIO_PIPELINE_TOKEN` must be at least 32 characters. Both services read the same variable, so set it once in `.env`.
- **Uploads or audio fail on local storage.** Check that the audio directory is writable by the container, and that there is enough disk space.
- **Long recordings run out of disk.** The pipeline writes decoded audio to disk. A 24-hour recording needs about 2.76 GB of decoded PCM, plus the source audio and temporary files. Jobs pause with a disk-space error when space runs out, and they resume when space is available.
