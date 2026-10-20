# Desktop app

This file specifies the macOS desktop app: what it does at start and quit, what it writes to disk, and what the user sees. The app is a Tauri 2 shell (`desktop-tauri/`) that runs the server (`crates/oah`) in its own process, on the loopback address, and shows the web app in a window. HTTP behavior of the server is in [auth.md](auth.md), [plaud.md](plaud.md) and [export.md](export.md).

## 1. Scope

- Platform: macOS on Apple Silicon (`aarch64-apple-darwin`), minimum macOS 11.0. The app is distributed as an app bundle and a disk image, signed ad hoc (signing identity `-`).
- Product name `OpenAudioHub`. Bundle identifier `io.github.jeremyl691.openaudiohub`. Version `1.2.0` (the workspace version, which is also the value written to `config.json` as `lastVersion`).
- One copy of the app runs at a time, on one data folder. It signs in as one local account (section 4).
- The server listens on 127.0.0.1 only. The app has no automatic update check.
- The app bundles two programs, `ffmpeg` and `ffprobe`, placed next to the app executable. The server uses them to decode and convert audio, compute waveforms and prepare files for transcription. They are built with GPL, nonfree and version 3 components disabled (`desktop-tauri/scripts/build-ffmpeg.sh`).

## 2. Data folder and files

### 2.1 Location and permissions

- Default folder: `$HOME/Library/Application Support/OpenAudioHub`.
- `OAH_DESKTOP_DATA_DIR` replaces the folder. `OAH_USER_DATA_DIR` is accepted as a second name for the same override. An empty value is ignored.
- The log is in the data folder (section 2.6). There is no separate logs folder.
- Every JSON file the shell writes, and the copies it makes of the database and of user data, go through a temporary file in the same folder and then a rename. The temporary name is `.<file name>.<12 hex characters>.tmp`. A failed write leaves no temporary file.
- Files that hold keys or user data are created with mode 0600: `config.json`, `secrets.json`, `openaudiohub.env`, the key export, database copies, and downloads and saved text files.
- The data folder itself is created with the default mode.

### 2.2 Contents of the data folder

| Entry | Contents |
|-------|----------|
| `config.json` | Desktop preferences and launch state (section 2.3). |
| `secrets.json` | The field encryption key (section 2.4). |
| `openaudiohub.env` | Optional user settings (section 2.5). |
| `openaudiohub.sqlite`, `-wal`, `-shm` | The SQLite database. The `-wal` and `-shm` files exist while the app runs. |
| `storage/` | Audio files and other stored media. Pipeline working folders are in `storage/.pipeline/<job id>/`. |
| `backups/` | Database copies made before an upgrade, named `<stamp>-before-<version>.sqlite` (section 3.5). |
| `main.log`, `main.log.1` | The app log and its previous copy (section 2.6). |
| `.instance.lock` | Lock file that holds the single-copy lock (section 3.3). |

The window's browser data (cookies, local storage) is kept by the framework's default webview store, outside the data folder.

`<stamp>` is the current UTC time in the form `2026-10-16T08-00-00-000Z`: the ISO 8601 time with `:` and `.` replaced by `-`.

### 2.3 config.json

```
{
  "schemaVersion": 1,
  "ports": { "app": 38400 },
  "closeAction": "background",
  "showTray": true,
  "launchAtLogin": false,
  "lastVersion": "1.2.0",
  "boundUserId": "<user id>"
}
```

- A missing file means the defaults. A file that is not valid JSON, or is JSON but not an object, is renamed to `config.json.corrupt-<stamp>`, and the defaults are used. Nothing is shown to the user.
- `schemaVersion` above 1 stops the start with: "config.json was written by a newer OpenAudioHub; install the newer version."
- `lastVersion` newer than the running version stops the start (section 3.5).
- `ports.app` is used only if it is an integer from 1024 to 65535. Otherwise 38400 is used.
- `closeAction` is `background` (default) or `quit`. `showTray` is true (default) or false. `launchAtLogin` is a boolean (default false). The meanings are in sections 5, 6 and 9.
- `boundUserId` names the local account (section 4). The shell reads it and never writes it.
- Every save writes `schemaVersion: 1`. Keys the shell does not know are kept as they were.
- The file is saved on each start (`lastVersion`, and the port when it moved), and on each preference change.

