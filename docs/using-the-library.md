# Using the library

This page covers the dashboard, the library and its collections, starring, search, merging, and the recording page.

- [Interface language](#interface-language)
- [Dashboard](#dashboard)
- [Library and collections](#library-and-collections)
- [Filters and sorting](#filters-and-sorting)
- [Search](#search)
- [Star a recording](#star-a-recording)
- [Select several recordings](#select-several-recordings)
- [Merge recordings](#merge-recordings)
- [Upload audio](#upload-audio)
- [A recording](#a-recording)
- [Rename and delete](#rename-and-delete)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Interface language

The app speaks English, Simplified Chinese, Japanese and Korean. Choose the language in the account menu at the top right, under **Language**. The choice is remembered in this browser, and dates and relative times follow it. The interface language is separate from the transcription language and the AI output language.

## Dashboard

The dashboard is the first page after you sign in. It has three tiles. Each one opens the matching list in the library:

- **Last 7 days** shows the recordings from the past week, and how long they are.
- **Not transcribed** shows recordings that still need a transcript.
- **Processing** shows recordings that the audio pipeline or a transcription is working on.

Below the tiles, the dashboard shows your latest recording and a short **Recent** list.

While the dashboard is open, it also syncs with Plaud on its own schedule. See [Connect your Plaud account](connect-plaud-account.md#how-sync-works).

## Library and collections

The library lists every recording you have. Each row shows the title, the duration, when it was recorded, where it came from, and its status. Choose a row to preview it. Choose **Open full view** to open its page.

The collections narrow the list. Choose one in the sidebar:

| Collection | Shows |
|---|---|
| Starred | Recordings you starred. |
| Last 7 days | Recordings from the past week. |
| From Plaud | Recordings synced from your Plaud account. |
| Uploaded | Files you uploaded, and recordings you merged. |

## Filters and sorting

Above the list, choose a status filter. It works inside the collection you are viewing:

- **All**
- **Transcribed**
- **Processing**
- **Untranscribed**

Open the sort menu to sort by **Newest first**, **Oldest first**, or **Name**. You can also choose a list density, **Comfortable** or **Compact**.

## Search

The search field matches recording titles and the text of transcripts. Press `/` to move to the field. Results update as you type.

## Star a recording

Star a recording to keep it in the **Starred** collection. Choose the star next to its title, or choose **Star** in its actions menu. Choose the star again to remove it.

## Select several recordings

Select rows with their check boxes, or choose **Select all** above the list. The toolbar then offers:

- **Download**: downloads the selected recordings as one zip file. See [Backup and restore](backup-and-restore.md#audio-download).
- **Merge recordings**: joins the selected recordings into one new recording. See below.

## Merge recordings

Merging joins the audio of two or more recordings, from 2 to 100, into one new recording. The new recording goes to the **Uploaded** collection.

- The title is the one you enter. If you leave it empty, the new title is the first recording's title with ` (merged)` added.
- The start time is the earliest of the recordings you merged.
- The originals stay as they are. Deleting one later does not affect the merged recording.
- A merged recording longer than 24 hours is not allowed.

If every recording you merge already has a transcript, the merged recording gets the joined transcript, with time offsets.

## Upload audio

Choose **Upload audio** to add a file from your computer. The supported types are MP3, MP4, M4A, WAV, OGG, Opus, WebM, AAC and FLAC. A file can be up to 500 MB. The title is the file name, or the upload date if you chose dates for titles in **Settings**.

## A recording

The recording page shows the title, the audio player, the transcript and the summary.

- **Player.** Play, pause, seek, change the volume and the speed. The player stays at the bottom of the window on large screens. Choose **Skip back 15 seconds** or **Skip forward 15 seconds** to move in larger steps. Keyboard arrows move 5 seconds.
- **Transcript.** Each segment has its start time. Choose a time to play from there. Turn on **Follow playback** to keep the segment that is playing in view. **Transcript source** chooses between the transcripts you have, if there is more than one.
- **Summary.** The summary, with its action items and key points.
- **Actions.** The **Recording actions** menu holds **Transcribe recording**, **Re-transcribe recording**, **Transcribe in browser**, **Summarize**, **Star**, **Download audio**, **Delete recording**, and the export items. Export items save the transcript as JSON or TXT, and the summary as TXT or Markdown.

Transcription and summaries need an AI provider, or you can transcribe in the browser. See [AI providers](providers.md).

## Rename and delete

To rename a recording, edit its name on the recording page. A rename sends a `recording.updated` webhook event. See [Automation API and webhooks](automation-and-webhooks.md#events).

To delete a recording, choose **Delete recording** in the actions menu. Deleting removes its audio, transcript and summary. It cannot be undone. A later sync from Plaud does not bring the recording back. Deleting a recording does not change the copy in Plaud.

## Keyboard shortcuts

Press `?` anywhere to see the shortcuts list.

| Keys | Action |
|---|---|
| `⌘` `K` | Open the command palette |
| `?` | Show the shortcuts |
| `,` | Open settings |
| `/` | Focus search |
| `j` / `k` | Next and previous recording |
| `Space` | Play or pause |
| `←` / `→` | Seek back or forward 5 seconds |
| `↑` / `↓` | Volume up or down |
