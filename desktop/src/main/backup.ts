import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many dumps to keep (PLAN T13.6). */
export const BACKUP_KEEP = 5;

/** Keeps the newest `keep` dumps in `dir`, removes the rest, and returns the removed file names. */
export function pruneBackups(dir: string, keep = BACKUP_KEEP): string[] {
    const dumps = readdirSync(dir)
        .filter((name) => name.endsWith(".dump"))
        .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    const removed = dumps.slice(keep).map((dump) => dump.name);
    for (const name of removed) rmSync(join(dir, name), { force: true });
    return removed;
}

export interface BackupOptions {
    pgDumpBin: string;
    host: string;
    port: number;
    user: string;
    database: string;
    /** Passed through PGPASSWORD, so it never appears in the process arguments. */
    password: string;
    /** The backups folder under the user data directory. */
    dir: string;
    /** Part of the file name, for example "from-1.0.1-to-1.1.0". */
    label: string;
    /** Environment for pg_dump (an allow-list, see childEnvironment). */
    env: Record<string, string>;
    now?: Date;
}

/**
 * Writes a custom-format dump of the database (`pg_dump -Fc`) before a migration that changes the schema
 * (PLAN T13.6), then keeps the newest five. A failed dump removes its partial file and throws, so the
 * migration never runs without a backup.
 */
export function backupDatabase(options: BackupOptions): string {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const stamp = (options.now ?? new Date())
        .toISOString()
        .replace(/[:.]/g, "-");
    const file = join(options.dir, `${stamp}-${options.label}.dump`);
    try {
        execFileSync(
            options.pgDumpBin,
            [
                "--format=custom",
                "--no-owner",
                "--no-privileges",
                "--host",
                options.host,
                "--port",
                String(options.port),
                "--username",
                options.user,
                "--file",
                file,
                options.database,
            ],
            {
                env: { ...options.env, PGPASSWORD: options.password },
                stdio: "ignore",
            },
        );
        chmodSync(file, 0o600);
    } catch (error) {
        rmSync(file, { force: true });
        throw error;
    }
    pruneBackups(options.dir);
    return file;
}
