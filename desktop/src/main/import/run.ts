import { execFileSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { writeFileAtomic } from "../atomic-file.js";
import { type DesktopConfig, loadConfig, saveConfig } from "../config.js";
import type { DesktopPaths } from "../paths.js";
import { ensureDatabase, PostgresManager } from "../postgres.js";
import { type DesktopSecrets, saveSecrets } from "../secrets.js";
import { childEnvironment } from "../services.js";
import { chooseUser, type ImportedUser } from "./bind.js";
import { mergeExportedKeys, parseEnvLines } from "./keys.js";
import {
    checkExportMigrations,
    type ExportManifest,
    readManifest,
    versionMigrationHashes,
} from "./manifest.js";

export const APP_DATABASE = "openaudiohub";
export const IMPORT_DATABASE = "openaudiohub_import";
export const PRE_IMPORT_DATABASE = "openaudiohub_pre_import";
const DB_USER = "oah";

export interface ImportOptions {
    /** The export folder (manifest.json and the files listed in it). */
    dir: string;
    userEmail?: string;
    paths: DesktopPaths;
    /** The App's own secrets: the cluster password and the pipeline token stay as they are. */
    secrets: DesktopSecrets;
    postgresBin: string;
    /** A free loopback port for the cluster (the caller picks it, as the supervisor does). */
    port: number;
    migrationsDir: string;
    /** Applies the migrations to the database at this URL (the server's migrate script in the App). */
    migrate: (databaseUrl: string) => Promise<void>;
    log: (message: string) => void;
}

export interface ImportSummary {
    sourceProject: string;
    sourceRevision: string;
    exportedAt: string;
    user: { id: string; email: string };
    counts: Record<string, number>;
    previousDatabase: string | null;
}

/** What the switch changed, so `--rollback-import` can put it back (stored in imports/last.json). */
export interface ImportRecord {
    importedAt: string;
    previousDatabase: boolean;
    previousStorage: boolean;
    previousPipelineData: boolean;
    previousSecrets: boolean;
    previousEnv: boolean;
    previousBoundUserId: string | null;
    boundUserId: string;
    /** Set by `--rollback-import` once the switch has been put back. */
    rolledBackAt?: string;
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function connectionUrl(
    port: number,
    database: string,
    password?: string,
): string {
    const auth = password
        ? `${DB_USER}:${encodeURIComponent(password)}@`
        : `${DB_USER}@`;
    return `postgres://${auth}127.0.0.1:${port}/${database}`;
}

export async function withClient<T>(
    url: string,
    work: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
    // Server notices (such as "does not exist, skipping" from DROP ... IF EXISTS) are not printed to the log.
    const sql = postgres(url, {
        max: 1,
        connect_timeout: 10,
        onnotice: () => undefined,
    });
    try {
        return await work(sql);
    } finally {
        await sql.end({ timeout: 5 });
    }
}

async function databaseExists(
    adminUrl: string,
    name: string,
): Promise<boolean> {
    return withClient(adminUrl, async (sql) => {
        const rows =
            await sql`select 1 from pg_database where datname = ${name}`;
        return rows.length > 0;
    });
}

async function dropIfExists(adminUrl: string, name: string): Promise<void> {
    await withClient(adminUrl, async (sql) => {
        await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${name} and pid <> pg_backend_pid()`;
        await sql.unsafe(`drop database if exists ${name}`);
    });
}

/**
 * Renames a database after ending its connections. A backend that is still exiting makes the rename fail with
 * "being accessed by other users" (SQLSTATE 55006); that is retried briefly.
 */
export async function renameDatabase(
    adminUrl: string,
    from: string,
    to: string,
): Promise<void> {
    await withClient(adminUrl, async (sql) => {
        for (let attempt = 1; ; attempt += 1) {
            await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${from} and pid <> pg_backend_pid()`;
            try {
                await sql.unsafe(`alter database ${from} rename to ${to}`);
                return;
            } catch (error) {
                const busy = (error as { code?: string }).code === "55006";
                if (!busy || attempt >= 10) throw error;
                await new Promise((done) => setTimeout(done, 200));
            }
        }
    });
}

/** Restores the custom-format dump into an empty database. Credentials go through PGPASSWORD. */
function restoreDump(
    postgresBin: string,
    port: number,
    password: string,
    dump: string,
): void {
    execFileSync(
        join(postgresBin, "pg_restore"),
        [
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--username",
            DB_USER,
            "--dbname",
            IMPORT_DATABASE,
            dump,
        ],
        {
            env: childEnvironment(postgresBin, { PGPASSWORD: password }),
            stdio: "pipe",
        },
    );
}

/** Lists a tar archive, and refuses absolute paths and parent references before anything is extracted. */
function extractSafely(
    archive: string,
    destination: string,
    postgresBin: string,
): void {
    const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    for (const entry of entries) {
        if (entry.startsWith("/") || entry.split("/").includes("..")) {
            throw new Error("the archive has an unsafe path");
        }
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    execFileSync(
        "tar",
        ["-xf", archive, "-C", destination, "--no-same-owner"],
        {
            env: childEnvironment(postgresBin, {}),
        },
    );
}

/** Counts every table the export listed and the API credential digest; throws at the first difference. */
async function verifyDatabase(
    url: string,
    manifest: ExportManifest,
    versionHashes: string[],
): Promise<void> {
    await withClient(url, async (sql) => {
        for (const [table, expected] of Object.entries(manifest.counts)) {
            if (!TABLE_NAME.test(table))
                throw new Error(
                    `unexpected table name in the export: ${table}`,
                );
            const rows = await sql.unsafe(
                `select count(*)::int as n from ${table}`,
            );
            if (rows[0].n !== expected) {
                throw new Error(
                    `${table} has ${rows[0].n} rows; the export has ${expected}`,
                );
            }
        }
        if (manifest.apiCredentialsDigest !== "none") {
            const rows =
                await sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from api_credentials t`;
            if (rows[0].digest !== manifest.apiCredentialsDigest) {
                throw new Error(
                    "the API credential digest differs from the export",
                );
            }
        }
        // After the migrate step the database must hold exactly this version's migrations, in whatever order they
        // were applied. Drizzle skips a migration older than the newest applied one, so this is checked, not assumed.
        const applied =
            await sql`select hash from drizzle.__drizzle_migrations`;
        const appliedHashes = new Set(applied.map((row) => String(row.hash)));
        const missing = versionHashes.filter(
            (hash) => !appliedHashes.has(hash),
        );
        if (missing.length > 0 || appliedHashes.size !== versionHashes.length) {
            throw new Error(
                `after migrating, the database does not hold exactly this version's ${versionHashes.length} migrations; the import is refused`,
            );
        }
    });
}

async function readUsers(url: string): Promise<ImportedUser[]> {
    return withClient(url, async (sql) => {
        const rows =
            await sql`select id, email, created_at as "createdAt" from users order by created_at`;
        return rows.map((row) => ({
            id: String(row.id),
            email: String(row.email),
            createdAt: new Date(row.createdAt as Date),
        }));
    });
}

/** Moves `current` aside to `preserved` and puts `incoming` in its place. Refuses to overwrite an earlier import. */
function replaceDirectory(
    current: string,
    incoming: string,
    preserved: string,
): boolean {
    if (existsSync(preserved)) {
        throw new Error(
            `${preserved} is kept from an earlier import; roll that back first`,
        );
    }
    const had = existsSync(current);
    if (had) renameSync(current, preserved);
    renameSync(incoming, current);
    return had;
}

function replaceFile(current: string, preserved: string): boolean {
    if (!existsSync(current)) return false;
    if (existsSync(preserved)) {
        throw new Error(
            `${preserved} is kept from an earlier import; roll that back first`,
        );
    }
    copyFileSync(current, preserved);
    return true;
}

/**
 * Imports a Docker export into this App (PLAN T15.2). The steps: check the export, restore the database into a
 * new database, migrate it, verify it against the export, then switch to it atomically: the previous database,
 * storage, secrets, and env are kept as *.pre-import. The App's own cluster is used, so the App must not be
 * running (the CLI and the menu make sure of that).
 */
export async function runImport(
    options: ImportOptions,
): Promise<ImportSummary> {
    const { dir, paths, secrets, postgresBin, port, log } = options;
    const manifest = readManifest(dir);
    const versionHashes = versionMigrationHashes(options.migrationsDir);
    checkExportMigrations(manifest.migrations.hashes, versionHashes);
    log(
        "export checked: files and sha256 match, and its migrations are all known to this version",
    );

    const manager = new PostgresManager({
        binDir: postgresBin,
        dataDir: paths.pgdata,
        logFile: join(paths.logs, "postgres-import.log"),
        port,
        password: secrets.POSTGRES_PASSWORD,
        userName: DB_USER,
        childEnv: childEnvironment(postgresBin, {}),
        scratchDir: paths.userData,
    });
    await manager.initialize();
    await manager.start();
    const adminUrl = connectionUrl(port, "postgres", secrets.POSTGRES_PASSWORD);
    const storageStaging = `${paths.storage}.importing`;
    const pipelineStaging = `${paths.pipelineData}.importing`;
    let switched = false;
    try {
        if (await databaseExists(adminUrl, PRE_IMPORT_DATABASE)) {
            throw new Error(
                `${PRE_IMPORT_DATABASE} is kept from an earlier import; roll that back first (--rollback-import)`,
            );
        }
        // Checked before anything changes: a copy kept by an earlier import would stop the file switch halfway,
        // after the database has already been switched.
        const keptCopy = [
            `${paths.storage}.pre-import`,
            `${paths.pipelineData}.pre-import`,
            `${paths.secrets}.pre-import`,
            `${paths.userEnv}.pre-import`,
        ].find((path) => existsSync(path));
        if (keptCopy) {
            throw new Error(
                `${keptCopy} is kept from an earlier import; roll that back first (--rollback-import)`,
            );
        }
        await dropIfExists(adminUrl, IMPORT_DATABASE);
        await ensureDatabase(adminUrl, IMPORT_DATABASE);
        restoreDump(
            postgresBin,
            port,
            secrets.POSTGRES_PASSWORD,
            join(dir, "db.dump"),
        );
        log("database restored into a new database");

        const importUrl = connectionUrl(
            port,
            IMPORT_DATABASE,
            secrets.POSTGRES_PASSWORD,
        );
        await options.migrate(importUrl);
        log("migrations applied");

        await verifyDatabase(importUrl, manifest, versionHashes);
        log("row counts and the API credential digest match the export");
        const user = chooseUser(await readUsers(importUrl), options.userEmail);

        // Staging: storage and pipeline data are extracted next to their final places first.
        rmSync(storageStaging, { recursive: true, force: true });
        rmSync(pipelineStaging, { recursive: true, force: true });
        extractSafely(join(dir, "storage.tar"), storageStaging, postgresBin);
        extractSafely(
            join(dir, "pipeline-data.tar"),
            pipelineStaging,
            postgresBin,
        );
        const keys = parseEnvLines(
            readFileSync(join(dir, "secrets.env"), "utf8"),
        );
        const mergedSecrets = mergeExportedKeys(secrets, keys);
        const envText = readFileSync(join(dir, "config.env"), "utf8");
        const config = loadConfig(paths.config).config;
        const previousBoundUserId = config.boundUserId ?? null;
        log("storage and keys staged");

        // The switch. Nothing is removed: the previous state is renamed or copied to *.pre-import.
        const previousDatabase = await databaseExists(adminUrl, APP_DATABASE);
        switched = true;
        if (previousDatabase)
            await renameDatabase(adminUrl, APP_DATABASE, PRE_IMPORT_DATABASE);
        await renameDatabase(adminUrl, IMPORT_DATABASE, APP_DATABASE);
        const previousStorage = replaceDirectory(
            paths.storage,
            storageStaging,
            `${paths.storage}.pre-import`,
        );
        const previousPipelineData = replaceDirectory(
            paths.pipelineData,
            pipelineStaging,
            `${paths.pipelineData}.pre-import`,
        );
        const previousSecrets = replaceFile(
            paths.secrets,
            `${paths.secrets}.pre-import`,
        );
        saveSecrets(paths.secrets, mergedSecrets);
        const previousEnv = replaceFile(
            paths.userEnv,
            `${paths.userEnv}.pre-import`,
        );
        writeFileAtomic(paths.userEnv, envText, 0o600);
        saveConfig(paths.config, {
            ...config,
            boundUserId: user.id,
        } as DesktopConfig);
        log("switched to the imported database, storage, keys and settings");

        const record: ImportRecord = {
            importedAt: new Date().toISOString(),
            previousDatabase,
            previousStorage,
            previousPipelineData,
            previousSecrets,
            previousEnv,
            previousBoundUserId,
            boundUserId: user.id,
        };
        mkdirSync(paths.imports, { recursive: true, mode: 0o700 });
        writeFileAtomic(
            join(paths.imports, `${timestamp()}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
        );
        writeFileAtomic(
            join(paths.imports, "last.json"),
            `${JSON.stringify(record, null, 2)}\n`,
        );

        return {
            sourceProject: manifest.sourceProject,
            sourceRevision: manifest.sourceRevision,
            exportedAt: manifest.exportedAt,
            user: { id: user.id, email: user.email },
            counts: manifest.counts,
            previousDatabase: previousDatabase ? PRE_IMPORT_DATABASE : null,
        };
    } catch (error) {
        if (!switched) {
            // Nothing has been switched: the scratch database and staged folders go, so a retry starts clean.
            await dropIfExists(adminUrl, IMPORT_DATABASE).catch(
                () => undefined,
            );
            rmSync(storageStaging, { recursive: true, force: true });
            rmSync(pipelineStaging, { recursive: true, force: true });
        }
        throw error;
    } finally {
        await manager.stop();
    }
}
