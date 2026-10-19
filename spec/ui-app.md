# ui-app: signed-in shell, Dashboard, Settings, onboarding, theme

This file describes the signed-in app outside the library. It covers the shell (sidebar, top bar, account menu), keyboard shortcuts, the Dashboard, the Settings pages, the onboarding dialog, theme, toasts, and the not-found page. It does not cover the library and recording pages (`ui-library.md`), the sign-in and sign-up pages (`auth.md`), or the public docs site (`pages.md`).

Element test ids and accessible names are part of the contract. Names are shown in quotes and are case-sensitive. The contract tests are in `contract-tests/tests/ui-app.spec.ts`.

## 1. Shell

### 1.1 Regions and breakpoints

| Region | Element | Notes |
|---|---|---|
| Sidebar | `nav`, `data-testid="app-sidebar"`, label "Main navigation" | Left navigation. |
| Top bar | `header`, `data-testid="topbar"` | Sticky, at the top of the content column. |
| Content | `main` | The page body, below the top bar. |

Breakpoints (viewport width):

- Below 768px (`md`): the sidebar is hidden. The "Toggle Sidebar" button opens it as a sheet over the page.
- 768px and up: the sidebar is docked on the left.
- 1024px and up (`lg`): the top bar shows the toolbar search (see 1.4). The settings section list is docked (see 4.1).

### 1.2 Collapse

- The "Toggle Sidebar" button is at the left of the top bar. It shows the sidebar as a sheet below 768px, and collapses or expands the docked sidebar at 768px and up.
- Ctrl+B (Windows and Linux) or Cmd+B (macOS) does the same as the button.
- The docked state is stored in a cookie named `sidebar_state` with value `true` (expanded) or `false` (collapsed), path `/`, lifetime 7 days.

### 1.3 Sidebar items

The sidebar is a navigation landmark labelled "Main navigation". From top to bottom:

1. Logo link, accessible name "OpenAudioHub home", to `/dashboard`. It shows the icon and the wordmark.
2. `nav-overview`, "Dashboard", to `/dashboard`.
3. `nav-recordings`, "Library", to `/recordings`, with the number of recordings.
4. Group label "Collections".
5. `nav-collection-starred`, "Starred", to `/recordings?collection=starred`, with a count.
6. `nav-collection-recent`, "Last 7 days", to `/recordings?collection=recent`, with a count.
7. `nav-collection-plaud`, "From Plaud", to `/recordings?collection=plaud`, with a count.
8. `nav-collection-uploaded`, "Uploaded", to `/recordings?collection=uploaded`, with a count.
9. At the bottom: `nav-settings`, "Settings", to `/settings`, and `nav-docs`, "Docs", to `/docs`.

Active state: the current item has `aria-current="page"`, and no other item does.

- "Dashboard" is active on `/dashboard`.
- "Library" is active on `/recordings` only when no collection is selected. Recording pages (`/recordings/<id>`) make no item active.
- A collection item is active on `/recordings` when its collection is selected.
- "Settings" is active on any `/settings` path. "Docs" is active on any `/docs` path.

Footer, below the items:

- A copyright line ("© 2026 OpenAudioHub contributors") and a licence line ("Licensed under AGPL-3.0").
- The version link: the server's version from `GET /api/health`, shown as `v<version>`. Accessible name "Release notes for OpenAudioHub v<version>". It opens the release page in a new tab. It is shown only when the version is known.
- A "Report a bug" link to the project's issue tracker, opening in a new tab.
- A GitHub icon link, accessible name "View source code on GitHub", opening in a new tab.

### 1.4 Top bar

Left to right:

1. "Toggle Sidebar" button (see 1.2).
2. The page title, when the path has one:
   - `/recordings` and `/recordings/<id>`: "Library".
   - `/dashboard`: "Dashboard".
   - `/settings` and `/settings/<section>`: "Settings".
   - Other paths: no title.

Right side, in order:

