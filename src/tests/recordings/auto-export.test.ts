import {
    link,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, link: vi.fn(actual.link) };
});

vi.mock("@/db", () => ({
    db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/desktop/mode", () => ({
    isDesktopMode: vi.fn(() => true),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({})),
}));

vi.mock("@/lib/recordings/download-audio", () => ({
    openAudioAsMp3: vi.fn(),
}));

vi.mock("@/lib/encryption/fields", () => ({
    encryptText: (value: string) => value,
    decryptText: (value: string) => value,
}));

import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { isDesktopMode } from "@/lib/desktop/mode";
import {
    autoExportRecording,
    renameAutoExport,
} from "@/lib/recordings/auto-export";
import { openAudioAsMp3 } from "@/lib/recordings/download-audio";
import { createUserStorageProvider } from "@/lib/storage/factory";

let dir: string;
let settingsRows: Record<string, unknown>[];
let recordingRows: Record<string, unknown>[];
let updates: unknown[];

const startTime = new Date(2026, 4, 6, 12);

function baseRecording(overrides: Record<string, unknown> = {}) {
    return {
        id: "rec-1",
        filename: "Planning Call",
        startTime,
        storagePath: "user-1/rec.mp3",
        autoExportPath: null,
        ...overrides,
    };
}

function baseSettings(overrides: Record<string, unknown> = {}) {
    return {
        autoExport: true,
        folder: dir,
        titleMode: "original",
        ...overrides,
    };
}

/** Routes each `db.select()` by table: settings and recordings get their own rows. */
function fakeDb(settings: unknown, recording: unknown) {
    settingsRows = settings ? [settings as Record<string, unknown>] : [];
    recordingRows = recording ? [recording as Record<string, unknown>] : [];
    (db.select as Mock).mockImplementation(() => ({
        from: (table: unknown) => ({
            where: () => ({
                limit: async () =>
                    table === userSettings ? settingsRows : recordingRows,
            }),
        }),
    }));
}

async function listDir(): Promise<string[]> {
    return (await readdir(dir)).sort();
}

