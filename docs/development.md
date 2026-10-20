# Development

This guide covers how to build and test OpenAudioHub from the source tree.

- [Project layout](#project-layout)
- [Prerequisites](#prerequisites)
- [Rust workspace](#rust-workspace)
- [Web app](#web-app)
- [Run the server locally](#run-the-server-locally)
- [Contract tests](#contract-tests)
- [Desktop app](#desktop-app)
- [Container image](#container-image)

## Project layout

| Path | What it holds |
|---|---|
| `crates/oah/` | The server library and the `oah-server` binary. |
| `crates/oah/src/routes/` | HTTP routes for recordings, settings, providers and sign-in. |
| `crates/oah/src/transcribe/` | Transcription runs and provider calls. |
| `crates/oah/src/pipeline/` | Audio pipeline for long recordings: decoding, speech detection, splitting, and joining the parts. |
| `crates/oah/src/summary/` | Summaries and titles, and their prompts. |
| `crates/oah/src/plaud/` | Plaud sign-in, sync and background sync. |
| `crates/oah/src/export/` | Transcript export and the automatic export of new recordings. |
| `crates/oah/src/config.rs` | Every environment variable the server reads. |
| `crates/oah/src/ai.rs` | Provider presets, choosing a provider, and chat calls. |
| `crates/oah/src/crypto.rs` | Field encryption and password hashing. |
| `crates/oah/src/jobs.rs` | The background job queue. |
| `crates/oah/migrations/` | SQLite migrations. The server runs them when it starts. |
| `crates/oah/models/` | The voice activity detection model that the pipeline uses. |
| `desktop-tauri/` | The Mac app. `src/main.rs` starts it, `files.rs` handles the data folder and secrets, `bridge.rs` handles the window bridge and Plaud sign-in, `menu.rs` builds the menu bar item, and `backup.rs` makes the copy before an upgrade. |
| `desktop-tauri/binaries/` | ffmpeg and ffprobe for the Mac app. |
| `web/` | The web app: React, TypeScript, Tailwind and Vite. The pages are in `src/pages/`. |
| `web/src/lib/i18n.ts` | The interface language: the four languages, detection, storage and `t()`. |
| `web/src/locales/` | One folder per language, one JSON file per area. Every string a person sees lives here. |
| `desktop-tauri/locales/` | The same four languages for the Mac app's menu-bar item and its own dialogs. |
| `contract-tests/` | Playwright tests that call a running server over HTTP. |
| `spec/` | The behavior specification. `spec/README.md` lists the files. |
| `deploy/` | `Dockerfile` and `compose.yml`. |

## Prerequisites

- A Rust toolchain that supports edition 2024, which means Rust 1.85 or newer.
- Node.js 22 and pnpm. The version of pnpm is named in the `packageManager` field of `web/package.json`.
- `ffmpeg` and `ffprobe` on your `PATH`, or set `FFMPEG_PATH` and `FFPROBE_PATH`. The pipeline and the media tests need them.
- For the Mac app: macOS with the Xcode command line tools, which provide the C compiler and `make` that the ffmpeg build script uses.
- `openssl`, to make test keys.

## Rust workspace

The workspace has two members: `crates/oah` and `desktop-tauri`.

```sh
cargo build -p oah --bin oah-server     # the server
cargo test -p oah                       # the server tests
cargo test                              # every test in the workspace
```

The server embeds the web app from `web/dist` in release builds. Build the web app before you build the server for a release. See [Web app](#web-app).

## Web app

```sh
cd web
pnpm install
pnpm build        # type checks with tsc, then builds to web/dist
pnpm typecheck    # type checks only
pnpm dev          # a development server with hot reload
```

The development server sends `/api` requests to `http://localhost:3000`. Start the server on port 3000 when you use `pnpm dev`.

## Run the server locally

From the repository root:

```sh
cd web && pnpm install && pnpm build && cd ..

mkdir -p dev-data
openssl rand -hex 32 > dev-data/key.txt
ENCRYPTION_KEY=$(cat dev-data/key.txt) \
OAH_DATA_DIR=./dev-data \
PORT=3000 \
cargo run -p oah --bin oah-server
```

Open `http://localhost:3000`. Keep the key in `dev-data/key.txt`. Every run must use the same key, or the encrypted fields in the database cannot be read.

Admin commands use the same environment:

```sh
cargo run -p oah --bin oah-server -- reset-password you@example.test
```

Use a test folder for `OAH_DATA_DIR`. Do not point it at a real library.

## Contract tests

The contract tests check the HTTP behavior described in `spec/`. They never read the database or the files. Each file in `contract-tests/tests/` matches a spec file, for example `recordings.spec.ts` checks `spec/recordings.md`.

Install the test dependencies once:

```sh
cd contract-tests && pnpm install && cd ..
```

Run the suite against a fresh server:

```sh
contract-tests/run.sh server
```

This builds the server and the web app into `.dev-artifacts/`, starts the server on a new data folder, runs the suite, and stops the server. The server uses port 3211. Set `OAH_SERVER_PORT` to use another port. Extra arguments go to Playwright, for example:

```sh
contract-tests/run.sh server tests/recordings.spec.ts
```

To run against a server that is already running, start the fake AI provider, then pass the address of the server:

```sh
node contract-tests/fakes/fake-ai.mjs 3299
OAH_BASE_URL=http://localhost:3000 contract-tests/run.sh url
```

The tests use the AI fake for all provider calls. A test that needs another fake service starts it inside its own test file.

Tests create their own data. Do not depend on counts or on data from another test.

## Desktop app

Build the bundled ffmpeg and ffprobe first. The script downloads pinned source archives, checks their SHA-256 sums, and builds them with LGPL-only options:

```sh
cd desktop-tauri
scripts/build-ffmpeg.sh
```

The binaries go in `desktop-tauri/binaries/`, named with the target triple. The build is cached in `.cache/`.

Build the web app, then the Mac app bundle:

```sh
cd web && pnpm build && cd ../desktop-tauri
npx @tauri-apps/cli@2 build
```

The bundle is written under `target/release/bundle/` in the repository root.

To run the Mac app from a development build without touching your real data, point it at a test folder:

```sh
cd desktop-tauri
OAH_DESKTOP_DATA_DIR="$HOME/oah-test-data" cargo run
```

`OAH_DESKTOP_DATA_DIR` replaces the default data folder. Use it for every development run.

## Container image

From the repository root:

```sh
docker build -f deploy/Dockerfile -t openaudiohub .
```

The image builds in three stages: the web app with Node 22, the server with Rust, and a Debian slim image that holds the server and ffmpeg. The image needs no secrets to build. `ENCRYPTION_KEY` is set at run time.

To try the image, run it with the same settings as `compose.yml`, or tag it with the name in `compose.yml` and use the compose file. See [Self-hosting](self-hosting.md).

## Interface language

The web app and the Mac app speak English, Simplified Chinese, Japanese and Korean. Strings live in `web/src/locales/{en,zh-CN,ja,ko}/`; components read them through `useI18n()` and `t()`, described in `web/src/lib/i18n.ts`.

- A new string is added to all four language files at once, and the same English wording is written in `en`.
- The catalog check runs with `pnpm --dir web typecheck` and `pnpm --dir web build`. It fails on a key missing from a language, an empty translation, a placeholder that differs from English, or a JSON file that does not parse. Run it alone with `pnpm --dir web check:i18n`.
- The Mac app reads its own catalogs in `desktop-tauri/locales/`. A Rust test fails when a key is missing from a language or a placeholder differs.
- Do not wrap user data in `t()`: recording names, transcripts, summaries and prompt text keep their own language.
- To add a language, add its folder under both `locales/` directories, add it to `LOCALES` in `web/src/lib/i18n.ts` and to the language list in `desktop-tauri/src/i18n.rs`, then translate every key.

## Changing behavior

The specification in `spec/` describes how the product behaves. When you change behavior, change the spec and the matching contract tests in the same change. Mark anything you are not sure about with `UNVERIFIED:` and say why, as the spec README asks.
