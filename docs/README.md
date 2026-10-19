# OpenAudioHub Docs

Long recordings, intelligently transcribed.

OpenAudioHub keeps your Plaud recordings in one place. It syncs them from your Plaud account, keeps the audio on storage you control, and writes transcripts and summaries with the AI providers you choose. You can search, play, star, merge and export your library. When you decide to leave, you can export everything.

You can run it in two ways:

- **The Mac app** runs the server on an Apple Silicon Mac, and shows the library in its own window.
- **A self-hosted server** runs as one container on your own machine or server. You open it in a browser.

Both ways run the same server code. The project is at [github.com/JeremyL691/OpenAudioHub](https://github.com/JeremyL691/OpenAudioHub).

## Guides

These guides cover the day-to-day features.

- [Using the library](using-the-library.md): the dashboard, the library and its collections, starring, search, merging, and the recording page.
- [Connect your Plaud account](connect-plaud-account.md): the three sign-in methods, regions, sync, and what happens when a sign-in expires.
- [Browser extension](browser-extension.md): install the extension, sign in to Plaud, and review its permissions and privacy.
- [AI providers](providers.md): add providers, choose the one used for transcription and for summaries, and use local models.
- [Notifications](notifications.md): email and Bark push when new recordings sync.
- [Automation API and webhooks](automation-and-webhooks.md): personal API keys, and signed webhook deliveries.
- [Backup and restore](backup-and-restore.md): transcript exports, audio downloads, auto export, and how to protect the server.

## Self-hosting

You run the server yourself, with Docker Compose, or with the Mac app. These pages cover installation, configuration, and upkeep.

- [Install](self-hosting.md): the container, the compose file, the reverse proxy, accounts, backups, upgrades, and password resets.
- [Mac app](desktop.md): the same server on an Apple Silicon Mac, without Docker. Data folder, keys, preferences, and backups.
- [Environment variables](environment-variables.md): every setting the server reads at startup.
- [S3-compatible storage](storage-s3.md): store audio in AWS S3, Cloudflare R2, MinIO, Backblaze B2 and other services.
- [Email (SMTP) setup](email-smtp.md): outgoing mail for notifications and password reset.

## Reference

- [Public API](public-api.md): the read-only `/api/v1` surface for scripts and tools.
- [Architecture](architecture.md): how the pieces fit together, including the long-audio pipeline.
- [Security model](security-model.md): authentication, sessions, rate limits, and trust boundaries.
- [Encryption at rest](encryption-at-rest.md): which fields are encrypted, and how to protect the key.
- [Error responses](../spec/errors.md): the error envelope and the error codes the server returns.
- [Behavior specification](../spec/README.md): how every part of the product behaves, file by file.

## Contributing

Build and test instructions are in [development.md](development.md). The docs themselves are Markdown files in the `docs` folder of the repository, and each page has an **Edit on GitHub** link.

## License

OpenAudioHub is AGPL-3.0 software. The source and the releases are in the repository.
