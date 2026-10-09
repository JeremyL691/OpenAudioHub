import { sql } from "drizzle-orm";
import type { db } from "@/db";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialises first-run creation of the desktop account. Two launches that
 * exchange a session at the same moment must not both create a user.
 */
export async function acquireDesktopUserLock(tx: DbTransaction): Promise<void> {
    await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('oah_desktop_local_user', 0))`,
    );
}
