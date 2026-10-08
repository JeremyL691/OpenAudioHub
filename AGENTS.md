# OpenAudioHub Agent Guidelines

## First task

If the user did not give a concrete task, read this file, `README.md`, and `BRANCHING.md`. Then ask which area to work on: sync, transcription, AI, storage, UI, settings, onboarding, notifications, the audio pipeline, or docs.

## The one rule

Understand what you are changing. People depend on OpenAudioHub to reach their recordings, transcripts, and storage. If you cannot explain what your change does and how it interacts with the rest of the system, do not ship it.

Using AI to write code is fine. Submitting AI-generated code you do not understand is not.

## Style

- Keep answers short and direct.
- No emojis in commits, issues, pull request comments, or code.
- No filler or cheerful padding.
- Avoid overusing spaced em dashes (` — `), especially in user-facing copy. Prefer a period, a comma, a colon, parentheses, or a shorter sentence.

## Code quality

- Avoid `any` unless it is truly necessary.
- Check `node_modules` for external API type definitions instead of guessing.
- Never use inline imports (`await import("./foo")`, `import("pkg").Type`). Use top-level imports.
- Never remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.
- Ask before you remove functionality or code that looks intentional.
- Internal code APIs are not a contract, so refactor freely. The deploy surface described below is.

### Comments

JSDoc on exported APIs only. No narrative or strategy comments in source. Put design rationale in the commit message.

## Commands

- After code changes (not docs), run `pnpm format-and-lint:fix && pnpm type-check`. Fix every error and warning before you commit.
- When you run check, type-check, or test commands, capture the full output. Do not pipe it through `head` or `tail`. Hidden errors are the problem these commands exist to surface.
- Tests: `pnpm test`. Integration tests need a test database. `scripts/dev/test-stack.sh` starts one.
- End-to-end tests: `pnpm e2e` runs Playwright against a production build on port 3210, with a fake AI server on port 3299.
- Regression tests for a specific bug go in `src/tests/regressions/<issue-number>-<short-slug>.test.ts`.
- Dev-only diagnostics: `/api/dev/plaud/info` probes the stored Plaud connection and reports the device and recording counts. It is hidden in production.

## Tool usage (CRITICAL)

- Read files with the Read tool, not `sed` or `cat`. Use `offset` and `limit` for ranged reads.
- Read every file in full before you edit it.

## Git rules (CRITICAL)

Several agents may work in the same checkout. These rules stop one agent from destroying another's work.

- Commit only the files you changed in this session.
- Include `fixes #<number>` or `closes #<number>` in the commit message when a related issue exists.
- Never use `git add -A` or `git add .`. Stage paths explicitly with `git add -- <paths>`.
- Before you commit, run `git status` and confirm that you staged only your files.
- Matching `src/db/migrations/*.sql` and `src/db/migrations/meta/*` files belong with the `src/db/schema.ts` change that produced them.
- Delete files with `git rm -- <paths>`.

Forbidden operations: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`, and force pushes.

### Commit prefixes

`feat:`, `fix:`, `refactor:`, `chore:`, `perf:`, and `docs:`. Squash-merge scoped features into `main`.

### Rebase conflicts

Resolve conflicts only in files you changed. If a conflict is in a file you did not change, stop and ask.

### User override

If user instructions conflict with these rules, ask for explicit confirmation before you act.

## Issues and pull requests

- Read every comment on an issue or pull request, not only the body. `gh issue view <number> --json title,body,comments,labels,state` retrieves all of it.
- Write multi-line comments to a file and post them with `gh issue comment --body-file` or `gh pr comment --body-file`. Preview the text before you post it, and post one final comment.
- Plans and TODOs that must survive a session belong in GitHub issues, not in code comments.

## Changelog

`CHANGELOG.md` is curated by maintainers at release time. Contributors do not edit it in pull requests.

- New entries go under `## [Unreleased]`, in these subsections: `### Breaking Changes` (needs a migration note), `### Added`, `### Changed`, `### Fixed`, `### Removed`, and `### Security`.
- Append to existing subsections. Do not create duplicates.
- Never modify a released version section such as `## [1.0.0]`.
- Breaking changes, and schema or environment changes that ship to every self-host image, get an entry. Describe the footprint: the table, migration number, or variable name, and the behavior that changes.

Attribution format:

- Internal change: `Fixed sync stall on 429 ([#123](https://github.com/JeremyL691/OpenAudioHub/issues/123))`
- External contribution: `Added Groq provider ([#456](https://github.com/JeremyL691/OpenAudioHub/pull/456) by [@username](https://github.com/username))`

## Releasing

Agents do not cut releases. Maintainers do. The procedure is in [BRANCHING.md](BRANCHING.md).

## Deploy surface (CRITICAL)

The deploy surface is a contract with self-hosters. It covers the database schema, environment variables, `docker-compose.yml`, the image tags, and the installer.

