# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Sign-in, sign-up and password-reset limits are counted per connection address again. Without `RATE_LIMIT_TRUST_PROXY_HEADERS` the server used to have no client address at all and skipped the per-address checks, so an unauthenticated client could try passwords without limit. Forwarding headers are still ignored unless the setting is on, so a client cannot pick its own bucket.
- A server refuses webhook targets that use plain `http` or resolve to a private address, which stops an ordinary user from making the server reach machines on its own network. The Mac app keeps allowing local targets because it is single-user. The policy also refuses the private IPv4 address inside a NAT64 or 6to4 address, and the delivery no longer goes through an `HTTPS_PROXY` from the environment.
- A worker that lost a long-transcription job can no longer write its progress, phase, error or transcript over the run that replaced it. The retry counter is reset by an explicit retry, so it repeats; each claim now carries a generation that does not.

### Changed

- `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` now defaults to `true` on a server and `false` in the Mac app, and an unset or empty value follows the default of the mode. A self-hosted server that delivers to a machine on its own network, such as a home automation tool at a `192.168` address, must set `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=false`; the server logs a warning at startup naming how many stored targets the rule refuses. An invalid value now stops startup instead of failing webhook requests.
- The Compose file sets `RATE_LIMIT_TRUST_PROXY_HEADERS` to `true` by default, because it publishes the port on loopback only and expects a reverse proxy in front of it. Turn it off when the server is reached directly.
- The public API rate limit is counted per connection address instead of one shared bucket when the proxy setting is off.
- A release tag is checked before anything is built: the tagged commit must be on `main`, the four version files must match the tag, `CHANGELOG.md` must have a section for it, and the whole suite runs again on that commit. A tag pushed at an unreviewed commit no longer publishes downloads.
- The pull request checks now format-check the Rust code, lint and test the Mac app crate, and run the long-recording suite. They used to cover the server, the web app and the extension only.
- A security workflow runs `cargo-deny` and the npm audits, on lock-file changes, on `main`, and weekly. Dependabot opens grouped dependency updates.

## [1.2.0] - 2026-10-19

### Added

- The interface speaks English, Simplified Chinese, Japanese and Korean. The language is chosen from the account menu and from the signed-out and public pages, is remembered, and follows the browser language until a choice is made. The Mac app's menu-bar item and its own dialogs follow the same choice.
- Every new interface string must be added in all four languages. The web build checks the catalogs, so a missing translation fails the build.

### Changed

- Auto export in the original format saves an Opus file as `.ogg`, the name of its container, without re-encoding it. A previous automatic export of the same recording is renamed from `.opus` to `.ogg` when it still matches the stored audio and still carries an automatic name.

## [1.1.2] - 2026-10-19

### Fixed

- A long recording sends the speaker settings the user chose, so speaker labels can be turned off and a speaker count can be passed to the provider. A diarizing model also stops labelling speakers when they are turned off.
- A cancel that arrives after the last chunk no longer stores a transcript. A cancelled job stays cancelled, and a run whose transcript was already saved keeps its result instead of being marked cancelled.
- A forced transcription run deletes the work folder of the job it replaces, and always starts the new run.
- A manual retry of a failed long recording gets its three attempts again instead of failing at once on the next transient error.
- The status of a long recording follows the same table in the documentation, so a run that has not recorded its outcome yet reads as running.

## [1.1.1] - 2026-10-18

### Fixed

- Audio downloads in the Mac app open the macOS save dialog and save the file. Selecting several recordings saves one zip file. Downloads no longer replace the window or leave the app unresponsive.
- Auto export renames a date-named file to the AI title only when the title came from the AI. Original, date and hand-edited titles keep the date name.
- Recording names in date mode use the plain date, and a later Plaud rename no longer replaces a date, generated or hand-edited title.
- Auto export writes the format chosen in settings. OGG output is an Ogg container with Opus audio, and the original format keeps the real file extension.
- Auto export only saves recordings that arrive while it is on, once each, and changing the format re-saves earlier exports in the new format.
- A Plaud metadata change updates the recording without downloading its audio again.
- An automatic summary appears in the recording as soon as it finishes, and a failed or empty run no longer leaves the recording marked as summarized.

### Added

- Recording names can fix date titles written by earlier versions, after a preview of each change.
- The summary status reports whether a run is queued, running, done or failed.

### Removed

- Full backup archives and scheduled backups, including the `/api/backup` routes and the backup settings. Existing archives and records are left in place.

## [1.1.0] - 2026-10-18

### Added

- Browser extension for Plaud sign-in, built and released with the app. Install it from a release zip and use it for Google, Apple and email sign-in.

### Changed

- The Plaud connect page downloads the browser extension zip from the latest release. The Plaud account settings link to the extension guide.
- Release pages list every download with a short description, and include a `SHA256SUMS.txt` file with the checksums of the Mac app, the browser extension, the installer and the compose file.

## [1.0.0] - 2026-10-18

Initial release.

### Added

- **Plaud sync.** Connect a Plaud account with a browser sign-in, an email code, or a pasted token. Recordings sync by hand or in the background, with a rate limit on manual syncs.
- **Library.** Upload audio files, a dashboard, recording list with search, collections, stars, and merging of recordings. Recording pages include audio playback with a waveform, keyboard shortcuts, and editable titles.
- **Transcription.** Presets for OpenAI, Google Gemini, ElevenLabs, Groq, Together AI, OpenRouter, SiliconFlow, OpenCode Go, LM Studio, Ollama, and any OpenAI-compatible service. Separate choices for transcription and summaries, with encrypted API keys.
- **In-browser transcription.** Transcribe a recording on your own device with a Whisper model, with no provider and no audio sent to a third party.
- **Long recordings.** An audio pipeline detects speech, splits long files into parts, transcribes them, and joins the transcripts. Files that exceed provider limits are compressed first.
- **Summaries and titles.** AI summaries with action items and key points, AI titles, and selectable summary styles and prompt presets.
- **Exports and backups.** Export recordings with transcripts, summaries, and audio. Create full backup archives, schedule backups, and auto export new recordings as MP3 or the original file (Mac app).
- **Notifications.** Email (SMTP) and Bark push notifications when new recordings sync.
- **Automation.** Personal API keys, a read-only public API under `/api/v1`, and signed webhook deliveries with a delivery log and redelivery.
- **Storage.** Audio on local disk or in any S3-compatible bucket.
- **Accounts and security.** Email and password accounts with password reset, sessions, sign-in rate limits, and field encryption at rest for titles, transcripts, summaries and tokens.
- **Self-hosting.** A single container image for linux/amd64 and linux/arm64, a Docker Compose file, a one-line installer, a health endpoint, and a single SQLite data volume.
- **Mac app.** A desktop app for Apple Silicon Macs that runs the server locally, with a menu bar item, launch at login, and a local data folder.

[Unreleased]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.2.0
[1.1.2]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.2
[1.1.1]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.1
[1.1.0]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.0
