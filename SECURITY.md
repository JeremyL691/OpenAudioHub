# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |

Releases from before 1.0.0 are not supported by this project.

## Reporting a vulnerability

Do not report security vulnerabilities in public issues, pull requests, or discussions.

Report them privately through [GitHub private vulnerability reporting](https://github.com/JeremyL691/OpenAudioHub/security/advisories/new). Include:

- The type of issue, for example injection, cross-site scripting, or an authorization bypass.
- The affected files, version, or commit.
- The configuration needed to reproduce the issue.
- Step-by-step instructions, and a proof of concept if you have one.
- The impact, including how an attacker could use it.

We aim to acknowledge reports within 7 days, and we will coordinate a fix and a disclosure date with you.

## Deployment guidance

### Environment

- Never commit `.env`.
- Generate `BETTER_AUTH_SECRET` (at least 32 characters) and `ENCRYPTION_KEY` (64 hex characters) from a cryptographically secure source.
- Keep a backup of `ENCRYPTION_KEY` separate from the database backup. Without it, encrypted content cannot be recovered.
- Rotate secrets on a schedule. Key rotation for `ENCRYPTION_KEY` is not implemented yet. See [docs/encryption-at-rest.md](docs/encryption-at-rest.md).

### Database

- Use a strong database password, and do not expose Postgres to other hosts.
- Encrypt database backups, and store them where only the operator can read them.

### Secrets and tokens

- Plaud access tokens, AI provider keys, SMTP credentials, and S3 credentials are encrypted at rest with AES-256-GCM.
- Personal API keys are stored only as HMAC-SHA256 hashes.
- Give AI provider keys the narrowest permissions the provider offers.

### Network

- Serve OpenAudioHub over HTTPS behind a reverse proxy.
- Set `RATE_LIMIT_TRUST_PROXY_HEADERS=true` only when the proxy overwrites `X-Forwarded-For`. Otherwise clients can forge their address.
- Set `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true` on any instance that other people can reach.

### Containers

- The official image runs as a non-root user.
- Rebuild or pull images regularly to pick up base-image fixes.

### Storage

- Local storage: restrict the audio directory to the service user.
- S3: use a key with access to one bucket only, and enable server-side encryption on the bucket.

### Accounts

- Set `DISABLE_REGISTRATION=true` once the accounts you need exist.
- Enforce strong passwords. Sessions use HTTP-only cookies and expire automatically.

## Known security considerations

### Plaud access token

- The Plaud token is long-lived, about 300 days, and grants access to your recordings.
- Mitigation: reconnect the account to replace the token, or disconnect it in Settings.

### Transcription providers

- Audio and transcripts are sent in plaintext to the AI provider you configure. Use a provider you trust, or a local provider such as Ollama or LM Studio.
- Browser transcription downloads model files the first time it runs.

### Uploads and downloads

- Recordings can be large. Size limits and path-traversal checks apply to local storage.

### Outbound requests

- The app calls Plaud, AI providers, webhook targets, and S3-compatible storage.
- Webhook targets may point at private addresses unless `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true` is set. On a reachable instance, set it, because otherwise the instance can be used to reach your private network.

## Security updates

Security fixes are announced through GitHub Security Advisories, in the release notes, and in [CHANGELOG.md](CHANGELOG.md).

## Credits

We credit researchers who report valid issues, with their permission.
