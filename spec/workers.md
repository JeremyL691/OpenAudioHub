# Background workers

This file describes everything OpenAudioHub does without a request from a user: timers, queues, automatic transcription and summaries, outgoing webhooks, export and backup jobs, notifications, and what happens when the process stops.

Endpoints that start or read this work live in other files:

- Plaud connection, manual sync, and the auto-sync settings: `plaud.md`
- Transcription requests, providers, and the audio pipeline status: `transcription.md`
- Summaries, titles, and presets: `ai.md`
- Webhook endpoints, payloads, signatures, and delivery records: `webhooks.md`
- Export archive, backup jobs, and scheduled backup settings: `export-backup.md`
- Audio pipeline worker: `audio-pipeline.md`
- Password reset and account sessions: `auth.md`
- Test email and notification settings: `settings.md`
- Environment variables and container layout: `deployment.md`

Terms used below:

- **Pass**: one run of a timer-driven worker.
- **Claim**: a worker marks a job or row as its own, so no other pass takes it.
- **Lease**: the time a claimed job stays with its worker. The worker renews it while it works. If the lease runs out, another worker may claim the job.
- **In process**: state kept in memory by one server process. It is lost when the process stops.

---

## 1. Overview

| Worker | Trigger | Interval | Concurrency | Retry policy | Failure result |
|--------|---------|----------|-------------|--------------|----------------|
| Webhook delivery | Starts at boot with one immediate pass. Also runs when a delivery is queued. | Every 30 seconds | One pass at a time. Up to 50 deliveries per pass, at most 10 for one user. Deliveries in a pass are sent one after another. | Up to 6 attempts in total. Waits 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours after failures 1 to 5. | Status becomes `dead` after the 6th failure, or at once for a permanent failure. The endpoint's last delivery status becomes `failed`. |
| Background Plaud sync | Starts at boot. First pass 30 seconds after boot. | `BACKGROUND_SYNC_INTERVAL_MS`, default 300000 (5 minutes) | One pass at a time. Up to 20 users per pass, one after another. A user's run is abandoned after 10 minutes. | No retry inside a pass. The next pass tries again. | Error is logged for that user. Other users still run. A rejected Plaud token marks the connection (see section 3). |
| Auto-transcription | A job is queued when an upload or a Plaud sync adds a recording, and the user has auto-transcribe on. | When a job is queued. Idle workers check again every 5 seconds for delayed retries. | Two jobs at a time, across users. | Retryable provider errors are retried, up to 3 attempts in total, with backoff (section 4). | The job is marked failed. The recording keeps no transcript. A `transcription.failed` event is sent. |
| Auto-summary | Right after a transcript is saved, when the user has auto-summarize on. | None (event-driven) | Runs inside the save step for that recording. | None. Hourly cap per user (section 5). | An event `summary.failed` is emitted. The transcript is kept. |
| Manual summary job | A request for a summary (`ai.md`). | When a job is queued | Two jobs at a time. | None. A failed job is not retried. | The job fails and its error is returned to the request. |
| Export job worker | Starts at boot. Claims a job when one is queued. | When a job is queued. Idle workers check again every 5 seconds. | One job at a time. | A failed build is retried, up to 3 attempts in total, with backoff (section 8). | Job is marked failed. The partial archive is deleted. An incomplete archive fails the job at once. |
| Export maintenance | Every 30 seconds. | Every 30 seconds | All expired archives in each pass. | Retried on the next pass. | Archive file and job row stay until the file delete succeeds. |
| Scheduled backup | Every 30 seconds. Desktop app only. | Daily = 24 hours. Weekly = 7 days. Monthly = 30 days. | Skipped while the user has an active export job. | A failed copy is not retried until the interval has passed since the scheduled job was created. | The export job is still complete. No backup file is written. The failure is logged. |
| Auto export | Every 30 seconds. Desktop app only. | Every 30 seconds | Per user, in turn. | A failed export is retried on the next pass. | The failure is logged. The recording is exported on a later pass. |
| Audio pipeline worker | Starts at boot. | See `audio-pipeline.md`. | See `audio-pipeline.md`. | See `audio-pipeline.md`. | See `audio-pipeline.md`. |

