<p align="center">
  <img src="desktop-tauri/icons/icon.png" width="120" alt="OpenAudioHub logo">
</p>

<h1 align="center">OpenAudioHub</h1>

<p align="center">
  Sync your Plaud recordings, transcribe and summarize them on infrastructure you control.
</p>

<p align="center">
  <a href="https://github.com/JeremyL691/OpenAudioHub/actions/workflows/ci.yml"><img src="https://github.com/JeremyL691/OpenAudioHub/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/JeremyL691/OpenAudioHub/releases/latest"><img src="https://img.shields.io/github/v/release/JeremyL691/OpenAudioHub" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
</p>

OpenAudioHub is a self-hosted server and Mac app that keeps your Plaud recordings in one searchable library, with transcripts, summaries and titles from the AI providers you choose.

## Screenshots

<table>
  <tr>
    <td><img src="docs/images/dashboard.png" alt="Dashboard"></td>
    <td><img src="docs/images/library.png" alt="Library"></td>
  </tr>
  <tr>
    <td><img src="docs/images/recording.png" alt="Recording page"></td>
    <td><img src="docs/images/settings.png" alt="Settings"></td>
  </tr>
</table>

## Features

- **Plaud sync.** Connect your Plaud account in the browser, with an email code or a pasted token. Sync runs by hand or in the background.
- **Transcription.** Use OpenAI, Google Gemini, ElevenLabs, Groq, OpenRouter, Ollama, LM Studio or any OpenAI-compatible service. You can also transcribe in the browser with a Whisper model, without sending audio to a provider.
- **Long recordings.** Speech detection splits long files into parts, transcribes them and joins the results.
- **Summaries and titles.** Summaries with key points and action items, and automatic titles, in the style you choose.
- **Library.** Search, collections, stars, merging, playback with a waveform, and keyboard shortcuts.
- **Export and backup.** Export recordings with their transcripts and summaries, create full backups, and schedule them.
- **Automation.** Personal API keys, a read-only public API, and signed webhooks with a delivery log.
- **Storage and privacy.** Keep audio on local disk or in an S3-compatible bucket. Titles, transcripts, summaries and tokens are encrypted at rest.
- **Notifications.** Email and Bark push when new recordings arrive.

## Download the Mac app

OpenAudioHub runs natively on Apple Silicon Macs (macOS 11 or later).

1. Download `OpenAudioHub_<version>_aarch64.dmg` from the [latest release](https://github.com/JeremyL691/OpenAudioHub/releases/latest).
2. Open the disk image and drag **OpenAudioHub** into your Applications folder.
3. Open the app. The app is ad-hoc signed and not notarized, so macOS blocks the first launch. Open **System Settings**, go to **Privacy & Security**, and choose **Open Anyway** next to the message about OpenAudioHub. Confirm, and the app opens.

Your library stays on your Mac, in `~/Library/Application Support/OpenAudioHub`. See the [Mac app guide](docs/desktop.md).

## Self-hosting quick start

You need Docker with Compose v2, and a domain name with an HTTPS reverse proxy for anyone who connects from outside your machine.

Install with one command. It downloads the compose file, creates the encryption key, starts the container and waits for the health check:

```sh
curl -fsSL https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh | sh
```

To pin a release, set `OAH_VERSION` before the command, for example `OAH_VERSION=1.0.0`. The installer never overwrites an existing `.env`.

Or set it up by hand:

```sh
mkdir openaudiohub && cd openaudiohub
curl -fsSLO https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/compose.yml
printf 'ENCRYPTION_KEY=%s\nAPP_URL=http://localhost:3000\n' "$(openssl rand -hex 32)" > .env
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
```

Then open `http://localhost:3000/register` and create your account. Keep the `ENCRYPTION_KEY` in `.env` safe: without it, the encrypted data cannot be read. The container listens on `127.0.0.1` only. See the [self-hosting guide](docs/self-hosting.md) for the reverse proxy, backups and upgrades.

## Documentation

- [Documentation index](docs/README.md)
- Using OpenAudioHub: [library](docs/using-the-library.md), [connecting Plaud](docs/connect-plaud-account.md), [AI providers](docs/providers.md), [notifications](docs/notifications.md), [automation and webhooks](docs/automation-and-webhooks.md), [backup and restore](docs/backup-and-restore.md)
- Self-hosting: [install and operate](docs/self-hosting.md), [environment variables](docs/environment-variables.md), [S3-compatible storage](docs/storage-s3.md), [email (SMTP)](docs/email-smtp.md), [Mac app](docs/desktop.md)
- Reference: [public API](docs/public-api.md), [architecture](docs/architecture.md), [security model](docs/security-model.md), [encryption at rest](docs/encryption-at-rest.md)
- Behavior specification: [spec/](spec/README.md)

## Development

Prerequisites:

- Rust 1.85 or newer (edition 2024)
- Node.js 22 and pnpm, as set in the `packageManager` field of `web/package.json`
- `ffmpeg` and `ffprobe` on your `PATH`
- For the Mac app: macOS with the Xcode command line tools

Common commands:

```sh
cargo test -p oah                       # server tests
cargo clippy -p oah --all-targets -- -D warnings

cd web && pnpm install && pnpm build    # type checks, then builds the web app
cd contract-tests && pnpm install && cd ..
contract-tests/run.sh server            # builds the server and runs the contract suite
```

The full guide, including running the server locally and building the Mac app, is in [docs/development.md](docs/development.md).

## Project layout

| Path | Contents |
|---|---|
| [`crates/oah/`](crates/oah) | Server library and the `oah-server` binary (Rust, axum, SQLite) |
| [`web/`](web) | Web app (React, TypeScript, Vite, Tailwind) |
| [`desktop-tauri/`](desktop-tauri) | Mac app shell (Tauri 2) and the ffmpeg build script |
| [`contract-tests/`](contract-tests) | Playwright suite that checks the HTTP behavior against a running server |
| [`spec/`](spec) | Behavior specification that the server, web app and tests follow |
| [`docs/`](docs) | User, self-hosting and developer documentation |
| [`deploy/`](deploy) | Container image, compose file and installer |
| [`.github/`](.github) | CI, release workflow, issue and pull request templates |

## Contributing and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. It lists the checks to run and the commit message format.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).
- Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

OpenAudioHub is free software licensed under the [GNU Affero General Public License v3.0 only](LICENSE). See [NOTICE](NOTICE) for copyright notices and the licenses of bundled third-party components.

Plaud is a trademark of its owner. OpenAudioHub is an independent project and is not affiliated with or endorsed by Plaud Inc.
