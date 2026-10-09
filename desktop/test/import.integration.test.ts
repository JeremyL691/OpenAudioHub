import { execFile, execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig } from "../src/main/config.js";
import { parseEnvLines } from "../src/main/import/keys.js";
import { rollbackImport } from "../src/main/import/rollback.js";
import {
    APP_DATABASE,
    connectionUrl,
    PRE_IMPORT_DATABASE,
    runImport,
    withClient,
} from "../src/main/import/run.js";
import { type DesktopPaths, resolvePaths } from "../src/main/paths.js";
import { isLoopbackPortFree } from "../src/main/ports.js";
import { ensureDatabase, PostgresManager } from "../src/main/postgres.js";
import {
    type DesktopSecrets,
    generateSecrets,
    saveSecrets,
    validateSecrets,
} from "../src/main/secrets.js";

/** Staged by `pnpm dist` (stage-postgres.mjs and stage-server.mjs). The suite is skipped when they are absent. */
const here = fileURLToPath(new URL(".", import.meta.url));
const binDir = join(here, "..", "build", "postgres", "bin");
const serverDir = join(here, "..", "build", "server");
/** The App's own migrations, read the way the App reads them (relative to the server folder). */
const migrationsDir = join(serverDir, "src", "db", "migrations");
/** The rehearsal export from scripts/export-for-desktop.sh (PLAN T15.1). It is git-ignored, so the suite skips without it. */
const exportDir = fileURLToPath(
    new URL("../../.dev-artifacts/rehearsal/export-1", import.meta.url),
);
const ready =
    existsSync(join(binDir, "initdb")) &&
    existsSync(join(serverDir, "migrate.mjs")) &&
    existsSync(migrationsDir) &&
    existsSync(join(exportDir, "manifest.json"));

const TEST_PORT_BASE = 38700;
const runtimeEnv = {
    PATH: `${binDir}:/usr/bin:/bin`,
    LANG: "en_US.UTF-8",
    TZ: "UTC",
};
const quiet = () => undefined;

let root: string;
let paths: DesktopPaths;
let secrets: DesktopSecrets;
let port = 0;

async function freePortFrom(start: number): Promise<number> {
    for (let candidate = start; candidate < start + 50; candidate += 1) {
        if (await isLoopbackPortFree(candidate)) return candidate;
    }
    throw new Error("no free test port");
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oah-import-"));
    paths = resolvePaths({ OAH_USER_DATA_DIR: root }, root);
    mkdirSync(paths.logs, { recursive: true });
    secrets = generateSecrets();
    saveSecrets(paths.secrets, secrets);
    port = await freePortFrom(TEST_PORT_BASE + Math.floor(Math.random() * 40));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const adminUrl = () =>
    connectionUrl(port, "postgres", secrets.POSTGRES_PASSWORD);
const databaseUrl = (database: string) =>
    connectionUrl(port, database, secrets.POSTGRES_PASSWORD);

function clusterManager(): PostgresManager {
    return new PostgresManager({
        binDir,
        dataDir: paths.pgdata,
        logFile: join(paths.logs, "postgres-test.log"),
        port,
        password: secrets.POSTGRES_PASSWORD,
        childEnv: runtimeEnv,
        scratchDir: paths.userData,
    });
}

/** Runs `work` with the App's cluster started, then stops it: the import and the rollback start their own. */
async function withCluster<T>(work: () => Promise<T>): Promise<T> {
    const manager = clusterManager();
    await manager.initialize();
    await manager.start();
    try {
        return await work();
    } finally {
        await manager.stop();
    }
}

async function databaseNames(): Promise<string[]> {
    return withClient(adminUrl(), async (sql) => {
        const rows =
            await sql`select datname from pg_database order by datname`;
        return rows.map((row) => String(row.datname));
    });
}

/** Runs the staged migrate script the way the App does. Its error text is left out: it can carry the URL. */
function migrate(databaseUrlValue: string): Promise<void> {
    return new Promise((done, fail) => {
        execFile(
            process.execPath,
            ["migrate.mjs"],
            {
                cwd: serverDir,
                env: {
                    ...runtimeEnv,
                    NODE_ENV: "production",
                    DATABASE_URL: databaseUrlValue,
                },
                timeout: 240_000,
            },
            (error) => {
                if (error) {
                    fail(
                        new Error(
                            `migrate.mjs exited with ${error.code ?? "a signal"}`,
                        ),
                    );
                } else {
                    done();
                }
            },
        );
    });
}

function importOptions(userEmail?: string) {
    return {
        dir: exportDir,
        userEmail,
        paths,
        secrets,
        postgresBin: binDir,
        port,
        migrationsDir,
        migrate,
        log: quiet,
    };
}

function rollbackOptions() {
    return { paths, secrets, postgresBin: binDir, port, log: quiet };
}

/**
 * The export's users, read by restoring its dump into a throwaway database (dropped again). The importer
 * refuses two accounts without --user-email, so the test needs the address to name.
 */
async function exportUsers(): Promise<Array<{ id: string; email: string }>> {
    const probe = "oah_export_probe";
    await withClient(adminUrl(), (sql) =>
        sql.unsafe(`drop database if exists ${probe}`),
    );
    await ensureDatabase(adminUrl(), probe);
    try {
        execFileSync(
            join(binDir, "pg_restore"),
            [
                "--no-owner",
                "--no-privileges",
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
                "--username",
                "oah",
                "--dbname",
                probe,
                join(exportDir, "db.dump"),
            ],
            {
                env: { ...runtimeEnv, PGPASSWORD: secrets.POSTGRES_PASSWORD },
                stdio: "pipe",
            },
        );
        return await withClient(databaseUrl(probe), async (sql) => {
            const rows =
                await sql`select id, email from users order by created_at`;
            return rows.map((row) => ({
                id: String(row.id),
                email: String(row.email),
            }));
        });
    } finally {
        await withClient(adminUrl(), (sql) =>
            sql.unsafe(`drop database if exists ${probe}`),
        );
    }
}

function countFiles(dir: string): number {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
        else if (entry.isFile()) total += 1;
    }
    return total;
}

