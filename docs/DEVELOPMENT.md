# Development guide

This guide covers setting up a local development environment for OpenAudioHub.

## Prerequisites

- Node.js 22, and the pnpm version pinned in `.github/workflows/ci.yml`.
- [Bun](https://bun.sh). Some scripts, such as `db:migrate` and `e2e`, run with it.
- Postgres 16.
- Docker, for container builds and the container test stacks.
- For the audio pipeline: Python 3.12 and [uv](https://docs.astral.sh/uv/).

## Quick start

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate the two secrets and add them to `.env`:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
```

Set `DATABASE_URL` to your local database, for example `postgresql://postgres:postgres@localhost:5432/openaudiohub`, and set `APP_URL=http://localhost:3000`. Then create the database, apply the migrations, and start the server:

```bash
createdb openaudiohub
pnpm db:migrate
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Development server with hot reload |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm format-and-lint` | Check formatting and lint rules with Biome |
| `pnpm format-and-lint:fix` | Apply Biome fixes |
| `pnpm type-check` | TypeScript check |
| `pnpm test` | Unit and integration tests with Vitest |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm e2e` | Playwright end-to-end tests |
| `pnpm db:generate` | Generate a migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Drizzle Studio, a database browser |

## Tests

Integration tests need a Postgres test database. `scripts/dev/test-stack.sh` starts one in a container:

```bash
eval "$(scripts/dev/test-stack.sh env)"
pnpm test
```

End-to-end tests build the app and serve it on port 3210, with a fake AI server on port 3299:

```bash
pnpm e2e
```

Live Plaud API tests are opt-in. They need `PLAUD_BEARER_TOKEN`, and CI skips them. See [CONTRIBUTING.md](../CONTRIBUTING.md#integration-tests).

Audio pipeline tests run from the `audio-pipeline` directory:

```bash
cd audio-pipeline
uv run --frozen --group dev pytest
```

## Architecture

The app is a Next.js (App Router) application with Postgres, Drizzle ORM, and Better Auth. The interface uses Tailwind CSS and shadcn/ui. The audio pipeline is a separate FastAPI service. The [architecture reference](../content/docs/reference/architecture.mdx) describes how the parts fit together.

## Database changes

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate`. This writes the SQL and the snapshot.
3. Review the generated SQL in `src/db/migrations/`.
4. Run `pnpm db:migrate`, and commit the schema change together with the generated files.

Do not hand-write migration SQL, and do not edit the snapshots under `src/db/migrations/meta/`. The contributing guide and AGENTS.md explain why.

## Container development

To build the image from your local checkout and run the full stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The overlay builds the app image locally instead of pulling it. The `.env` file must include the secrets described in the [installation guide](../content/docs/self-hosting/install.mdx).

## Code style

Biome handles formatting and linting. Run `pnpm format-and-lint:fix` before you commit. Use these naming conventions:

- Components: `PascalCase.tsx`.
- Other source files: `kebab-case.ts`.
- API routes: `src/app/api/<name>/route.ts`.
- Database tables and columns: `snake_case`.

## Troubleshooting

- **The port is already in use.** Find the process with `lsof -i :3000` and stop it.
- **Type errors after dependency changes.** Remove the `.next` directory and start again. The build regenerates the route types.
- **`pnpm db:migrate` cannot connect.** Check that `DATABASE_URL` points at a running Postgres, and that the database exists.
- **Environment validation fails.** The error names the variable. The required values are listed in [environment variables](../content/docs/self-hosting/environment-variables.mdx#required-at-runtime).
