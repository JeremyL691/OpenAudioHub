/**
 * Electron main process entry (PLAN §20, T13.3–T13.5). Start order: data layout and secrets, ports,
 * PostgreSQL, the one-shot migration, then the pipeline and the web server, then the session exchange
 * and the window. Closing the window keeps the app in the menu bar (D-305). The layout under `bundleRoot`
 * matches the app's Resources folder, so the same code runs from a development build (desktop/build) and
 * from the packaged app.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    app,
    type BrowserWindow,
    dialog,
    session,
    shell,
    type Tray,
    utilityProcess,
} from "electron";
import { writeFileAtomic } from "./atomic-file.js";
import { backupDatabase } from "./backup.js";
import { loadConfig, saveConfig } from "./config.js";
import { exportSecrets } from "./export-keys.js";
import { buildTrayTemplate } from "./menu.js";
import { resolvePaths } from "./paths.js";
import { choosePorts } from "./ports.js";
import { ensureDatabase, PostgresManager, readPgVersion } from "./postgres.js";
import { bundleOf, removeQuarantine } from "./quarantine.js";
import { loadOrCreateSecrets } from "./secrets.js";
import {
    childEnvironment,
    fromUtilityProcess,
    PostgresService,
    ProcessService,
    pipelineFactory,
} from "./services.js";
import { exchangeSession } from "./session.js";
import { type Service, Supervisor } from "./supervisor.js";
import { createTray } from "./tray.js";
import { parseUserEnv } from "./user-env.js";
import { isDowngrade } from "./versioning.js";
import { APP_PARTITION, createAppWindow } from "./window.js";

const DATABASE_NAME = "openaudiohub";
const DATABASE_USER = "oah";
const ENV_TEMPLATE =
    "# OpenAudioHub settings. Only the keys listed in the documentation are read.\n# Restart the app after changing this file.\n";

/** The menu-bar item. Kept at module level so it is not garbage collected. */
let tray: Tray | null = null;

