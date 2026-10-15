import {
    mkdir,
    mkdtemp,
    readdir,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    copyArchiveToBackupFolder,
    formatBackupDate,
    isBackupDue,
    isBackupFileName,
    pickBackupFileName,
    pruneBackupFolder,
    resolveBackupFolder,
    selectBackupsToPrune,
} from "@/lib/export/scheduled-backup";

const DAY = 24 * 60 * 60 * 1000;

describe("isBackupDue", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    const none = { lastBackupAt: null, lastJobCreatedAt: null };

    it("is due when the user has never been backed up or queued", () => {
        expect(isBackupDue("daily", none, now)).toBe(true);
    });

    it("uses the interval for each frequency", () => {
        const twoDaysAgo = new Date(now.getTime() - 2 * DAY);
        expect(
            isBackupDue("daily", { ...none, lastBackupAt: twoDaysAgo }, now),
        ).toBe(true);
        expect(
            isBackupDue("weekly", { ...none, lastBackupAt: twoDaysAgo }, now),
        ).toBe(false);
        const twentyDaysAgo = new Date(now.getTime() - 20 * DAY);
        expect(
            isBackupDue(
                "weekly",
                { ...none, lastBackupAt: twentyDaysAgo },
                now,
            ),
        ).toBe(true);
        expect(
            isBackupDue(
                "monthly",
                { ...none, lastBackupAt: twentyDaysAgo },
                now,
            ),
        ).toBe(false);
        const thirtyOneDaysAgo = new Date(now.getTime() - 31 * DAY);
        expect(
            isBackupDue(
                "monthly",
                { ...none, lastBackupAt: thirtyOneDaysAgo },
                now,
            ),
        ).toBe(true);
    });

    it("is not due inside the interval", () => {
        const justNow = new Date(now.getTime() - 60 * 1000);
        expect(
            isBackupDue("daily", { ...none, lastBackupAt: justNow }, now),
        ).toBe(false);
    });

    it("keeps a monthly schedule quiet 10 days after the last backup even with no job rows", () => {
        const tenDaysAgo = new Date(now.getTime() - 10 * DAY);
        expect(
            isBackupDue(
                "monthly",
                { lastBackupAt: tenDaysAgo, lastJobCreatedAt: null },
                now,
            ),
        ).toBe(false);
    });

    it("uses the later of the last backup and the newest scheduled job", () => {
        const tenDaysAgo = new Date(now.getTime() - 10 * DAY);
        const justNow = new Date(now.getTime() - 60 * 1000);
        // A recent job (e.g. a failed copy or a build still running) blocks re-queueing.
        expect(
            isBackupDue(
                "daily",
                { lastBackupAt: tenDaysAgo, lastJobCreatedAt: justNow },
                now,
            ),
        ).toBe(false);
        // An old job does not hide a stale backup: the backup term governs.
        const fortyDaysAgo = new Date(now.getTime() - 40 * DAY);
        expect(
            isBackupDue(
                "monthly",
                { lastBackupAt: tenDaysAgo, lastJobCreatedAt: fortyDaysAgo },
                now,
            ),
        ).toBe(false);
        expect(
            isBackupDue(
                "monthly",
                { lastBackupAt: fortyDaysAgo, lastJobCreatedAt: tenDaysAgo },
                now,
            ),
        ).toBe(false);
    });

    it("is never due without a frequency", () => {
        expect(isBackupDue(null, none, now)).toBe(false);
        expect(isBackupDue("never", none, now)).toBe(false);
    });
});

