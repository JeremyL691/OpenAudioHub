# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-10-28

### Added

- The browser extension keeps the Plaud connection fresh. Plaud sign-ins last about 24 hours, so a connection made through the extension used to stop syncing every day or two. After you connect, the extension sends each newer Plaud sign-in from your browser to OpenAudioHub, at browser start and about every 30 minutes. When the sign-in is about to expire, it opens Plaud in a background tab for up to a minute so Plaud renews it. This needs the browser to be running and signed in to Plaud. Connect once more with the extension to turn it on.
- `POST /api/plaud/auth/refresh` takes a newer Plaud token from the browser extension, authorized by a key the extension registers when it connects. A token for a different Plaud account is refused, and disconnecting removes the keys.

### Fixed

- The extension popup offers Connect on the first click on a connect page. Before, the result of an earlier sign-in took the first click, and Connect only appeared on the second.
## [1.3.2] - 2026-10-22

### Changed

- A self-hosted server now opens straight to the dashboard with one local account, as the Mac app does. There is no landing page, sign-up or sign-in.
- An upgraded server keeps using its earliest account.
- Set `OAH_MULTI_USER=true` to keep separate accounts with sign-in.

### Fixed

- A request that reads and then writes no longer fails with "database is locked" when another request commits in between. Every transaction takes the write lock when it starts, so the request waits for a busy writer, up to the busy timeout, instead of failing at once.
- An Ask AI answer that finishes quickly no longer stays on "Reading the transcript". The answer stream ends only after the turn is saved, and a stream opened just after the answer ended reads the saved turn instead of waiting.

## [1.3.0] - 2026-10-21

### Added

- Ask AI: a recording with a transcript can be asked about. The conversation is kept encrypted for that recording, answers stream into a panel beside the recording, and each answer cites the transcript rows it used. Selecting a citation marks exactly those rows and plays from the first one; a transcript without timings marks the cited line. The panel chooses a saved provider, a model from a searchable list and a thinking level, so a question can use a different model from summaries without changing the summary default.
- Ask AI answers from the transcript shown in the recording, follows up on the recent questions in the same conversation, and offers suggested questions in an empty chat.
- A thinking level follows the order minimal, low, medium, high, xhigh and max. A level the model does not declare is never sent: the choice rounds up to the closest declared level, takes the highest one when it is above them all, and sends nothing at all when the model's levels are unknown.
- A long recording is answered from the parts a question needs, and a question about the whole recording reads every part before answering. The answer says which of the two it did, so a partial read never reads as a complete one.
- A question, its answer and its citations survive a restart and a replaced transcript. An answer is only saved while the run that started it still holds it, so stopping, clearing or re-transcribing a recording cannot be overwritten by an older run.
- `docs/providers.md` and `spec/recording-chat.md` describe the behaviour, including the provider requests and the bounds one question works within.

### Changed

- The workspace states Rust 1.94.1 as its minimum, and the toolchain pin, the CI images, the container build and the documentation all name that same patch release. The container image is built by a fixed compiler now instead of whatever the floating `rust:1` tag points at.
- `tools/check/rust-version.sh` compares every place the Rust version is declared and fails on a difference. CI runs it, so a drift fails a pull request instead of a contributor's build.
- The development and contribution guides install and check the extension as well, and their commands no longer assume the shell stayed in the directory of a previous step.
- The security policy states that fixes go into the newest release, instead of listing version lines that were already out of date.
- One check, `Quality gate`, now covers the whole pull request suite: the server, the minimum Rust version, the web app, the extension, the Mac app, the long-recording pipeline, the contract tests and the dependency scans. A skipped or cancelled check fails it, so a check that never ran cannot read as a pass.
- The dependency scan covers the development dependencies of the web app, the extension and the contract tests, not only their production packages. The extension keeps all of its tooling in `devDependencies`, so an audit of production packages alone never looked at it.
- `vitest` in the extension is at the release that fixes the reported advisories, with `tinypool` pinned above the affected versions.
- The library search asks the server once for the whole library instead of fetching every transcribed recording's detail and matching in memory. `GET /api/recordings/search?q=` returns the ids whose name or newest transcript text matches; the transcript text itself is never returned, and nothing is indexed in plain text. The search box waits for a short pause in typing, and a request that is still running or that failed shows its own state rather than reading as "nothing matches".

### Fixed

- Saving a transcript and the work that follows it now commit together. `transcription.completed`, the automatic title and the automatic summary used to be called after the transcript was committed, so a process that stopped in between left a transcript with no event and no automatic summary, and a failed summary enqueue was only logged. A queue job that names the transcript is written in the same transaction, and a follow-up for a transcript that was since deleted or replaced ends without touching the newer text. A retried save does not queue the same follow-up twice. The guarantee is at least once: a provider call that answered but was not committed is made again.
- A worker that lost a long-transcription job can no longer write that job's chunk state. Marking a chunk as sending, storing its result and recording its failure now apply only while the job runs under the generation the worker claimed, so a response that arrives after a takeover cannot overwrite what the new run stored or is about to read. Chunk results stored before a takeover stay reusable.
- The library specification said the recordings page is rendered on the server. The server answers the path with the app shell and the page renders in the browser, as the pages specification says.
- The Mac app build reports a failed source download as a download, with retries and a deadline, instead of calling the missing file a checksum mismatch. A cached archive that no longer matches its pinned checksum is downloaded again.
- The contract suites stop the server and the fake services they started, including when a run ends early. A port held by a process the run did not start is reported instead of killed.

## [1.2.5] - 2026-10-20

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
- A security workflow runs `cargo-deny` and the npm audits, on lock-file changes, on `main`, and weekly.

### Added

- The long-recording pipeline is covered end to end over HTTP. A separate contract run drives a generated speech recording through ffmpeg, speech detection, chunk planning, several provider calls and the merge, and checks cancel, provider failures, a timeout, and a retry that keeps the chunks that already succeeded. A restart after a crash is covered too: the saved speech detection is reused and finished chunks are not sent again.
- `docs/performance.md` records how long the pipeline takes on a reference machine, what it uses in memory and disk, and how to measure the same numbers with `tools/bench/pipeline.sh`.

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

[Unreleased]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.3.0...v1.3.2
[1.3.0]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.2.5...v1.3.0
[1.2.5]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.2.0...v1.2.5
[1.2.0]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.2.0
[1.1.2]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.2
[1.1.1]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.1
[1.1.0]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.0