- **Schema changes are additive by default.** Dropping a column or table needs a user-impact assessment and a migration plan. See the database migrations rules below.
- **Environment variable renames.** Either keep the old name working for one release, with a deprecation warning, or document the break in `docs/MIGRATION_FROM_RIFFADO.md` and `CHANGELOG.md`.
- **`docker-compose.yml` is a user contract.** Breaking structural changes need a changelog migration note.
- **The installer is part of the deploy surface.** `scripts/install.sh` ships as a release asset, and `src/lib/install-commands.ts` points users at it. Breaking changes need a changelog note.
- **Sync changes need a real-account test.** Test against a real Plaud account before you ship anything that touches `src/lib/sync/` or `src/lib/plaud/`.
- **Breaking changes are announced.** They ship with loud logging and a changelog entry. Never silently.

Ask: if this goes wrong, how many users notice, and how quickly can they recover?

## Product context

OpenAudioHub is AGPL-3.0 software for self-hosted transcription of Plaud recordings. It currently supports the Plaud Note family (Note, Note Pro, NotePin). There is no hosted mode. Every code path is the self-host path.

Invariants, in priority order:

1. **Self-host is first-class.** If it does not run with `docker compose up`, it does not ship.
2. **The local AI path keeps working.** Browser transcription with Transformers.js, and local servers such as Ollama and LM Studio, must not regress.
3. **No vendor lock-in.** Storage is pluggable (local or S3-compatible). AI providers are pluggable (any OpenAI-compatible endpoint). Never add a default cloud fallback that silently sends data elsewhere.
4. **Export parity.** The full-data ZIP is the proof that users can leave. Every recording, transcript, and summary must round-trip. Do not ship a feature that cannot be backed up.
5. **No compliance claims.** HIPAA, SOC 2, and privilege claims belong to the operator and their provider. Do not write copy that claims them.

Product principles, in priority order:

1. **Performance.** Optimistic updates on writes. No data waterfalls. Minimal blocking states during onboarding.
2. **Good defaults.** Less configuration is better. Sensible sync intervals, retention, and storage paths. Auto-detect the Plaud region through its `-302` redirect.
3. **Convenience.** Shareable URLs. Re-authentication is a modal, not a full onboarding reset.
4. **Security.** AES-256-GCM for stored secrets. A `userId` check on every user-scoped query. Path-traversal protection in local storage. Range-header validation for audio streaming.

## Code conventions

- Prefer server components. Use `"use client"` only where you need interactivity.
- Route handlers live under `src/app/api/`, one `route.ts` per endpoint.
- Database access uses Drizzle. Fluent Drizzle queries may live inline in route handlers and feature `lib/` files. Raw SQL (`db.execute(sql\`...\`)` or a full `SELECT`, `INSERT`, `UPDATE`, or `DELETE` in a `sql\`\`` template) must live in `src/db/queries/`. Inline `sql` fragments inside the fluent builder (in `set`, `where`, or `orderBy`) can stay where they are used.
- In any `sql\`\`` template, every value must be a `${...}` placeholder, never concatenated. Every `Date` must be converted with `.toISOString()` and cast. User-supplied `ILIKE` patterns must escape `%` and `_`. Sort columns and identifiers come from a fixed allowlist, never from user input.
- Environment variables are validated with Zod in `src/lib/env.ts`. Add new variables there and read them through the validated `env` object. Never read `process.env.X` directly in feature code.
- Toasts use `sonner`. Do not use `alert()` or a custom toast system.
- Client components that fetch data use the existing `/api/...` routes.

## CRITICAL: User-scoped queries

Every query that touches user-scoped data must include `where(eq(table.userId, session.user.id))`. Trusting a route parameter or a body field without this check is a security bug. An attacker could read or change other users' recordings, transcriptions, tokens, and AI keys.

This applies to every query, every time. It is not optional, and it does not depend on whether the route is internal.

## CRITICAL: Encryption at rest

These values are encrypted with AES-256-GCM before they reach the database, through the helpers in `src/lib/encryption/`:

- Plaud access tokens (`plaudConnections.bearerToken`)
- AI provider API keys (`apiCredentials.apiKey`)
- SMTP credentials
- S3 credentials
- Recording titles, transcripts, summaries, and prompt text

Decrypt only at the moment you build an outbound request or render a response. Never log decrypted values. Never return them in an API response unless the caller is the owner and the endpoint's contract calls for it.

## CRITICAL: Database migrations

Edit `src/db/schema.ts` first, then run `pnpm db:generate` to produce the migration. Do not hand-write migration SQL. Drizzle tracks migrations through snapshots in `src/db/migrations/meta/`. A hand-written migration has no snapshot, so later `db:generate` runs re-emit changes that already applied. That silently corrupts the history.

