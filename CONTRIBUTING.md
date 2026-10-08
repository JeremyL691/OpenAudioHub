# Contributing to OpenAudioHub

Thanks for your interest. This guide is short on purpose. Read all of it before you open a pull request.

## The one rule

**You must understand your code.** If you can't explain what your change does and how it interacts with the rest of the system, the pull request will be closed.

Using AI to write code is fine. Submitting AI-generated code you don't understand is not.

## Before you submit

- **Search first.** Check [open issues](https://github.com/JeremyL691/OpenAudioHub/issues) and pull requests so you don't duplicate work in progress.
- **Open an issue for anything non-trivial.** Agree on the approach before you write a large change.
- **Read [AGENTS.md](AGENTS.md).** It describes the code conventions and the deploy-surface contracts this project keeps.
- **Read [BRANCHING.md](BRANCHING.md).** Pull requests target `main`.

## Development setup

Use the Node.js, pnpm, Python, and uv versions pinned in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The scripts also need [Bun](https://bun.sh).

```bash
git clone https://github.com/JeremyL691/OpenAudioHub.git
cd OpenAudioHub
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate the secrets and paste them into `.env`:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Point `DATABASE_URL` at a local Postgres database, apply the migrations, and start the server:

```bash
createdb openaudiohub
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers the rest of the setup.

To run the full containerized stack from your local code:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## Checks

Run these before you push. All of them must pass.

```bash
pnpm format-and-lint:fix
pnpm type-check
pnpm test
pnpm build
```

For changes to the audio pipeline, also run:

```bash
cd audio-pipeline
uv run --frozen --group dev ruff check src tests
uv run --frozen --group dev ruff format --check src tests
uv run --frozen --group dev pytest
```

## Submitting a pull request

1. Branch from `main`. Use `feature/...`, `fix/...`, or `docs/...`.
2. Write clean, tested code that follows the existing patterns.
3. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `chore:`, `perf:`, or `docs:`.
4. Open the pull request against `main`. Link the related issue, and explain **why** the change is needed, not only what it does.
5. Describe any user-visible change, and note whether it is a breaking change. Maintainers use that description when they write the changelog entry.

Do not edit `CHANGELOG.md` in a pull request. Maintainers write entries at release time. See [BRANCHING.md](BRANCHING.md).

## Database migrations

Edit `src/db/schema.ts` first, then run `pnpm db:generate`. Do not hand-write migration SQL, and do not edit files under `src/db/migrations/meta/`. Drizzle tracks the history in those snapshots, and hand-written changes corrupt it. See [AGENTS.md](AGENTS.md) for the details.

## Integration tests

Tests against the live Plaud API are opt-in, and CI skips them so that no credentials leak:

```bash
export PLAUD_BEARER_TOKEN="<your token>"
bun test src/tests/plaud.integration.test.ts
```

Never paste a token into an issue, a pull request, or a log.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for private reporting.

## License

OpenAudioHub is licensed under [AGPL-3.0](LICENSE). By contributing, you agree that your contributions are licensed under the same terms. If you run a modified version as a network service, you must offer its source to the people who use it.

## Code of Conduct

Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
