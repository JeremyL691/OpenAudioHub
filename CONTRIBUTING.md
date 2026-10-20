# Contributing to OpenAudioHub

Thank you for your interest in OpenAudioHub. This guide explains how to set up a development environment, which checks to run, and what a good pull request looks like.

By contributing, you agree that your contribution is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

## Before you start

- For a bug, search the existing issues first. For a new feature, open an issue to discuss it before writing much code.
- For a security problem, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need:

- Rust 1.85 or newer, with `clippy` and `rustfmt`.
- Node.js 22 and pnpm. The pnpm version is set in the `packageManager` field of `web/package.json`.
- `ffmpeg` and `ffprobe` on your `PATH`.
- Docker, if you change the container image or the installer.

The full guide, with the project layout, is in [docs/development.md](docs/development.md).

```sh
cd web && pnpm install && cd ..
cd contract-tests && pnpm install && cd ..
```

Use a test data folder for every local run. Never point a development build at a real library.

## Checks

Run these before you open a pull request. They match the CI workflow.

```sh
cargo fmt --all --check
cargo clippy -p oah --all-targets -- -D warnings
cargo test -p oah

pnpm --dir web typecheck
pnpm --dir web build

contract-tests/run.sh server
```

`contract-tests/run.sh server` builds the server and the web app, starts the server on a new data folder, runs the contract suite and stops the server. It needs `openssl` and `curl`.

The long-recording pipeline runs in its own suite, `contract-tests/run.sh pipeline`. It also needs `espeak-ng` and `ffmpeg`, which generate the speech recording it transcribes.

## Interface text and translations

The interface is translated into English, Simplified Chinese, Japanese and Korean. Every string a person can see in the app lives in `web/src/locales/{en,zh-CN,ja,ko}/`, one file per area.

When you add or change a button, menu item, dialog, empty state, hint, error message or accessible name, add the text in all four languages in the same pull request. Do not leave a key out of a language: `pnpm --dir web typecheck` runs the catalog check and fails on a missing key, an empty translation, or a placeholder that differs from English.

Rules for the catalogs:

- Keys name a place and a meaning, not the English words, and nested objects group one area (for example `settings.export.originalHint`).
- Write whole sentences. Never build a sentence by joining translated fragments.
- Values that change inside a sentence use named placeholders, such as `{count}` or `{title}`. The placeholders must be identical in all four languages.
- Do not translate product names (OpenAudioHub, Plaud), provider names, model names, file formats, API fields or user data.
- The interface language is separate from the transcription language and the AI output language; do not tie them together.

## Behavior changes

The specification in [`spec/`](spec/README.md) describes how the product behaves. If your change alters behavior, update the matching spec file and the contract tests in the same pull request. Mark anything you are unsure about with `UNVERIFIED:` and say why.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(library): add keyboard shortcut for starring
fix(plaud): retry sync after a short network error
docs(self-hosting): explain the reverse proxy timeouts
```

Common types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci` and `chore`. Use the scope for the area of the code that changed. Write the subject in the imperative mood, in lower case, without a final full stop.

## Pull requests

- Keep each pull request to one change. Split unrelated work into separate pull requests.
- Describe what changed and why, and how you tested it. Link the related issue.
- Include tests for new behavior and for bug fixes.
- Update the documentation in `docs/` and the entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Do not commit secrets, personal data, recordings, or generated files such as `web/dist` or `.dev-artifacts/`.
- All checks must pass. A maintainer reviews every pull request before it is merged.

## Code style

- Rust code is formatted with `cargo fmt`, and it must pass `clippy` with warnings as errors.
- Web code is TypeScript in strict mode. Keep components in `web/src/components` and pages in `web/src/pages`.
- Follow the existing style of the file you change. The [`.editorconfig`](.editorconfig) file sets the basics.

## Conduct

Everyone who takes part in this project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a problem in private, follow its [Enforcement](CODE_OF_CONDUCT.md#enforcement) section.
