import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({
    get db() {
        return holder.db;
    },
}));

import {
    claimPendingExportJobs,
    completeExportJob,
    createExportJob,
    getBackupFolderForUser,
    getLastScheduledBackupAt,
    getLatestScheduledExportJob,
    markScheduledBackupCopied,
    selectBackupSchedules,
} from "@/db/queries/export-jobs";
import { exportJobs, userSettings, users } from "@/db/schema";
import { isBackupDue } from "@/lib/export/scheduled-backup";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("scheduled backup queries", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "scheduled_backup",
        );
        holder.db = database.db;
        const db = database.db;
        await db
            .insert(users)
            .values({ id: "u-sched", email: "sched@example.com" });
        await db.insert(userSettings).values({
            userId: "u-sched",
            backupFrequency: "daily",
            backupFolder: "/Volumes/Ext/Backups",
        });
        await db
            .insert(users)
            .values({ id: "u-manual", email: "manual@example.com" });
        await db
            .insert(users)
            .values({ id: "u-monthly", email: "monthly@example.com" });
        await db.insert(userSettings).values({
            userId: "u-monthly",
            backupFrequency: "monthly",
            lastBackupAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        });
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("stores manual jobs by default and scheduled jobs when asked", async () => {
        const manual = await createExportJob("u-manual");
        expect(manual.kind).toBe("manual");
        const claimed = await claimPendingExportJobs(10);
        const claim = claimed.find((c) => c.id === manual.id);
        expect(claim?.kind).toBe("manual");
        await completeExportJob({
            jobId: manual.id,
            claimToken: claim?.claimToken ?? "",
            storageKey: "exports/u-manual/x.zip",
            fileSize: 1,
            recordingCount: 0,
        });

        const scheduled = await createExportJob("u-sched", {
            kind: "scheduled",
        });
        expect(scheduled.kind).toBe("scheduled");
        expect((await getLatestScheduledExportJob("u-sched"))?.id).toBe(
            scheduled.id,
        );
        expect(await getLastScheduledBackupAt("u-sched")).toBeNull();
    });

    it("reports the claimed kind and the last completed scheduled backup", async () => {
        const claimed = await claimPendingExportJobs(10);
        const claim = claimed.find((c) => c.userId === "u-sched");
        expect(claim?.kind).toBe("scheduled");
        await completeExportJob({
            jobId: claim?.id ?? "",
            claimToken: claim?.claimToken ?? "",
            storageKey: "exports/u-sched/y.zip",
            fileSize: 2,
            recordingCount: 1,
        });
        // Completing the job alone does not count as a backup: the copy must land.
        expect(await getLastScheduledBackupAt("u-sched")).toBeNull();
        await markScheduledBackupCopied("u-sched", new Date());
        const last = await getLastScheduledBackupAt("u-sched");
        expect(last).toBeInstanceOf(Date);
        expect(Date.now() - (last as Date).getTime()).toBeLessThan(60_000);
    });

    it("lists scheduled users and their backup folder", async () => {
        const schedules = (await selectBackupSchedules()).filter(
            (s) => s.userId === "u-sched",
        );
        expect(schedules).toEqual([
            {
                userId: "u-sched",
                backupFrequency: "daily",
                lastBackupAt: expect.any(Date),
            },
        ]);
        expect(await getBackupFolderForUser("u-sched")).toBe(
            "/Volumes/Ext/Backups",
        );
        expect(await getBackupFolderForUser("u-manual")).toBeNull();
    });

    it("does not re-queue a monthly schedule 10 days after its last backup, with no job rows", async () => {
        const db = database?.db;
        if (!db) throw new Error("test database was not initialized");
        const rows = await db
            .select()
            .from(exportJobs)
            .where(eq(exportJobs.userId, "u-monthly"));
        expect(rows).toHaveLength(0);

        const [schedule] = (await selectBackupSchedules()).filter(
            (s) => s.userId === "u-monthly",
        );
        expect(schedule?.lastBackupAt).toBeInstanceOf(Date);
        expect(
            isBackupDue(
                schedule.backupFrequency,
                { lastBackupAt: schedule.lastBackupAt, lastJobCreatedAt: null },
                new Date(),
            ),
        ).toBe(false);
    });
});
