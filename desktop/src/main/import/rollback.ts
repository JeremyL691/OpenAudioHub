import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import { loadConfig, saveConfig } from "../config.js";
import type { DesktopPaths } from "../paths.js";
import { PostgresManager } from "../postgres.js";
import type { DesktopSecrets } from "../secrets.js";
import { childEnvironment } from "../services.js";
import {
    APP_DATABASE,
    connectionUrl,
    type ImportRecord,
    PRE_IMPORT_DATABASE,
    renameDatabase,
    withClient,
} from "./run.js";

export interface RollbackOptions {
    paths: DesktopPaths;
    secrets: DesktopSecrets;
    postgresBin: string;
    port: number;
    log: (message: string) => void;
}

/**
 * Puts back what the last import replaced (PLAN T15.3, `--rollback-import`). Nothing is deleted: the imported
 * database, storage, pipeline data, keys and env move aside as `*.rolled-back-<stamp>`, and the copies that the
 * import kept as `*.pre-import` return to their places. After a first import, which replaced no database, the
 * imported database is moved aside and the App creates an empty one on its next start.
 */
export async function rollbackImport(options: RollbackOptions): Promise<void> {
    const { paths, secrets, postgresBin, port, log } = options;
    const lastFile = join(paths.imports, "last.json");
    if (!existsSync(lastFile)) {
        throw new Error("there is no import to roll back");
    }
    const record = JSON.parse(readFileSync(lastFile, "utf8")) as ImportRecord;
    if (record.rolledBackAt) {
        throw new Error(
            `the last import was already rolled back at ${record.rolledBackAt}`,
        );
    }
    if (!existsSync(paths.pgdata)) {
        throw new Error(
            "the database cluster is missing; the rollback cannot run",
        );
    }
    // Every copy the rollback needs is checked before the first rename, so a missing copy never leaves a
    // half-restored App behind.
    const restores: Array<[boolean, string]> = [
        [record.previousStorage, paths.storage],
        [record.previousPipelineData, paths.pipelineData],
        [record.previousSecrets, paths.secrets],
        [record.previousEnv, paths.userEnv],
    ];
    for (const [previous, current] of restores) {
        if (previous && !existsSync(`${current}.pre-import`)) {
            throw new Error(
                `${current}.pre-import is missing; the rollback cannot restore it`,
            );
        }
    }

    // Digits only, so the stamp is a valid identifier suffix and never needs quoting.
    const stamp = new Date().toISOString().replace(/\D/g, "");
    const manager = new PostgresManager({
        binDir: postgresBin,
        dataDir: paths.pgdata,
        logFile: join(paths.logs, "postgres-rollback.log"),
        port,
        password: secrets.POSTGRES_PASSWORD,
        childEnv: childEnvironment(postgresBin, {}),
        scratchDir: paths.userData,
    });
    await manager.start();
    try {
        const adminUrl = connectionUrl(
            port,
            "postgres",
            secrets.POSTGRES_PASSWORD,
        );
        await switchDatabases(adminUrl, record.previousDatabase, stamp);
    } finally {
        await manager.stop();
    }
    log(
        record.previousDatabase
            ? `database restored from ${PRE_IMPORT_DATABASE}`
            : "the imported database was moved aside (the App had none before)",
    );

    for (const [previous, current] of restores) {
        moveAside(current, stamp);
        if (previous) renameSync(`${current}.pre-import`, current);
    }
    log("storage, keys and settings restored");

    const { boundUserId: _imported, ...config } = loadConfig(
        paths.config,
    ).config;
    saveConfig(
        paths.config,
        record.previousBoundUserId
            ? { ...config, boundUserId: record.previousBoundUserId }
            : config,
    );

    writeFileAtomic(
        lastFile,
        `${JSON.stringify({ ...record, rolledBackAt: new Date().toISOString() }, null, 2)}\n`,
    );
}

/** Moves the imported database aside and, when the import kept one, puts the previous database back. */
async function switchDatabases(
    adminUrl: string,
    previousDatabase: boolean,
    stamp: string,
): Promise<void> {
    if (previousDatabase) {
        const kept = await withClient(
            adminUrl,
            (sql) =>
                sql`select 1 from pg_database where datname = ${PRE_IMPORT_DATABASE}`,
        );
        if (kept.length === 0) {
            throw new Error(
                `${PRE_IMPORT_DATABASE} is missing; the rollback cannot restore the database`,
            );
        }
    }
    await renameDatabase(
        adminUrl,
        APP_DATABASE,
        `${APP_DATABASE}_rolled_back_${stamp}`,
    );
    if (previousDatabase) {
        await renameDatabase(adminUrl, PRE_IMPORT_DATABASE, APP_DATABASE);
    }
}

/** Renames `path` to `path.rolled-back-<stamp>` when it exists; it is never deleted. */
function moveAside(path: string, stamp: string): void {
    if (existsSync(path)) renameSync(path, `${path}.rolled-back-${stamp}`);
}