Notifications (email, Bark, browser) are not timers. They are sent inline when their trigger happens. See sections 10 to 12.

---

## 2. Startup and process guards

### Startup

At startup the server starts these background workers: the webhook delivery worker, the background Plaud sync worker, the export job worker, the auto-transcription and summary job workers, the audio pipeline worker, and the maintenance loop that runs export cleanup and, on the desktop app, scheduled backups and auto export.

Background Plaud sync can be turned off with `BACKGROUND_SYNC_ENABLED`. The audio pipeline has its own switch (`AUDIO_PIPELINE_ENABLED`).

### Process guards

- **Unhandled exception.** The process has no handler that logs and exits on an uncaught error. A panic inside a job handler is caught and the job is treated as a retryable failure. A panic in another background task ends only that task.
- **Shutdown signals.** On `SIGINT` (Ctrl-C) or `SIGTERM` the server stops accepting connections and lets in-flight requests finish. Background workers are not waited for. Work in progress is recovered at the next start (section 13).

---

## 3. Background Plaud sync

This worker runs the same sync as the manual sync in `plaud.md`, for users who have no browser open.

### When a pass runs

- The first pass runs 30 seconds after boot.
- Then a pass runs every `BACKGROUND_SYNC_INTERVAL_MS`. Allowed range: 60000 to 3600000 (1 to 60 minutes). Default: 300000.
- The next pass starts only after the current one has ended, so passes never overlap in one process.
- Setting `BACKGROUND_SYNC_ENABLED` to `false` turns the worker off. Any other value leaves it on. Default: `true`.

### Which users a pass picks

A pass picks up to 20 users. A user qualifies when all of these are true:

- The user has a Plaud connection.
- The user is not suspended.
- The connection is not marked as needing reconnect (section 3, failures).
- The user has never synced, or the last sync is older than 4 minutes.

Users are ordered by last sync time, oldest first, with never-synced users first. The 4-minute rule stops the background worker from repeating a sync that a browser tab just finished.

### What a sync does for one user

1. Loads the user's Plaud connection and settings. If there is no connection, the sync stops with "No Plaud connection found" (not a failure). A suspended user is not picked (see above).
2. Asks Plaud for recordings, newest edit first, 50 per page. Paging stops when a page is short, or after 2 pages in a row with nothing new, nothing updated, and nothing imported.
3. Processes each page in groups of 5 recordings in parallel.
4. For each recording:
   - **Not in the database:** downloads the audio, detects its format, stores it, and creates the recording. The title is the Plaud file name, or the date-based title if the user's title mode is `date`. Emits `recording.synced`.
   - **In the database with the same Plaud version:** skipped. If Plaud transcript import is on and the recording is missing a Plaud transcript or summary, the import fills the gap.
   - **In the database with a new Plaud version:** downloads the audio again and updates the recording. Emits `recording.updated`.
   - **Deleted by the user:** never restored. Skipped.
   - **Any error on one recording:** recorded as `Failed to sync <file name>: <error>`. The other recordings continue.
5. Sends notifications for new recordings (sections 10 and 11).
6. If the user has auto-transcribe on, queues a transcription job for each new recording (section 4).
7. Saves the sync time on the connection, clears the "needs reconnect" mark, and updates the workspace ID if Plaud reports a new one. This step runs only when the recording list was read without a failure.

Automatic export is not part of a pass. The export schedule picks up new recordings (`export-backup.md`).

### Failures

- **Plaud rejects the token (HTTP 401).** The connection is marked as needing reconnect, with a time stamp. The result carries the message `Plaud rejected the stored token. Reconnect your Plaud account.` The sync stops for that user. The saved sync time is not changed. Notifications for recordings already added in the pass are still sent. Auto-transcription does not run. The dashboard shows a reconnect banner (`plaud.md`).
- **Any other error for the whole sync.** The result gets `Sync failed: <message>`. The saved sync time is not changed, so the user is due again at the next pass.
- **A run longer than 10 minutes.** The run for that user is abandoned, the error is logged, and the next user is synced.
- **A pass that throws.** Logged. The pass ends. The next pass runs on schedule.
- **Needs-reconnect users.** The background pass does not pick a user whose connection is marked as needing reconnect. The user is picked again once a reconnect clears the mark. A manual sync for such a user still runs (`plaud.md`).

