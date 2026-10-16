import { and, count, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import {
    type CollectionCounts,
    LOCAL_DEVICE_SN,
    RECENT_WINDOW_MS,
} from "@/lib/recordings/collections";

/**
 * Sidebar counts for the smart collections, in one query. Must stay in step
 * with `inCollection` in `src/lib/recordings/collections.ts`.
 */
export async function getCollectionCounts(
    userId: string,
): Promise<CollectionCounts> {
    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const [row] = await db
        .select({
            all: count(),
            starred: count(recordings.starredAt),
            recent: sql<number>`count(*) filter (where ${gte(recordings.startTime, since)})`,
            uploaded: sql<number>`count(*) filter (where ${recordings.deviceSn} = ${LOCAL_DEVICE_SN})`,
            plaud: sql<number>`count(*) filter (where ${ne(recordings.deviceSn, LOCAL_DEVICE_SN)})`,
        })
        .from(recordings)
        .where(
            and(eq(recordings.userId, userId), isNull(recordings.deletedAt)),
        );
    return {
        all: Number(row?.all ?? 0),
        starred: Number(row?.starred ?? 0),
        recent: Number(row?.recent ?? 0),
        uploaded: Number(row?.uploaded ?? 0),
        plaud: Number(row?.plaud ?? 0),
    };
}
