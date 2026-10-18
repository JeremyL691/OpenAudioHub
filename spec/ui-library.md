# UI: recordings library and detail

This file describes the recordings library (`/recordings`), the recording detail
page (`/recordings/{id}`), the mini player, and the keyboard shortcuts. It is
written so a new frontend can be built from it. Every `data-testid` and accessible
name listed here is part of the interface. The HTTP calls are described in
[recordings.md](recordings.md), [transcription.md](transcription.md) and
[ai.md](ai.md). Contract tests for this page are in
`contract-tests/tests/ui-library.spec.ts`.

Layout breakpoints, in CSS pixels:

- Below 1024: one pane at a time (list or detail). See "Phone layout".
- 1024 and up: list and detail side by side on the library. On the detail page
  the player is docked at the bottom.
- 1440 and up: on the detail page the transcript runs beside a right column with
  the summary and details. Below 1440 these are tabs.

Colors, fonts and spacing are out of scope.

---

## 1. Library page `/recordings`

Signed in only. The page is rendered on the server. The list is built from the
account's non-deleted recordings, newest first by recording time. Per-user
preferences (sort, density, page size, playback defaults) are read on first paint.

### 1.01 Regions

| Region | Accessible name / role | testid | Notes |
|---|---|---|---|
| Page heading | `heading` level 1, "Recordings" (visually hidden) | none | Always present. |
| Top bar | (see [ui-app.md](ui-app.md)) | `topbar` | Holds the command trigger, the upload button and the user menu. |
| Command trigger | button "Open command palette" | `command-trigger` | Shown only on `/recordings` (the palette is mounted there). |
| Top-bar search | (not shown on `/recordings`) | `toolbar-search` | Shown on other pages. It is a GET form to `/recordings?q=`. |
| Upload | button "Upload audio" (text "Upload"; "Uploading audio" while busy) | `upload-button` | Disabled while an upload is running. See 1.08. |
| List pane | region of the page | `recording-list` | Holds the day groups and rows. |
| Detail pane | region to the right of the list | none | Shows the selected recording. See 1.09. |

Heading order on desktop: the page heading, then the list heading "All recordings"
(or the collection name), then the preview heading (the title button of the
selected recording).

### 1.02 List header and toolbar

Under the list heading the header shows the count of the filtered list, and a
"Clear" link to `/recordings` when a collection is open.

| Element | Role / name | testid | Behavior |
|---|---|---|---|
| List heading | `heading` level 2: "All recordings", or the collection label (Starred, Last 7 days, From Plaud, Uploaded) | none | |
| Clear collection | link "Clear" | none | Goes to `/recordings`. Shown only with a collection. |
| Search box | textbox "Search recordings", placeholder "Search recordings, transcripts..." | `recording-search` | Filters on each keystroke. Matches the name (any case) or the transcript text. |
| Clear search | button "Clear search" | none | Shown only when the search is not empty. Empties the search. |
| Status chips | group with legend "Filter recordings" | see below | One is pressed at a time (`aria-pressed`). |
| Count line | text | none | "N of M recordings" (N "matching" when a search or chip is active). In select mode it reads "K selected". |
| Select mode | button, label "Select" | `recording-select-mode` | Enters select mode. |
| Sort | button "Sort" (opens a menu) | `recording-sort` | Menu label "Sort by". Radio items: "Newest first", "Oldest first", "Name". |
| Density | button "Density" (opens a menu) | none | Menu label "Density". Radio items: "Comfortable", "Compact". |

Status chips (`data-testid` on each button, text is the label):

| testid | Label | Meaning |
|---|---|---|
| `recording-filter-all` | All | Default. |
| `recording-filter-transcribed` | Transcribed | Has a transcript. |
| `recording-filter-processing` | Processing | Has a job in progress or a transcript job running. |
| `recording-filter-untranscribed` | Untranscribed | No transcript. |

Chips and the search filter the list that is already loaded. They do not call the
server. The filter can also come from the address: `?filter=all|transcribed|processing|untranscribed`
(any other value means `all`).