describe("backup file naming", () => {
    it("treats only generated names as backups", () => {
        expect(isBackupFileName("OpenAudioHub-backup-2026-10-15.zip")).toBe(
            true,
        );
        expect(isBackupFileName("OpenAudioHub-backup-2026-10-15-3.zip")).toBe(
            true,
        );
        expect(isBackupFileName("OpenAudioHub-backup-notes.zip")).toBe(false);
        expect(
            isBackupFileName("OpenAudioHub-backup-2026-10-15 copy.zip"),
        ).toBe(false);
    });

    it("formats the local calendar date", () => {
        expect(formatBackupDate(new Date(2026, 0, 5, 23, 30))).toBe(
            "2026-01-05",
        );
    });

    it("adds -2, -3 when names are taken", () => {
        const date = new Date(2026, 9, 14);
        expect(pickBackupFileName(date, new Set())).toBe(
            "OpenAudioHub-backup-2026-10-14.zip",
        );
        expect(
            pickBackupFileName(
                date,
                new Set(["OpenAudioHub-backup-2026-10-14.zip"]),
            ),
        ).toBe("OpenAudioHub-backup-2026-10-14-2.zip");
        expect(
            pickBackupFileName(
                date,
                new Set([
                    "OpenAudioHub-backup-2026-10-14.zip",
                    "OpenAudioHub-backup-2026-10-14-2.zip",
                ]),
            ),
        ).toBe("OpenAudioHub-backup-2026-10-14-3.zip");
    });

    it("defaults the folder under Documents", () => {
        expect(resolveBackupFolder(null, "/Users/me")).toBe(
            path.join("/Users/me", "Documents", "OpenAudioHub Backups"),
        );
        expect(resolveBackupFolder("/Volumes/Ext/Backups", "/Users/me")).toBe(
            "/Volumes/Ext/Backups",
        );
    });
});

describe("selectBackupsToPrune", () => {
    it("keeps the newest N by mtime and returns the rest", () => {
        const entries = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
            name: `OpenAudioHub-backup-${i}.zip`,
            mtimeMs: i * 1000,
        }));
        expect(selectBackupsToPrune(entries, 5)).toEqual([
            "OpenAudioHub-backup-2.zip",
            "OpenAudioHub-backup-1.zip",
        ]);
    });
});

describe("backup folder copy and prune", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "oah-backup-test-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("creates a missing folder, writes the archive, and keeps other files", async () => {
        const folder = path.join(dir, "nested", "Backups");
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "notes.txt"), "keep me");
        const saved = await copyArchiveToBackupFolder({
            folder,
            now: new Date(2026, 9, 14),
            openArchive: async () => Readable.from([Buffer.from("zipdata")]),
        });
        expect(path.basename(saved)).toBe("OpenAudioHub-backup-2026-10-14.zip");
        expect((await readdir(folder)).sort()).toEqual([
            "OpenAudioHub-backup-2026-10-14.zip",
            "notes.txt",
        ]);
    });

    it("removes the temp file and rethrows when the copy fails", async () => {
        const folder = path.join(dir, "Backups");
        await mkdir(folder);
        await expect(
            copyArchiveToBackupFolder({
                folder,
                now: new Date(2026, 9, 14),
                openArchive: async () => {
                    const stream = new Readable({
                        read() {
                            this.destroy(new Error("storage went away"));
                        },
                    });
                    return stream;
                },
            }),
        ).rejects.toThrow("storage went away");
        expect(await readdir(folder)).toEqual([]);
    });

    it("prunes only OpenAudioHub backup zips down to five", async () => {
        const folder = path.join(dir, "Backups");
        await mkdir(folder);
        for (let i = 1; i <= 6; i++) {
            const file = path.join(
                folder,
                `OpenAudioHub-backup-2026-10-0${i}.zip`,
            );
            await writeFile(file, "x");
            const when = new Date(2026, 9, i);
            await utimes(file, when, when);
        }
        await writeFile(path.join(folder, "my-own-file.zip"), "x");
        await writeFile(
            path.join(folder, "OpenAudioHub-backup-notes.txt"),
            "x",
        );

        const removed = await pruneBackupFolder(folder, 5);

        expect(removed).toEqual(["OpenAudioHub-backup-2026-10-01.zip"]);
        expect((await readdir(folder)).sort()).toEqual(
            [
                "OpenAudioHub-backup-2026-10-02.zip",
                "OpenAudioHub-backup-2026-10-03.zip",
                "OpenAudioHub-backup-2026-10-04.zip",
                "OpenAudioHub-backup-2026-10-05.zip",
                "OpenAudioHub-backup-2026-10-06.zip",
                "OpenAudioHub-backup-notes.txt",
                "my-own-file.zip",
            ].sort(),
        );
    });
});