### Concurrency with manual sync

A manual sync (`plaud.md`) and a background sync for the same user do not run at the same time in one process. The second caller waits for the first and gets the same result, with a flag that says it joined a sync already in progress.

---

## 4. Auto-transcription of new recordings

When an upload or a Plaud sync adds a recording and the user has auto-transcribe on, one transcription job is queued for that recording. Manual transcription from the recording page is separate (`transcription.md`).

### What a job does

- A job first checks that the recording still exists and is not deleted, and that it has no transcript of any source. If any of these is not true, the job is done without a provider call.
- Otherwise it runs the same transcription as a manual run without a provider or model override (`transcription.md`).
- Jobs are stored in the database. A job that was queued or running when the process stopped is picked up again after its lease runs out.

### Retries

- A provider error marked as retryable is retried. The job goes back to the queue after a delay: 30 seconds after the first failed attempt, then twice as long each time, capped at one hour, with up to 20% random extra time.
- A job gets 3 attempts in total. After the last attempt, or after an error that is not retryable, the job is marked failed. The recording then has no transcript, and nothing queues it again. A manual run still works.
- Two transcription jobs run at the same time in one process, across users.

---

## 5. Auto-summary after transcription

### When it runs

It runs right after a transcript is saved, from any path that saves one: a manual run, an automatic run, a browser transcript, and a finished audio pipeline job. The save step waits for the summary step before it returns. Automatic summary runs inside that step, not as a queued job.

### Rules

- Does nothing unless the user's auto-summarize setting is on. The setting is read from the database when the caller does not pass it.
- Summary preset: the user's auto-summarize preset if set, otherwise the default preset.
- **Hourly cap per user.** A fixed one-hour window, limited by `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` (default 60, must be a positive integer). Once the cap is reached, the summary is skipped. It is not queued and not retried later.
  - Event `summary.failed` with error text `Automatic summary limit reached`.
  - The count is kept in process memory. Each server process counts on its own, and the count starts again after a restart.
- The manual "generate summary" button is not capped (`ai.md`).
- On success: the summary is saved, and event `summary.completed` is emitted.
- On failure: the error is logged, and event `summary.failed` is emitted with the error text. The transcript is not rolled back.
- The automatic summary does not check for a manual summary job already running for the same recording, so both can run at the same time.

### Auto-title

When automatic title is on, a title is generated after each saved transcript, before the summary step. The steps are described in `transcription.md` ("After a transcript is saved"). If the title cannot be generated, the recording keeps its name.

Webhook payloads for `summary.completed` and `summary.failed` are in `webhooks.md`.

---

## 6. Manual summary jobs

- A manual summary is a job of kind `summary`, stored in the database. Its states are queued, running, done and failed.
- A request for a recording that already has a summary job queued or running joins that job. It waits for the job and gets the same result.
- The job state is stored in the database, so it survives a restart. A job whose worker stopped is claimed again after its lease runs out.
- A failed summary job is not retried. Its error is returned to the request.
- `GET` on a summary reports whether a run is in progress (`ai.md`).

---

## 7. Webhook delivery worker

### Timing

- Starts at boot and runs one pass at once.
- Then runs every 30 seconds.
- Also runs right away when a delivery is queued.
- A pass that is still running blocks the next one.

### One pass

1. Claims up to 50 deliveries that are due, at most 10 for one user. A claim lasts 15 minutes. A delivery whose claim has run out may be claimed again.
2. For each claimed delivery, reloads it and its endpoint. If either is no longer current, the claim is released and no attempt is counted. If the endpoint is disabled, the delivery goes back to `pending` with no request sent.
3. Looks up the recording and builds the payload from its current state at send time.
4. Sends the request (below).
5. Records the result.

