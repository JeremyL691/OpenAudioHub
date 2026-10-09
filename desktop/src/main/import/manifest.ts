import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The export written by scripts/export-for-desktop.sh (PLAN T15.1). */
export interface ExportManifest {
    format: "openaudiohub-desktop-export";
    version: 1;
    exportedAt: string;
    sourceProject: string;
    sourceImage: string;
    sourceRevision: string;
    migrations: { count: number; hashes: string[] };
    counts: Record<string, number>;
    apiCredentialsDigest: string;
    files: Record<string, { sha256: string; bytes: number }>;
}

export const EXPORT_FILES = [
    "db.dump",
    "storage.tar",
    "pipeline-data.tar",
    "secrets.env",
    "config.env",
] as const;

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Reads manifest.json and checks it: the format, every listed file present with the recorded size and sha256.
 * Throws with the first problem; it never prints file contents.
 */
export function readManifest(dir: string): ExportManifest {
    const path = join(dir, "manifest.json");
    if (!existsSync(path)) throw new Error("manifest.json is missing");
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error("manifest.json is not valid JSON");
    }
    const manifest = parsed as ExportManifest;
    if (
        manifest?.format !== "openaudiohub-desktop-export" ||
        manifest.version !== 1
    ) {
        throw new Error(
            "manifest.json is not an OpenAudioHub desktop export (version 1)",
        );
    }
    for (const file of EXPORT_FILES) {
        const entry = manifest.files?.[file];
        if (!entry) throw new Error(`manifest has no entry for ${file}`);
        const full = join(dir, file);
        if (!existsSync(full)) throw new Error(`${file} is missing`);
        if (statSync(full).size !== entry.bytes) {
            throw new Error(`${file} has the wrong size`);
        }
        if (sha256File(full) !== entry.sha256) {
            throw new Error(`${file} does not match its sha256`);
        }
    }
    if (!Array.isArray(manifest.migrations?.hashes)) {
        throw new Error("manifest has no migration hashes");
    }
    return manifest;
}

/**
 * The sha256 of every migration file this version ships, in file-name order. Drizzle records the same digest of
 * each file in its migrations table, so the two can be compared directly.
 */
export function versionMigrationHashes(migrationsDir: string): string[] {
    return readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => sha256File(join(migrationsDir, name)));
}

/**
 * Every migration in the export must be one this version ships (PLAN T15.2 step 2). The order does not matter:
 * a database records the order it was migrated in, and that is not always the file order. Migrations that this
 * version has and the export lacks are applied by the migrate step, and verifyDatabase (run.ts) confirms that
 * the result holds exactly this version's migrations.
 */
export function checkExportMigrations(
    exported: string[],
    versionHashes: string[],
): void {
    const known = new Set(versionHashes);
    for (const hash of exported) {
        if (!known.has(hash)) {
            throw new Error(
                `the export has a migration this version does not have (${hash.slice(0, 12)}...). Update the app before importing.`,
            );
        }
    }
}
