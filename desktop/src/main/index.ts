/**
 * Electron main process entry (PLAN §20, T13.3–T13.5). Start order: data layout and secrets, ports,
 * PostgreSQL, the one-shot migration, then the pipeline and the web server, then the session exchange
 * and the window. The layout under `bundleRoot` matches the app's Resources folder, so the same code
 * runs from a development build (desktop/build) and from the packaged app.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, dialog, utilityProcess } from "electron";
import { loadConfig, saveConfig } from "./config.js";
import { resolvePaths } from "./paths.js";
import { choosePorts } from "./ports.js";
import { ensureDatabase, PostgresManager, readPgVersion } from "./postgres.js";
import { loadOrCreateSecrets } from "./secrets.js";
import {
    childEnvironment,
    fromUtilityProcess,
    PostgresService,
    ProcessService,
    pipelineFactory,
} from "./services.js";
import { exchangeSession } from "./session.js";
import { Supervisor } from "./supervisor.js";
import { parseUserEnv } from "./user-env.js";
import { createAppWindow } from "./window.js";

const DATABASE_NAME = "openaudiohub";
const DATABASE_USER = "oah";

/** Bundle root: the Resources folder in the packaged app, desktop/build in development. */
export function bundleRootFor(): string {
    if (app.isPackaged) return process.resourcesPath;
    return resolve(__dirname, "..", "..", "build");
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

    const loadedConfig = loadConfig(paths.config);
    const databaseExists = readPgVersion(paths.pgdata) !== null;
    const { secrets } = loadOrCreateSecrets({
        path: paths.secrets,
        databaseExists,
    });

    const chosen = await choosePorts(loadedConfig.config.ports);
    saveConfig(paths.config, { ...loadedConfig.config, ports: chosen.ports });
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

    const migrate = new ProcessService("migrate", () =>
        fromUtilityProcess(
            utilityProcess.fork(join(serverDir, "migrate.mjs"), [], {
                env: { ...webEnv, DATABASE_URL: databaseUrl },
                stdio: "pipe",
                serviceName: "oah-migrate",
            }),
        ),
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
        ),
    );

    const supervisor = new Supervisor({
        services: [
            new PostgresService(manager, () =>
                ensureDatabase(postgresAdminUrl, DATABASE_NAME),
            ),
            migrate,
            pipeline,
            web,
        ],
        oneShot: ["migrate"],
        parallel: ["pipeline", "next"],
        log: (message) => console.info(`[supervisor] ${message}`),
    });
    supervisor.onEvent((event) => {
        if (event.type === "failed") {
            dialog.showErrorBox(
                "OpenAudioHub stopped",
                `${event.service} stopped: ${event.reason}`,
            );
        }
    });
    await supervisor.start();

    const partitionFetch = (
        url: string,
        init: { method: string; headers: Record<string, string> },
    ) =>
        window.webContents.session.fetch(url, init) as unknown as Promise<{
            status: number;
        }>;
    const window = createAppWindow({
        appOrigin,
        reauthenticate: () =>
            exchangeSession({ appOrigin, launchSecret, fetch: partitionFetch }),
    });
    await exchangeSession({ appOrigin, launchSecret, fetch: partitionFetch });
    await window.loadURL(`${appOrigin}/dashboard`);

    app.on("before-quit", () => {
        void supervisor.stop();
    });
}

if (process.env.OAH_SKIP_MAIN !== "1") {
    void app
        .whenReady()
        .then(main)
        .catch((error: unknown) => {
            dialog.showErrorBox(
                "OpenAudioHub could not start",
                error instanceof Error ? error.message : String(error),
            );
            app.quit();
        });
}