Within a pass, deliveries are sent one after another. A redelivery request, by contrast, sends its delivery at once (`webhooks.md`).

### Request

- Method `POST` to the endpoint URL.
- Headers and body signature are built as described in `webhooks.md`. The signature timestamp is in whole seconds.
- Body is JSON with these top-level fields: the event name, the delivery time, the recording detail, and an `error` field when the event carries one. The exact field names are in `webhooks.md`.
- Timeout: 10 seconds from the start of the request. On timeout the request is cut and counted as a transient failure.
- Redirects are not followed. Success: any HTTP status from 200 to 299.
- Failure: any other status, or a network error. The status text is `HTTP <status>` for a non-2xx response.
- Response body: the first 4096 characters are stored with the delivery record, only when `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` is `true` and the target passed the public-address check. Otherwise the stored body is `null`, so a delivery to an internal address cannot be read back through the deliveries list.
- The target is checked against the URL policy before sending. The check resolves the host and sends to the checked address. `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` controls the policy (see `deployment.md` and `webhooks.md`).

### Recording the result

Success:
- Delivery status becomes `success`.
- Attempt count goes up by one. Last response status and body are stored. Last error is cleared.
- Endpoint's last delivery time and status are set to `success`.

Failure:
- Attempt count goes up by one. Last response, error, and attempt time are stored.
- If the failure is permanent, or the attempt count is now 6 or more, the status becomes `dead` and the next attempt time is now.
- Otherwise the status becomes `pending` and the next attempt time is set to the current time plus the backoff for that attempt number: 30 seconds after failure 1, 2 minutes after failure 2, 10 minutes after failure 3, 1 hour after failure 4, and 6 hours after failure 5.
- Endpoint's last delivery time is set and its status becomes `failed`.

Permanent failures (no retry):
- The recording no longer exists or is no longer available to the user. The stored payload then says `Recording is no longer available`.
- The stored envelope, URL or secret cannot be read, or the stored URL is no longer valid.
- The URL policy rejects the target at send time.
- The payload cannot be built.

Every other failure is transient and follows the backoff schedule. A delivery therefore gets 6 attempts in total before it becomes `dead`.

---

## 8. Export job worker

Full export archives are described in `export-backup.md`. This section covers the worker.

### Timing and claims

- The worker claims a job when one is queued. While idle, it checks again every 5 seconds, which is how delayed retries run.
- One job runs at a time.
- A running job holds a lease of 120 seconds. The worker renews the lease in the background while the build runs. If the worker stops, the lease runs out and the job is claimed again from the start. A worker that has lost its lease does not save its result.

### Maintenance pass (every 30 seconds)

1. Removes expired archives (see Cleanup below).
2. On the desktop app only: schedules backups (section 9) and exports new recordings through auto export (`export-backup.md`).

Each step is independent. An error in one step is logged and does not stop the pass.

### Running one job

- The build has two limits. It stops if it makes no progress for 5 minutes, or if it runs for more than 3 hours in total. Progress means bytes written or a recording finished.
- If the build fails or is stopped by either limit, the attempt is recorded as an error against this attempt only.
- If an incomplete archive would result (audio missing or unreadable for one or more recordings), the archive is discarded. The job fails at once. The error text is `Export incomplete: audio was missing or unreadable for <n> recording(s). The archive was discarded.`
- A result is saved only if this attempt still owns the job. If another worker took the job over while this one was running, this result is discarded and its file is deleted. No notification is sent.
- After any failure, the partial file for this attempt is deleted.

### Retry policy

- A failed build goes back to pending and is claimed again after a backoff: 30 seconds after the first failure, then twice as long each time, capped at one hour, with up to 20% random extra time.
- A job gets 3 attempts in total (`export-backup.md`). After the last attempt the job is marked failed for good, and the failure is logged.
- An incomplete archive (missing audio) is not retried. The job fails at once.

### Cleanup

- For each completed archive past its `expiresAt`, the stored file is deleted first. A file that is already missing counts as deleted. The job row is deleted only after the file is gone. If the file delete fails, the row stays and the next pass tries again.

### Notifications on success