### 2.4 secrets.json

```
{
  "schemaVersion": 1,
  "ENCRYPTION_KEY": "<64 hex characters>"
}
```

- `ENCRYPTION_KEY` is the key that encrypts stored values in the database (`crypto::FieldKey`). The file is valid when `schemaVersion` is 1 and `ENCRYPTION_KEY` is exactly 64 hex characters. Any other `schemaVersion`, or invalid JSON, makes the file invalid.
- When the file is missing or invalid, and no database file exists, a new file is written with a new key of 32 random bytes (64 hex characters). An invalid file is first renamed to `secrets.json.corrupt-<stamp>`.
- When the file is missing or invalid, and the database file exists, the app does not start and does not create a key. The messages are:
  - "secrets.json is missing but the database exists. Restore it from a backup; it was not regenerated."
  - "secrets.json cannot be used (<reason>). The database exists, so it was not regenerated. Restore it from a backup." The reason is "it is not valid JSON", "unknown schemaVersion" or "ENCRYPTION_KEY is not 64 hex characters".
- The server also reads an optional `API_TOKEN_HASH_SECRET` value from this file, and a value under one other accepted name. A value must be at least 32 characters, or the start fails. Without one, the key for personal API key hashes is HMAC-SHA-256 with `ENCRYPTION_KEY` as the key, over the fixed label defined in `api_hash_secret` (`crates/oah/src/config.rs`).
- Export Keys copies this file (section 6.4).

### 2.5 openaudiohub.env

- Edit Configuration (section 6.2) creates the file when it is missing, with exactly this content:
  ```
  # OpenAudioHub settings. Only the keys listed in the documentation are read.
  # Restart the app after changing this file.
  ```
- The file is read once, at start. Changes apply after a restart.
- A line is `KEY=VALUE`. Blank lines, lines that start with `#`, and lines without `=` are ignored. Spaces around the key and the value are trimmed. Key names are case-sensitive.
- Only these seven keys are read. Any other key is ignored without a message:
  - `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE`
  - `BACKGROUND_SYNC_ENABLED`
  - `BACKGROUND_SYNC_INTERVAL_MS`
  - `WHISPER_MAX_BYTES`
  - `WHISPER_COMPRESS_BITRATE_KBPS`
  - `WHISPER_REQUEST_TIMEOUT_MS`
  - `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR`

  Their meaning is defined by the server ([deployment.md](deployment.md)).
- Values:
  - Unquoted: the text up to a ` #` (a space, then `#`), trimmed.
  - Single-quoted: the text between the quotes, taken literally. Only spaces may follow the closing quote.
  - Double-quoted: a backslash makes the next character literal, with `\n` read as a newline and `\t` as a tab. Only spaces may follow the closing quote.
  - A line with no closing quote, or with other text after the closing quote, is ignored.
- The accepted values are set as environment variables of the app process before the server starts.
- Storage type, mail, cloud-storage and proxy settings are not read from this file. The desktop server always uses local storage and always runs the audio pipeline.

### 2.6 Log

- `main.log` is in the data folder. Each line is the UTC time in ISO 8601 form with milliseconds (for example `2026-10-16T08:00:00.000Z`), a space, and the message. Each line is also written to standard error.
- When `main.log` reaches 5 MiB, it is renamed to `main.log.1`, replacing the previous `main.log.1`.
- A failed write is dropped. Logging never stops the app.
- Logs never contain tokens, keys, passwords, the launch code or export contents.
- Lines written: `main process started`; `not started: <disk message>`; `could not start: <reason>`; `app port is now <port>`; `window opened on port <port>`; `database backup written before the upgrade: <path>`; `could not save config.json: <reason>`; the key export events (section 6.4); the Plaud events (section 10.3); download and file-save failures (section 8).

## 3. Start and stop

### 3.1 Start order

