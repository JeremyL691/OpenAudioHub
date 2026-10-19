# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A long recording sends the speaker settings the user chose, so speaker labels can be turned off and a speaker count can be passed to the provider.
- A cancel that arrives after the last chunk no longer stores a transcript. A cancelled job stays cancelled, and a run whose transcript was already saved is not marked cancelled.

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

### Known issues

- The long-audio pipeline ignores the `speakerDiarization` and `diarizationSpeakerCount` settings ([#28](https://github.com/JeremyL691/OpenAudioHub/issues/28)).
- A cancel that arrives after the last chunk still saves the transcript ([#29](https://github.com/JeremyL691/OpenAudioHub/issues/29)).
- A forced manual run leaves the superseded job's work folder behind ([#30](https://github.com/JeremyL691/OpenAudioHub/issues/30)).
- A manual retry does not reset the job's claim counter ([#31](https://github.com/JeremyL691/OpenAudioHub/issues/31)).

[Unreleased]: https://github.com/JeremyL691/OpenAudioHub/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.1
[1.1.0]: https://github.com/JeremyL691/OpenAudioHub/releases/tag/v1.1.0
