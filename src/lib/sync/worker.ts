import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { plaudConnections, users } from "@/db/schema";
import { env } from "@/lib/env";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";

// ponytail: skip users synced in the last 4 min -- they likely just client-synced
const STALE_THRESHOLD_MS = 4 * 60 * 1000;
const MAX_USERS_PER_TICK = 20;

/**
 * Claim users due for a server-side sync tick: every user with a Plaud
 * connection whose last sync is stale. Unattended background sync is the
 * whole point of running the container without a browser open (#159).
 *
 * Exported for testing.
 */
export async function claimUsersForSync(): Promise<string[]> {
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

    const conditions = [
        isNull(users.suspendedAt),
        or(
            isNull(plaudConnections.lastSync),
            lt(plaudConnections.lastSync, staleThreshold),
        ),
    ];

    const rows = await db
        .select({ userId: plaudConnections.userId })
        .from(plaudConnections)
        .innerJoin(users, eq(users.id, plaudConnections.userId))
        .where(and(...conditions))
        // Oldest/never-synced first (NULLS FIRST is Postgres's default for
        // ASC) so a large eligible pool cycles through everyone instead of
        // the same MAX_USERS_PER_TICK subset winning every tick.
        .orderBy(asc(plaudConnections.lastSync))
        .limit(MAX_USERS_PER_TICK);

    return rows.map((r) => r.userId);
}

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const userIds = await claimUsersForSync();
        if (userIds.length === 0) return;

        let synced = 0;
        let errors = 0;
        for (const userId of userIds) {
            try {
                await syncRecordingsForUser(userId);
                synced++;
            } catch (error) {
                errors++;
                console.error(
                    `[background-sync] failed for user ${userId}:`,
                    error,
                );
            }
        }

        if (synced > 0 || errors > 0) {
            console.log(`[background-sync] synced=${synced} errors=${errors}`);
        }
    } catch (error) {
        console.error("[background-sync] tick failed:", error);
    } finally {
        running = false;
    }
}

let started = false;
let running = false;

/**
 * Start the server-side background sync worker. Syncs recordings for all
 * users independently of any open browser tab or the client-side
 * `useAutoSync` polling. Tick
 * interval is configurable via `BACKGROUND_SYNC_INTERVAL_MS` (default 5
 * min); the whole worker can be disabled via `BACKGROUND_SYNC_ENABLED=false`.
 * Safe to call more than once.
 */
export function startBackgroundSyncWorker(): void {
    if (started) return;
    if (!env.BACKGROUND_SYNC_ENABLED) return;
    started = true;
    const interval = setInterval(() => {
        void tick();
    }, env.BACKGROUND_SYNC_INTERVAL_MS);
    interval.unref?.();
    setTimeout(() => void tick(), 30_000);
}