1. Resolve the data folder (section 2.1).
2. Disk check (section 3.4). If it fails, the app exits with code 1.
3. Create the data folder. If it cannot be created, the reason goes to standard error and the app exits with code 2.
4. Take the single-copy lock (section 3.3). If another copy holds it, this process exits with code 0 and prints nothing.
5. Log `main process started`.
6. Read `config.json` (section 2.3). A newer `schemaVersion`, or a `lastVersion` newer than this version, stops the start.
7. Read `secrets.json`, or create it on a first start (section 2.4). A failure stops the start.
8. If the bundled `ffmpeg` and `ffprobe` exist next to the executable, set `FFMPEG_PATH` and `FFPROBE_PATH` to them. Set the environment variables from `openaudiohub.env` (section 2.5).
9. Bind the server to 127.0.0.1 (section 3.2). Save the port to `config.json` if it changed.
10. If an upgrade copy is due, write it (section 3.5). A failure stops the start.
11. Open the database. The file is created if missing, opened in WAL mode with `synchronous=FULL`, foreign keys on and a 5-second busy timeout, and the pending migrations are applied. A failure stops the start with "cannot open the database: <reason>".
12. Start the server's background workers (transcription, audio pipeline, summaries, webhooks, Plaud sync, automatic export) and serve HTTP on the bound port.
13. Save `config.json` with `lastVersion` set to this version.
14. Create the window, the menu-bar item (visible if `showTray` is true) and the Plaud refresh loop (section 10.3). Log `window opened on port <port>`. The window is created hidden when `--background` is given (section 11).

A start that fails at any step logs `could not start: <reason>` (or `not started: <reason>` for the disk check), shows the dialog in section 12, and exits with code 1.

### 3.2 Ports

- The app listens on 127.0.0.1 only. The preferred port is `ports.app` from `config.json`, or 38400.
- If the preferred port is busy, the next 19 ports are tried in order. If all are busy, the system chooses any free port.
- A port other than the saved one is saved to `config.json` and logged as `app port is now <port>`. No notification is shown.
- The window's origin includes the port, so a moved port starts the web app's stored browser data over.

### 3.3 Single instance

- The first copy takes an exclusive lock on `.instance.lock` in the data folder and keeps it until it exits.
- A second copy started from a shell ends at once with code 0 and prints nothing. It does not signal the first copy.
- On macOS, a Finder or Dock launch of a running app activates the running copy. The reopen event shows its window (section 5).

### 3.4 Disk space

- The data folder's disk, or the nearest existing parent of it, must have at least 200 MiB (209,715,200 bytes) free for the user.
- A disk that cannot be measured is not treated as full.
- When the check fails, the reason is logged as `not started: <text>`, the dialog in section 12 is shown, and the app exits with code 1. The text is "Only <N> MB are free on the disk that holds <folder>. Free at least 200 MB on that disk and open OpenAudioHub again." `<N>` is the whole number of megabytes free.
- The disk is checked only at start. A full disk during a session is not detected by the shell.

### 3.5 Upgrade copy and downgrade refusal

- An upgrade copy is written when the database file exists and `lastVersion` is missing or older than this version. It is not written on a first start, nor on a start of the same version.
- The copy is made with SQLite `VACUUM INTO` into `backups/<stamp>-before-<version>.sqlite`, with mode 0600. The file is a complete, consistent copy of the database. Audio files are not in it. The `backups/` directory is created with mode 0700.
- After each successful copy, only the 5 newest files in `backups/` whose names contain `-before-` and end in `.sqlite` are kept. Older ones are deleted.
- A failed copy removes its partial file and stops the start with "could not back up the database before the upgrade, so OpenAudioHub did not start: <reason>". Migrations do not run without a copy.
- A `lastVersion` newer than this version stops the start with: "These files were written by OpenAudioHub <lastVersion>, which is newer than this app (<this version>). Install <lastVersion> or later." Nothing is changed.
- Versions are compared part by part as numbers. A part that is not a number counts as 0. Pre-release labels are not handled.
- The shell has no action to restore an upgrade copy. Restoring one is a manual step.

### 3.6 Quit

- Quit from the menu-bar item (section 6.2), or closing the window with `closeAction` set to `quit`, ends the process. The app does not wait for workers or for an orderly shutdown. Committed database writes are durable because the database uses `synchronous=FULL`.
- Background work (refresh loop, server workers) ends with the process.