Sort and density changes are saved at once with `PUT /api/settings/user`
(fields `recordingListSortOrder` and `listDensity`). The save is best effort.

Search rules: the text is trimmed and compared in lower case. A recording matches
when its name contains the text, or when its transcript text contains it. The
search can be seeded with `?q=` (at most 200 characters; longer values are ignored).

Enter in the search box opens the first row of the current filtered list in the
detail pane.

### 1.03 Rows

Each recording is one row. Rows are grouped under day headings in newest or oldest
order, and as one group in name order.

Row element (`data-testid="recording-row"`, attribute `data-id` = recording id):

- A main button. Its accessible name is its text: name, duration, date and source,
  and the status label. Selecting it shows the recording in the detail pane. The
  pressed state (`aria-pressed`) is set only in select mode.
- Name: text with the recording name (`recording-row-name`).
- A "Starred" hidden label when the recording is starred.
- Duration, date/time in the chosen date format, and the source ("Plaud" or
  "Uploaded" text as derived from the device field).
- A status badge (section 7). While a job for this row runs, the badge reads
  "Transcribing" or "Summarizing" instead of the saved state.
- A waveform thumbnail (decorative).
- A menu button, label "Row actions", shown on hover or focus (not in select mode).
  Menu items:

| Item | Action |
|---|---|
| "Open" | Shows the recording in the detail pane. |
| "Rename" | Opens the rename dialog (section 1.06). |
| "Transcribe" | Starts server transcription (`POST /api/recordings/{id}/transcribe`). Disabled while it runs. |
| "Transcribe in browser" | Runs the browser transcription (section 2.5). Disabled while a transcription runs. |
| "Download audio" | Navigates to `GET /api/recordings/{id}/audio?download=1`. |
| "Delete" (destructive) | Opens a confirmation (section 1.07). |

Deleting or renaming from the row menu does not change the detail pane unless it
is the selected recording.

In select mode each row also shows a check box mark, `data-testid="recording-row-checkbox"`
with `data-checked="true|false"`. Clicking a row toggles it. The row menu is hidden.

Pending uploads appear above the day groups as rows (they have no testid of their
own; they show the file name and progress).

Empty results:

| Condition | Text |
|---|---|
| No recordings at all (and no upload running) | Whole list replaced by the empty state (section 1.10). |
| Search has no hits | "No recordings match your search." |
| A status chip has no hits | "No recordings match this filter." |

### 1.04 Day headings

When sorted by date, each group has a heading with the day label and a line that
reads "N recording(s) · total duration" (for example "2 recordings · 1 h 5 min").
Sorted by name there are no headings.

### 1.05 Selecting and bulk actions

Select mode is turned on by `recording-select-mode` and off by `recording-select-cancel`
or by a successful merge. Turning it off clears the selection.

In select mode the toolbar shows, in this order:

| testid | Name | Enabled when | Action |
|---|---|---|---|
| `recording-select-all` | "Select all" | always | Selects every row in the current filtered list. |
| `recording-bulk-download` | "Download" | at least one selected | A link to `GET /api/recordings/download?ids=<id,id,...>` (ZIP of MP3 files). Disabled when none are selected. |
| `recording-bulk-merge` | "Merge" | two or more selected | Opens the merge dialog (section 1.06). |
| `recording-select-cancel` | "Cancel" | always | Leaves select mode. |

The count line reads "K selected". Selections are dropped when their recording is
deleted.

### 1.06 Rename and merge dialogs

**Rename recording** (dialog, title "Rename recording"):

- Text box labeled "Name", prefilled with the current name. Max length is the
  title limit (see [recordings.md](recordings.md)).
- "Cancel" closes without saving. "Save" calls `PATCH /api/recordings/{id}` with
  `{"filename": "<name>"}`.
- An empty name shows the toast "Name cannot be empty" and does not save. A name
  that is the same as before closes the dialog without a call.
- On success the list shows the new name right away and the page data is refreshed.

**Merge recordings** (dialog, title "Merge recordings"):

