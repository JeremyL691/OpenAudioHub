import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import postgres from "postgres";
import { writeFileAtomic } from "./atomic-file.js";

/** The data directory format this build understands (PLAN D-306). */
export const POSTGRES_MAJOR = "16";

const CONF_BEGIN = "# BEGIN OpenAudioHub (managed; rewritten on every start)";
const CONF_END = "# END OpenAudioHub (managed)";

export class PortInUseError extends Error {
    constructor(readonly port: number) {
        super(
            `PostgreSQL could not bind 127.0.0.1:${port} because the port is in use`,
        );
        this.name = "PortInUseError";
    }
}

export interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export function runCommand(
    file: string,
    args: string[],
    options: { env: Record<string, string>; timeoutMs: number; cwd?: string },
): Promise<CommandResult> {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            {
                env: options.env,
                timeout: options.timeoutMs,
                cwd: options.cwd,
                encoding: "utf8",
                maxBuffer: 1 << 22,
            },
            (error, stdout, stderr) => {
                const code =
                    error &&
                    typeof (error as { code?: unknown }).code === "number"
                        ? (error as { code: number }).code
                        : error
                          ? 1
                          : 0;
                resolve({
                    code,
                    stdout: String(stdout),
                    stderr: String(stderr),
                });
            },
        );
    });
}

/**
 * True when initdb was interrupted: it writes PG_VERSION before it finishes, so the file can exist while
 * global/pg_control, the last thing bootstrap writes, does not. Such a directory is not a cluster.
 */
function isInterruptedInit(dataDir: string): boolean {
    return (
        existsSync(join(dataDir, "PG_VERSION")) &&
        !existsSync(join(dataDir, "global", "pg_control"))
    );
}

/**
 * Returns the data directory's major version, or null when no usable cluster exists yet. An interrupted
 * initialization counts as no cluster, so index.ts sees no database and initialize() can discard it.
 */
