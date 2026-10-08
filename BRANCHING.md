# Branching and release model

OpenAudioHub has one long-lived branch, `main`, and tagged releases. Self-hosters run releases, not branches.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` | The only long-lived branch. Pull requests merge here. It may be broken at any commit, so do not deploy from it. |
| `feature/*`, `fix/*`, `docs/*` | Short-lived branches that open pull requests into `main`. |

Do not run `git clone` and `docker compose up --build` against `main` for production. Deploy a tagged release.

## Releases

A release is a git tag named `vX.Y.Z` on a commit in `main`. The commit's `package.json` version must match the tag, and CHANGELOG.md must contain a `## [X.Y.Z]` section. The release workflow refuses to publish otherwise.

Pushing a version tag starts two workflows:

- `docker.yml` builds multi-architecture images and publishes them to `ghcr.io/jeremyl691/openaudiohub`, tagged `X.Y.Z`, `X.Y`, and `latest`.
- `release.yml` creates a draft GitHub Release. Its notes come from the `## [X.Y.Z]` section of CHANGELOG.md. It attaches `docker-compose.yml`, `env.example`, and `install.sh`, so the one-line installer works.

Every push to `main` also publishes the `dev` image tag. `latest` follows tags only.

## Cutting a release

1. On `main`, set the version in `package.json`, and move the entries under `## [Unreleased]` into a new `## [X.Y.Z]` section in CHANGELOG.md. Merge that change through a pull request once CI passes.
2. Create and push the tag: `git tag vX.Y.Z` and then `git push origin vX.Y.Z`.
3. Wait for `docker.yml` and `release.yml` to finish.
4. Review the draft release, edit the notes if needed, and publish it.

`scripts/release.ts` automates the version bump, the changelog heading, and the tag. Read its header before you run it.

## Hotfixes

If a release has an urgent bug and `main` has moved on with unrelated changes:

1. Fix the bug on `main` first.
2. Branch from the release tag, for example `git checkout -b release-1.0 v1.0.0`.
3. Cherry-pick the fix and push the branch.
4. Tag `v1.0.1` on that branch.

If `main` is still releasable, cut a normal release from `main` instead.