- Lists the selected recordings. Each item has `data-testid="merge-item"` with
  `data-id`, and the buttons "Move <name> up" (`merge-move-up`) and "Move <name> down"
  (`merge-move-down`). The first item cannot move up and the last cannot move down.
- Order buttons: "Recording time" (`merge-order-time`, the default) and "Import order"
  (`merge-order-import`). Each is a toggle (`aria-pressed`). Moving an item by hand
  clears both toggles.
- Title: text box labeled "Title" (`merge-title`). Default is "<first item name> (merged)".
- Check box labeled "Delete original recordings after merging"
  (`merge-delete-originals`, unchecked by default).
- "Cancel" closes. "Merge" (`merge-confirm`) is disabled with fewer than two items.
- Action: `POST /api/recordings/merge` with `{"ids": [...in list order], "title": "<title>"}`.
  Response `201` with `{"id": "<new id>"}`. If delete-originals is checked, each
  original is then deleted with `DELETE /api/recordings/{id}`. Failed deletes produce
  one toast: "Merged, but N original recording(s) could not be deleted".
- Success: toast "Recordings merged" with an action "Open" (goes to `/recordings/{new id}`).
  The dialog closes, select mode ends, and the page data is refreshed.
- Errors show the server message as a toast.

### 1.07 Delete confirmation

Shown from the row menu. It is a confirmation with title "Delete this recording?",
the recording name in bold, and a description saying that the audio file and any
transcript or summary are removed, and that a Plaud device copy is re-downloaded at
the next sync. Buttons: "Cancel" keeps the recording. "Delete" calls
`DELETE /api/recordings/{id}`.

On success the row disappears at once, the toast "Recording deleted" is shown, and
if it was selected the next recording in the list is selected. On failure the row
comes back and the error is shown.

### 1.08 Upload entry points

- Top bar `upload-button` (text "Upload"). It opens the system file picker for audio
  (`accept="audio/*,.mp3,.mp4,.m4a,.wav,.ogg,.opus,.webm,.aac,.flac"`) so native pickers
  that do not expand wildcard MIME types still accept every supported upload extension. The
  picker is a hidden file input.
- The empty state's "Upload Audio" button does the same.
- Each chosen file is sent with `POST /api/recordings/upload` (multipart field
  `file`). While it runs, a pending row shows. On success the toast reads
  `"<file name>" uploaded` and the list refreshes. On failure the toast shows the
  server error or "Upload failed".

### 1.09 Preview pane (library)

Shown on the right of the list on 1024 and up, and on phones only after a row is
picked. With no selection (no recordings) the empty state replaces the whole page.

Elements:

- "Back to recordings" button (text), shown only below 1024. Returns to the list.
- `open-full-view`: link "Open full view" to `/recordings/{id}`.
- Title: heading level 2 holding a button labeled "Rename <name>" (`title="Rename"`).
  Clicking it turns the title into a text box labeled "Recording name". Enter saves
  (`PATCH /api/recordings/{id}`), Escape restores the old name, Blur saves. Empty
  names and names over the limit show a toast and are not saved.
- Date, duration and source line under the title.
- Star button (`recording-star`, see 1.11).
- Player (section 2.3) and the tabs "Transcript", "Summary", "Details". Their content
  is the same as on the detail page (section 2.4 to 2.6).

The recording title appears twice in the preview: in the preview heading and in the
player card.

### 1.10 Empty state

Shown when the account has no non-deleted recordings and no upload is running
(`empty-state`). Heading "No recordings yet", text "Run a sync to pull your recordings
down from Plaud, then transcribe them here.", and two buttons:

- "Sync Device" (disabled with the label "Syncing…" while a sync runs). Starts a
  Plaud sync (see [plaud.md](plaud.md)).
- "Upload Audio" (see 1.08).

The top-bar upload and the command trigger stay available.

### 1.11 Star

`recording-star` is a toggle button in the preview and detail headers. Its accessible
name is "Star" when not starred and "Unstar" when starred. `aria-pressed` reflects the
state. The icon changes at once. The call is `PUT /api/recordings/{id}/star` with
`{"starred": true|false}`. On failure the icon reverts and the toast "Could not update
the star" is shown. Starring a recording that is already starred keeps the first star
time.