## 4. Local account and the window's session

- The desktop app has no password and no sign-up. Sign-up is refused, and the server reports registration as off.
- At each start the shell creates a launch code: 32 random bytes, hex encoded. It is kept in memory only and is given to the server for this process. It is never written to disk.
- The window's first load is `GET /api/desktop/session?code=<launch code>`. The server accepts the code once per process. On success it creates a session and answers 303 to `/dashboard` with the session cookie. A second use of the code is refused with 401.
- The window can sign in again with `POST /api/desktop/session` and `Authorization: Bearer <launch code>`. The request must have the Host header `127.0.0.1:<port>`; any other Host is refused with 403 `INVALID_HOST`, and a wrong bearer with 401. On success the answer is 204 with the session cookie. This request may be repeated. The window uses it through `reconnect()` (section 7.2), and the Plaud refresh uses it for its own session (section 10.3).
- Session cookie: `oah_session`, path `/`, `HttpOnly`, `SameSite=Lax`, lifetime 7 days, no `Secure` flag on the loopback address.
- The local account is the user named by `boundUserId` in `config.json`. If that user does not exist, the session request fails with a server error.
- Without `boundUserId`, the account is the earliest-created user (ties broken by id).
- If there are no users, the server creates one named "Local user" with email `local@openaudiohub.localhost`, marked as verified, and with no password.

## 5. Main window

- Title "OpenAudioHub". Opens at 1280 × 820 points. Minimum size 720 × 480 points.
- Size and position are not saved between launches.
- The window shows the web app served on this launch's port. The shell adds no page of its own.
- Closing the window (its close button) follows `closeAction`:
  - `background` (default): the window is hidden, not destroyed. The server keeps running and the menu-bar item stays.
  - `quit`: the window closes and the app exits (section 3.6).
- A hidden window is shown again by a click on the Dock icon (a reopen event) or by **Open OpenAudioHub**. Showing unminimizes the window and gives it focus.

## 6. Menu bar, Dock and key export

### 6.1 Menu-bar item

- Created at start. Shown when `showTray` is true (default), and hidden when it is false. Changing `showTray` in preferences applies at once.
- Icon: a monochrome 18-point template image, tinted by macOS for light and dark menu bars. Tooltip: "OpenAudioHub".

### 6.2 Menu items

In this order. The labels are shown here in English; they follow the interface language (section 7.4).

1. **Open OpenAudioHub**: shows the window (section 5).
2. Separator.
3. **Open Data Folder**: opens the data folder with the system's default app (Finder).
4. **Open Logs Folder**: opens the same data folder, where `main.log` is.
5. **Edit Configuration…**: creates `openaudiohub.env` with the template (section 2.5) if it is missing, then opens it in the default text editor (`open -t`).
6. **Export Keys…**: section 6.4.
7. Separator.
8. **Launch at Login** (check item): section 9. Enabled only in a release build; it is disabled in a debug build.
9. **Language**: a submenu with one check item per interface language, in the order English, 简体中文, 日本語, 한국어, each written in its own language. The checked item is the current language. Choosing one switches the interface language (section 7.4).
10. Separator.
11. **Quit OpenAudioHub** (Command+Q): quits (section 3.6).

### 6.3 Dock

- The shell sets no activation policy, so the Dock icon is shown while the app runs, whether or not the window is visible.

### 6.4 Export Keys

1. A warning dialog titled "Export the encryption keys?" with the text "The file contains the keys that protect your data. Store it somewhere safe and never share it." The buttons are **Export…** and **Cancel**.
2. On **Export…**, a save dialog titled "Export the encryption keys" opens with the default file name `openaudiohub-keys.json`.
3. The output is a byte-for-byte copy of `secrets.json`, written with mode 0600. For a file this app created, it holds `schemaVersion` and `ENCRYPTION_KEY`.
4. On success the log gets "exported the keys to a file the user chose". The key values are never logged.
5. On failure the log gets "the keys could not be exported: <reason>", and the dialog "The keys could not be exported" shows the reason.

There is no command-line form of Export Keys.

## 7. Preferences and the page bridge

### 7.1 Preferences

