# Changelog

Changes to OpenAudioHub are recorded here. Maintainers write entries at release time.

Based on Riffado v0.6.4 (`712e74f`). Release notes from before this project are in the upstream changelog at https://github.com/riffado/riffado/blob/main/CHANGELOG.md.

## [Unreleased]

## [1.0.0]

First OpenAudioHub release. It is built from the base commit named above, and it includes the long-audio pipeline. Hosted-only code is removed, and the project is renamed. To move an existing installation, follow [docs/MIGRATION_FROM_RIFFADO.md](docs/MIGRATION_FROM_RIFFADO.md).

### Breaking Changes

- Webhook headers are renamed to `X-OpenAudioHub-Event`, `X-OpenAudioHub-Delivery`, `X-OpenAudioHub-Timestamp`, and `X-OpenAudioHub-Signature`. The User-Agent is `OpenAudioHub-Webhooks/1`. The previous header names are no longer sent. Update receivers before you switch.
- The version variable is renamed to `OPENAUDIOHUB_VERSION`. The previous name is no longer read. Compose and the installer read only the new name.
- The Compose project, container names, image (`ghcr.io/jeremyl691/openaudiohub`), database name (`openaudiohub`), and volume names change. Existing data must be restored into the new database.
- The audio pipeline's job field and request field are named `core_job_id`. The pipeline still accepts the previous request field, and it renames its column on startup. Upgrade the pipeline before Core.
- `docker-compose.yml` enables the audio pipeline by default and requires `AUDIO_PIPELINE_TOKEN`, which must be at least 32 characters.
- Hosted-only environment variables, including `IS_HOSTED`, are removed. Unknown variables are ignored.
- Migration `0041_rebrand_source_values` rewrites stored legacy source values to `openaudiohub`. Reads accept both values.

### Added

- Migration guide at [docs/MIGRATION_FROM_RIFFADO.md](docs/MIGRATION_FROM_RIFFADO.md).
- API keys use the `oah_` prefix. Existing `op_` keys keep working.
- Third-party notices in [NOTICE](NOTICE).

### Changed

- Product names, UI copy, email text, and the footer read OpenAudioHub. The footer attribution credits the upstream project.
- Browser storage keys are now `openaudiohub:*`. Values under the previous key names are copied on first read, and the old keys are then removed.
- The browser connector global is `window.__openaudiohubConnector`. The previous global is still read.
- Download filenames are `openaudiohub-export-*.zip`. The Bark group is `openaudiohub-recordings`. Temporary directories use the `oah-` prefix.
- The installer defaults to `$HOME/openaudiohub` and downloads from `github.com/JeremyL691/OpenAudioHub`.
- Uncaught exceptions are logged, and the process stops. Unhandled promise rejections are logged.

### Fixed

- Clicking a line in the transcript seeks the audio to that line. The highlight follows playback, and Follow playback keeps the active line in view.
- Choosing a display theme applies it at once, without a reload.
- Long recordings get an automatic summary after the audio pipeline commits the transcript, as direct transcription already did. A job that is replayed does not summarize twice.
- The recording page no longer scrolls sideways at 1280 px when a title is long. Titles truncate.
- Uploaded recordings are labelled Upload, not Plaud.

### Removed

- Hosted-only features: Stripe billing, managed transcription, PostHog and OpenAnalytics, the hosted admin console, marketing and newsletter email, email validation, the landing, pricing, legal, changelog, and rebrand pages, trial banners, and the Discord link.
- Database tables and columns that supported those features remain in place as deprecated objects. No data is dropped.
- `docker-compose.enhanced.yml`. Its settings are in `docker-compose.yml`.
- `.github/FUNDING.yml` and `SPONSORS.md`.

### Security

- The bundled Postgres service publishes its port on `127.0.0.1` only.
- The installer generates `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `AUDIO_PIPELINE_TOKEN`.

### Known issues

- `pnpm audit --prod` reports critical advisories in `next` 16.2.10 (remote code execution, fixed in 16.3.8 or later). Upgrade `next` before publishing a public release.
- Login, registration and password-reset rate limits are inactive unless `RATE_LIMIT_TRUST_PROXY_HEADERS=true` is set behind a trusted reverse proxy. The server logs a notice at startup.
- The feature list once named translation of summaries. The imported code never had it, so it is not in this release.
