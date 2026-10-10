import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Free space the App needs before it starts. PostgreSQL writes its WAL and the pipeline writes audio, and on a
 * nearly full disk those writes fail in the middle of a session. Refusing to start, with a reason, is the safer
 * outcome (A4 check 10).
 */
export const MIN_FREE_BYTES = 200 * 1024 * 1024;

const MB = 1024 * 1024;

/** The part of fs.statfsSync that freeBytesAt uses, so tests can pass a fake. */
export type StatfsFn = (path: string) => { bavail: number; bsize: number };

/** Errors that mean the path does not exist (yet), as opposed to a volume that cannot be read. */
const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Free bytes available to this user on the volume that holds `path`. The data folder is created after the check,
 * so a missing path is measured at its nearest existing ancestor, which is on the same volume. Returns null when
 * the volume cannot be read.
 */
export function freeBytesAt(
    path: string,
    statfs: StatfsFn = statfsSync,
): number | null {
    const absolute = resolve(path);
    try {
        const stats = statfs(absolute);
        return stats.bavail * stats.bsize;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(absolute);
        if (!code || !MISSING_PATH_CODES.has(code) || parent === absolute) {
            return null;
        }
        return freeBytesAt(parent, statfs);
    }
}

/**
 * The message for a disk that is too full. It names the folder and the free space, and says what to do, because
 * the App does not start until the user frees space.
 */
export function describeShortage(freeBytes: number, path: string): string {
    const freeMb = Math.floor(freeBytes / MB);
    const neededMb = MIN_FREE_BYTES / MB;
    return `Only ${freeMb} MB are free on the disk that holds ${path}. Free at least ${neededMb} MB on that disk and open OpenAudioHub again.`;
}