The same action is in the detail actions menu as `recording-star-toggle`, labeled
"Star" or "Unstar".

### 1.12 Collections and deep links

- `?collection=starred|recent|plaud|uploaded` narrows the list. Other values are
  ignored. Recent means the last 7 days. The sidebar collection links are described
  in [ui-app.md](ui-app.md).
- `?id=<id>` selects that recording. Unknown ids select the first recording. On a
  phone this opens the detail view.
- `?q=` seeds the search and `?filter=` seeds the chip.

### 1.13 Pagination

The list first shows one page of rows. The page size is the user's `itemsPerPage`
setting (default 50). When the end marker below the rows comes into view, the next
page is added. If the marker is still in view after the page is added, the next page
is added too, so the list keeps growing until the marker leaves the view or every row
is shown. The count line always shows the full filtered total. Chip, search and
sort changes restart at the first page.

### 1.14 Keyboard on the library

See section 5.

---

## 2. Detail page `/recordings/{id}`

Signed in, and onboarding must be complete. Unknown or deleted ids, or ids that
belong to another account, return a not-found page (status 404).

### 2.1 Header

| Element | Role / name | testid | Behavior |
|---|---|---|---|
| Back | button "Back to recordings" | none | Navigates to `/recordings`. |
| Title | heading level 1 holding a button "Rename <name>" | none | Inline rename, as in 1.09. |
| Meta line | text | none | Date, duration, source. |
| Star | button "Star" / "Unstar" | `recording-star` | As in 1.11. |
| Actions | button "Recording actions" | none | Opens the actions menu (2.2). |

### 2.2 Actions menu

Opened by "Recording actions". Items:

| Item | Enabled | Action |
|---|---|---|
| "Download audio" | always | Navigates to `GET /api/recordings/{id}/audio?download=1`. |
| "Star" / "Unstar" (`recording-star-toggle`) | always | As in 1.11. |
| "Export TXT", "Export SRT", "Export VTT", "Export JSON" | only when there is a transcript (SRT and VTT also need timestamps) | Builds the file in the browser from the transcript on the page and downloads it. |
| "Transcribe" (or "Re-transcribe" when a transcript exists) | not while a transcription or pipeline job runs | `POST /api/recordings/{id}/transcribe`. |
| "Delete recording" (destructive) | always | Opens the delete dialog (2.7). |

The exports use the same content as the transcript toolbar (2.4).

### 2.3 Player

The player card has `data-testid="player"`. It contains:

- Scrubber (`player-scrubber`): a waveform (a slider labeled "Audio waveform scrubber")
  when the user's scrubber setting is waveform and peaks exist, otherwise a slider
  labeled "Seek". Clicking or dragging seeks. Waveform keys: Left/Right move by 1% of
  the length (5% with Shift), Home goes to the start, End to the end.
- Time (`player-time`): "current / duration" in `m:ss` (or `h:mm:ss`) form.
- Transport row:
  - "Skip back 15 seconds" and "Skip forward 15 seconds" (disabled until the audio has a duration). Clamped to the clip.
  - Play / Pause button (`player-play`), label "Play" or "Pause".
  - "Mute" / "Unmute" button (label changes with the volume; restores the previous level).
  - Volume slider labeled "Volume" (0 to 100; hidden below the `sm` breakpoint).
  - Speed button (`player-speed`). Label "Playback speed <value>. Click to change.",
    text shows the value. Clicking cycles 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x, then back.
- Audio: the audio element loads `GET /api/recordings/{id}/audio` (metadata first).
- Starting values come from the user's defaults: playback speed, volume (default 75),
  and auto-play next (when a recording ends, the next row in the list is selected
  if there is one).
- Download menu (the download icon in the header on the library preview; hidden on the
  detail page, where the actions menu does this): "Download MP3" and "Download original"
  (`download-original`, `GET /api/recordings/download?ids={id}&format=original`).
- Waveform status line, under the header: "Analyzing audio…" while decoding,
  "Generate waveform" when auto-decode is skipped (long recordings), and "Retry
  waveform" after an error. Each is a button; the first two call the browser decode and
  upload peaks with `POST /api/recordings/{id}/peaks`.