| Key | Values | Default | Stored | Effect |
|-----|--------|---------|--------|--------|
| `closeAction` | `background`, `quit` | `background` | `config.json` | What closing the window does (section 5). |
| `showTray` | true, false | true | `config.json` | Shows or hides the menu-bar item (section 6.1). |
| `launchAtLogin` | true, false | false | `config.json` mirror; the system setting is the source | Start at login (section 9). |
| `locale` | `en`, `zh-CN`, `ja`, `ko` | the system language, else `en` | `config.json` and the page's own storage | The interface language (section 7.4). |

- `getPreferences` reads `launchAtLogin` from the system's login item, not from the saved value.
- A key that is not in the table cannot be changed by preferences. Ports, `boundUserId` and the launch code are not settable.
- `locale` is also readable through `getPreferences`. A value that names no supported language is ignored.
- Setting `closeAction` to any value other than `background` or `quit` fails with "closeAction must be background or quit", and nothing is changed.
- Setting `launchAtLogin` changes the login item first. If that fails, the reply is "could not change launch at login: <reason>" and no other key changes.
- Each successful change is saved to `config.json` at once. The menu check mark follows `launchAtLogin`.

### 7.2 Bridge

The main window's pages get one object, `window.__openaudiohubDesktop`, with a `version` field of 7. It is defined by an initialization script on every page of the main window. Its methods call Tauri commands. Only the app's own origin (section 7.3) is granted these commands. The launch-time capability adds the origin `http://127.0.0.1:<port>/*` to the commands in `desktop-tauri/capabilities/default.json`.

| Method | Command | Result |
|--------|---------|--------|
| `getPreferences()` | `prefs_get` | `{ closeAction, showTray, launchAtLogin }` (section 7.1). |
| `setPreferences(updates)` | `prefs_set` | The preferences after the update. Unknown keys are ignored. |
| `openPlaudBrowser(code)` | `open_plaud_browser` | Opens `http://127.0.0.1:<port>/connect/plaud?code=<code>` in the default browser (section 10.1). |
| `pickFolder()` | `pick_folder` | A folder path, or null on cancel. The dialog is titled "Choose the export folder". |
| `saveTextFile(name, text)` | `save_text_file` | Saves text with a save dialog; resolves true when saved, false on cancel (section 8). |
| `downloadRecordings(ids, format)` | `download_recordings` | Shows a save dialog, then writes one recording's audio or one archive of several. Resolves with the saved path, or null on cancel (section 8). |
| `reconnect()` | `desktop_secret`, then `POST /api/desktop/session` | Signs the window in again (section 4). Resolves true when the server accepts it. |
| `initialLocale` (property) | none | The interface language settled at start (section 7.4). |
| `locale` (in preferences) | `prefs_get`, `prefs_set` | The interface language. Setting it saves the choice, rebuilds the menu, and does not tell the page again. |
| `setLocale(locale)` | `set_locale` | Saves the language chosen in the page, rebuilds the menu, and resolves with the language in use. |
| `onLocaleChange(listener)` | none | Runs `listener(locale)` when the language is changed from the menu-bar item. Returns a function that stops listening. |

- Failures from the commands reach the page as errors: "Could not open the folder picker.", "Could not open the save dialog.", "Invalid Plaud browser handoff" and the preference messages in section 7.1.

### 7.3 Navigation rules