- **Manual export.** When the archive is ready, the "export ready" email is sent to the account's address, if SMTP is configured and the account has a plain email address (section 10.3).
- **Scheduled backup.** No email. The archive is copied to the backup folder instead (section 9).

---

## 9. Scheduled backups (desktop app only)

Scheduled backups run only when the server runs in the desktop app. Settings and the list of backups are in `export-backup.md`.

### Schedule

| Frequency | Interval |
|-----------|----------|
| daily | 24 hours |
| weekly | 7 days |
| monthly | 30 days |

A user's backup is due when either:

- No backup has ever been copied and no scheduled job has ever been created, or
- The later of the last copied backup time and the last scheduled job creation time is more than one interval ago.

Using the later of the two stops a backup from being queued again while the previous one is still building, and right after a failed copy.

A backup is not queued when the user already has an active export job. Errors for one user are logged. They do not stop other users.

### Copy to the backup folder

- Runs after the scheduled job completes.
- Folder: the user's configured backup folder. If none is set, `Documents/OpenAudioHub Backups` in the user's home folder. The folder is created if it does not exist.
- File name: `OpenAudioHub-backup-YYYY-MM-DD.zip`, using the server's local calendar date. If the name is taken, `-2`, `-3`, and so on are added before `.zip`.
- The archive is written to a temporary file in the same folder. It is renamed to the final name only when the copy completes. A partial copy never appears as a backup.
- Failure: the temporary file is deleted. The error is logged. The scheduled job itself stays complete.
- The last-backup time is updated only after a successful copy.

### Pruning

- After each successful copy, only backup files that match the name pattern are considered. Files with other names are never touched.
- The newest 5 backup files are kept, by modified time. Older ones are deleted.
- A pruning failure is logged and does not fail the copy.

---

## 10. Email notifications

### 10.1 Transport

- Sent with SMTP. Email is configured when `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASSWORD` are set. If they are not, email is skipped and a warning is logged. The skipped send returns "not sent" to its caller.
- Port: `SMTP_PORT` if set. Otherwise 465 when `SMTP_SECURE` is `true`, and 587 when it is not.
- `SMTP_SECURE` default: `false`. When it is `true`, the connection uses implicit TLS. Otherwise STARTTLS is used.
- Timeout for the whole send: 30 seconds.
- Sender address: `SMTP_FROM` if set. Otherwise `SMTP_USER`. Otherwise `OpenAudioHub <noreply@<host of APP_URL>>`, or `noreply@localhost` if `APP_URL` is not set.
- Reply-To: `SMTP_REPLY_TO`, if set.
- Plain-text body: the text version if one is given. Otherwise the HTML with tags removed.
- No retry for a single send.
- Two send paths:
  - **Soft send** (used by sync and the export job): returns true or false. Errors are logged, not raised.
  - **Strict send** (used by the test email): raises an error with one of these messages:
    - `SMTP authentication failed. Please check your SMTP_USER and SMTP_PASSWORD.` (the server refused the login)
    - `Timed out waiting for the SMTP server. Check that SMTP_HOST and SMTP_PORT are right.` (timeout)
    - `SMTP error: <server message>` for a protocol or TLS error with a message.
    - `Could not reach the SMTP server at <host>:<port>. Make sure SMTP_HOST and SMTP_PORT are entered correctly.` for any other connection failure.
    - `SMTP is not set up yet. Add SMTP_HOST, SMTP_USER, and SMTP_PASSWORD to the server environment.` when email is not configured.

### 10.2 Sending

Each email is sent once for the event that triggers it. A send that fails is logged and is not retried.

### 10.3 Email list

Layout: every email uses the same branded layout, with a preview line, a heading, body text, one button, and a footer link. The HTML is the layout; the fields below are what the content uses.

**New recording synced**
- Trigger: a sync pass created at least one new recording, the user has email notifications on, and a notification address is set (or the account email is used). Updated recordings do not trigger it. Sent once per sync pass, counting all new recordings in that pass.
- Subject: `New recording synced` when the count is 1. Otherwise `<count> new recordings synced`.
- Fields: `count`, recording names, link to `<APP_URL>/recordings`, link to `<APP_URL>/settings/notifications`.
- Names: the HTML lists up to 10 names, each linking to the recordings page. If there are more, it adds `+<n> more`. The plain text lists all names.
- Button text: view recordings. Footer link: manage notifications.
- Plain text: states the count, lists names, and gives both links.