Keyboard on the player is in section 5.

### 2.4 Transcript card

Heading "Transcript". On the detail page the tab is "Transcript".

Header controls:

- "Follow playback" switch (`aria-label="Follow playback"`, role switch), shown when a
  timed transcript exists. On by default. It turns off when the reader scrolls the
  transcript by hand, and turns back on when the switch is pressed.
- "Transcribe" (no transcript yet),
  or "Re-transcribe" on the library preview. These call `POST /api/recordings/{id}/transcribe`.
  The browser-side option is in section 2.5.
  Disabled while a transcription or pipeline job runs.

Body:

- Source switcher (`source-switcher`): one button per transcript source ("Plaud",
  "Mix", "Your provider"). Shown only when there is more than one transcript.
  Selecting one switches the text. The primary source comes first.
- Toolbar (`transcript-toolbar`): "Download transcript as TXT", "Download transcript as JSON"
  (both download a file built in the browser), and "Delete" (`DELETE /api/recordings/{id}/transcription?source=<source>`
  after a confirmation titled "Delete this transcript?"; the summary is removed with it).
  Delete is disabled while a job runs.
- Timeline (`transcript-timeline`, an ordered list): one item per timed segment,
  `data-testid="transcript-segment"`, with `data-start-ms` (milliseconds) and
  `data-active="true|false"`. Each item has a button with the timestamp `hh:mm:ss` and the
  segment text. Clicking it seeks the player to the segment start. The playing segment
  has `aria-current="time"` and is kept in view when follow playback is on.
- The transcript text cannot be edited in the interface. Only download, delete and seek
  are offered.
- Without timings the transcript is plain text (speaker lines such as `SPEAKER_00:`,
  `Speaker 1:` or `UNKNOWN:` are shown as speaker turns with a coloured label).
- Metadata line under the text (language, provider, model).

When no transcript exists the body shows "No transcription yet. Use the Transcribe
button above." Pipeline states replace this text (section 7).

### 2.5 In-browser transcription

- Row menu item "Transcribe in browser" (section 1.03). Disabled while a transcription runs.
  It runs a browser speech model and uploads the result with
  `POST /api/recordings/{id}/transcription/from-browser`.
- Transcript card button "Transcribe in browser" (shown with no transcript, next to
  "Transcribe"). Its completion refreshes the page.
- Toasts: "Transcribing in browser…" while running, then "Transcribed in browser".
  Failure shows the error message, or "Browser transcription failed".

### 2.6 Summary panel

`summary-panel`, heading "Summary". On the detail page it is a tab (on wide layouts a
column). With no transcript the panel says "A summary is available once the recording
has a transcript." and has no controls.

With a transcript:

- Language select (labeled "Summary language") and template select (default label is
  the template name). Hidden while a summary generates.
- "Summarize" (`summary-generate`, when there is no summary) or "Re-generate" (when there is one).
  Label "Generating…" while it runs; the button is disabled. Calls
  `POST /api/recordings/{id}/summary` with the chosen template and language.
- Result (`summary-content`): the summary as formatted text, then the "Key Points" and
  "Action Items" lists when present.
- Footer: badges for template, language, provider and model; buttons "Copy" (clipboard),
  "Download summary as Markdown" (text "Markdown"), "Download summary as TXT" (text "TXT"),
  and "Delete" (`DELETE /api/recordings/{id}/summary`).
- Empty state: "No summary yet. Click "Summarize" to generate one."

See [ai.md](ai.md) for the calls and errors.

### 2.7 Delete

Opened by "Delete recording" in the actions menu. The dialog has title "Delete this
recording?", a description (the audio, transcription and AI summary are removed from
OpenAudioHub; the Plaud device copy is not affected but will not be re-synced), and
buttons "Cancel" and "Delete recording". While it runs the button reads "Deleting…"
and both buttons are disabled.

Success: `DELETE /api/recordings/{id}`, toast "Recording deleted", navigation to
`/recordings`. Failure: the server message as a toast, and the dialog stays open.

