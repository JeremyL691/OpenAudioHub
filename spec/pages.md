# Pages

This file describes which paths the server answers, with what status, redirect and
headers, and what the browser app shows for public pages. It covers the health route, the
static files, the not-found page, the security headers, and the public pages (landing,
install, docs).

Owned by other files: sign-in and registration pages (`/login`, `/register`,
`/forgot-password`, `/reset-password`) in `auth.md`; `/connect/plaud` in `plaud.md`;
`/dashboard`, `/recordings` and `/settings/*` in `ui-library.md` and `ui-app.md`.

The server serves a single web app for every page path. Its HTML shell is the same for all
of them. Page content is rendered in the browser, except where a row below says the server
answers directly.

Unless a row says otherwise, a page path returns the same result signed in or out.

## Route summary

| Method | Path | Auth | Result |
|---|---|---|---|
| GET | `/` | none | Signed out: 200 app shell (landing page). Signed in, or desktop app: 307 to `/dashboard` |
| GET | `/login`, `/register`, `/forgot-password`, `/reset-password` | none | Signed out: 200 app shell. Signed in: 307 to `/dashboard` |
| GET | `/suspended` | session | Signed out: 307 to `/login`. Signed in, account active: 307 to `/recordings`. Suspended account: 200 app shell |
| GET | `/dashboard` | session | Signed out: 307 to `/login`. Suspended: 307 to `/suspended`. Active: 200 app shell, or 307 to a settings section (see "Redirects") |
| GET | `/recordings` | session | As `/dashboard` |
| GET | `/recordings/{id}` | session | Signed out: 307 to `/login`. Suspended: 307 to `/suspended`. Active, own recording: 200 app shell. Otherwise 404 not-found page |
| GET | `/settings`, `/settings/{section}` | session | As `/dashboard`, for a listed section (see "Settings sections"). Other sections: 404 not-found page |
| GET | `/connect/plaud` | none | 200 app shell |
| GET | `/install` | none | 200 app shell |
| GET | `/docs`, `/docs/{path}` | none | 200 app shell, for any path under `/docs` |
| GET | `/api/health` | none | 200 JSON, or 503 when the database does not answer |
| GET | `/assets/{file}` | none | 200 build file, long cache |
| GET | static files (see "Static files") | none | 200 file |
| any | any other path | any | 404 HTML not-found page |
| any | `/api/...` with no route | any | 404 JSON `{ "error": "Not found", "code": "NOT_FOUND" }` |

## Common response rules

- Pages are HTML with `charset=utf-8`. The app shell declares `lang="en"`.
- Trailing slashes on page paths are accepted without a redirect: `/install/` gives the same
  200 as `/install`.
- Paths are case-sensitive.
- Redirects use status 307 (temporary) with a `Location` path on the same server, for
  example `/dashboard`.
- Query strings are ignored on static files and page paths, except for the redirect rule
  for `/dashboard?settings=`.
- API paths (`/api/...`) never get the app shell or the not-found page.

## Health

### GET /api/health

Auth: none. Status `200`, `Content-Type: application/json`:

```json
{ "status": "ok", "version": "1.0.0" }
```

- `version` is the application version without a `v` prefix.
- The route runs a trivial database query. If the database does not answer, the response is
  `503` with the error envelope, `code` `DATABASE_UNAVAILABLE`, message `Database unavailable`.

## App shell

- Every page path that is not an API path, not a static file, and not unknown, returns the
  app shell: the web app's `index.html`, with `Content-Type: text/html; charset=utf-8` and
  `Cache-Control: no-cache`.
- If the web build is missing, the shell answers `404` with the plain-text message
  `The web app is not built. Run pnpm build in web/.`.

## Redirects

Server-side redirects. All are `307` with a `Location` path.