**Export ready**
- Trigger: a manual export job completes, SMTP is configured, and the account has a plain email address. Not sent for scheduled backups.
- Subject: `Your OpenAudioHub export is ready`.
- Preview line: `Your OpenAudioHub data export is ready to download.`
- Heading: `Your export is ready`.
- Body: says the archive holds every recording's audio, transcript, and AI summary.
- Fields: `downloadUrl` = `<APP_URL>/settings/export`. Used for the button and the footer link.
- Button: download export.

**Test email**
- Trigger: the user asks for a test email (`settings.md`). Uses the strict send, so the caller sees the error.
- Subject: `Test Email from OpenAudioHub`.
- Heading: `Test email`.
- Fields: link to `<APP_URL>/dashboard` (button) and `<APP_URL>/settings/notifications` (footer link).
- Plain text says the test was received and lists both links.

**Reset your password**
- Trigger: password reset request (`auth.md`).
- Subject: `Reset your OpenAudioHub password`.
- Heading: `Reset your password`.
- Fields: reset link. The text says the link expires in 1 hour. The reset link is also printed as plain text under the button.
- Plain text: says the user can ignore the email if they did not ask for a reset.
- Button: reset password.

---

## 11. Bark push notifications

Bark is a push service. Each user sets their own push URL in settings (`settings.md`). The server sends to that URL. No Bark server setting is needed.

### When it is sent

- Once per sync pass, if the pass created at least one new recording, the user has Bark on, and a push URL is set.
- Not sent for updated recordings.
- The push URL must be an absolute `http` or `https` address with a host. Any other value (for example `ftp:`, `file:`, or text that is not a URL) is refused before any request is made. The server logs a warning that does not include the URL.

### Request

- Method `POST` to the user's push URL.
- Content type `application/json; charset=utf-8`.
- Body: a JSON object. Fields are included only when set.
- Timeout: 3 seconds. A timeout is a failure and is logged.
- Success: any 2xx response. Any other response, or any error, is a failure. The response text is logged.
- Failure logs name the error kind (for example `timeout`, `connect`, `status`) and never the URL, because the URL holds the device key.

Full field list supported by the sender. Field names are exact:

| Field | Type | Meaning |
|-------|------|---------|
| `body` | string | Required. Main text. |
| `title` | string | Title line. |
| `subtitle` | string | Second line. |
| `badge` | number | App icon badge. |
| `sound` | string | Sound name. |
| `icon` | string | Icon URL. |
| `group` | string | Notification group. |
| `url` | string | Link opened on tap. |
| `level` | string | `critical`, `active`, `timeSensitive`, or `passive`. |
| `volume` | number | Volume for critical alerts. |
| `copy` | string | Text copied on tap. |
| `autoCopy` | string `"1"` | Copy automatically. |
| `call` | string `"1"` | Repeat as a call. |
| `isArchive` | number `1` or `0` | Save to history. |
| `id` | string | Notification id, used to replace or delete. |
| `delete` | string `"1"` | Delete the notification with the given id. |

What the recording sync sends:

| Field | Value |
|-------|-------|
| `title` | `New recording synced` for 1 recording. `<count> new recordings synced` otherwise. |
| `subtitle` | The first 3 recording names joined with `, `. Followed by `...` if there are more than 3. Omitted if there are no names. |
| `body` | `A recording just arrived from your Plaud device` for 1. `<count> recordings just arrived from your Plaud device` otherwise. |
| `url` | `<APP_URL>/dashboard` |
| `group` | `openaudiohub-recordings` |
| `sound` | `minuet` |
| `badge` | The number of new recordings. |

### Failure

- A failed or timed-out push is logged. It does not change the sync result.
- Not retried.

---

## 12. Browser notifications