### 2.8 Details card

`RecordingDetailsCard`, heading "Details" (tab on narrow layouts, column on wide).
Shows the recording's fields: name, recorded time, duration, file size, source and
device. Read-only.

### 2.9 Phone layout of the detail page

Below 1024 the header, player and sections stack. The player is not docked. The
sections are tabs.

---

## 3. Mini player

`mini-player` is a compact bar with `aria-label="Now playing"`, shown under the top
bar when the full player has scrolled out of the viewport. It does not appear when
the full player is not laid out (for example in a hidden phone pane).

Contents:

- Play / Pause button (label "Play" or "Pause") driving the same playback as the
  full player.
- The recording name.
- A progress bar labeled "Playback progress".
- Time "m:ss / m:ss".

Clicking it does not navigate. It takes no space in the page layout. On desktop the
player is docked and stays in view, so the mini player does not show there.

---

## 4. Command palette (⌘K)

The palette is a dialog with the visually hidden title "Command palette" (accessible
name of the dialog). Its input has placeholder "Search recordings, transcripts, or
actions…". Groups: "Recent", "Actions" and "Theme". It is available on `/recordings`
only. Choosing a recording selects it in the library. Enter runs the highlighted item.
Ctrl or Cmd with Enter on a recording without a transcript starts transcription for it.
Escape closes.

Palette groups:

- "Recent": the newest recordings by recording time, up to a fixed limit. The selected one shows a "Selected" badge.
- "Actions": "Upload audio", "Sync device", "Open settings" (`,`) and "Keyboard shortcuts" (`?`).
- "Theme": "Light", "Dark" and "System". The active theme shows an "Active" badge.

---

## 5. Keyboard shortcuts

Keys are matched on the key name. "Ctrl/Cmd" means Ctrl or Meta. Shortcuts are not
used while the focus is in a text field (text box or text area), except Ctrl/Cmd+K.

| Key | Where | Action |
|---|---|---|
| Ctrl/Cmd + K | library | Opens the command palette. Works even when a text field has focus. |
| ? | any signed-in page (not while a dialog is open) | Opens the "Keyboard shortcuts" dialog. |
| , | any signed-in page (not while a dialog is open) | Opens `/settings` (does nothing if already there). |
| / | library | Focuses the library search box (`recording-search`). Does not type the slash. |
| j | library | Selects the next row in the current filtered list. At the end it stays on the last row. |
| k | library | Selects the previous row. At the start it stays on the first row. |
| Space | detail page (player) | Plays or pauses. Prevents page scroll. |
| ← | detail page (player) | Seeks back 5 seconds, clamped to 0. |
| → | detail page (player) | Seeks forward 5 seconds, clamped to the duration. |
| ↑ | detail page (player) | Volume up by 5 (max 100). |
| ↓ | detail page (player) | Volume down by 5 (min 0). |
| Enter (in search) | library | Opens the first row of the filtered list. |
| Escape | dialogs | Closes the dialog. |

Notes:

- j and k, and / and ?, are ignored while the command palette, the shortcuts dialog or
  an onboarding dialog is open. The modal owns the keys.
- The waveform scrubber, when focused, handles Left and Right itself (1% steps), so
  the player key handler does not also seek.
- The library list keys (j, k) work only on `/recordings`. The detail page has no j/k.
- The player keys act only while the audio has metadata. Before that they still
  toggle, but seeking waits for the duration.

### 5.1 Shortcuts dialog

Title "Keyboard shortcuts". Description "Power-user shortcuts available across the
dashboard." Three groups, each a list:

| Group | Rows (description: keys) |
|---|---|
| Global | Command palette: ⌘ K. Show this cheatsheet: ?. Open settings: ,. Focus search: /. |
| Recording list | Next recording: j. Previous recording: k. |
| Player | Play / pause: Space. Seek back 5s: ←. Seek forward 5s: →. Volume up: ↑. Volume down: ↓. |

Escape or the close button closes it. Nothing else changes.

---

## 6. Empty and error states (summary)