function manifestCounts(): Record<string, number> {
    const manifest = JSON.parse(
        readFileSync(join(exportDir, "manifest.json"), "utf8"),
    ) as { counts: Record<string, number> };
    return manifest.counts;
}

describe.skipIf(!ready)(
    "importing the rehearsal export (PLAN T15.2, T15.3)",
    () => {
        it(
            "imports into an App with no data, binds the named account, and rollback takes the import back out",
            { timeout: 600_000 },
            async () => {
                const users = await withCluster(exportUsers);
                expect(users).toHaveLength(2);

                // Two accounts: without --user-email the import stops before anything is switched, and leaves nothing behind.
                await expect(runImport(importOptions())).rejects.toThrow(
                    "--user-email",
                );
                const afterRefusal = await withCluster(databaseNames);
                expect(afterRefusal).not.toContain(APP_DATABASE);
                expect(afterRefusal).not.toContain("openaudiohub_import");
                expect(existsSync(`${paths.storage}.importing`)).toBe(false);

                const summary = await runImport(importOptions(users[0].email));
                expect(summary.user).toEqual({
                    id: users[0].id,
                    email: users[0].email,
                });
                expect(summary.previousDatabase).toBeNull();

                const counts = manifestCounts();
                await withCluster(async () => {
                    for (const table of [
                        "users",
                        "recordings",
                        "audio_pipeline_jobs",
                    ]) {
                        const rows = await withClient(
                            databaseUrl(APP_DATABASE),
                            (sql) =>
                                sql.unsafe(
                                    `select count(*)::int as n from ${table}`,
                                ),
                        );
                        expect(rows[0].n).toBe(counts[table]);
                    }
                });

                // Storage holds exactly the archive's files.
                const archived = execFileSync(
                    "tar",
                    ["-tf", join(exportDir, "storage.tar")],
                    { encoding: "utf8" },
                )
                    .split("\n")
                    .filter((entry) => entry !== "" && !entry.endsWith("/"));
                expect(countFiles(paths.storage)).toBe(archived.length);

                // The export's keys are merged in; this App keeps its own database password. Booleans only, so no value is printed.
                const exported = parseEnvLines(
                    readFileSync(join(exportDir, "secrets.env"), "utf8"),
                );
                const saved = validateSecrets(
                    JSON.parse(readFileSync(paths.secrets, "utf8")),
                );
                expect(saved.ENCRYPTION_KEY === exported.ENCRYPTION_KEY).toBe(
                    true,
                );
                expect(
                    saved.BETTER_AUTH_SECRET === exported.BETTER_AUTH_SECRET,
                ).toBe(true);
                expect(
                    saved.POSTGRES_PASSWORD === secrets.POSTGRES_PASSWORD,
                ).toBe(true);

                expect(loadConfig(paths.config).config.boundUserId).toBe(
                    users[0].id,
                );
                const record = JSON.parse(
                    readFileSync(join(paths.imports, "last.json"), "utf8"),
                );
                expect(record.previousDatabase).toBe(false);
                expect(record.boundUserId).toBe(users[0].id);

                // Rollback: the import is moved aside (nothing is deleted), and the App is back to having no data.
                await rollbackImport(rollbackOptions());
                expect(existsSync(paths.storage)).toBe(false);
                expect(existsSync(paths.userEnv)).toBe(false);
                expect(loadConfig(paths.config).config.boundUserId).toBe(
                    undefined,
                );
                const restored = validateSecrets(
                    JSON.parse(readFileSync(paths.secrets, "utf8")),
                );
                expect(restored.ENCRYPTION_KEY === secrets.ENCRYPTION_KEY).toBe(
                    true,
                );
                expect(await withCluster(databaseNames)).not.toContain(
                    APP_DATABASE,
                );
                const rolledBack = JSON.parse(
                    readFileSync(join(paths.imports, "last.json"), "utf8"),
                );
                expect(typeof rolledBack.rolledBackAt).toBe("string");
                await expect(rollbackImport(rollbackOptions())).rejects.toThrow(
                    "already rolled back",
                );
            },
        );

        it(
            "keeps the App's previous database, storage, keys and settings, and rollback puts them back",
            { timeout: 600_000 },
            async () => {
                await withCluster(async () => {
                    await ensureDatabase(adminUrl(), APP_DATABASE);
                    await withClient(databaseUrl(APP_DATABASE), (sql) =>
                        sql.unsafe(
                            "create table app_marker (note text); insert into app_marker values ('before import')",
                        ),
                    );
                });
                mkdirSync(paths.storage, { recursive: true });
                writeFileSync(join(paths.storage, "keep.txt"), "before import");
                writeFileSync(paths.userEnv, "OAH_TEST_MARKER=before-import\n");
                saveConfig(paths.config, {
                    ...defaultConfig(),
                    boundUserId: "previous-user",
                });

                const users = await withCluster(exportUsers);
                const summary = await runImport(importOptions(users[0].email));
                expect(summary.previousDatabase).toBe(PRE_IMPORT_DATABASE);

                await withCluster(async () => {
                    const kept = await withClient(
                        databaseUrl(PRE_IMPORT_DATABASE),
                        (sql) => sql`select note from app_marker`,
                    );
                    expect(kept[0].note).toBe("before import");
                    const imported = await withClient(
                        databaseUrl(APP_DATABASE),
                        (sql) => sql`select count(*)::int as n from users`,
                    );
                    expect(imported[0].n).toBe(2);
                });
                expect(
                    readFileSync(
                        join(`${paths.storage}.pre-import`, "keep.txt"),
                        "utf8",
                    ),
                ).toBe("before import");
                expect(
                    readFileSync(`${paths.userEnv}.pre-import`, "utf8"),
                ).toBe("OAH_TEST_MARKER=before-import\n");
                expect(readFileSync(paths.userEnv, "utf8")).not.toBe(
                    "OAH_TEST_MARKER=before-import\n",
                );
                expect(loadConfig(paths.config).config.boundUserId).toBe(
                    users[0].id,
                );

                // While the previous database is still kept, another import is refused.
                await expect(
                    runImport(importOptions(users[0].email)),
                ).rejects.toThrow("roll that back first");

                await rollbackImport(rollbackOptions());
                await withCluster(async () => {
                    const names = await databaseNames();
                    expect(names).not.toContain(PRE_IMPORT_DATABASE);
                    expect(
                        names.filter((name) =>
                            name.startsWith(`${APP_DATABASE}_rolled_back_`),
                        ),
                    ).toHaveLength(1);
                    const marker = await withClient(
                        databaseUrl(APP_DATABASE),
                        (sql) => sql`select note from app_marker`,
                    );
                    expect(marker[0].note).toBe("before import");
                });
                expect(
                    readFileSync(join(paths.storage, "keep.txt"), "utf8"),
                ).toBe("before import");
                expect(readFileSync(paths.userEnv, "utf8")).toBe(
                    "OAH_TEST_MARKER=before-import\n",
                );
                expect(loadConfig(paths.config).config.boundUserId).toBe(
                    "previous-user",
                );
            },
        );

        it(
            "refuses another import while a copy that an earlier import kept is still there, and changes nothing",
            { timeout: 600_000 },
            async () => {
                mkdirSync(paths.storage, { recursive: true });
                writeFileSync(join(paths.storage, "keep.txt"), "before import");
                const users = await withCluster(exportUsers);
                await runImport(importOptions(users[0].email));

                // No database was kept, so only the copy of storage stops this one, before the database is touched.
                await expect(
                    runImport(importOptions(users[0].email)),
                ).rejects.toThrow("roll that back first");

                await withCluster(async () => {
                    const imported = await withClient(
                        databaseUrl(APP_DATABASE),
                        (sql) => sql`select count(*)::int as n from users`,
                    );
                    expect(imported[0].n).toBe(2);
                    const names = await databaseNames();
                    expect(names).not.toContain(PRE_IMPORT_DATABASE);
                    expect(names).not.toContain("openaudiohub_import");
                });
                expect(
                    readFileSync(
                        join(`${paths.storage}.pre-import`, "keep.txt"),
                        "utf8",
                    ),
                ).toBe("before import");
            },
        );
    },
);