export function readPgVersion(dataDir: string): string | null {
    if (isInterruptedInit(dataDir)) return null;
    const file = join(dataDir, "PG_VERSION");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/**
 * True when `commandLine` (from `ps -o command=`) is a postgres server running on `dataDir`. The check is
 * exact: the executable must be named postgres or postmaster, and `-D` must be followed by the whole data
 * directory as one argument. A substring match would also accept `pgdata-old`, or an editor that has the path
 * in its arguments, and the caller signals the pid this returns true for. The executable's folder is not
 * checked: a postmaster left by this app before it moved (to /Applications) or was replaced by an update runs
 * from another bundle path, and it must still be stopped before its pid file goes. The executable is the text
 * before the first ` -` flag, so a path containing spaces still matches.
 */
export function isPostmasterFor(commandLine: string, dataDir: string): boolean {
    const flagStart = commandLine.search(/\s-/);
    const head = (
        flagStart === -1 ? commandLine : commandLine.slice(0, flagStart)
    ).trim();
    // A second absolute path before the flags means another program was given the binary as an argument
    // (`vim /…/postgres -D …`). Spaces inside one path are fine; a space followed by `/` is not.
    if (/\s\//.test(head)) return false;
    const executable = resolve(head);
    const name = basename(executable);
    if (name !== "postgres" && name !== "postmaster") return false;
    const pattern = new RegExp(
        `(?:^|\\s)-D ?${escapeRegExp(resolve(dataDir))}/?(?=\\s|$)`,
    );
    return pattern.test(commandLine);
}

/** The managed block that every start rewrites (D-306): loopback only, UTC, scram, no unix socket. */
export function renderManagedConf(port: number): string {
    return [
        CONF_BEGIN,
        "listen_addresses = '127.0.0.1'",
        `port = ${port}`,
        "unix_socket_directories = ''",
        "max_connections = 30",
        "timezone = 'UTC'",
        "log_timezone = 'UTC'",
        "password_encryption = 'scram-sha-256'",
        CONF_END,
        "",
    ].join("\n");
}

/** Replaces the managed block in postgresql.conf, leaving the rest of the file alone. */
export function applyManagedConf(confPath: string, port: number): void {
    const current = existsSync(confPath) ? readFileSync(confPath, "utf8") : "";
    const pattern = new RegExp(
        `${escapeRegExp(CONF_BEGIN)}[\\s\\S]*?${escapeRegExp(CONF_END)}\\n?`,
        "g",
    );
    const base = current.replace(pattern, "");
    const separator = base.length === 0 || base.endsWith("\n") ? "" : "\n";
    writeFileAtomic(
        confPath,
        `${base}${separator}${renderManagedConf(port)}`,
        0o600,
    );
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a server on a data directory needs to be found and stopped. */
export interface PostmasterLocation {
    /** Directory with initdb, pg_ctl, postgres, pg_isready (the staged bin directory). */
    binDir: string;
    dataDir: string;
    /** Child environment: PATH limited to the bundle, TZ=UTC (PLAN D-319). */
    childEnv: Record<string, string>;
}

export interface PostgresManagerOptions extends PostmasterLocation {
    logFile: string;
    port: number;
    /** Superuser password, written to a 0600 file only for initdb. */
    password: string;
    userName?: string;
    /** Directory where the temporary password file is created (inside the user data folder). */
    scratchDir: string;
    /** Receives notices such as a discarded interrupted initialization. Defaults to console.warn. */
    log?: (message: string) => void;
}

/**
 * Fast shutdown of the server on `location.dataDir` (pg_ctl stop -m fast). Does nothing when no live server
 * holds the data directory; a pid file whose process is gone is removed.
 */
export async function stopPostmaster(
    location: PostmasterLocation,
): Promise<void> {
    const pidFile = join(location.dataDir, "postmaster.pid");
    if (!existsSync(pidFile)) {
        return;
    }
    const pid = readPostmasterPid(pidFile);
    if (pid === null || !processAlive(pid)) {
        rmSync(pidFile, { force: true });
        return;
    }
    const result = await runCommand(
        join(location.binDir, "pg_ctl"),
        ["-D", location.dataDir, "-m", "fast", "-w", "-t", "30", "stop"],
        { env: location.childEnv, timeoutMs: 60_000 },
    );
    if (
        result.code !== 0 &&
        !/is not running|No such file/i.test(`${result.stdout}${result.stderr}`)
    ) {
        throw new Error(`pg_ctl stop failed (exit ${result.code})`);
    }
}

/**
 * Stops a postmaster that an earlier run of the App left on this data directory. When the App's main process is
 * killed, the server keeps running with no parent to stop it, and its port stays busy. Calling this before the
 * ports are chosen keeps the saved port free, so the App does not move Postgres for its own orphan.
 *
 * Only a process whose command line is a postgres server on exactly this data directory is stopped (see
 * isPostmasterFor). The pid file is removed when its process is gone, or after that server was stopped. Call it
 * only while the App holds the single-instance lock: a running App owns its postmaster, and must not be stopped.
 */
export async function stopStalePostmaster(
    location: PostmasterLocation,
): Promise<void> {
    const pidFile = join(location.dataDir, "postmaster.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number.parseInt(
        readFileSync(pidFile, "utf8").split("\n")[0] ?? "",
        10,
    );
    if (!Number.isInteger(pid) || pid <= 0 || !processAlive(pid)) {
        rmSync(pidFile, { force: true });
        return;
    }
    const command = await runCommand(
        "ps",
        ["-o", "command=", "-p", String(pid)],
        {
            env: {},
            timeoutMs: 5_000,
        },
    );
    if (isPostmasterFor(command.stdout, location.dataDir)) {
        await stopPostmaster(location);
    }
    rmSync(pidFile, { force: true });
}

export class PostgresManager {
    private readonly userName: string;

    constructor(private readonly options: PostgresManagerOptions) {
        this.userName = options.userName ?? "oah";
    }

    private bin(name: string): string {
        return join(this.options.binDir, name);
    }

    private get confPath(): string {
        return join(this.options.dataDir, "postgresql.conf");
    }

    /**
     * Creates the cluster on first use and refuses data written by another major version. An interrupted
     * initdb is moved aside, never deleted, so its files stay available for diagnosis.
     */
    async initialize(): Promise<{ created: boolean }> {
        if (isInterruptedInit(this.options.dataDir)) {
            const aside = `${resolve(this.options.dataDir)}.failed-init-${Date.now()}`;
            renameSync(this.options.dataDir, aside);
            (this.options.log ?? console.warn)(
                `PostgreSQL initialization was interrupted; moved the data directory to ${aside} and initializing again`,
            );
        }
        const version = readPgVersion(this.options.dataDir);
        if (version !== null) {
            if (version !== POSTGRES_MAJOR) {
                throw new Error(
                    `the data directory belongs to PostgreSQL ${version}; this app runs PostgreSQL ${POSTGRES_MAJOR}`,
                );
            }
            applyManagedConf(this.confPath, this.options.port);
            return { created: false };
        }

        mkdirSync(this.options.scratchDir, { recursive: true, mode: 0o700 });
        const pwfile = join(
            this.options.scratchDir,
            `.initdb-pw-${randomBytes(6).toString("hex")}`,
        );
        writeFileSync(pwfile, `${this.options.password}\n`, { mode: 0o600 });
        try {
            const result = await runCommand(
                this.bin("initdb"),
                [
                    "-D",
                    this.options.dataDir,
                    "-U",
                    this.userName,
                    "-E",
                    "UTF8",
                    "--lc-collate=C",
                    "--lc-ctype=en_US.UTF-8",
                    "--data-checksums",
                    "--auth=scram-sha-256",
                    `--pwfile=${pwfile}`,
                ],
                { env: this.options.childEnv, timeoutMs: 300_000 },
            );
            if (result.code !== 0) {
                throw new Error(
                    `initdb failed (exit ${result.code}); see the PostgreSQL log`,
                );
            }
        } finally {
            rmSync(pwfile, { force: true });
        }
        applyManagedConf(this.confPath, this.options.port);
        return { created: true };
    }

    /** True when a server answers on the configured port. */
    async isReady(): Promise<boolean> {
        const result = await runCommand(
            this.bin("pg_isready"),
            ["-h", "127.0.0.1", "-p", String(this.options.port), "-t", "2"],
            { env: this.options.childEnv, timeoutMs: 5_000 },
        );
        return result.code === 0;
    }

    /**
     * Starts the server. A leftover postmaster from an earlier run that owns this data directory is
     * stopped first. A bind failure raises PortInUseError so the caller can choose another port.
     */
    async start(): Promise<void> {
        applyManagedConf(this.confPath, this.options.port);
        await stopStalePostmaster(this.options);
        if (await this.isReady()) {
            return;
        }
        const result = await runCommand(
            this.bin("pg_ctl"),
            [
                "-D",
                this.options.dataDir,
                "-l",
                this.options.logFile,
                "-w",
                "-t",
                "60",
                "start",
            ],
            { env: this.options.childEnv, timeoutMs: 120_000 },
        );
        if (result.code !== 0) {
            const tail = readTail(this.options.logFile, 4096);
            if (
                /Address already in use|could not bind|could not create listen socket|could not create any TCP\/IP sockets/i.test(
                    tail,
                )
            ) {
                throw new PortInUseError(this.options.port);
            }
            throw new Error(
                `pg_ctl start failed (exit ${result.code}); see the PostgreSQL log`,
            );
        }
        if (!(await this.isReady())) {
            throw new Error(
                "PostgreSQL started but does not answer on its port",
            );
        }
    }

    /** Fast shutdown: active transactions are rolled back and the data is flushed. */
    async stop(): Promise<void> {
        await stopPostmaster(this.options);
    }
}

function readPostmasterPid(pidFile: string): number | null {
    const pid = Number.parseInt(
        readFileSync(pidFile, "utf8").split("\n")[0] ?? "",
        10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function readTail(path: string, bytes: number): string {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf8");
    return text.length > bytes ? text.slice(text.length - bytes) : text;
}

/** Creates the application database when it is missing. The superuser owns the cluster (PLAN D-306). */
export async function ensureDatabase(
    adminUrl: string,
    databaseName: string,
): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) {
        throw new Error(
            "database name must be lower-case letters, digits and underscores",
        );
    }
    const client = postgres(adminUrl, { max: 1, connect_timeout: 10 });
    try {
        const rows =
            await client`select 1 from pg_database where datname = ${databaseName}`;
        if (rows.length === 0) {
            await client.unsafe(`create database ${databaseName}`);
        }
    } finally {
        await client.end({ timeout: 2 });
    }
}
