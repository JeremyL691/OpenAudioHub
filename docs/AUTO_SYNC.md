# Auto-sync

OpenAudioHub syncs recordings from Plaud through two mechanisms. Both run the same routine, `syncRecordingsForUser` in `src/lib/sync/sync-recordings.ts`.

## Server-side worker

The worker starts once per app process from `src/instrumentation.ts`, through `startBackgroundSyncWorker` in `src/lib/sync/worker.ts`. The first tick runs 30 seconds after startup. After that, a tick runs every `BACKGROUND_SYNC_INTERVAL_MS`, which defaults to five minutes.

On each tick, the worker:

1. Claims up to 20 users who have a Plaud connection and have not synced in the last 4 minutes. The users who synced longest ago are claimed first, so a large user base takes turns across ticks.
2. Runs `syncRecordingsForUser` for each claimed user, one after another.

Every user with a connected Plaud account is eligible. An unattended container therefore keeps syncing when no browser is open.

## Browser poller

The `useAutoSync` hook in `src/hooks/use-auto-sync.ts` syncs from an open tab through `POST /api/plaud/sync`. Its defaults:

| Option | Default | Behavior |
| --- | --- | --- |
| `syncOnMount` | `true` | Sync when the dashboard loads |
| `syncOnVisibilityChange` | `true` | Sync when the tab becomes visible again, if more than half the interval has passed |
| `interval` | 5 minutes | Sync at this interval while the tab is open |
| `minInterval` | 1 minute | Never sync more often than this |
| `enabled` | `true` | Turn the poller on or off |

The poller gives immediate results while someone is looking. The server worker keeps syncing when nobody is. The worker skips any user a tab synced in the last 4 minutes, so the two do not duplicate work.

## Configuration

Server-side settings are environment variables. The full list is in the [environment variables reference](../content/docs/self-hosting/environment-variables.mdx).

```bash
# Turn the server-side worker on or off. Default true.
BACKGROUND_SYNC_ENABLED=true

# Worker tick interval in milliseconds. Default 300000. Range 60000 to 3600000.
BACKGROUND_SYNC_INTERVAL_MS=300000

# Per-user limit on manual sync requests to POST /api/plaud/sync. Default 10. Range 1 to 600.
PLAUD_SYNC_RATE_LIMIT_PER_MINUTE=10
```

The browser poller's options are code-level defaults. They have no environment variables. The sync interval and the on/off setting are stored in the browser's localStorage under `openaudiohub:sync-interval` and `openaudiohub:auto-sync-enabled`.

## Browser storage keys

| Key | Purpose |
| --- | --- |
| `openaudiohub:last-sync` | Time of the last successful browser sync |
| `openaudiohub:sync-in-progress` | A short-lived lock that prevents two tabs from syncing at once |
| `openaudiohub:sync-interval` | The browser's sync interval |
| `openaudiohub:auto-sync-enabled` | Whether the browser poller is on |

Browsers that still hold values under the key names used before the rename have them copied to these keys the first time they are read. The old keys are then removed.

## Troubleshooting

- **No new recordings.** Check that `BACKGROUND_SYNC_ENABLED` is not `false`. Check the Plaud connection under **Settings → Plaud Account**. A reconnect banner means the token expired. Then search the server logs for `[background-sync]`.
- **A tick failed.** The worker logs `[background-sync] tick failed` and continues on the next tick. Repeated failures usually mean the database is unreachable.
- **Syncs happen too often.** Raise `BACKGROUND_SYNC_INTERVAL_MS`. The worker already skips users who synced within the last 4 minutes, so values below that have no effect on how often a user syncs.
- **Manual sync returns 429.** Raise `PLAUD_SYNC_RATE_LIMIT_PER_MINUTE`, or wait for the window to reset.

## Code map

- `src/lib/sync/sync-recordings.ts`: the sync routine.
- `src/lib/sync/worker.ts`: the server-side worker.
- `src/hooks/use-auto-sync.ts`: the browser poller.
- `src/lib/sync-config.ts`: the browser's stored sync settings.
