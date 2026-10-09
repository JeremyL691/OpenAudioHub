import { randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `content` to `path` through a temporary file in the same directory, then renames it into
 * place, so a crash never leaves a half-written file. The parent directory is created with 0700 and
 * the file ends up with `mode` (0600 for anything secret).
 */
export function writeFileAtomic(
    path: string,
    content: string,
    mode = 0o600,
): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(
        dir,
        `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
        const fd = openSync(temp, "wx", mode);
        try {
            writeFileSync(fd, content);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temp, path);
        chmodSync(path, mode);
    } catch (error) {
        rmSync(temp, { force: true });
        throw error;
    }
}