- `command-trigger`: a button with accessible name "Open command palette", tooltip "Search recordings, transcripts, and actions". It is shown only on `/recordings` and only at `md` and up. At `lg` and up it also shows the text "Search" and a "⌘K" hint. It opens the command palette (see `ui-library.md`).
- `toolbar-search`: a search form with role "search" that submits with GET to `/recordings` with the query parameter `q`. The field has accessible name "Search recordings" and placeholder "Search". It is shown on every signed-in page except `/recordings`, and only at `lg` and up.
- `upload-button`: a button with accessible name "Upload audio". Its text is "Upload" at `sm` and up, and hidden below `sm`. It opens the file picker for audio files. Tooltip: "Upload an audio file from your computer". It is disabled while an upload runs, or while any recording is being processed. While uploading, its accessible name is "Uploading audio" and its text is "Uploading…".
- `user-menu`: the account menu trigger (see 2).

### 1.5 Responsive layout

- Below `md`: the sidebar is hidden behind "Toggle Sidebar", and the command trigger is hidden.
- Below `lg`: the toolbar search is hidden, and the settings section list is replaced by the section picker.
- Below `sm`: the upload button shows only its icon.
- Touch targets are 40px tall below `sm` and 32px at `sm` and up.

## 2. Account menu (`user-menu`)

### 2.1 Trigger

- A round button with the first letter of the account email in capitals, or "?" when there is no email.
- Attribute `data-sync-state` holds one of `ok`, `failed`, `syncing`, `idle`. A coloured ring around the button shows the same state.
- Accessible name "Account menu" followed by a suffix: ", synced" (`ok`), ", sync failed" (`failed`), ", syncing" (`syncing`), or ", not synced yet" (`idle`).
- Tooltip, in this order of precedence: "Plaud needs reconnecting"; "Syncing…"; "Sync failed: <reason>"; "Last synced <relative time>" after a successful sync; "Not synced yet".

### 2.2 Menu content

Header row: a circle with the email initial, a title and a subtitle.

- Web: the title is the account email, or "Signed in" when there is none. The subtitle is "Signed in".
- Desktop app: the title is "OpenAudioHub" and the subtitle is "Local account".

Items, in order:

1. "Sync now". Starts a manual sync (see `plaud.md`). Disabled while a sync runs.
2. "Reconnect Plaud". Shown only when the Plaud sign-in has expired. It opens `/settings/plaud-account`.
3. "Settings", with the key hint ",". It opens `/settings`.
4. "Keyboard shortcuts", with the key hint "?". It opens the keyboard shortcuts dialog.

Theme group:

- A label "Theme".
- Three radio items, in this order: "Light", "Dark", "Auto" ("Auto" follows the system). The checked item is the current choice.
- Choosing a theme keeps the menu open (see section 6).

Footer (web only, not in the desktop app):

- "Log out" (destructive style). It ends the session and loads `/login` (see `auth.md`).

Keyboard: Enter or Space opens the menu from the trigger. Escape closes it and returns focus to the trigger.

## 3. Dashboard (`/dashboard`)

The Dashboard is the signed-in home page. It is the page after sign-in and sign-up (see `auth.md`).

Redirect: `/dashboard?settings=<section>` goes to `/settings/<section>` when `<section>` is one of the settings sections. Any other value shows the Dashboard.

### 3.1 Header

- A level 1 heading "Dashboard".
- Today's date, written in the viewer's locale as weekday, month and day.
- A region named "Plaud sync" with the status text:
  - "Plaud not connected" when no Plaud account is connected;
  - "Plaud sign-in expired" when the stored Plaud sign-in was rejected;
  - "Not synced yet" when connected and no sync has run in this session;
  - "Last synced <relative time>" otherwise;
  - "Checking Plaud…" while the connection state is loading.
- When connected and not expired: a button `overview-sync-now`, "Sync now", or "Syncing…" while a sync runs.
- When Plaud needs reconnecting: a strip with the text "Reconnect Plaud to keep recordings syncing." and a link "Reconnect" to `/settings/plaud-account`.

### 3.2 Empty library

When the account has no recordings, the page shows, after the header:

- An empty state with the title "No recordings yet" and the text "Sync from your Plaud account, or upload an audio file to start your library.".
- Buttons: `overview-upload`, "Upload audio" (opens the file picker), and `overview-sync`, "Sync now" (or "Syncing…" while busy).
- A link "Add an AI provider" to `/settings/providers`, shown only when the account has no AI provider.
- The Set up section (3.6).

### 3.3 Library present

When the account has recordings, the page shows, in order:

