# OpenAudioHub specification

The files in this folder specify how OpenAudioHub behaves for its users and for the systems that talk to it: the HTTP requests and responses, the pages, the background behaviour, the files written to disk, and the deployment settings. Each file describes the current behaviour only. Use them to check an implementation, to build a client, or to answer "what does this do?" for an area of the product.

The contract tests in `contract-tests/` check the specification against a running server. Each area has a test file in `contract-tests/tests/`, and the tests talk to the server over HTTP.

## Files

| File | Covers |
|------|--------|
| `ai.md` | AI providers, presets, summaries, titles and prompt presets. |
| `audio-pipeline.md` | The pipeline for long recordings: probing, voice activity detection, chunking, transcript merging, repair and disk budget. |
| `auth.md` | Accounts, sign-up and sign-in, the session cookie, the desktop session exchange, password reset, rate limits and origin checks. |
| `deployment.md` | The server container: image, compose file, environment variables, data volume, health check and upgrades. |
| `desktop.md` | The macOS desktop app: start and quit, windows, tray, menu, preferences, launch at login and the data folder. |
| `export-backup.md` | The quick export, full backup archives and scheduled backups. |
| `pages.md` | The routes the server answers: web pages, redirects, health, install and docs links, and not-found responses. |
| `plaud.md` | The Plaud connection, its sign-in flows, sync, and the Plaud web API the app calls. |
| `recordings.md` | Recordings over HTTP: list, detail, edit, star, delete, upload, download, audio streaming, waveform peaks and merge. |
| `settings.md` | User settings, storage usage, the test email, and the public `/api/v1` API. |
| `transcription.md` | Starting a transcription, choosing a provider, what providers receive and return, and storing or deleting transcripts. |
| `ui-app.md` | The signed-in shell, navigation, the Dashboard, settings pages, dialogs, onboarding and theme. |
| `ui-design.md` | The visual design shared by every screen: colours, type, shapes and layout recipes. |
| `ui-library.md` | The recordings library, the recording detail page, the player and keyboard shortcuts. |
| `webhooks.md` | Webhook endpoints, signed deliveries, the delivery log and redelivery. |
| `workers.md` | Background work that no request starts: timers, queues, automatic steps, notifications and failure handling. |

## Contract tests

- Test files in `contract-tests/tests/` are named after the spec file they check. A few files cover more than one spec file.
- Tests send HTTP requests only. They do not read the database or the files on disk.
- Tests create their own data and do not depend on data from other tests.
- External services are faked. AI calls go to a fake provider in `contract-tests/fakes/`.
- Run a file against a running server with `contract-tests/run.sh url tests/<area>.spec.ts`. The server's address is read from `OAH_BASE_URL`. `contract-tests/run.sh server` starts a fresh server first.
