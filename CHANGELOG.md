# Changelog

Changes to OpenAudioHub are recorded here. Maintainers write entries at release time.

Based on Riffado v0.6.4 (`712e74f`). Release notes from before this project are in the upstream changelog at https://github.com/riffado/riffado/blob/main/CHANGELOG.md.

## [Unreleased]

## [1.0.1]

### Fixed

- The one-line installer works. The audio pipeline is now published as `ghcr.io/jeremyl691/openaudiohub-audio-pipeline`, and `docker-compose.yml` pulls it instead of building it from source, so an installation needs no source checkout. To build both images from a checkout, add `docker-compose.dev.yml`.

## [1.0.0]

First OpenAudioHub release. It is built from the base commit named above, and it includes the long-audio pipeline. Hosted-only code is removed, and the project is renamed. To move an existing installation, follow [docs/MIGRATION_FROM_RIFFADO.md](docs/MIGRATION_FROM_RIFFADO.md).

### Breaking Changes

- Webhook headers are renamed to `X-OpenAudioHub-Event`, `X-OpenAudioHub-Delivery`, `X-OpenAudioHub-Timestamp`, and `X-OpenAudioHub-Signature`. The User-Agent is `OpenAudioHub-Webhooks/1`. The previous header names are no longer sent. Update receivers before you switch.
- The version variable is renamed to `OPENAUDIOHUB_VERSION`. The previous name is no longer read. Compose and the installer read only the new name.
- The Compose project, container names, image (`ghcr.io/jeremyl691/openaudiohub`), database name (`openaudiohub`), and volume names change. Existing data must be restored into the new database.
- The audio pipeline's job field and request field are named `core_job_id`. The pipeline still accepts the previous request field, and it renames its column on startup. Upgrade the pipeline before Core.
- `docker-compose.yml` enables the audio pipeline by default and requires `AUDIO_PIPELINE_TOKEN`, which must be at least 32 characters.
- Hosted-only environment variables, including `IS_HOSTED`, are removed. Unknown variables are ignored.
- Migration `0041_rebrand_source_values` rewrites stored legacy source values to `openaudiohub`. Reads accept both values. Migration `0043_source_default_openaudiohub` makes `openaudiohub` the column default for new rows.
- Migration `0044_provider_presets_siliconflow_opencode` moves `Custom` provider rows onto the SiliconFlow (China) and OpenCode Go presets when their base URL matches. Keys, models, and default flags are unchanged. OpenCode Go rows point at `https://opencode.ai/zen/go/v1`, and the app sends the `x-opencode-session` header itself, so a header-injecting proxy is no longer needed.
- Summary templates write Markdown, not JSON. Existing summaries are unchanged. Regenerate a summary to get the new layout.
- Summary output languages are Auto, Chinese (Simplified), English, Japanese, and Korean. A saved language outside that list reads as Auto.

### Added

- Migration guide at [docs/MIGRATION_FROM_RIFFADO.md](docs/MIGRATION_FROM_RIFFADO.md).
- API keys use the `oah_` prefix. Existing `op_` keys keep working.
- Third-party notices in [NOTICE](NOTICE).
- Summary templates for meetings (minutes with an owner, task, due date, and status for each action item), interviews and research, phone and client calls, lectures, brainstorms, and voice memos.
- A summary language choice for each run, and a record of the template and language each summary used.
- Copy, Markdown, and TXT export for summaries. TXT and JSON downloads for transcripts.
- Deleting a transcript, together with the summary made from it.
- SiliconFlow (China) and OpenCode Go provider presets. OpenCode Go is for summaries and titles only. `OPENCODE_GO_SESSION_ID` sets its session header.
- A Back to app link in the docs.

### Changed

- Product names, UI copy, email text, and the footer read OpenAudioHub. The footer reads “Licensed under AGPL-3.0” and links to NOTICE, which credits the upstream project.
- Browser storage keys are now `openaudiohub:*`. Values under the previous key names are copied on first read, and the old keys are then removed.
- The browser connector global is `window.__openaudiohubConnector`. The previous global is still read.
- Download filenames are `openaudiohub-export-*.zip`. The Bark group is `openaudiohub-recordings`. Temporary directories use the `oah-` prefix.
- The installer defaults to `$HOME/openaudiohub` and downloads from `github.com/JeremyL691/OpenAudioHub`.
- Uncaught exceptions are logged, and the process stops. Unhandled promise rejections are logged.
- Transcripts show every segment, in a scroll area on the recording page and in the library preview. Scrolling by hand turns off Follow playback.
- Summaries follow the template's structure and say when a section has nothing to report.
- Summary and title generation share one provider client and one chat-model fallback.

### Fixed

- Clicking a line in the transcript seeks the audio to that line. The highlight follows playback, and Follow playback keeps the active line in view.
- Choosing a display theme applies it at once, without a reload.
- Long recordings get an automatic summary after the audio pipeline commits the transcript, as direct transcription already did. A job that is replayed does not summarize twice.
- The recording page no longer scrolls sideways at 1280 px when a title is long. Titles truncate.
- Uploaded recordings are labelled Upload, not Plaud.
- The default export format in Settings › Export/Backup can be set to TXT, SRT, or VTT. The server used to reject those choices and accept `csv` and `zip`, which the exporter cannot produce. A saved `csv` or `zip` default now falls back to JSON.
- Recordings that the audio pipeline is processing show their phase in the library and on the overview, and they appear under the Processing filter.
- The recording page shows the title, date, and size once, in the page header. File sizes use the same units everywhere.
- Status badges update after a transcript or summary is deleted or regenerated.
- Title generation no longer forces `gpt-4o-mini` when the stored default is a Whisper model on Groq or Together AI.

### Removed

- Hosted-only features: Stripe billing, managed transcription, PostHog and OpenAnalytics, the hosted admin console, marketing and newsletter email, email validation, the landing, pricing, legal, changelog, and rebrand pages, trial banners, and the Discord link.
- Database tables and columns that supported those features remain in place as deprecated objects. No data is dropped.
- `docker-compose.enhanced.yml`. Its settings are in `docker-compose.yml`.
- `.github/FUNDING.yml` and `SPONSORS.md`.
- `EMAIL_SEND_RATE_PER_SECOND`. It only paced the removed marketing email.

### Security

- The bundled Postgres service publishes its port on `127.0.0.1` only.
- The installer generates `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `AUDIO_PIPELINE_TOKEN`.
- `next` is upgraded from 16.2.10 to 16.3.8, which fixes three critical remote code execution advisories (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4, GHSA-vcvr-r3jv-pc5j).

### Known issues

- `pnpm audit --prod` reports one critical advisory, in `protobufjs` 6.11.4 (GHSA-xq3m-2v4x-88gg). It arrives through `@xenova/transformers`, which runs in-browser transcription, and has no fixed 6.x release.
- Login, registration and password-reset rate limits are inactive unless `RATE_LIMIT_TRUST_PROXY_HEADERS=true` is set behind a trusted reverse proxy. The server logs a notice at startup.
- The feature list once named translation of summaries. The imported code never had it, so it is not in this release.
