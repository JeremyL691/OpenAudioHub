import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_INTERVAL_MS: Record<string, number | undefined> = {
    daily: DAY_MS,
    weekly: 7 * DAY_MS,
    monthly: 30 * DAY_MS,
};

export const BACKUP_FILE_PREFIX = "OpenAudioHub-backup-";
export const BACKUP_FILE_SUFFIX = ".zip";
export const BACKUP_KEEP_COUNT = 5;

/**
 * A scheduled backup is due when nothing was ever backed up or queued, or
 * the later of the last copied backup and the newest scheduled job is older
 * than the interval. The job term stops re-queueing while a build runs and
 * right after a failed copy; the backup term survives job-row cleanup.
 */
export function isBackupDue(
    frequency: string | null,
    last: { lastBackupAt: Date | null; lastJobCreatedAt: Date | null },
    now: Date,
): boolean {
    const interval = BACKUP_INTERVAL_MS[frequency ?? ""];
    if (interval === undefined) return false;
    const times = [last.lastBackupAt, last.lastJobCreatedAt]
        .filter((d): d is Date => d instanceof Date)
        .map((d) => d.getTime());
    if (times.length === 0) return true;
    return now.getTime() - Math.max(...times) > interval;
}

/** Local calendar date as YYYY-MM-DD. */
export function formatBackupDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Only names pickBackupFileName makes, so pruning never touches a user's own
// file that merely shares the prefix (e.g. OpenAudioHub-backup-notes.zip).
const BACKUP_FILE_NAME =
    /^OpenAudioHub-backup-\d{4}-\d{2}-\d{2}(?:-\d+)?\.zip$/;

export function isBackupFileName(name: string): boolean {
    return BACKUP_FILE_NAME.test(name);
}

/** `OpenAudioHub-backup-YYYY-MM-DD.zip`, with `-2`, `-3`... appended when the name is taken. */
export function pickBackupFileName(
    date: Date,
    existingNames: ReadonlySet<string>,
): string {
    const base = `${BACKUP_FILE_PREFIX}${formatBackupDate(date)}`;
    let name = `${base}${BACKUP_FILE_SUFFIX}`;
    for (let n = 2; existingNames.has(name); n++) {
        name = `${base}-${n}${BACKUP_FILE_SUFFIX}`;
    }
    return name;
}

/** Names to delete so that only the newest `keep` backup files remain (newest by mtime). */
export function selectBackupsToPrune(
    entries: { name: string; mtimeMs: number }[],
    keep: number,
): string[] {
    return [...entries]
        .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
        .slice(keep)
        .map((e) => e.name);
}

export function resolveBackupFolder(
    configured: string | null,
    homeDir: string,
): string {
    return (
        configured ?? path.join(homeDir, "Documents", "OpenAudioHub Backups")
    );
}

/** Deletes old backup files in `folder`. Never touches anything that isn't an OpenAudioHub backup zip. */
export async function pruneBackupFolder(
    folder: string,
    keep: number = BACKUP_KEEP_COUNT,
): Promise<string[]> {
    const files = (await readdir(folder, { withFileTypes: true })).filter(
        (d) => d.isFile() && isBackupFileName(d.name),
    );
    const entries = await Promise.all(
        files.map(async (d) => ({
            name: d.name,
            mtimeMs: (await stat(path.join(folder, d.name))).mtimeMs,
        })),
    );
    const stale = selectBackupsToPrune(entries, keep);
    for (const name of stale) {
        await unlink(path.join(folder, name));
    }
    return stale;
}

/**
 * Copies one finished archive into `folder` as a dated backup file. The
 * bytes go to a temp file first and are renamed into place only once the
 * copy is complete, so a partial copy never looks like a finished backup.
 * Throws on failure (the temp file is removed); pruning failures are
 * logged and do not fail the copy.
 */
export async function copyArchiveToBackupFolder(input: {
    folder: string;
    now: Date;
    openArchive: () => Promise<Readable>;
}): Promise<string> {
    await mkdir(input.folder, { recursive: true });
    const existing = new Set(await readdir(input.folder));
    const name = pickBackupFileName(input.now, existing);
    const finalPath = path.join(input.folder, name);
    const tmpPath = path.join(input.folder, `.${name}.${randomUUID()}.tmp`);
    try {
        const source = await input.openArchive();
        await pipeline(source, createWriteStream(tmpPath));
        await rename(tmpPath, finalPath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        throw error;
    }
    try {
        await pruneBackupFolder(input.folder);
    } catch (error) {
        console.warn(
            `[export-worker] backup pruning failed in ${input.folder}:`,
            error,
        );
    }
    return finalPath;
}
