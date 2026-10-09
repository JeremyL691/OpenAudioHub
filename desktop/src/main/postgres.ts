import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

/** Returns the data directory's major version, or null when the cluster does not exist yet. */
export function readPgVersion(dataDir: string): string | null {
    const file = join(dataDir, "PG_VERSION");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
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

export interface PostgresManagerOptions {
    /** Directory with initdb, pg_ctl, postgres, pg_isready (the staged bin directory). */
    binDir: string;
    dataDir: string;
    logFile: string;
    port: number;
    /** Superuser password, written to a 0600 file only for initdb. */
    password: string;
    userName?: string;
    /** Child environment: PATH limited to the bundle, TZ=UTC (PLAN D-319). */
    childEnv: Record<string, string>;
    /** Directory where the temporary password file is created (inside the user data folder). */
    scratchDir: string;
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

    /** Creates the cluster on first use and refuses data written by another major version. */
    async initialize(): Promise<{ created: boolean }> {
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
        await this.clearStalePostmaster();
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
        const pidFile = join(this.options.dataDir, "postmaster.pid");
        if (!existsSync(pidFile)) {
            return;
        }
        const pid = readPostmasterPid(pidFile);
        if (pid === null || !processAlive(pid)) {
            rmSync(pidFile, { force: true });
            return;
        }
        const result = await runCommand(
            this.bin("pg_ctl"),
            [
                "-D",
                this.options.dataDir,
                "-m",
                "fast",
                "-w",
                "-t",
                "30",
                "stop",
            ],
            { env: this.options.childEnv, timeoutMs: 60_000 },
        );
        if (
            result.code !== 0 &&
            !/is not running|No such file/i.test(
                `${result.stdout}${result.stderr}`,
            )
        ) {
            throw new Error(`pg_ctl stop failed (exit ${result.code})`);
        }
    }

    private async clearStalePostmaster(): Promise<void> {
        const pidFile = join(this.options.dataDir, "postmaster.pid");
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
            { env: {}, timeoutMs: 5_000 },
        );
        if (command.stdout.includes(this.options.dataDir)) {
            await this.stop();
        }
        rmSync(pidFile, { force: true });
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
