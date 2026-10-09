import { join } from "node:path";
import { utilityProcess } from "electron";
import type { CliCommand } from "./cli.js";
import { ImportChoiceError } from "./import/bind.js";
import { rollbackImport } from "./import/rollback.js";
import { type ImportSummary, runImport } from "./import/run.js";
import type { DesktopPaths } from "./paths.js";
import type { DesktopSecrets } from "./secrets.js";
import { childEnvironment, fromUtilityProcess } from "./services.js";

export interface CommandContext {
    command: CliCommand;
    paths: DesktopPaths;
    secrets: DesktopSecrets;
    bundleRoot: string;
    /** The App's configured cluster port. The App is not running (the single-instance lock checked that). */
    port: number;
    log: (message: string) => void;
}

export interface CommandResult {
    /** The exit code (cli.ts): 0 done, 1 failed, 3 the command line or the account choice needs a change. */
    code: 0 | 1 | 3;
    message: string;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function summaryText(summary: ImportSummary): string {
    const kept = summary.previousDatabase
        ? `; the previous database is kept as ${summary.previousDatabase}`
        : "";
    return `imported the export of ${summary.sourceProject} (exported ${summary.exportedAt}); signed in as ${summary.user.email}${kept}`;
}

/**
 * Runs the server's migrate script in a utility process, as the App does (its Electron binary cannot run scripts
 * as Node). A non-zero exit fails the import; the import's own checks decide what is safe to switch.
 */
function migrateWith(
    serverDir: string,
    binDir: string,
    logFile: string,
): (databaseUrl: string) => Promise<void> {
    return (databaseUrl) =>
        new Promise<void>((done, fail) => {
            const child = utilityProcess.fork(
                join(serverDir, "migrate.mjs"),
                [],
                {
                    cwd: serverDir,
                    env: childEnvironment(binDir, {
                        DATABASE_URL: databaseUrl,
                    }),
                    stdio: "pipe",
                    serviceName: "oah-migrate",
                },
            );
            fromUtilityProcess(child, logFile).onExit((code) => {
                if (code === 0) done();
                else fail(new Error(`the migration step exited with ${code}`));
            });
        });
}

/**
 * Runs `--import` or `--rollback-import` with the App's own cluster, migrate step and data layout (PLAN T15.2,
 * T15.3). The result carries the exit code; nothing here prints secrets.
 */
export async function runCliCommand(
    context: CommandContext,
): Promise<CommandResult> {
    const { command, paths, secrets, bundleRoot, port, log } = context;
    const postgresBin = join(bundleRoot, "postgres", "bin");
    const serverDir = join(bundleRoot, "server");
    const shared = { paths, secrets, postgresBin, port, log };

    if (command.kind === "rollback") {
        try {
            await rollbackImport(shared);
            return {
                code: 0,
                message:
                    "the previous data is back; the imported data is kept beside it",
            };
        } catch (error) {
            return {
                code: 1,
                message: `rollback not done: ${errorText(error)}`,
            };
        }
    }

    try {
        const summary = await runImport({
            ...shared,
            dir: command.dir,
            userEmail: command.userEmail,
            migrationsDir: join(serverDir, "src", "db", "migrations"),
            migrate: migrateWith(
                serverDir,
                join(bundleRoot, "bin"),
                join(paths.logs, "migrate.log"),
            ),
        });
        return { code: 0, message: summaryText(summary) };
    } catch (error) {
        if (error instanceof ImportChoiceError) {
            return { code: 3, message: errorText(error) };
        }
        return { code: 1, message: `import not done: ${errorText(error)}` };
    }
}