1. "At a glance" (3.4).
2. "Latest recording" (3.5).
3. "Recent recordings" (3.6).
4. The Set up section (3.7), when it applies.

### 3.4 At a glance

A region named "At a glance" with three tiles. Each tile is a link, shows its label, a large number and a hint:

| Tile label | Value | Hint | Link |
|---|---|---|---|
| "Last 7 days" | recordings that started in the last 7 days | "Nothing recorded", or the recorded time such as "2 h 5 min recorded" | `/recordings?collection=recent` |
| "Not transcribed" | recordings without a transcript | "Review" when above 0, otherwise "All transcribed" | `/recordings?filter=untranscribed` |
| "Processing" | recordings with a running pipeline step | the first processing recording's title and step ("Transcribing", "Processing audio", "Writing summary"), or "Nothing running" | `/recordings?filter=processing` |

"Last 7 days" counts the 7 × 24 hours before now.

### 3.5 Latest recording

- A section labelled by the heading "Latest recording".
- Shows the newest recording's title, its start date, its source ("Plaud" or "Upload") and its duration, and a waveform when peaks exist.
- A round icon link with accessible name "Open <title>" to `/recordings/<id>`.

### 3.6 Recent recordings

- A section labelled "Recent recordings", with a heading "Recent" and a link "Show all" to `/recordings`.
- Up to 8 of the newest recordings. Each row links to `/recordings?id=<id>`, not to the detail page.
- Each row shows a small waveform, the title, the source and start time, a status badge (hidden below `sm`) and the duration.

### 3.7 Set up

- A section labelled "Set up" with two rows, in this order: "Connect Plaud" (to `/settings/plaud-account`) and "Add an AI provider" (to `/settings/providers`).
- A row that is not done is a link. A done row shows a check, the text "Done" for screen readers, and no link.
- The whole section is hidden once Plaud is connected and at least one AI provider exists.

### 3.8 Data

- All figures, the processing state and the recent list come from the signed-in account's recordings only.
- Titles are shown decrypted, for the viewer only.

## 4. Settings

### 4.1 Structure

- `/settings` has no content of its own. It goes to one section, in this order:
  1. the section named in the URL hash (for example `/settings#sync`), when the hash names a section this build can show;
  2. else the section the viewer opened last, stored in the browser under the key `settings-last-section`, when it is still valid;
  3. else `providers`.
- `/settings/<section>` shows one section. An unknown section, or a desktop-only section in a browser, shows the not-found page (see 8).
- Every visit to a section stores it as the last section.

Layout:

- Left column, at `lg` and up, labelled "Settings sections" (a navigation landmark). It holds a search field `settings-search` (accessible name "Search settings") and the sections in groups.
- Below `lg`: a section picker, labelled "Select settings section", at the top of the page. It lists the same sections, grouped.
- The main area holds the section's title and controls, in an element with `data-testid="settings-section-<id>"`.

Each nav item is a link with accessible name "<name> settings", for example "Sync settings", to `/settings/<id>`. The current item has `aria-current="page"`.

Search filters the items by name and by a keyword list, case-insensitively. Groups with no match are hidden. With no match the text "No results" shows.

Navigation groups, in order:

| Group | Sections (name, id) |
|---|---|
| AI | Providers (`providers`), Transcription (`transcription`), Summary (`summary`), Recording names (`naming`) |
| Plaud & Sync | Plaud Account (`plaud-account`), Sync (`sync`) |
| Playback & Display | Playback (`playback`), Display (`display`) |
| Data | Storage (`storage`), Export/Backup (`export`) |
| Desktop (desktop app only) | Desktop (`desktop`) |

The section `notifications` is not in the navigation. Its page is still reachable by URL and by the hash.

Each section page has a visually hidden level 1 heading "Settings", and its own level 1 heading, with a one-line description:

