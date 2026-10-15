import { constants, createWriteStream } from "node:fs";
import { copyFile, link, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings, userSettings } from "@/db/schema";
import { isDesktopMode } from "@/lib/desktop/mode";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { openAudioAsMp3 } from "@/lib/recordings/download-audio";
import {
    audioExtension,
    buildDownloadFilename,
    dateRecordingTitle,
} from "@/lib/recordings/filename";
import { createUserStorageProvider } from "@/lib/storage/factory";

// exFAT, SMB and some FUSE drives have no hard links; an exclusive copy works there.
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

function placeExclusive(source: string, target: string): Promise<void> {
    return link(source, target).catch((error: NodeJS.ErrnoException) => {
        if (!NO_HARD_LINKS.has(error.code ?? "")) throw error;
        return copyFile(source, target, constants.COPYFILE_EXCL);
    });
}

/**
 * Places `source` at the first free `name` in `dir` ("a.mp3", "a (2).mp3", ...).
 * Both link and COPYFILE_EXCL fail with EEXIST instead of overwriting, so a user's file is never replaced.
 */
async function linkUnique(
    dir: string,
    name: string,
    source: string,
): Promise<string> {
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; n < 1000; n++) {
        const target = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
        try {
            await placeExclusive(source, target);
            return target;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    throw new Error("no free file name in auto-export folder");
}

/** Writes the recording's MP3 into the user's auto-export folder if enabled. Never throws. */
export async function autoExportRecording(
    userId: string,
    recordingId: string,
): Promise<void> {
    try {
        if (!isDesktopMode()) return;

        const [settings] = await db
            .select({
                autoExport: userSettings.autoExport,
                folder: userSettings.autoExportFolder,
                titleMode: userSettings.autoExportTitleMode,
                format: userSettings.autoExportFormat,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoExport || !settings.folder) return;

        const [recording] = await db
            .select({
                filename: recordings.filename,
                startTime: recordings.startTime,
                storagePath: recordings.storagePath,
                autoExportPath: recordings.autoExportPath,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        // Never export the same recording twice.
        if (!recording || recording.autoExportPath) return;

        const title =
            settings.titleMode === "date"
                ? dateRecordingTitle(recording.startTime)
                : decryptText(recording.filename);
        const original = settings.format === "original";
        const name = buildDownloadFilename(
            title,
            recording.storagePath,
            recordingId,
            original ? audioExtension(recording.storagePath) : "mp3",
        );

        // Written under a temp name first so a half-written file never shows up as a finished file.
        const temp = join(settings.folder, `.${recordingId}.part`);
        try {
            const storage = await createUserStorageProvider(userId);
            await pipeline(
                original
                    ? await storage.downloadStream(recording.storagePath)
                    : await openAudioAsMp3(storage, recording.storagePath),
                createWriteStream(temp),
            );
            const finalPath = await linkUnique(settings.folder, name, temp);
            await db
                .update(recordings)
                .set({ autoExportPath: encryptText(finalPath) })
                .where(
                    and(
                        eq(recordings.id, recordingId),
                        eq(recordings.userId, userId),
                    ),
                );
        } finally {
            await rm(temp, { force: true });
        }
    } catch (error) {
        console.error("[auto-export] export failed", recordingId, error);
    }
}

/** AI mode: renames the exported file to `title`. No-op unless enabled, mode is 'ai' and the recording was exported. Never throws. */
export async function renameAutoExport(
    userId: string,
    recordingId: string,
    title: string,
): Promise<void> {
    try {
        if (!isDesktopMode()) return;

        const [settings] = await db
            .select({
                autoExport: userSettings.autoExport,
                titleMode: userSettings.autoExportTitleMode,
            })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);
        if (!settings?.autoExport || settings.titleMode !== "ai") return;

        const [recording] = await db
            .select({
                storagePath: recordings.storagePath,
                autoExportPath: recordings.autoExportPath,
            })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                    isNull(recordings.deletedAt),
                ),
            )
            .limit(1);
        if (!recording?.autoExportPath) return;

        const oldPath = decryptText(recording.autoExportPath);
        // Keep the extension the export was written with (.mp3, or the stored original's).
        const name = buildDownloadFilename(
            title,
            recording.storagePath,
            recordingId,
            extname(oldPath).slice(1) || "mp3",
        );
        // Compare case-insensitively: on macOS a case-only rename would link onto the file itself.
        if (basename(oldPath).toLowerCase() === name.toLowerCase()) return;
        // The user may have moved or deleted the export; nothing to rename then.
        try {
            await stat(oldPath);
        } catch {
            return;
        }

        const newPath = await linkUnique(dirname(oldPath), name, oldPath);
        await db
            .update(recordings)
            .set({ autoExportPath: encryptText(newPath) })
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            );
        await unlink(oldPath);
    } catch (error) {
        console.error("[auto-export] rename failed", recordingId, error);
    }
}