The same rule covers rebases, conflict resolution, and renumbering. Rerun `pnpm db:generate` against the rebased schema. Never edit `meta/_journal.json` or the snapshots by hand. Never delete or merge migrations that Drizzle has already produced, even unreleased ones. Stacked changes in one release ship as separate files.

If `drizzle-kit` generates SQL that re-adds columns that already exist, the snapshots have drifted from reality. Fix the drift. Do not patch around it by hand.

## Architecture notes

- **Sync is pull-based.** Plaud has no push interface. The sync worker in `src/lib/sync/sync-recordings.ts` is idempotent and paginated. A background worker in `src/lib/sync/worker.ts` runs it for every connected user.
- **Transcription runs in two places.** Either in the browser with Transformers.js, or on the server through any OpenAI-compatible provider. The choice is per recording.
- **The audio pipeline is optional.** It is a private FastAPI service with SQLite state, reachable only on the Compose network. Core keeps the provider credentials and makes every provider request.
- **Storage is pluggable** behind `StorageProvider` in `src/lib/storage/types.ts`, selected by the factory in `src/lib/storage/factory.ts`. Do not branch on the storage type anywhere else.
- **AI is pluggable** through OpenAI-compatible HTTP in `src/lib/ai/`. Users configure a base URL and an API key per provider. Do not hard-code provider-specific behavior.

## Plaud API gotchas

These are non-obvious facts about Plaud's server.

- **No refresh tokens.** The OTP login returns only an access token, a long-lived JWT of about 300 days. Do not add refresh-token handling. When the token expires, the user reconnects.
- **Two token types, UT and WT.** Plaud issues a long-lived user token (UT, about 300 days) and short-lived workspace tokens (WT, about 24 hours). OpenAudioHub stores the UT in `plaudConnections.bearerToken`, and `PlaudClient` mints a fresh WT from it for each request. A WT carries `ut_ref`, `wid`, and `wtype` claims, and a UT does not. Both kinds appear in the browser, so paste flows often grab the wrong one. `isPlaudWorkspaceToken()` in `src/lib/plaud/auth.ts` guards the connect and verify routes. Recommend the connector extension first. If the user pastes a token manually, point them at `pld_tokenstr` in localStorage, not at `/device/list` or `/file/simple/web`.
- **Regional servers.** `api.plaud.ai` is global. Accounts can live on `api-euc1.plaud.ai` or `api-apse1.plaud.ai`. A `/auth/otp-send-code` response with `status: -302` and `data.domains.api` means the account is on another region. `plaudSendCode` follows the redirect.
- **Rate limiting.** `PlaudClient` retries 429 and 5xx responses with backoff (`src/lib/plaud/client.ts`). Honor `Retry-After`.
- **Bearer tokens are encrypted at rest.** Decrypt them only when you construct the HTTP request.

## Extension points

### Adding a storage adapter

Storage is configured per instance through environment variables, not per user.

1. Implement `StorageProvider` in `src/lib/storage/types.ts`: `uploadFile`, `downloadFile`, `getSignedUrl`, `deleteFile`, and `testConnection`.
2. Add the adapter class in `src/lib/storage/<name>.ts`.
3. Add the new type to the `StorageType` union in `types.ts`.
4. Add a branch to `createStorageProvider()` in `src/lib/storage/factory.ts`.
5. Add environment variables to `src/lib/env.ts` and `.env.example`.
6. Validate required variables in the factory, and throw a clear error when one is missing. Follow the S3 branch.
7. Add a settings section only if the adapter has settings that users see. S3 does. Local storage does not.

### Adding an AI provider

Most providers need no code. OpenAI-compatible providers are configured in the UI with a base URL, an API key, and model names. Document the preset in `docs/` or the in-app guide.

If a provider has non-standard authentication, write an adapter that exposes it behind an OpenAI-compatible surface. Do not branch on the provider name in feature code.

### Adding a notification backend

Each backend is a file in `src/lib/notifications/`, such as `bark.ts` or `email.ts`, and callers invoke it directly.

1. Add `src/lib/notifications/<name>.ts` exporting `send<Name>Notification()`.
2. Wire it into the callers, following the existing pattern.
3. Add environment variables to `src/lib/env.ts` and `.env.example`.
4. Add a settings toggle if users configure the backend.
5. Set a timeout. `bark.ts` uses 3 seconds. A notification must never block the sync loop.

## Pointers

- [README.md](README.md): product overview and self-host installation.
- [CONTRIBUTING.md](CONTRIBUTING.md): contributor workflow.
- [BRANCHING.md](BRANCHING.md): branches and releases.
- [CHANGELOG.md](CHANGELOG.md): version history.
- [SECURITY.md](SECURITY.md): vulnerability reporting.
- [docs/MIGRATION_FROM_RIFFADO.md](docs/MIGRATION_FROM_RIFFADO.md): upgrading an earlier installation.
