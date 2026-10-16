import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({
    get db() {
        return holder.db;
    },
}));

import { getCollectionCounts } from "@/db/queries/collections";
import { recordings, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

function recording(id: string, userId: string, overrides: object = {}) {
    const start = new Date(Date.now() - DAY);
    return {
        id,
        userId,
        deviceSn: "SN-1",
        plaudFileId: id,
        filename: id,
        duration: 1000,
        startTime: start,
        endTime: start,
        filesize: 1,
        fileMd5: "0".repeat(32),
        storageType: "local",
        storagePath: id,
        plaudVersion: "1",
        ...overrides,
    };
}

describeWithDatabase("getCollectionCounts", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "collection_counts",
        );
        holder.db = database.db;
        await database.db.insert(users).values([
            { id: "u1", email: "u1@example.com" },
            { id: "u2", email: "u2@example.com" },
        ]);
        await database.db.insert(recordings).values([
            recording("r-starred", "u1", { starredAt: new Date() }),
            recording("r-old", "u1", {
                startTime: new Date(Date.now() - 30 * DAY),
            }),
            recording("r-upload", "u1", { deviceSn: "local" }),
            recording("r-deleted", "u1", { deletedAt: new Date() }),
            recording("r-other-user", "u2"),
        ]);
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("counts each collection for the user, skipping deleted rows", async () => {
        expect(await getCollectionCounts("u1")).toEqual({
            all: 3,
            starred: 1,
            recent: 2,
            uploaded: 1,
            plaud: 2,
        });
    });
});