- The main window loads only `http://127.0.0.1:<port>` (scheme `http`, this launch's port). Any other `http` or `https` address is not loaded and is opened in the default browser with the system `open` command.
- An address under `/api/` on the app's own origin never loads as a page. The session link `/api/desktop/session` is the one exception; files are saved through the bridge instead.
- Other schemes, `about:blank` included, are not loaded and are dropped.
- The Plaud refresh window (section 10.2) has its own rules.

### 7.4 Interface language

- The desktop app speaks the same four languages as the page (spec/ui-app.md, "Interface language"): English, Simplified Chinese, Japanese and Korean.
- At start the language is the one saved in `config.json`, else the system language, else English. A saved value that names no supported language is ignored.
- Choosing a language in the page (`setLocale`) or in the menu-bar item saves it in `config.json` and switches the menu labels at once. Choosing it in the menu-bar item also tells the window's page, which applies it without writing the choice back.
- The menu-bar labels and the shell's own dialogs and messages use the language: "Export Keys…" (section 6.4), "Choose the export folder" (section 7.2), "Save download" (section 8), and the start-up disk-space and start-failure dialogs.
- The buttons the system adds to a dialog (for example "Cancel" on a save dialog) follow the system language, not this setting.
- A language change never changes stored recordings, transcripts or summaries.

## 8. Downloads and file saves

Audio and text are saved by the shell, not by the webview.

- `downloadRecordings(ids, format)` accepts 1 to 100 recording ids (letters, digits, `_` and `-`, at most 64 characters) and `format` `mp3` or `original`. Anything else fails before a dialog opens.
- One `mp3` id uses `/api/recordings/<id>/audio?download=1`. One `original` id and any set of several ids use `/api/recordings/download` with the same ids and format. The server answers with the file or the archive.
- The command signs in through `POST /api/desktop/session` with the launch secret, reusing the session cookie until the server answers `401`.
- A save dialog opens attached to the main window, starting in the user's Downloads folder with the name from the server's `Content-Disposition`. The name is made safe: the last part of any path is kept, control characters and leading dots are removed, it is cut to 200 characters, and an empty result becomes `download`.
- Only one download runs at a time. A second request while one is in progress fails with "A download is already in progress".
- The response streams into a temporary file in the destination folder with mode 0600. Only a complete transfer is renamed to the chosen name; a cancelled dialog, a refused response, a stalled transfer or a write error removes the temporary file and leaves any existing destination unchanged.
- A transfer with no bytes for 60 seconds is stopped. The server is given up to 15 minutes to start answering.
- `saveTextFile` uses the same name rules, opens the save dialog in the Downloads folder, and writes the text through a temporary file with mode 0600. A cancelled dialog returns false.

## 9. Start at login

- **Launch at Login** and the preference `launchAtLogin` control a login item that starts the app with the argument `--background`.
- Turning the item on or off sets the system setting. The saved value in `config.json` is updated only when the change succeeds. A failure is logged as "could not change launch at login: <reason>".
- A login start creates the window hidden. The menu-bar item is shown when `showTray` is true. A normal start shows the window.

## 10. Plaud

The server side of the Plaud connection is in [plaud.md](plaud.md). The desktop app adds the browser handoff, the token capture window and the background refresh.

### 10.1 Browser handoff

- The page calls `openPlaudBrowser(code)`. The shell builds the URL from its own origin, never from the page's text. The origin must be `http`, host `127.0.0.1`, with a port, and no user name or password. The code must be exactly 43 characters from `A-Z`, `a-z`, `0-9`, `-` and `_`.
- The URL `http://127.0.0.1:<port>/connect/plaud?code=<code>` is opened in the default browser.

### 10.2 Token capture window

The refresh uses a hidden window (label `plaud-refresh`, title "Plaud token refresh", 480 × 720 points, not shown). It opens a Plaud page, waits for a token, closes, and returns the token. It uses the app's default webview store.

- Token sources, checked every second by the shell and by the page:
  1. The cookie `pld_ut` on a domain ending in `plaud.ai` or `plaud.cn`.
  2. The local storage key `pld_tokenstr` on `web.plaud.ai` or `web.plaud.cn`.
  The page hands a value over by navigating to `oah-token://token?v=<value>`. The shell takes the value only while the window shows an `https` address on `web.plaud.ai` or `web.plaud.cn`.
- Value forms accepted: a JSON string, a `bearer ` or `Bearer ` prefix, surrounding quotes, and percent encoding (decoded when a `%` is present).
- A token must have three dot-separated parts and be longer than 20 characters.
- If the token's payload has an `exp` claim, that expiry must be later than the current time and later than the expiry of the token in use. A token without `exp` is accepted.
- The wait ends with the first accepted token, when the window is closed, or after the timeout (60 seconds for the refresh). A timeout or a closed window yields no token.

### 10.3 Background refresh

- The loop starts with the window. The first check runs 60 seconds after start, then a check runs every 30 minutes. Checks do not overlap.
- Each check reads `GET /api/plaud/connection` with the app session. The fields used are `connected`, `needsReconnect`, `tokenExpiresAt` (ISO 8601), `server` and `apiBase`. A reply other than 200 ends the check, logged as "plaud token check skipped: <reason>".
- A refresh is due when `connected` is true and either `needsReconnect` is true, or the expiry is within 6 hours from now or already past. An unknown expiry with no `needsReconnect` is not refreshed.
- Retry guard, kept in memory: a capture for a token with the same expiry is not repeated within 6 hours. A token with a new expiry is tried at once. The guard resets at each start.
- The capture page is `https://web.plaud.cn/` when `server` is `cn`, otherwise `https://web.plaud.ai/`.
- On a token, the shell posts `POST /api/plaud/auth/connect-token` with the session cookie and the JSON body `{"accessToken": "<token>", "apiBase": "<host>", "source": "desktop-refresh"}`. `apiBase` is the connection's `apiBase` when it is not empty, otherwise the host from this table:

  | Region claim in the token | API host |
  |---------------------------|----------|
  | `aws:us-west-2` | `https://api.plaud.ai` |
  | `aws:eu-central-1` | `https://api-euc1.plaud.ai` |
  | `aws:ap-southeast-1` | `https://api-apse1.plaud.ai` |
  | any other, or none | `https://api.plaud.cn` if the capture page was the China site, otherwise `https://api.plaud.ai` |

- The session cookie is cached. A 401 from any call creates a new session with the launch code and repeats the call once. Each call to the server has a 20-second timeout.
- Log lines: "plaud token refreshed" (success); "plaud token refresh: the app rejected the new token (<message>)" (the server refused the token); "plaud token refresh: the app did not answer (<reason>)"; "plaud token refresh: no new token from Plaud" (no acceptable token in time).
- The user is not prompted. When no token arrives, the shell does nothing else; the connection is refreshed by a later check or by the user reconnecting from the Plaud account page.
- The shell does not check for system sleep or wake.

## 11. Command-line arguments and environment

| Argument | Effect |
|----------|--------|
| `--background` | The window is created hidden. Used by the login item (section 9). |

Other arguments are ignored. The app has no other command-line modes.

| Variable | Effect |
|----------|--------|
| `OAH_DESKTOP_DATA_DIR`, `OAH_USER_DATA_DIR` | Data folder override (section 2.1). |
| `FFMPEG_PATH`, `FFPROBE_PATH` | Program paths. Replaced by the bundled programs when they exist (section 3.1). |
| `HOME` | Base of the default data folder. |

Exit codes: 0 for a normal exit and for a second copy; 1 for a start that failed, including the disk check; 2 when the data folder cannot be created.

## 12. Dialogs and log-only failures

Dialogs are native alerts. The app shows no notifications.

| Title (or text) | When | Result |
|-----------------|------|--------|
| "OpenAudioHub could not start" + reason | Any start failure in section 3.1 | Exit 1. |
| "OpenAudioHub needs more free disk space" + disk message | Disk check fails (section 3.4) | Exit 1. |
| "Export the encryption keys?" | Export Keys (section 6.4) | Warning with Export… and Cancel. |
| "The keys could not be exported" + reason | Export fails (section 6.4) | Dialog only. |
| "The download could not be saved: <reason>" | Download or save fails (section 8) | Dialog only. |

The following failures are written to the log only: a failure to open a folder or the configuration file in the default app; a failure to save `config.json`; a failure to change the login item from the menu; a failure to remove old database copies; and the Plaud refresh events in section 10.3.

## 13. Not in the desktop app

Stated so that these are not added by accident:

- No automatic update check.
- No saved window size or position.
- No notifications.
- No runtime disk check.
- No system sleep or wake handling.
- No Dock icon hiding, no quarantine removal and no move to the Applications folder.
- No Plaud sign-in window. Plaud sign-in is the browser handoff; the token capture window (section 10.2) is used only for the refresh.
- No restore action for upgrade copies, and no backup action in the shell. Automatic export runs inside the server in desktop mode, to a folder the user chooses; see [export.md](export.md).
- No application menu or keyboard shortcut in the shell, apart from Command+Q on the Quit item.