| Section id | Heading | Description |
|---|---|---|
| `providers` | AI Providers | Connect transcription and summary providers. Anything OpenAI-compatible works. |
| `transcription` | Transcription | Provider choice and default options for turning audio into text. |
| `summary` | Summary | Which provider writes summaries, and the prompt presets it uses. |
| `naming` | Recording names | Choose how new recordings are named, and fix date titles written before the date mode used plain dates. |
| `plaud-account` | Plaud Account | The Plaud cloud account OpenAudioHub pulls recordings from. |
| `sync` | Sync | When and how OpenAudioHub pulls new recordings from your Plaud device. |
| `playback` | Playback | Start-up settings the player applies to every recording. |
| `display` | Display | Date and time format, list order, theme, and other interface choices. |
| `storage` | Storage | Where OpenAudioHub keeps the audio files behind your recordings. |
| `export` | Export & Backup | Take your data with you: recordings, transcripts, and summaries. |
| `notifications` | Notifications | Choose how and when OpenAudioHub lets you know about new recordings and sync events. |
| `desktop` | Desktop | Options that only the desktop app has. |

### 4.2 Save behaviour

- Most controls save at once through `PUT /api/settings/user` with a JSON body holding only the changed field (see `settings.md`). The control shows the new value at once.
- Text and number inputs save after a short pause, or on blur.
- When a save fails, the control returns to its previous value and a toast "Failed to save settings. Changes reverted." appears.
- A control is disabled while a save for it runs.
- A section loads its values when it opens. While loading, a spinner stands in for the controls.

### 4.3 Providers (`providers`)

- Button "Add Provider" opens the dialog "Add AI Provider". Each saved provider is a row with the buttons "Edit provider" (dialog "Edit AI Provider") and "Delete provider". The row also has a "Test connection" button. Its result reads "Connected · <n> ms" on success, or the failure text.
- The dialog holds: "Provider" (a select), "API Key", "Base URL (Optional)", and "Default Model". A "Test connection" button runs `POST /api/settings/ai/providers/test`. Saving calls `POST` or `PUT /api/settings/ai/providers[/<id>]`. The model picker uses `POST /api/settings/ai/providers/models`. See `ai.md`.
- Adding a provider needs a provider and an API key. Otherwise the toast "Provider and API key are required" appears.
- Deleting asks for confirmation in a dialog titled "Delete this provider?". Toast "Provider deleted successfully".
- The transcription default is set with `PUT /api/settings/ai/providers/default-transcription`.

### 4.4 Transcription (`transcription`)

- "Auto-transcribe new recordings". Saves `autoTranscribe`.
- "Import Plaud transcripts and summaries". Saves `importPlaudContent`.
- "When Plaud has a transcript" (`transcript-mode`): "Use Plaud only" or "Keep both, and also run my provider". Saves `transcriptMode`.
- "Primary transcript" (`preferred-transcript-source`): "Plaud" or "My provider". Saves `preferredTranscriptSource`.
- "Default transcription language" (`transcription-language`): "Auto-detect", then the supported languages. Saves `defaultTranscriptionLanguage`.
- "Speaker labels" (switch). Saves `speakerDiarization`.
- "Expected speakers" (`diarization-speaker-count`): "Auto", or 1 to 32. Saves the count.
- "Transcription quality" (`transcription-quality`). Saves `transcriptionQuality`.

### 4.5 Summary (`summary`)

- "Default summary prompt" (`summary-preset`): the built-in prompts and the account's custom prompts. Saves `summaryPrompt.selectedPrompt`.
- "AI output language" (`ai-output-language`). Saves `aiOutputLanguage`.
- "Auto-generate summary after transcription" (switch). Saves `autoSummarize`.
- "Preset for auto-summary" (`auto-summarize-preset`). The first option is the default prompt. Saves `autoSummarizePreset`.
- Custom prompts: an "Add" control opens a form with "Name" (`custom-summary-prompt-name`, placeholder "My Custom Prompt") and "Prompt" (`custom-summary-prompt-text`). Saving is disabled until both are filled. Empty values show "Name and prompt are required". Saving shows "Prompt saved". A failed save shows "Failed to save prompt. Changes reverted.". Each custom prompt has edit and delete actions. Delete shows "Prompt deleted".

### 4.6 Recording names (`naming`)

- A radio group labelled "Recording name" with three options: the original file name ("Keep the name from Plaud or the uploaded file."), the recording date ("Name by recording date, e.g. 2026-10-12."), and an AI-generated title. Saves `recordingTitleMode`. A failed save restores the previous option.
- "Sync titles to Plaud" (switch). Saves `syncTitleToPlaud`.
- The default for a new account is the AI-generated title.
- "Existing date titles": a "Check titles" button reads `GET /api/recordings/title-repair` and lists each candidate with its current name and the date it would become, as unchecked checkboxes (`title-repair-list`, `title-repair-item`). "Update selected" posts the picked ids and their expected names to `POST /api/recordings/title-repair`, then reloads the list. A title that changed since the check is skipped. With no candidates the section reads "No titles need fixing."