| From | Condition | To |
|---|---|---|
| `/` | signed in, or desktop app | `/dashboard` |
| `/login`, `/register`, `/forgot-password`, `/reset-password` | signed in | `/dashboard` |
| `/suspended` | signed out | `/login` |
| `/suspended` | signed in, account active | `/recordings` |
| `/dashboard`, `/recordings`, `/recordings/{id}`, `/settings`, `/settings/{section}` | signed out | `/login` |
| `/dashboard`, `/recordings`, `/recordings/{id}`, `/settings`, `/settings/{section}` | account suspended | `/suspended` |
| `/dashboard?settings=<section>` | `<section>` is a listed settings section | `/settings/<section>` |
| `/dashboard?settings=<other>` | unknown or empty section | 200 app shell (no redirect) |

Settings sections for `?settings=`: `providers`, `transcription`, `summary`, `naming`,
`plaud-account`, `sync`, `playback`, `display`, `notifications`, `storage`, `export`.

Browser-side forwards, done by the web app after the shell loads:

| From | To |
|---|---|
| `/settings` | `/settings/<section>`. The section is taken from the URL hash if it names a section. Otherwise the last section opened in this browser is used. Otherwise `providers` |
| `/settings#<section>` | `/settings/<section>` |
| `/recordings?id=<id>` | Preselects that recording in the library |

## Settings sections

`/settings/{section}` is served for the sections in the list above, and for `desktop` when the
server runs as the desktop app. Any other section gives the not-found page.

## Not-found page

Any unknown path, for any method, returns `404` with an HTML page, except `/api/...` paths
(JSON, see the route summary). The page:

- `<title>`: `Page not found · OpenAudioHub`
- `<meta name="robots" content="noindex">`
- A `404` label, `<h1>` "Page not found", and the text "The link may be out of date, or the page
  may have moved."
- One link button:
  - signed out: "Back to home", link `/`;
  - signed in: "Go to recordings", link `/recordings`.
- The page is self-contained (no app shell), so the status code is 404 for every visitor.

The same page is used for unknown recordings (`/recordings/{id}` when the recording does not
exist or belongs to another account), unknown settings sections, and removed paths such as
`/install.sh`.

## Suspended page

`/suspended` gives the server redirects above. A suspended account that opens any other page
gets the app shell. The web app then checks the account with a session route, which answers
`403 ACCOUNT_SUSPENDED`, and shows the suspended view:

- `<title>`: `Account suspended | OpenAudioHub`, and `noindex`.
- Heading "Your account is suspended".
- Text: "While we review your account, recordings, sync, and transcription are on hold."
  and "Contact the administrator of this instance if you think this is a mistake."
- A "Sign out" button.
- The suspension reason is never shown.

## Static files

Content types are derived from the file extension.

| Path | Status | Content type | Notes |
|---|---|---|---|
| `/favicon.ico` | 200 | `image/x-icon` | |
| `/icon.svg` | 200 | `image/svg+xml` | Linked by the app shell |
| `/apple-icon.png` | 200 | `image/png` | Home screen icon |
| `/icon-192.png`, `/icon-512.png` | 200 | `image/png` | Manifest icons |
| `/og.png` | 200 | `image/png` | Social card image |
| `/manifest.webmanifest` | 200 | JSON | See below |
| `/robots.txt` | 200 | text | `User-Agent: *` then `Disallow: /` |
| `/sitemap.xml` | 200 | XML | A `urlset` with no URLs |
| `/theme-init.js` | 200 | script | Applies the saved theme before first paint |
| `/assets/*` | 200 | by extension | Built, hashed files. `Cache-Control: public, max-age=31536000, immutable` |
| other build files | 200 | by extension | `Cache-Control: no-cache` |

Manifest body:

```json
{
  "name": "OpenAudioHub",
  "short_name": "OpenAudioHub",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

The robots file asks every crawler to skip everything. Self-hosted instances are private.

## Security headers

Every response from the server carries these headers, unless the handler has already set the
same header:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Content-Security-Policy` | see below |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, only when `APP_URL` starts with `https://` |

Content Security Policy for the app (directives in order):

