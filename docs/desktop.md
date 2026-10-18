# Mac app

The OpenAudioHub Mac app runs the server on your Mac. Your library stays on your Mac. The app shows the library in its own window, and it keeps syncing when the window is closed.

- [Requirements](#requirements)
- [Install and first launch](#install-and-first-launch)
- [Where your data lives](#where-your-data-lives)
- [Keep a copy of your keys](#keep-a-copy-of-your-keys)
- [Window and menu bar](#window-and-menu-bar)
- [Preferences](#preferences)
- [Settings file](#settings-file)
- [Sign in to Plaud](#sign-in-to-plaud)
- [Launch at login](#launch-at-login)
- [Backups](#backups)
- [Ports and network](#ports-and-network)
- [Problems](#problems)

## Requirements

- A Mac with Apple Silicon (an M-series chip).
- At least 200 MB of free space on the disk that holds your data folder. The app does not start when less space is free.
- A Plaud account, to sync recordings.

## Install and first launch

1. Copy `OpenAudioHub.app` to your Applications folder.
2. Open it.

On the first launch, the app:

- creates the data folder,
- creates a new encryption key in `secrets.json`,
- creates the local account `Local user`,
- starts the server and the database on your Mac,
- opens the Dashboard in its window.

The app has no password and no sign-in page, and no "Log out". The local account signs in for you each time you open the app. If the window ever loses its session, it shows "Reconnecting…" for a moment and signs in again by itself.

Only one copy of the app runs at a time. If you open it again, the window of the running copy comes to the front.

## Where your data lives

The data folder is `~/Library/Application Support/OpenAudioHub`. Open it from the menu bar with **Open Data Folder**.

| Name | What it holds |
|---|---|
| `openaudiohub.sqlite` | The database: recordings, transcripts, summaries, settings and accounts. While the app runs, `-wal` and `-shm` files sit next to it. |
| `storage/` | Audio files. While a long recording is processed, `storage/.pipeline/` holds temporary files. |
| `backups/` | Copies of the database made before an upgrade. See [Backups](#backups). |
| `secrets.json` | The encryption key, `ENCRYPTION_KEY`. See [Keep a copy of your keys](#keep-a-copy-of-your-keys). |
| `config.json` | Window and launch settings. The app writes it. Do not edit it while the app runs. |
| `openaudiohub.env` | Your optional settings file. See [Settings file](#settings-file). |
| `main.log` | The app log. When it reaches 5 MB, it moves to `main.log.1`. |

Deleting the app does not delete the data folder.

## Keep a copy of your keys

`secrets.json` holds the key that encrypts your titles, transcripts, summaries and the Plaud sign-in token. Without that key, the encrypted data in the database cannot be read.

- Use **Export Keys…** in the menu bar. Confirm, then choose a place to save the copy. The file name is `openaudiohub-keys.json`. The copy has the same content as `secrets.json`.
- Store the copy in a password manager or another safe place. Do not share it.
- Do not store the copy next to your backup file. Keep the two apart.

If `secrets.json` is missing or cannot be read, but the database exists, the app does not start. It does not make a new key, because the old data would become unreadable. Put back the copy you exported, then open the app again.

## Window and menu bar

The menu bar icon has these items, in this order:

1. **Open OpenAudioHub**: opens the window.
2. **Open Data Folder**: opens the data folder in Finder.
3. **Open Logs Folder**: opens the same data folder. The log is `main.log` in it.
4. **Edit Configuration…**: opens `openaudiohub.env`. The app creates the file first if it is missing.
5. **Export Keys…**: saves a copy of `secrets.json`.
6. **Launch at Login**: a check box. See [Launch at login](#launch-at-login).
7. **Quit OpenAudioHub**: stops the app and the server. Shortcut: Command-Q.

Closing the window does not quit the app by default. The server keeps syncing in the background, and the icon stays in the menu bar. To quit, choose **Quit OpenAudioHub**, or change the close action in the preferences below.

## Preferences

Open **Settings**, then **Desktop**. This page is only in the Mac app.

- **Show in the menu bar.** Turn the icon on or off. The change applies at once.
- **When the window is closed.** Choose **Keep running in the background** (the default) or **Quit the app**.

## Settings file

`openaudiohub.env` lets you change a few server settings. Choose **Edit Configuration…** in the menu bar to open it.

Each line has the form `KEY=VALUE`. Lines that start with `#` are notes. The app reads the file when it starts, so restart the app after you change it.

The app reads only these keys:

| Key | Default | Meaning |
|---|---|---|
| `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE` | `10` | Syncs you can start by hand in one minute. From 1 to 600. |
| `BACKGROUND_SYNC_ENABLED` | `true` | `false` stops the background sync. |
| `BACKGROUND_SYNC_INTERVAL_MS` | `300000` | Time between background syncs, in milliseconds. From 60000 to 3600000. |
| `WHISPER_MAX_BYTES` | `25165824` | The largest file sent to a provider without changes. From 1 to 26214400. |
| `WHISPER_COMPRESS_BITRATE_KBPS` | `12` | The first bitrate used to shrink a file that is too large. |
| `WHISPER_REQUEST_TIMEOUT_MS` | `3600000` | How long one provider request may take, in milliseconds. |
| `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | `60` | Automatic summaries you can make in one hour. |

Values can be in quotes. A value in double quotes can use `\n`, `\t`, `\\` and `\"`. A value in single quotes is taken as written. A `#` that follows a space starts a note after an unquoted value.

The app reads no other keys from this file. Email, S3 and provider settings are server settings, and the Mac app does not read them from this file. The Mac app keeps audio on disk only, in its data folder.

## Sign in to Plaud

The steps below are the Mac app's. For all sign-in methods, see [Connect your Plaud account](connect-plaud-account.md).

1. Open **Settings**, then **Plaud Account**.
2. Choose **Connect Plaud**.
3. Choose **Sign in with Plaud**, then **Open Plaud sign-in**. A connect page opens in your browser. Finish the sign-in there with the [browser extension](browser-extension.md).

The **Email code** and **Paste token** tabs work in the app too. The app never sees your Plaud password.

The token is stored encrypted in the database. It is not written to the log. Plaud tokens expire after 24 hours. When one expires the connection shows **Sign-in expired** and you sign in once more on any of the three paths.

## Launch at login

Turn on **Launch at Login** in the menu bar. The app then starts when you sign in to your Mac. When it starts this way, it does not open the window. Its menu bar icon appears if **Show in the menu bar** is on.

The check box is not available in development builds.

## Backups

The app makes these backups. For what you can export, see [Backup and restore](backup-and-restore.md).

**A copy before each upgrade.** When a new version of the app starts on data that an older version wrote, it first copies the database to `backups/`. The file name has the time and the app version, for example `<time>-before-1.1.0.sqlite`. The app keeps the five newest copies. If the copy fails, the app does not start, so that your data stays as it was.

**A full backup from Settings.** Open **Settings**, then **Export/Backup**, then choose **Create full backup**. The app builds one zip file with your audio, transcripts, summaries and a `manifest.json` file. Download it while it is ready. It is kept for 7 days.

**Scheduled backups.** In **Settings**, then **Export/Backup**, choose how often (daily, weekly or monthly) and a folder. The default folder is `Documents/OpenAudioHub Backups`. Each backup is saved there as `OpenAudioHub-backup-YYYY-MM-DD.zip`, and the app keeps the five newest. The app must be running for a backup to happen.

**Auto export.** The same page can save each new recording into a folder of your choice, once, as MP3 or as the original file. The file name can be the recording's original name, its date (`2026-10-12`), or the AI title once one exists.

A backup zip does not hold `secrets.json`. To move to another Mac, quit the app and copy the whole data folder. The copy includes `secrets.json`, so keep it private.

## Ports and network

The app listens on one port, on `127.0.0.1`. Other computers on your network cannot reach it. Programs on the same Mac can use the [public API](public-api.md) through that address.

The window uses port `38400` by default. If another program uses it, the app uses the next free port, and it saves the new port in `config.json`. Your browser settings for the window are tied to the port, so they may need to be set again after a port change.

## Problems

- **The app does not start and shows "OpenAudioHub could not start".** The dialog gives the reason. Open the data folder and read `main.log` for more detail.
- **The app says the disk is full.** Free at least 200 MB on the disk that holds your data folder, then open the app again.
- **The app says config.json was written by a newer OpenAudioHub.** Install the newer version of the app.