| Where | Text or behavior |
|---|---|
| Library, no recordings | Empty state (1.10). |
| Library, search with no hits | "No recordings match your search." |
| Library, chip with no hits | "No recordings match this filter." |
| Detail, unknown id | Not-found page, status 404. |
| Rename, empty name | Toast "Name cannot be empty". |
| Rename, too long | Toast "Name must be N characters or fewer". |
| Star failed | Toast "Could not update the star". |
| Delete failed | Toast with the server message, or "Failed to delete recording". |

---

## 7. Pipeline status labels

Long audio goes through a server pipeline. The detail page and the transcript card
show its phase. The phase label comes from the job's `phase` field and is shown as the
text of a `pipeline-status` block (`data-phase` holds the raw phase).

| Phase | Label |
|---|---|
| queued | Waiting to start |
| download | Fetching the original audio |
| decode | Preparing the audio |
| vad | Looking for speech |
| chunking | Splitting speech into segments |
| transcribing | Transcribing the audio |
| completed | Transcription done |
| needs_alignment | Saved without timestamps |
| paused_disk | Paused: waiting for free disk space |
| failed | Transcription failed |
| cancelled | Transcription cancelled |
| any other | Processing transcription |

Other fixed texts:

- Right after pressing Transcribe, before the job starts: "Queueing transcription…".
- Running: a progress bar labeled "Audio preprocessing progress" and a `pipeline-cancel`
  button "Cancel".
- Failed: "Transcription failed", the error text, and `pipeline-retry` "Retry". The block
  has `role="alert"`.
- Paused for disk space: "Waiting for disk space. Processing picks up again on its own once
  room is free." with `pipeline-cancel`.
- Saved without timestamps: the phase label "Saved without timestamps". The
  detail card has no timeline, the SRT and VTT export items stay disabled, and the card
  adds: "This transcript was saved without timestamps. The timeline and the SRT and VTT
  exports are not available for it."

Row status badges show the state of the recording, in this order of precedence:

| State | Badge text |
|---|---|
| A summary job is running | Summarizing |
| A transcription job is running | Transcribing |
| Has a summary | Summary ready |
| Has a transcript | Transcript ready |
| None of these | Not transcribed |

`pipeline-cancel` and `pipeline-retry` call the audio pipeline routes (see
[transcription.md](transcription.md)).

---

## 8. `data-testid` index

| testid | Where | Section |
|---|---|---|
| `recording-search` | library search box | 1.02 |
| `recording-sort` | sort button | 1.02 |
| `recording-filter-all`, `-transcribed`, `-processing`, `-untranscribed` | status chips | 1.02 |
| `recording-select-mode`, `recording-select-all`, `recording-select-cancel` | select mode | 1.05 |
| `recording-bulk-download`, `recording-bulk-merge` | bulk actions | 1.05 |
| `recording-list` | list container | 1.01 |
| `recording-row`, `recording-row-checkbox` | rows | 1.03 |
| `merge-order-time`, `merge-order-import`, `merge-list`, `merge-item`, `merge-move-up`, `merge-move-down`, `merge-title`, `merge-delete-originals`, `merge-confirm` | merge dialog | 1.06 |
| `empty-state` | empty state | 1.10 |
| `upload-button` | top-bar upload | 1.08 |
| `command-trigger`, `topbar`, `toolbar-search` | top bar | 1.01 |
| `open-full-view` | preview link | 1.09 |
| `recording-star`, `recording-star-toggle` | star | 1.11 |
| `player`, `player-scrubber`, `player-time`, `player-play`, `player-speed` | player | 2.3 |
| `download-original` | player download menu | 2.3 |
| `transcript-toolbar`, `transcript-timeline`, `transcript-segment`, `source-switcher` | transcript | 2.4 |
| `summary-panel`, `summary-generate`, `summary-content` | summary | 2.6 |
| `pipeline-status`, `pipeline-cancel`, `pipeline-retry` | pipeline | 7 |
| `mini-player` | mini player | 3 |

---

## 9. Not covered by tests

- Live pipeline phase transitions and their timing (section 7). The contract suite
  does not run a long job.