These run in the open web page, not on the server. They are shown only when the user has allowed notifications in the browser.

- Permission is requested only when the user starts a sync themselves. A background sync uses an existing grant. If the user has denied permission, nothing is shown and no error is shown.
- If permission is granted, the notification uses the site icon.
- The page also shows an in-app toast and plays a short chime when a sync adds recordings. The toast can be turned off with `syncNotifications`, and the chime with `notificationSound`.
- **New recordings:** title `New recording synced` (1) or `<count> new recordings synced`. Body: `A recording just arrived from your Plaud device` (1) or `<count> recordings just arrived from your Plaud device`. Tag `new-recording`. Tag means a new one replaces the old one with the same tag.

---

## 13. Crash and restart recovery

| State | Where it is kept | What happens after a restart or crash |
|-------|------------------|---------------------------------------|
| Last Plaud sync time | Database | Kept. A user whose sync never finished is still stale and is picked by the next pass. A sync that failed before saving the time keeps its old time. |
| Plaud "needs reconnect" mark | Database | Kept until a sync succeeds or the user reconnects. |
| Running Plaud sync | Memory | Lost. The next pass starts a new sync. |
| Auto-transcription job | Database | Kept. A job whose worker stopped is claimed again after its lease runs out. |
| Auto-summary running | Not tracked. | Lost with the process. The transcript keeps its state. The summary is not retried. |
| Manual summary job | Database | Kept. A job whose worker stopped is claimed again after its lease runs out. |
| Webhook delivery in progress | Database, status `processing` | Claimed again once its 15-minute claim has run out (section 7). |
| Export job in progress | Database, with a claim and a lease | Claimed again after the 120-second lease runs out (section 8). A claim that was taken over cannot write its result. |
| Scheduled backup due | Database | Recomputed on the next maintenance pass. |
| Email send in progress | Not tracked. | Lost. The email is not sent again. |

---

## 14. Known weak spots

These are current limits of the design.

1. **Auto-summary can run beside a manual summary.** The automatic summary does not check for a manual summary job for the same recording.
2. **Rate limits are kept in process memory.** The manual sync limit, the automatic summary cap and the sign-in limits are counted per process and start again after a restart.
3. **The `keep_both` transcript mode does not change auto-transcription.** A recording with any transcript, from Plaud or from the server, is not transcribed by the job under either mode.
4. **A failed "export ready" email is not retried.** The job is complete, and nothing sends the email again.
5. **A run that takes longer than 10 minutes is abandoned.** Changes already saved stay. The rest of that user's work is done at a later pass.
6. **No graceful stop for workers.** Shutdown waits for requests only. Running builds, transcriptions and requests are cut off, and recovered later by their leases or claims.

---

## 15. Workers and environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `BACKGROUND_SYNC_ENABLED` | `true` | `false` turns off background Plaud sync. Any other value leaves it on. |
| `BACKGROUND_SYNC_INTERVAL_MS` | `300000` | Pass interval in milliseconds. Must be a whole number from 60000 to 3600000. |
| `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE` | `10` | Limit on manual sync requests per user per minute. Not used by the background pass. |
| `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` | `60` | Hourly cap on automatic summaries per user. Must be a positive whole number. |
| `APP_URL` | unset | Base address in email and Bark links. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | unset, unset, `false` | SMTP server, port, and secure connection. |
| `SMTP_USER`, `SMTP_PASSWORD` | unset | SMTP login. Both are needed for email. |
| `SMTP_FROM` | unset | Sender address. |
| `SMTP_REPLY_TO` | unset | Reply-To address. |
| `OAH_DESKTOP` | unset | `1` turns on desktop mode. Scheduled backups and auto export run only in desktop mode. |
| `AUDIO_PIPELINE_ENABLED` | see `deployment.md` | Turns on the audio pipeline. Auto-transcription may hand work to it. |
| `WEBHOOKS_REQUIRE_PUBLIC_TARGETS` | see `deployment.md` | Controls the URL policy for webhook targets. |
| `RATE_LIMIT_TRUST_PROXY_HEADERS` | unset | Startup warning when not `true`. |
