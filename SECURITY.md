# Security Policy

## Supported versions

Security fixes go into the newest release and into `main`. Older releases are not patched: upgrade to the newest version to get a fix.

| Version | Supported |
|---------|-----------|
| Newest release | Yes |
| Any older release | No |

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Report them privately through GitHub's security advisories:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected version or commit, the steps to reproduce it, and its likely impact.

Direct link: <https://github.com/JeremyL691/OpenAudioHub/security/advisories/new>

The maintainer will acknowledge the report, confirm whether it is a vulnerability, and keep you informed while a fix is prepared. Once a fix is released, the advisory is published with credit to the reporter unless you ask to stay anonymous.

## Scope

In scope: the server, the web app, the Mac app, the container image and the installer in this repository.

Out of scope: the Plaud service itself, third-party AI providers, and problems that come from a deployment that ignores the guidance in the [self-hosting guide](docs/self-hosting.md), such as a public port without a reverse proxy.