### 4.7 Plaud Account (`plaud-account`)

- Shows the connected account's email with a status badge ("Connected" or "Sign-in expired"), or a connect area when not connected. The state comes from `GET /api/plaud/connection`.
- When the sign-in has expired: the text "Reconnect Plaud to keep recordings syncing." and a "Reconnect" button, which opens the Plaud sign-in.
- Other actions: "Switch account" (confirmation "Switch Plaud account?") and "Disconnect". Both call `DELETE /api/plaud/connection`. Disconnecting shows "Plaud account disconnected".
- Connecting uses three tabs: "Sign in with Plaud", "Email code" ("Plaud email", "Verification code") and "Paste token" ("Account token"). Connecting shows "Plaud account connected". The "Sign in with Plaud" tab uses the browser extension, described in [browser-extension.md](browser-extension.md). See `plaud.md`.

### 4.8 Sync (`sync`)

- "Enable auto-sync" (switch). Saves `autoSyncEnabled`.
- "Sync interval" (`sync-interval`): "1 minute" to "30 minutes", in steps of 1, 2, 5, 10, 15 and 30 minutes. Saves `syncInterval` in milliseconds.
- "Sync on app load" (switch). Saves `syncOnMount`.
- "Sync on tab visibility" (switch, with the description "Sync when you return to the app tab."). Saves `syncOnVisibilityChange`.
- "Show sync notifications" (switch). Saves `syncNotifications`.

### 4.9 Playback (`playback`)

- "Default playback speed" (`playback-speed`): 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x. Saves `defaultPlaybackSpeed`.
- "Default volume" (slider, 0 to 100, shown as "<n>%"). Saves `defaultVolume` after the pointer or keys stop for a moment.
- "Auto-play next recording" (switch). Saves `autoPlayNext`.
- "Player scrubber" (`player-scrubber`): "waveform" or "slider". Saves `playerScrubber`.

### 4.10 Display (`display`)

- "Date/time format" (`date-time-format`): "Relative", "Absolute", "ISO". Saves `dateTimeFormat`.
- "Recording list sort order" (`sort-order`): "Newest first", "Oldest first", "By name". Saves `recordingListSortOrder`.
- "Items per page" (`items-per-page`): a whole number from 10 to 100. Values outside the range are ignored and nothing is saved. Saves `itemsPerPage`.
- "Theme" (`theme`): "Light", "Dark", "System". Applies at once and is saved (section 6).

### 4.11 Storage (`storage`)

- "Auto-delete old recordings" (switch). Saves `autoDeleteRecordings`. Turning it on also saves `retentionDays` with its current value; turning it off saves `retentionDays: null`.
- "Retention period" (`retention-days`): whole days from 1 to 365. Empty text saves `retentionDays: null`. Other invalid values are ignored.
- Storage usage comes from `GET /api/settings/storage` (see `settings.md`).

### 4.12 Export & Backup (`export`)

- "Default export format" (`export-format`). Saves `defaultExportFormat`.
- "Export text": downloads an export in the default format. The button shows "Exporting…" while it runs. Toasts "Export completed" or "Could not export your recordings".
- "Create full backup" (`backup-start`): calls `POST /api/backup`, shows "Building archive…" while it runs, and then offers "Backup ready to download". A failure shows "Failed to start backup". The download comes from `GET /api/backup/<id>/download`. See `export-backup.md`.
- "Re-run Onboarding" opens the onboarding dialog (section 5).
- The auto-export and backup-frequency controls, and the folder pickers ("Export folder", "Backup folder"), are shown with the text "Coming soon" and are disabled in the browser. The desktop app supports them.

### 4.13 Desktop (`desktop`, desktop app only)

- "Show in the menu bar" (switch), "When the window is closed" (choice: "Keep running in the background" or "Quit the app"), and "Launch at login" (switch). These call the desktop app, not `PUT /api/settings/user`.
- The section is not listed or reachable in a browser. In the browser `/settings/desktop` shows the not-found page.

