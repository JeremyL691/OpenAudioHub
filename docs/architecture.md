# Architecture

This page describes how the pieces of OpenAudioHub fit together. It is for people who run the server, build it, or want to know where their data goes.

- [The big picture](#the-big-picture)
- [One process](#one-process)
- [Data](#data)
- [Background work](#background-work)
- [Long recordings](#long-recordings)
- [Providers](#providers)
- [The web app](#the-web-app)
- [The Mac app](#the-mac-app)
- [Command-line tools](#command-line-tools)
- [Limits of one process](#limits-of-one-process)

## The big picture

```
 browser / Mac app window         scripts (API keys)        Plaud
          |                              |                    ^
          v                              v                    |
 +-------------------------------------------------------------+
 |  oah-server (Rust)                                          |
 |   HTTP API + web app   background workers   audio pipeline  |
 |          |                    |                  |          |
 +----------|--------------------|------------------|----------+
            v                    v                  v
        SQLite file        audio storage       ffmpeg + VAD model
     (one data folder)   (disk or S3 bucket)    (in the process)
                                 |
                                 v
                    AI providers (OpenAI-compatible,
                    Gemini, ElevenLabs, local models)
```

## One process

OpenAudioHub is one program, `oah-server`. It serves the HTTP API, the web app, and the background work in the same process. There is no separate database server, no queue service, and no second audio service.

The web app is a React single-page app. It is built into the server binary, so one file serves both the app and the API. Release builds embed the files, and development builds can read them from a folder.

## Data

- **Database.** One SQLite file in WAL mode, with full synchronous writes and foreign keys on. The schema is migrated when the server starts. Text fields for titles, transcripts, summaries, provider keys and the Plaud token are encrypted with `ENCRYPTION_KEY`. See [Encryption at rest](encryption-at-rest.md).
- **Audio.** Stored either in a folder on disk, or in an S3-compatible bucket. Each recording records where its audio is, so both can be used at once. See [S3-compatible storage](storage-s3.md).

## Background work

Work that takes time runs in the background, not in the request:

- **Plaud sync.** A loop syncs connected accounts at a set interval. A manual sync runs in the request, but other requests for the same account wait on the same run.
- **Transcription.** A queue of transcription jobs, one per recording.
- **Audio pipeline.** Splits long audio and transcribes the parts. See [Long recordings](#long-recordings).
- **Summaries and titles.** A queue of summary jobs. Titles are generated after a transcript is saved, and summaries run after that when turned on.
- **Webhook delivery.** Stores each event with its deliveries, and sends them with retries. See [Automation API and webhooks](automation-and-webhooks.md).
- **Exports.** On the Mac app, saves each new recording into the user's export folder.

Jobs are stored in the database. A worker takes a job with a lease and renews it while it works. If the process stops, the lease runs out and another worker takes the job. So a job can run twice after a crash, and each job is written to be safe to repeat.

Notifications (email and Bark) are sent after a sync adds new recordings. A failed notification is logged and is not retried. See [Notifications](notifications.md).

## Long recordings

The audio pipeline handles recordings that are too long or too large for one request to a provider.

1. ffmpeg decodes the file to 16 kHz mono audio.
2. A voice activity model (Silero VAD v5, run with ONNX Runtime and bundled with the server) finds where people speak. Its progress is checkpointed between blocks of audio.
3. The speech is cut into chunks. Cuts go at pauses, with a target of about 2 minutes and a hard limit of about 170 seconds per chunk. Long silences are left out.
4. Each chunk goes to the provider in turn. Finished chunks are kept for the job, so a retry does not send them again.
5. The results are joined, with times shifted to the start of the recording, into one transcript.

Recordings longer than 24 hours are refused. When the pipeline is turned off, the whole file is sent in one request, and a file over the size limit is re-encoded first. See [Environment variables](environment-variables.md#transcription-and-long-recordings).

## Providers

Transcription and summaries use providers that you configure. The server talks to them over HTTPS:

- OpenAI-compatible services, through the chat and transcription endpoints.
- Google Gemini, through its own API.
- ElevenLabs, through its speech-to-text API.
- Local models, such as LM Studio and Ollama, on the address you give.

Transcription in the browser does not use the server. The browser runs a Whisper model and sends only the text. See [AI providers](providers.md).

Plaud is reached directly over HTTPS at the regional Plaud servers. See [Connect your Plaud account](connect-plaud-account.md).

## The web app

The web app has three parts:

- The library and recording pages, for signed-in users.
- Settings.
- The docs site at `/docs`. Its pages are the Markdown files in the repository's `docs` folder, built into the app. Each page links back to its file on GitHub.

Sign-in uses a session cookie, `HttpOnly` and `SameSite=Lax`. See [Security model](security-model.md).

## The Mac app

The Mac app is a Tauri 2 program. It runs the same server code inside its own process, on `127.0.0.1` only, with one local account. It opens a window that shows the web app, and it adds a menu bar item and local settings. See [Mac app](desktop.md).

Differences from the self-hosted server:

- Audio is always stored on disk.
- Sign-up is off, and the local account signs in for you.
- The server listens only on the Mac.
- Auto export is available.

## Command-line tools

`oah-server` runs the server by default. One more command is available:

- `oah-server reset-password <email>` gives an account a new random password, prints it once, and signs out every session of the account. See [Reset a password](self-hosting.md#reset-a-password).

## Limits of one process

The design assumes one server process per database. Keep these in mind:

- Rate-limit counters are kept in memory. They reset when the server restarts, and each process has its own counters.
- Two server processes must not share one SQLite file.
- The database and the audio folder should be on a local disk, not on a network share.

If you need more than one server, run separate instances, each with its own data.