/** Bundle root: the Resources folder in the packaged app, desktop/build in development. */
export function bundleRootFor(): string {
    if (app.isPackaged) return process.resourcesPath;
    return resolve(__dirname, "..", "..", "build");
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Writes a start-up failure to the main log, so the reason survives the error dialog. Never throws. */
function recordStartupFailure(error: unknown): void {
    try {
        const paths = resolvePaths(process.env);
        mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
        appendFileSync(
            join(paths.logs, "main.log"),
            `${new Date().toISOString()} could not start: ${errorText(error)}\n`,
            { mode: 0o600 },
        );
    } catch {
        // The dialog still shows the reason.
    }
}

async function main(): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    app.setName("OpenAudioHub");

    const bundleRoot = bundleRootFor();
    const paths = resolvePaths(process.env);
    mkdirSync(paths.userData, { recursive: true, mode: 0o700 });
    mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
    const log = (message: string): void => {
        appendFileSync(
            join(paths.logs, "main.log"),
            `${new Date().toISOString()} ${message}\n`,
            { mode: 0o600 },
        );
    };
    log("main process started");

    if (app.isPackaged) {
        // D-346: a browser download leaves quarantine on the bundle, and quarantined ad-hoc binaries are
        // killed on first run. Remove it before any child process starts.
        const bundle = bundleOf(process.execPath);
        if (bundle) {
            try {
                if (removeQuarantine(bundle))
                    log("removed quarantine from the app bundle");
            } catch (error) {
                log(`quarantine removal failed: ${errorText(error)}`);
            }
        }
        // OAH_SKIP_MOVE_TO_APPLICATIONS=1 is for automated runs of a packaged build outside /Applications: the
        // move prompt is modal and would block them.
        if (
            process.env.OAH_SKIP_MOVE_TO_APPLICATIONS !== "1" &&
            !app.isInApplicationsFolder() &&
            app.moveToApplicationsFolder()
        ) {
            // The app moved itself to /Applications and relaunches from there.
            log("moved to Applications");
            return;
        }
    }

    const loadedConfig = loadConfig(paths.config);
    const currentVersion = app.getVersion();
    const lastVersion = loadedConfig.config.lastVersion;
    if (lastVersion && isDowngrade(lastVersion, currentVersion)) {
        // A newer version wrote this data; its migrations may not be understood here (T13.6).
        throw new Error(
            `These files were written by OpenAudioHub ${lastVersion}, which is newer than this app (${currentVersion}). Install ${lastVersion} or later.`,
        );
    }
    const databaseExists = readPgVersion(paths.pgdata) !== null;
    const { secrets } = loadOrCreateSecrets({
        path: paths.secrets,
        databaseExists,
    });

    const chosen = await choosePorts(loadedConfig.config.ports);
    let config = { ...loadedConfig.config, ports: chosen.ports };
    saveConfig(paths.config, config);
    const ports = chosen.ports;
    const appOrigin = `http://127.0.0.1:${ports.app}`;
    const launchSecret = randomBytes(32).toString("hex");

    const userEnvText = existsSync(paths.userEnv)
        ? readFileSync(paths.userEnv, "utf8")
        : "";
    const userEnv = parseUserEnv(userEnvText).values;

    const postgresBin = join(bundleRoot, "postgres", "bin");
    const manager = new PostgresManager({
        binDir: postgresBin,
        dataDir: paths.pgdata,
        logFile: join(paths.logs, "postgres.log"),
        port: ports.postgres,
        password: secrets.POSTGRES_PASSWORD,
        userName: DATABASE_USER,
        childEnv: childEnvironment(postgresBin, {}),
        scratchDir: paths.userData,
    });
    const postgresAdminUrl = `postgres://${DATABASE_USER}:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${ports.postgres}/postgres`;
    const databaseUrl = `postgres://${DATABASE_USER}:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${ports.postgres}/${DATABASE_NAME}`;

    const ffmpegBin = join(bundleRoot, "bin");
    const serverDir = join(bundleRoot, "server");
    const webEnv = childEnvironment(ffmpegBin, {
        ...userEnv,
        PORT: String(ports.app),
        OAH_LISTEN_HOST: "127.0.0.1",
        APP_URL: appOrigin,
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET,
        ENCRYPTION_KEY: secrets.ENCRYPTION_KEY,
        API_TOKEN_HASH_SECRET: secrets.API_TOKEN_HASH_SECRET,
        AUDIO_PIPELINE_ENABLED: "true",
        AUDIO_PIPELINE_BASE_URL: `http://127.0.0.1:${ports.pipeline}`,
        AUDIO_PIPELINE_TOKEN: secrets.AUDIO_PIPELINE_TOKEN,
        LOCAL_STORAGE_PATH: paths.storage,
        DEFAULT_STORAGE_TYPE: "local",
        OAH_DESKTOP: "1",
        OAH_DESKTOP_LAUNCH_SECRET: launchSecret,
        ...(loadedConfig.config.boundUserId
            ? { OAH_DESKTOP_USER_ID: loadedConfig.config.boundUserId }
            : {}),
    });

    const migrate = new ProcessService(
        "migrate",
        () =>
            fromUtilityProcess(
                utilityProcess.fork(join(serverDir, "migrate.mjs"), [], {
                    // The migrations folder is read relative to the working directory (migrate-idempotent.ts).
                    cwd: serverDir,
                    env: { ...webEnv, DATABASE_URL: databaseUrl },
                    stdio: "pipe",
                    serviceName: "oah-migrate",
                }),
                join(paths.logs, "migrate.log"),
            ),
        undefined,
        true,
    );

    const pipeline = new ProcessService(
        "pipeline",
        pipelineFactory({
            pythonBin: join(bundleRoot, "python", "bin", "python3"),
            launcher: join(bundleRoot, "pipeline-launcher.py"),
            port: ports.pipeline,
            env: childEnvironment(ffmpegBin, {
                ...userEnv,
                AUDIO_PIPELINE_DATA_DIR: paths.pipelineData,
                AUDIO_PIPELINE_TOKEN: secrets.AUDIO_PIPELINE_TOKEN,
                AUDIO_PIPELINE_CORE_URL: appOrigin,
            }),
            cwd: join(bundleRoot, "audio-pipeline"),
            logFile: join(paths.logs, "pipeline.log"),
        }),
    );

    const web = new ProcessService("next", () =>
        fromUtilityProcess(
            utilityProcess.fork(join(serverDir, "server-desktop.js"), [], {
                cwd: serverDir,
                env: webEnv,
                stdio: "pipe",
                serviceName: "oah-next",
            }),
            join(paths.logs, "next.log"),
        ),
    );

    // Before an upgrade that may change the database, take a dump (T13.6). A failed dump stops startup, so
    // the migration never runs without one. A first start and a restart of the same version take none.
    const upgradeBackup: Service = {
        name: "backup",
        async start() {
            if (!databaseExists || lastVersion === currentVersion) return;
            const file = backupDatabase({
                pgDumpBin: join(postgresBin, "pg_dump"),
                host: "127.0.0.1",
                port: ports.postgres,
                user: DATABASE_USER,
                database: DATABASE_NAME,
                password: secrets.POSTGRES_PASSWORD,
                dir: paths.backups,
                label: `from-${lastVersion ?? "unknown"}-to-${currentVersion}`,
                env: childEnvironment(postgresBin, {}),
            });
            log(`database backup written before the upgrade: ${file}`);
        },
        async stop() {},
        onUnexpectedExit() {},
    };

    const supervisor = new Supervisor({
        services: [
            new PostgresService(manager, () =>
                ensureDatabase(postgresAdminUrl, DATABASE_NAME),
            ),
            upgradeBackup,
            migrate,
            pipeline,
            web,
        ],
        oneShot: ["backup", "migrate"],
        parallel: ["pipeline", "next"],
        log: (message) => console.info(`[supervisor] ${message}`),
    });
    supervisor.onEvent((event) => {
        log(`supervisor ${JSON.stringify(event)}`);
        if (event.type === "failed") {
            dialog.showErrorBox(
                "OpenAudioHub stopped",
                `${event.service} stopped: ${event.reason}`,
            );
        }
    });
    await supervisor.start();
    // The data now works with this version. The next start compares against it (T13.6).
    config = { ...config, lastVersion: currentVersion };
    saveConfig(paths.config, config);

    const partitionFetch = (
        url: string,
        init: { method: string; headers: Record<string, string> },
    ) =>
        session
            .fromPartition(APP_PARTITION)
            .fetch(url, init) as unknown as Promise<{
            status: number;
        }>;
    const reauthenticate = () =>
        exchangeSession({ appOrigin, launchSecret, fetch: partitionFetch });

    let mainWindow: BrowserWindow | null = null;

    /**
     * Opens the window, or brings the open one forward. Closing the window destroys it, which releases the
     * renderer, and the Dock icon follows the window (D-305). The app keeps running in the menu bar.
     */
    async function openWindow(): Promise<void> {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            return;
        }
        const win = createAppWindow({ appOrigin, reauthenticate });
        mainWindow = win;
        app.dock?.show();
        win.on("closed", () => {
            mainWindow = null;
            app.dock?.hide();
        });
        try {
            await reauthenticate();
            await win.loadURL(`${appOrigin}/dashboard`);
            log("window loaded /dashboard");
        } catch (error) {
            log(`window start failed: ${errorText(error)}`);
            throw error;
        }
    }

    function showOpenError(error: unknown): void {
        log(`could not open the window: ${errorText(error)}`);
        dialog.showErrorBox(
            "OpenAudioHub could not open the window",
            errorText(error),
        );
    }

    async function exportKeysInteractively(): Promise<void> {
        const confirmation = await dialog.showMessageBox({
            type: "warning",
            message: "Export the encryption keys?",
            detail: "The file contains the keys that protect your data. Store it somewhere safe and never share it.",
            buttons: ["Export…", "Cancel"],
            defaultId: 1,
            cancelId: 1,
        });
        if (confirmation.response !== 0) return;
        const target = await dialog.showSaveDialog({
            defaultPath: "openaudiohub-keys.json",
        });
        if (target.canceled || !target.filePath) return;
        exportSecrets(paths.secrets, target.filePath);
        log("exported the keys to a file the user chose");
    }

    tray = createTray(
        join(bundleRoot, "tray"),
        buildTrayTemplate(
            {
                openWindow: () => void openWindow().catch(showOpenError),
                openDataFolder: () => void shell.openPath(paths.userData),
                openLogsFolder: () => void shell.openPath(paths.logs),
                editConfiguration: () => {
                    if (!existsSync(paths.userEnv))
                        writeFileAtomic(paths.userEnv, ENV_TEMPLATE, 0o600);
                    void shell.openPath(paths.userEnv);
                },
                exportKeys: () => void exportKeysInteractively(),
                setLaunchAtLogin: (enabled) => {
                    if (!app.isPackaged) return;
                    app.setLoginItemSettings({ openAtLogin: enabled });
                    config = { ...config, launchAtLogin: enabled };
                    saveConfig(paths.config, config);
                    log(`launch at login set to ${enabled}`);
                },
                quit: () => app.quit(),
            },
            {
                launchAtLogin: config.launchAtLogin === true,
                launchAtLoginAvailable: app.isPackaged,
            },
        ),
    );

    // Started at login: the menu-bar item only, as D-305 asks. A normal launch opens the window.
    if (app.getLoginItemSettings().wasOpenedAtLogin) {
        log("started at login: menu bar only");
        app.dock?.hide();
    } else {
        try {
            await openWindow();
        } catch (error) {
            log(`window start failed: ${errorText(error)}`);
            throw error;
        }
    }

    // A click on the Dock icon with no window open brings the window back.
    app.on("activate", () => {
        void openWindow().catch(showOpenError);
    });
    // Opening the app again while it runs (single instance, T13.5) brings the window forward.
    app.on("second-instance", () => {
        void openWindow().catch(showOpenError);
    });

    // Electron does not wait for before-quit listeners. Prevent the quit, stop the services in order
    // (no orphan processes), then quit for real.
    let quitting = false;
    app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        log("quitting: stopping services");
        void supervisor.stop().finally(() => {
            log("services stopped");
            app.quit();
        });
    });
}

if (process.env.OAH_SKIP_MAIN !== "1") {
    void app
        .whenReady()
        .then(main)
        .catch((error: unknown) => {
            recordStartupFailure(error);
            dialog.showErrorBox(
                "OpenAudioHub could not start",
                errorText(error),
            );
            app.quit();
        });
}