- `default-src 'self'`
- `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' chrome-extension: moz-extension:`
- `worker-src 'self' blob:`
- `style-src 'self' 'unsafe-inline'`
- `img-src 'self' data: blob:`, `media-src 'self' blob:`, `font-src 'self'`
- `connect-src 'self'`, plus `https://huggingface.co https://*.huggingface.co https://*.hf.co`
  (the in-browser speech model download), plus `ipc: http://ipc.localhost` in the desktop app
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`

The Plaud connection page (`/connect/plaud`) has its own policy, described in `plaud.md`.

## Public pages (browser-rendered)

These pages are part of the web app. The server returns the app shell for them.

### Landing page (`/`, signed out)

- Header: home link (accessible name "OpenAudioHub home"), "Docs" (`/docs`), a GitHub icon
  link (new tab, accessible name "View source code on GitHub"), and "Sign in" (`/login`).
- `<h1>` "Long recordings, intelligently transcribed.", with "Sign in" (`/login`) and
  "Create account" (`/register`). "Create account" is not shown when the server reports
  that registration is disabled (`DISABLE_REGISTRATION`).
- A features section with six feature cards, each an `<h3>`.
- A self-hosting section with links to the repository and to `/docs`.
- Footer: license link, source link and "Docs" link.
- The landing page is replaced by `/dashboard` in the browser when the session is active or
  the app runs as the desktop app.

The copy is in `web/src/pages/public/landing.tsx`.

### Install page (`/install`)

- `<h1>` "Install OpenAudioHub".
- A "Latest release" command box with a copy button (accessible name "Copy install command").
- A "Pin to a specific version" command box (copy button "Copy version-pinned install
  command"). It uses the version reported by `/api/health`, with the `v` prefix. It stays
  disabled until that version is known.
- A "View raw script" link to the installer script on GitHub
  (`https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/install.sh`).
- Lists of requirements and of what the installer does, and a link to the installer source.

The copy is in `web/src/pages/public/install.tsx`.

### Docs site (`/docs`)

- Pages are Markdown files from the repository's docs folder, bundled into the web app. The
  list of pages, their titles and their URLs is in `web/src/pages/docs/content.ts`.
- Current pages (URL and title):

| URL | Title |
|---|---|
| `/docs` | OpenAudioHub Docs |
| `/docs/guides/using-the-library` | Using the library |
| `/docs/guides/connect-plaud-account` | Connect your Plaud account |
| `/docs/guides/ai-providers` | AI providers |
| `/docs/guides/notifications` | Notifications |
| `/docs/guides/automation-and-webhooks` | Automation API and webhooks |
| `/docs/guides/backup-and-restore` | Backup and restore |
| `/docs/self-hosting/install` | Install |
| `/docs/self-hosting/desktop` | Mac app (beta) |
| `/docs/self-hosting/environment-variables` | Environment variables |
| `/docs/self-hosting/storage-s3` | S3-compatible storage |
| `/docs/self-hosting/email-smtp` | Email (SMTP) setup |
| `/docs/reference/public-api` | Public API |
| `/docs/reference/architecture` | Architecture |
| `/docs/reference/security-model` | Security model |
| `/docs/reference/encryption-at-rest` | Encryption at rest |
| `/docs/self-hosting` | Self-hosting (routable, not in the sidebar; shows the install content) |

- The browser sets each page's title to `<page title> · OpenAudioHub`.
- Layout: a top bar with "Back to app" (`/dashboard`) and a GitHub link, a sidebar with the
  pages in groups (Guides, Self Hosting, Reference), and an "Edit on GitHub" link on each
  page.
- A path under `/docs` that is not in the list shows the not-found view in the browser, with
  status 200 from the server.

## Not covered by tests

- The landing page, install page and docs content are not tested in the browser beyond the
  docs page titles.
- The suspended view needs an account suspension, which no public route sets.
- The registration-disabled landing page needs `DISABLE_REGISTRATION=true` on the target.
- Desktop-app redirects need the desktop build.
