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
- [Continuous integration and dependency checks](#continuous-integration-and-dependency-checks)

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

- Rust 1.94.1 or newer. The workspace needs it for its dependencies, mostly the AWS SDK that the S3 storage option uses; `rust-version` in `Cargo.toml` states the floor and `rust-toolchain.toml` pins the same exact version, so a checkout with rustup uses the right compiler on its own.
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

The long-recording pipeline is off in that run. To exercise it end to end over HTTP, run the pipeline suite:

```sh
contract-tests/run.sh pipeline
```

It starts a second server on port 3212 with `AUDIO_PIPELINE_ENABLED=true`, a short provider timeout, and generates a speech recording with `espeak-ng` and `ffmpeg` instead of using a stored file. Both modes stop the server and the fake services they started; a port held by another process is reported, not killed. The tests cover a full run with more than one chunk, cancel, provider failures, a timeout, and a retry. A machine without `espeak-ng` skips them and says so.

To run against a server that is already running, start the fake AI provider, then pass the address of the server:

```sh
node contract-tests/fakes/fake-ai.mjs 3299
OAH_BASE_URL=http://localhost:3000 contract-tests/run.sh url
```

The tests use the AI fake for all provider calls. A test that needs another fake service starts it inside its own test file.

Tests create their own data. Do not depend on counts or on data from another test.

## Desktop app

Build the bundled ffmpeg and ffprobe first. The script downloads pinned source archives, checks their SHA-256 sums, and builds them with LGPL-only options. A download is retried with a connection and a transfer deadline, and a download failure is reported apart from a checksum mismatch:

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

## Continuous integration and dependency checks

Every pull request runs these checks:

| Check | What it does |
|---|---|
| `server` | Checks that one Rust version is declared everywhere, then `cargo fmt --all -- --check`, clippy and the tests for `oah`. |
| `Minimum Rust version` | Builds the workspace with the pinned Rust version and the committed lock file. |
| `web` | The translation catalogs, the type check and the build. |
| `extension` | Type check, tests, build and zip. |
| `desktop` | Builds the web app and the ffmpeg sidecars, then lints and tests the Mac app crate. |
| `contract` | The browser and HTTP suite against a real server. |
| `pipeline` | The long-recording suite with the pipeline on, plus the restart test. |

The Rust version lives in four places that have to agree: `rust-version` in `Cargo.toml`, the pinned channel in `rust-toolchain.toml`, the `rust:` image tags in the workflows and `deploy/Dockerfile`, and the version the documents tell you to install. `tools/check/rust-version.sh` compares them and fails on a difference, so run it after you change a version:

```sh
tools/check/rust-version.sh
```

A `Quality gate` job depends on all of them. It fails when any of them failed, was cancelled, or never ran, so one check name covers the whole suite in branch protection. Require that name, and a failure in the Mac app job or the long-recording suite blocks a merge the same way a failing server test does.

The dependency checks run inside that suite. `security.yml` runs `cargo-deny` against `deny.toml`, and `pnpm audit` for the web app, the extension and the contract tests, including their development dependencies. `ci.yml` calls it, so a pull request runs it with everything else. It also runs on `main` and every Monday, because a new advisory appears without a commit here.

`tools/check/` holds the checks that read declarations and scripts rather than the product; the
table in [its README](../tools/check/README.md) lists them.

There is no dependency update bot. Upgrades are made by hand, when someone decides to make them, which keeps a broken major version from blocking every smaller update behind it. The weekly scan is what reports the problem; fixing it is a normal change with the usual checks.

`deny.toml` carries the dependency policy, including the licences allowed in this tree and the advisories that cannot be cleared from here. Each ignored advisory has a comment saying why: which dependency pulls it in, and what removing it depends on. Remove an entry once its dependency is updated.

A release tag runs `verify` before anything is built: the tagged commit must be on `main`, the four version files must match the tag, `CHANGELOG.md` must have a section for it, and the whole suite runs again on that commit.

## Benchmarks

`tools/bench/pipeline.sh` measures a long recording end to end: build the server, upload a generated speech file, run the pipeline against a local provider, and print the wall time of each phase, the peak memory and the work-folder size. It needs `ffmpeg` and `espeak-ng`, keeps everything in `.dev-artifacts/bench/`, and uses ports 3290 and 3291.

The reference numbers and what they mean are in [Performance](performance.md).

## Interface language

The web app and the Mac app speak English, Simplified Chinese, Japanese and Korean. Strings live in `web/src/locales/{en,zh-CN,ja,ko}/`; components read them through `useI18n()` and `t()`, described in `web/src/lib/i18n.ts`.

- A new string is added to all four language files at once, and the same English wording is written in `en`.
- The catalog check runs with `pnpm --dir web typecheck` and `pnpm --dir web build`. It fails on a key missing from a language, an empty translation, a placeholder that differs from English, or a JSON file that does not parse. Run it alone with `pnpm --dir web check:i18n`.
- The Mac app reads its own catalogs in `desktop-tauri/locales/`. A Rust test fails when a key is missing from a language or a placeholder differs.
- Do not wrap user data in `t()`: recording names, transcripts, summaries and prompt text keep their own language.
- To add a language, add its folder under both `locales/` directories, add it to `LOCALES` in `web/src/lib/i18n.ts` and to the language list in `desktop-tauri/src/i18n.rs`, then translate every key.

## Changing behavior

The specification in `spec/` describes how the product behaves. When you change behavior, change the spec and the matching contract tests in the same change. Mark anything you are not sure about with `UNVERIFIED:` and say why, as the spec README asks.
