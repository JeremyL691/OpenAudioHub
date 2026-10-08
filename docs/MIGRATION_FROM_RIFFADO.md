# Migrating from Riffado to OpenAudioHub

This guide moves an existing Riffado installation, or its Long Audio fork, to OpenAudioHub 1.0.0. Read the breaking changes first, then follow the steps in order. Take a full backup before you start, and keep the old volumes and the database dump until you have verified the new stack.

## Breaking changes

These changes are not aliased unless the table says so.

| Area | Before | After | What you need to do |
| --- | --- | --- | --- |
| Webhook headers | `X-Riffado-Event`, `X-Riffado-Delivery`, `X-Riffado-Timestamp`, `X-Riffado-Signature` | `X-OpenAudioHub-Event`, `X-OpenAudioHub-Delivery`, `X-OpenAudioHub-Timestamp`, `X-OpenAudioHub-Signature` | Update webhook receivers before you switch. The old names are not sent. The signature format is unchanged. |
| Webhook User-Agent | Riffado user agent | `OpenAudioHub-Webhooks/1` | Update any receiver or proxy rule that matches the old value. |
| Environment variable | `RIFFADO_VERSION` | `OPENAUDIOHUB_VERSION` | Rename it in `.env`. Compose ignores the old name and falls back to `latest`. |
| Image | `ghcr.io/riffado/riffado` | `ghcr.io/jeremyl691/openaudiohub` | Use the `docker-compose.yml` from the OpenAudioHub release. |
| Compose project | `riffado` | `openaudiohub` | Volumes are named `openaudiohub_*`. Existing `riffado_*` volumes are not used automatically. |
| Database name | `riffado` | `openaudiohub` | Restore your dump into the `openaudiohub` database (step 3). |
| Audio pipeline job field | `riffado_job_id` | `core_job_id` | Upgrade the pipeline before Core (see [Upgrade order](#upgrade-order)). The pipeline still accepts the old request field. |
| Audio pipeline setup | Optional overlay | Enabled by default. `AUDIO_PIPELINE_TOKEN` is required. | Add `AUDIO_PIPELINE_TOKEN` to `.env`, at least 32 characters. Compose refuses to start without it, even when the pipeline is disabled. |
| Hosted settings | `IS_HOSTED` and related variables | Removed | Unknown variables are ignored, so an old `.env` still starts. You can delete the hosted variables. |
| API keys | `op_` prefix | New keys use `oah_` | Existing `op_` keys keep working. New keys use the new prefix. |
| Transcript source value | `riffado` | `openaudiohub` | Migration `0041_rebrand_source_values` rewrites stored values on startup. Reads still accept the old value. |
| Browser storage keys | `riffado_*` | `openaudiohub:*` | Migrated automatically the first time each browser reads them. |
| Browser connector global | `window.__riffadoConnector` | `window.__openaudiohubConnector` | The old global is still read. Nothing to change. |
| Export filename | `riffado-export-*.zip` | `openaudiohub-export-*.zip` | Update scripts that match the filename. |
| Bark group | `riffado-recordings` | `openaudiohub-recordings` | Update any Bark rule that filters on the group. |
| Temporary file prefixes | `riffado-upload-`, `riffado-diarize-` | `oah-upload-`, `oah-diarize-` | Nothing, unless you monitor the temp directory by prefix. |
| Installer | `riffado.com/install.sh` | `https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh` | Update your runbooks. |

The sender for email notifications is `SMTP_FROM`, then `SMTP_USER`. Only when both are unset does it fall back to `OpenAudioHub <noreply@host>`, where `host` is the host of `APP_URL`. The old fallback was `noreply@riffado.com`.

## Upgrade order

Upgrade the audio pipeline before Core.

- A new pipeline accepts requests from an old Core, because it still reads `riffado_job_id`.
- A new Core cannot use an old pipeline, because the old pipeline does not know `core_job_id`.

In Compose, start the new `audio-pipeline` service, wait until it is healthy, and only then start `app`.

## Recommended path

`scripts/migrate-from-riffado.sh` runs the migration and checks it. It reads the old stack and never writes to it.

1. Stop the old app so nothing writes during the export. Wait until no pipeline job is active:

   ```bash
   docker stop riffado-app
   ```

2. Export (read-only). The script refuses to run while the old app is up:

   ```bash
   bash scripts/migrate-from-riffado.sh --export-only --out ./migration-artifacts/riffado-export
   ```

3. Restore into the new deployment. The script refuses to overwrite a database or a volume that already has data, and it prints seven checks to `validation.txt`:

   ```bash
   bash scripts/migrate-from-riffado.sh --restore-from ./migration-artifacts/riffado-export --target-project openaudiohub --target-env .env --target-dir .
   ```

Keep the old volumes and the old directory until the new stack has run for a while. The steps below are the same work done by hand, kept for reference.

## Manual steps (reference)

### 1. Back up the old installation

Run these commands from the directory that holds the old `docker-compose.yml` and `.env`. They only read from the old database and volumes.

```bash
docker compose exec -T db pg_dump -U postgres -Fc riffado > riffado.dump
docker run --rm -v riffado_audio:/data -v "$PWD":/backup alpine tar czf /backup/audio.tar.gz -C /data .
docker run --rm -v riffado_storage:/data -v "$PWD":/backup alpine tar czf /backup/storage.tar.gz -C /data .
docker run --rm -v riffado_audio-pipeline-data:/data -v "$PWD":/backup alpine tar czf /backup/pipeline-data.tar.gz -C /data .
cp .env env.riffado.backup
```

Check the dump with `pg_restore --list riffado.dump`. Keep `env.riffado.backup` with restricted permissions, because it contains secrets. Store a copy of `ENCRYPTION_KEY` in a separate, protected location.

Do not run `docker compose down -v`. That command deletes volumes.

### 2. Prepare the new `.env`

Start from the OpenAudioHub `.env.example`, then copy the values that must stay the same:

- `ENCRYPTION_KEY` must be unchanged. Without it, stored transcripts, summaries, and Plaud tokens cannot be decrypted.
- `BETTER_AUTH_SECRET` should be unchanged. Sessions remain valid, and personal API keys keep validating. If you set `API_TOKEN_HASH_SECRET`, keep that value too.
- `POSTGRES_PASSWORD` should match the password of the database you restore into. A new volume takes this value on first start.
- Rename `RIFFADO_VERSION` to `OPENAUDIOHUB_VERSION`. Pin an exact release, for example `1.0.0`.
- Add `AUDIO_PIPELINE_TOKEN`, a random value of at least 32 characters.
- Keep `APP_URL` as the address your users open.

Remove the hosted variables if you want. Unknown variables are ignored.

### 3. Restore the database

Start only the database service, then restore into the new database name:

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U postgres -d openaudiohub --no-owner < riffado.dump
```

The app applies pending migrations when its container starts. That includes `0041_rebrand_source_values`, which rewrites `riffado` source values to `openaudiohub`.

### 4. Restore the volumes

Copy the archives into the new volumes. Use the same destination paths as the old volumes.

```bash
docker run --rm -v openaudiohub_audio:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/audio.tar.gz"
docker run --rm -v openaudiohub_storage:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/storage.tar.gz"
docker run --rm -v openaudiohub_audio-pipeline-data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/pipeline-data.tar.gz"
```

Skip a volume if your installation does not use it. For example, S3 storage does not use the `storage` volume.

### 5. Start the pipeline, then the app

```bash
docker compose up -d audio-pipeline
docker compose up -d app
```

On startup the pipeline renames the `riffado_job_id` column in its SQLite job table to `core_job_id`. Keep the pipeline data volume backup until you have verified the new stack.

### 6. Verify

- `curl http://localhost:3000/api/health` returns `"status":"ok"`.
- You can sign in with an existing account.
- A recording plays, and its transcript and summary display. Decrypted text confirms that `ENCRYPTION_KEY` is correct.
- Settings shows your Plaud connection, providers, and notification settings.
- A test webhook delivery arrives with the `X-OpenAudioHub-*` headers, and your receiver accepts its signature.

### 7. Switch over

Both stacks cannot publish port 3000 at the same time. Stop the old stack before you start the new one on the same host. Changes made after the switch exist only in the new database.

Update webhook receivers before the switch. After the switch, the new app sends only the new header names.

## Rollback

Keep the old dump, the old volumes, and `env.riffado.backup` until the new stack has run for long enough to trust it.

To return to Riffado:

1. Stop the new stack: `docker compose down` (without `-v`).
2. Revert the transcript source values. This SQL reverses migration `0041`. Run it against the database before you start the old application:

   ```sql
   UPDATE "transcriptions" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
   UPDATE "ai_enhancements" SET "source" = 'riffado' WHERE "source" = 'openaudiohub';
   UPDATE "user_settings" SET "preferred_transcript_source" = 'riffado' WHERE "preferred_transcript_source" = 'openaudiohub';
   ```

   The same statements are in `scripts/rollback/rebrand-source-values.down.sql`. Migrations do not run this file automatically. The provider pointer that migration `0041` cleared cannot be restored.

3. Start the old stack with its original project name, its original image tag, and its original `.env`.

If you want to go back to the exact pre-upgrade state, restore the old dump into the old database and the archives into the old volumes. Anything written after the switch, such as recordings, transcripts, and settings, is lost in that case unless you export it first.

Restoring the pipeline data volume is the simplest way to roll back the pipeline. Stop the pipeline before you restore its volume.
