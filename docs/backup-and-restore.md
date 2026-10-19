# Backup and restore

OpenAudioHub has several ways to get your data out, and a way to protect the server itself. They do different jobs, so check which one you need.

- [Transcript export](#transcript-export): all transcripts and summaries in one file, in a format you choose.
- [Audio download](#audio-download): the audio files, one at a time or in bulk.
- [Auto export](#auto-export): Mac app only. New recordings are saved into a folder you choose as they arrive.
- [Server backup and restore](#server-backup-and-restore): copy the whole data, so the server can be rebuilt. This is for the person who runs the server.

## Transcript export

Transcript export writes your transcripts, with the summaries, to one file. Open **Settings**, then **Export**, and choose **Export text**.

The format is the **Default export format** on the same page. The choices are:

| Format | Content |
|---|---|
| JSON | One document with every recording and its transcript. |
| TXT | Plain text, one block per recording. |
| SRT | SubRip subtitles for all recordings. |
| VTT | WebVTT subtitles for all recordings. |

The file name is `recordings-<date>.<format>`. In the Mac app the export opens the macOS save dialog. In the browser it is downloaded. The export uses your signed-in browser session, so it is not available to personal API keys.

## Audio download

Each recording has **Download audio** in its menu. It saves the audio file as MP3. The player menu can also save the original file unchanged.

To download several recordings, select them in the library and choose **Download**. The result is one zip file with an audio file for each recording. A recording whose audio is missing is listed in an `errors.txt` file inside the zip, and the others are still included.

In the Mac app each download opens the macOS save dialog, so you choose the folder before the file is written. A cancelled dialog saves nothing. In the browser the file goes to the browser's Downloads folder.

## Auto export

Auto export runs only in the Mac app, and only while the app is running.

Choose a folder in **Settings**, then **Export**, then turn on **Auto-export new recordings**. Each new recording is saved there once:

- Format: **MP3** (converted), **OGG** (Ogg container with Opus audio), or the **original file**. An original Opus recording is saved with the `.ogg` extension, unchanged, because Opus audio lives in an Ogg container. Earlier automatic `.opus` files are renamed to `.ogg` on the next pass when they still match the recording.
- File name: the **original name**, the **date** (`2026-10-12`), or the **AI title** once the recording has one.

Only recordings that arrive while auto export is on are saved; recordings already in the library are not. A recording that was already exported is never written again. If you change the format later, files this app exported in the old format are written again in the new one and the old copy is removed. A file you renamed yourself is left alone.

A failed write is retried a few times and then left alone until the folder or format changes.

## Server backup and restore

This is for a self-hosted server. It saves everything the server needs, including the database and the audio, and it is not something people use to take their data out.

Back up two things:

1. **The data.** On a self-hosted server, that is the `data` volume, which holds the database and the audio on disk. If you use S3 storage, back up the bucket too. The Mac app keeps everything in its data folder.
2. **`ENCRYPTION_KEY`.** Keep a copy apart from the backup. Without it, the encrypted fields cannot be read.

For the copy and restore steps, see [Backups](self-hosting.md#backups) in the self-hosting guide.

The Mac app also makes a copy of its database before each upgrade, in the `backups` folder of the data folder. It keeps the five newest. See [Mac app](desktop.md#backups).

To restore on the Mac app, quit the app, copy the data folder back, and open the app again. The `secrets.json` file in that folder holds the key, so keep it with the data.

The zip files and audio files you save through the app are plain files. Store them somewhere safe, and keep them apart from `ENCRYPTION_KEY`.