### 4.14 Notifications (`notifications`, hidden)

- Not in the navigation, reachable only by URL or hash. It holds the notification controls described in `settings.md`.

## 5. Onboarding

- A dialog opens on any signed-in page while the account's `onboardingCompleted` setting is `false`.
- While onboarding is required, Escape and clicks outside do nothing, and there is no close button.
- Re-running from "Re-run Onboarding" opens it at the first step. Once the account has completed onboarding, it can be dismissed with Escape or by clicking outside.
- A progress bar labelled "Onboarding progress" shows the value "Step <n> of 4".
- Steps, in order: "Welcome", "Plaud", "AI provider", "Finish". Each step shows its status: whether Plaud is connected and whether an AI provider exists.
- Buttons:
  - "Back" on steps 2 to 4.
  - "Skip" on the Plaud and AI provider steps. It moves on without connecting.
  - "Next" on steps 1 to 3.
  - "Get Started" on the last step. It saves `onboardingCompleted: true`, closes the dialog and reloads the account's data. A failure shows "Failed to complete onboarding".
- Closing the dialog with Escape after a re-run does not change the flag.

## 6. Theme

- Choices: Light, Dark, and System. The account menu calls System "Auto", and the Display settings call it "System".
- Default: System, which follows the operating system's light or dark setting.
- The choice is stored in this browser under the key `theme`. A small script applies the stored choice before the first paint.
- A browser with no stored choice takes the account's saved theme once the account's settings load. That application happens after the first paint.
- Applying a choice changes the page at once: the root element gets the class `dark` for Dark, and for System when the system is dark. It does not reload the page and does not close the account menu.
- The choice is also saved to the account with `PUT /api/settings/user` and body `{ "theme": "light" | "dark" | "system" }`. The save is best effort. A failed save is silent, and the page keeps the choice.

## 7. Toasts and progress

- Toasts appear at the bottom right of the viewport, with a close control. They are announced by screen readers.
- Success toasts use short texts such as "Prompt saved" or "Provider deleted successfully". Error toasts use the messages named in this file.
- A save failure always shows the toast text named for that control, or "Failed to save settings. Changes reverted." for settings.
- A running sync shows "Syncing…" in the account menu tooltip and on the Dashboard button. Completion messages are described in `plaud.md`.

## 8. Not-found page

- An unknown settings section, or a desktop-only section in a browser, shows this page inside the app.
- Unknown page paths are answered by the server with its own not-found page, status `404` (see `pages.md`).
- The page shows the text "404", a level 1 heading "Page not found", the text "The link may be out of date, or the page may have moved.", and one button. For a signed-in viewer the button is "Go to recordings" (`/recordings`). For anyone else it is "Back to home" (`/`).
- The web build has no page of its own for render errors. An unhandled render error is shown by the router's default error display.

## 9. Desktop app differences

These apply only to the desktop app (see `desktop.md`). The browser build shows none of them.

- The account menu title is "OpenAudioHub" and the subtitle is "Local account". There is no "Log out", because the desktop app has one local account and no sign-out.
- The Desktop settings section is listed and reachable (see 4.13).
- The sign-in page is not shown. The window signs in to the local account on start (see `auth.md`).

## 10. Accessibility

- The Dashboard has one level 1 heading, "Dashboard". A settings page has its section heading as level 1, with a visually hidden level 1 "Settings" above it.
- The sidebar, the top bar and the content are landmarks: navigation, banner and main. The settings section list is a navigation landmark labelled "Settings sections".
- Every icon-only button has an accessible name (see the tables above).
- Status changes, such as sync state and save results, are announced by the toast region or by the account button's name. They are not shown by colour alone.
- Every interactive element shows a visible focus ring. Dialogs and menus keep focus while open, and return focus to their trigger when closed.
- While a menu or dialog is open, the page behind it is hidden from assistive technology.
- Touch targets are at least 40px tall below `sm`.
- The contract tests run an axe scan on the Dashboard and the settings pages.

## 11. Responsive behaviour

- The Dashboard and the settings pages must not scroll horizontally at 320px, 375px, 768px, 1024px, 1280px, or 1440px.
- Dashboard tiles stack in one column below `sm`, and show three across at `sm` and up.
- The layout rules for the shell are in 1.5.
