# Backup and restore

OpenAudioHub has three ways to get your data out, and one way to protect the server itself. They do different jobs, so check which one you need.

- [Full backup (zip)](#full-backup-zip): your recordings, transcripts and summaries in one archive. Use it to keep a copy or to take your data elsewhere.
- [Transcript export](#transcript-export): all transcripts and summaries in one file, in a format you choose.
- [Audio download](#audio-download): the audio files, one at a time or in bulk.
- [Scheduled backups and auto export](#scheduled-backups-and-auto-export): Mac app only. Copies go to a folder you choose.
- [Server backup and restore](#server-backup-and-restore): copy the whole data, so the server can be rebuilt. This is for the person who runs the server.

## Full backup (zip)

1. Open **Settings**, then **Export/Backup**.
2. Choose **Create full backup**. The job runs in the background.
3. When it is ready, download the zip. The server keeps it for 7 days.

The full backup holds the original audio too, so it is larger than a transcript export. Large libraries take a few minutes.

If a full backup finished in the last 24 hours, the button gives you that one instead of making a new one. When the server has SMTP set up, you also get an email when the archive is ready. See [Email (SMTP) setup](email-smtp.md).

The zip contains `manifest.json` and one folder per recording. A folder holds the audio file, `transcript.txt`, `timeline.json` and `summary.json`, for each item that exists. Items that are missing are left out, and the manifest says why. The manifest is the place to check what an archive holds.

The file name is `openaudiohub-export-<id>.zip`.

**The zip is plain text.** The server decrypts your titles, transcripts and summaries before it writes the archive. Store the file encrypted or in a safe place, and do not send it by email. Keep the file apart from your encryption key.

A full backup is not a restore package. OpenAudioHub cannot import it back.

## Transcript export

Transcript export writes your transcripts, with the summaries, to one file. Open **Settings**, then **Export/Backup**, and choose **Export text**.

The format is the **Default export format** on the same page. The choices are:

| Format | Content |
|---|---|
| JSON | One document with every recording and its transcript. |
| TXT | Plain text, one block per recording. |
| SRT | SubRip subtitles for all recordings. |
| VTT | WebVTT subtitles for all recordings. |

The file name is `recordings-<date>.<format>`. The export uses your signed-in browser session, so it is not available to personal API keys.

## Audio download

Each recording has **Download audio** in its menu. It saves the audio file as stored.

To download several recordings, select them in the library and choose **Download**. The result is one zip file with an audio file for each recording. A recording whose audio is missing is listed in an `errors.txt` file inside the zip, and the others are still included.

## Scheduled backups and auto export

These run only in the Mac app, and only while the app is running.

- **Scheduled backups.** Choose a frequency (daily, weekly or monthly) and a folder in **Settings**, then **Export/Backup**. The default folder is `Documents/OpenAudioHub Backups`. Each backup is a full backup zip named `OpenAudioHub-backup-YYYY-MM-DD.zip`. The app keeps the five newest copies in that folder and leaves other files alone.
- **Auto export.** Choose a folder, then each new recording is saved there once: as **MP3** (converted) or as the **original file**. The file name can follow the **original name**, the **date** (`2026-10-12`), or be renamed to the **AI title** once the recording has one. A recording that was already exported is never exported again.

## Server backup and restore

This is for a self-hosted server. It saves everything the server needs, including the database and the audio, and it is not something people use to take their data out.

Back up two things:

1. **The data.** On a self-hosted server, that is the `data` volume, which holds the database and the audio on disk. If you use S3 storage, back up the bucket too. The Mac app keeps everything in its data folder.
2. **`ENCRYPTION_KEY`.** Keep a copy apart from the backup. Without it, the encrypted fields cannot be read.

For the copy and restore steps, see [Backups](self-hosting.md#backups) in the self-hosting guide.

The Mac app also makes a copy of its database before each upgrade, in the `backups` folder of the data folder. It keeps the five newest. See [Mac app](desktop.md#backups).

To restore on the Mac app, quit the app, copy the data folder back, and open the app again. The `secrets.json` file in that folder holds the key, so keep it with the data.