describe("auto-export", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        dir = await mkdtemp(join(tmpdir(), "auto-export-"));
        updates = [];
        (isDesktopMode as Mock).mockReturnValue(true);
        (db.update as Mock).mockImplementation(() => ({
            set: (values: unknown) => ({
                where: async () => {
                    updates.push(values);
                },
            }),
        }));
        (openAudioAsMp3 as Mock).mockImplementation(async () =>
            Readable.from([Buffer.from("mp3")]),
        );
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("autoExportRecording", () => {
        it("names the file by recording date in date mode", async () => {
            fakeDb(baseSettings({ titleMode: "date" }), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(await listDir()).toEqual(["2026-05-06.mp3"]);
            expect(await readFile(join(dir, "2026-05-06.mp3"), "utf8")).toBe(
                "mp3",
            );
            expect(updates).toEqual([
                { autoExportPath: join(dir, "2026-05-06.mp3") },
            ]);
        });

        it("names the file by the recording title in original mode", async () => {
            fakeDb(baseSettings(), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(await listDir()).toEqual(["Planning Call.mp3"]);
            expect(updates).toEqual([
                { autoExportPath: join(dir, "Planning Call.mp3") },
            ]);
        });

        it("writes the stored original with its own extension in original format", async () => {
            const downloadStream = vi.fn(async () =>
                Readable.from([Buffer.from("ogg")]),
            );
            (createUserStorageProvider as Mock).mockResolvedValueOnce({
                downloadStream,
            });
            fakeDb(
                baseSettings({ format: "original" }),
                baseRecording({ storagePath: "user-1/rec.ogg" }),
            );

            await autoExportRecording("user-1", "rec-1");

            expect(downloadStream).toHaveBeenCalledWith("user-1/rec.ogg");
            expect(openAudioAsMp3).not.toHaveBeenCalled();
            expect(await listDir()).toEqual(["Planning Call.ogg"]);
            expect(updates).toEqual([
                { autoExportPath: join(dir, "Planning Call.ogg") },
            ]);
        });

        it("copies instead when the folder's drive has no hard links", async () => {
            await writeFile(join(dir, "Planning Call.mp3"), "old");
            const noLinks = Object.assign(new Error("EPERM"), {
                code: "EPERM",
            });
            (link as Mock).mockRejectedValue(noLinks);
            fakeDb(baseSettings(), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(await listDir()).toEqual([
                "Planning Call (2).mp3",
                "Planning Call.mp3",
            ]);
            expect(await readFile(join(dir, "Planning Call.mp3"), "utf8")).toBe(
                "old",
            );
            (link as Mock).mockReset();
        });

        it("picks a suffixed name and never overwrites an existing file", async () => {
            await writeFile(join(dir, "Planning Call.mp3"), "old");
            fakeDb(baseSettings(), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(await listDir()).toEqual([
                "Planning Call (2).mp3",
                "Planning Call.mp3",
            ]);
            expect(await readFile(join(dir, "Planning Call.mp3"), "utf8")).toBe(
                "old",
            );
            expect(updates).toEqual([
                { autoExportPath: join(dir, "Planning Call (2).mp3") },
            ]);
        });

        it("does nothing when auto-export is off", async () => {
            fakeDb(baseSettings({ autoExport: false }), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(openAudioAsMp3).not.toHaveBeenCalled();
            expect(await listDir()).toEqual([]);
        });

        it("does nothing outside desktop mode", async () => {
            (isDesktopMode as Mock).mockReturnValue(false);
            fakeDb(baseSettings(), baseRecording());

            await autoExportRecording("user-1", "rec-1");

            expect(openAudioAsMp3).not.toHaveBeenCalled();
            expect(await listDir()).toEqual([]);
        });

        it("never exports a recording twice", async () => {
            fakeDb(
                baseSettings(),
                baseRecording({ autoExportPath: join(dir, "Old.mp3") }),
            );

            await autoExportRecording("user-1", "rec-1");

            expect(openAudioAsMp3).not.toHaveBeenCalled();
            expect(await listDir()).toEqual([]);
        });

        it("does not throw when the folder is missing", async () => {
            const missing = join(dir, "missing");
            fakeDb(baseSettings({ folder: missing }), baseRecording());
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            await expect(
                autoExportRecording("user-1", "rec-1"),
            ).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalled();
            expect(updates).toEqual([]);
            errorSpy.mockRestore();
        });

        it("removes the temp file when the audio stream fails", async () => {
            (openAudioAsMp3 as Mock).mockImplementation(async () => {
                const stream = new Readable({
                    read() {
                        this.destroy(new Error("boom"));
                    },
                });
                return stream;
            });
            fakeDb(baseSettings(), baseRecording());
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});

            await autoExportRecording("user-1", "rec-1");

            expect(await listDir()).toEqual([]);
            expect(updates).toEqual([]);
            errorSpy.mockRestore();
        });
    });

    describe("renameAutoExport", () => {
        it("renames the exported file in ai mode", async () => {
            const oldPath = join(dir, "2026-05-06.mp3");
            await writeFile(oldPath, "mp3");
            fakeDb(
                baseSettings({ titleMode: "ai" }),
                baseRecording({ autoExportPath: oldPath }),
            );

            await renameAutoExport("user-1", "rec-1", "Standup");

            expect(await listDir()).toEqual(["Standup.mp3"]);
            expect(updates).toEqual([
                { autoExportPath: join(dir, "Standup.mp3") },
            ]);
        });

        it("keeps the original extension when renaming an original export", async () => {
            const oldPath = join(dir, "2026-05-06.ogg");
            await writeFile(oldPath, "ogg");
            fakeDb(
                baseSettings({ titleMode: "ai", format: "original" }),
                baseRecording({
                    storagePath: "user-1/rec.ogg",
                    autoExportPath: oldPath,
                }),
            );

            await renameAutoExport("user-1", "rec-1", "Standup");

            expect(await listDir()).toEqual(["Standup.ogg"]);
        });

        it("does nothing in date mode", async () => {
            const oldPath = join(dir, "2026-05-06.mp3");
            await writeFile(oldPath, "mp3");
            fakeDb(
                baseSettings({ titleMode: "date" }),
                baseRecording({ autoExportPath: oldPath }),
            );

            await renameAutoExport("user-1", "rec-1", "Standup");

            expect(await listDir()).toEqual(["2026-05-06.mp3"]);
            expect(updates).toEqual([]);
        });
    });
});
