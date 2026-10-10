import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { UtilityProcess } from "electron";
import type { PostgresManager } from "./postgres.js";
import type { Service } from "./supervisor.js";

/** Environment for every child process: an allow-list only (PLAN D-319). Secrets are added by the caller. */
export function childEnvironment(
    binDir: string,
    extra: Record<string, string>,
): Record<string, string> {
    return {
        PATH: `${binDir}:/usr/bin:/bin`,
        LANG: "en_US.UTF-8",
        TZ: "UTC",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        ...extra,
    };
}

export interface ProcessHandle {
    readonly pid: number | undefined;
    kill(signal?: NodeJS.Signals | number): boolean;
    onExit(callback: (code: number | null) => void): void;
}

export type ProcessFactory = () => ProcessHandle;

/**
 * A service backed by a child process. A stop request sets `requested` so the exit is not reported as a
 * crash. A one-shot service (the migration) is done when it exits with code 0: start() resolves then, and
 * a non-zero exit makes start() reject. Its exit is not reported as a crash.
 */
export class ProcessService implements Service {
    private handle: ProcessHandle | null = null;
    private requested = false;
    private exitCallback: ((reason: string) => void) | null = null;

    constructor(
        readonly name: string,
        private readonly factory: ProcessFactory,
        private readonly readiness: (
            handle: ProcessHandle,
        ) => Promise<void> = async () => undefined,
        private readonly oneShot = false,
    ) {}

    onUnexpectedExit(callback: (reason: string) => void): void {
        this.exitCallback = callback;
    }

    async start(): Promise<void> {
        this.requested = false;
        const handle = this.factory();
        this.handle = handle;
        const finished = new Promise<number | null>((resolve) => {
            handle.onExit((code) => {
                if (this.handle !== handle) return;
                this.handle = null;
                resolve(code);
                if (!this.requested && !this.oneShot)
                    this.exitCallback?.(`exited with code ${code ?? "signal"}`);
            });
        });
        if (this.oneShot) {
            const code = await finished;
            if (code !== 0)
                throw new Error(
                    `${this.name} exited with code ${code ?? "signal"}`,
                );
            return;
        }
        await this.readiness(handle);
    }

    /**
     * Asks the process to exit (SIGTERM), then kills it. The exit callback clears `handle`. It is not cleared
     * here, so a process that survives SIGKILL stays tracked and stop() reports it instead of hiding it.
     */
    async stop(graceMs: number): Promise<void> {
        this.requested = true;
        const handle = this.handle;
        if (!handle) return;
        handle.kill("SIGTERM");
        if (await waitFor(() => this.handle !== handle, graceMs)) return;
        handle.kill("SIGKILL");
        if (!(await waitFor(() => this.handle !== handle, 1000)))
            throw new Error(`${this.name} did not exit after SIGKILL`);
    }
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return condition();
}

/** How long a log waits for its pipes to end after the process exits. A grandchild can hold a pipe open. */
const LOG_DRAIN_MS = 2000;

interface OutputLog {
    /** Resolves once every byte written so far is in the log file. Never rejects. */
    finish(): Promise<void>;
}

/**
 * Appends a child's stdout and stderr to a log file. Without a reader the pipe fills up and the child
 * blocks, so every piped service gets a sink (PLAN T13.3 logs). The exit path calls `finish()`, which ends
 * the sink only after the pipes have ended. The drain timer starts at that call rather than at attach time,
 * so output written while the service runs is always kept. Logging never crashes the main process: a sink
 * error is dropped, and the pipes keep draining so the child does not block on a full pipe.
 */
function attachLog(
    child: {
        stdout: NodeJS.ReadableStream | null;
        stderr: NodeJS.ReadableStream | null;
    },
    logFile: string,
): OutputLog {
    const sink = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    const streams = [child.stdout, child.stderr].filter(
        (stream): stream is NodeJS.ReadableStream => stream !== null,
    );
    const ended = streams.map(
        (stream) =>
            new Promise<void>((resolve) => {
                stream.once("end", () => resolve());
                stream.once("close", () => resolve());
            }),
    );
    for (const stream of streams) stream.pipe(sink, { end: false });
    // Registered after pipe(): pipe() unpipes a source when the sink fails, and this listener then resumes it.
    sink.on("error", () => {
        for (const stream of streams) stream.resume();
    });
    return {
        finish: async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const gaveUp = new Promise<void>((resolve) => {
                timer = setTimeout(resolve, LOG_DRAIN_MS);
            });
            await Promise.race([Promise.all(ended), gaveUp]);
            clearTimeout(timer);
            // A pipe that is still open here belongs to a grandchild. Its later output is discarded.
            for (const stream of streams) {
                stream.unpipe(sink);
                stream.resume();
            }
            await new Promise<void>((resolve) => {
                if (sink.destroyed) {
                    resolve();
                    return;
                }
                sink.once("close", () => resolve());
                sink.end(() => resolve());
            });
        },
    };
}

/** Calls the exit callback once the output is in the log file, or at once when the service has no log. */
function reportExit(
    log: OutputLog | null,
    code: number | null,
    callback: (code: number | null) => void,
): void {
    if (log) void log.finish().then(() => callback(code));
    else callback(code);
}

/** Wraps a Node child process as a ProcessHandle. Its output goes to `logFile` when one is given. */
export function fromChildProcess(
    child: ChildProcess,
    logFile?: string,
): ProcessHandle {
    const log = logFile ? attachLog(child, logFile) : null;
    return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        onExit: (callback) => {
            // "close" follows the last output chunk. A spawn failure (a missing binary, EACCES) emits "error"
            // with no pid, and that counts as an exit with no code. An "error" after a successful spawn (a
            // failed kill) is not an exit. Whichever report comes first wins, so the callback runs once.
            let reported = false;
            const report = (code: number | null) => {
                if (reported) return;
                reported = true;
                reportExit(log, code, callback);
            };
            child.once("close", (code) => report(code));
            child.on("error", () => {
                if (child.pid === undefined) report(null);
            });
        },
    };
}

/**
 * The pipeline runs as `python -I -B pipeline-launcher.py <port>`. Closing its stdin asks it to shut
 * down gracefully (PLAN T12.4); SIGTERM is the fallback.
 */
export function pipelineFactory(options: {
    pythonBin: string;
    launcher: string;
    port: number;
    env: Record<string, string>;
    cwd: string;
    logFile?: string;
}): ProcessFactory {
    return () =>
        fromChildProcess(
            spawn(
                options.pythonBin,
                ["-I", "-B", options.launcher, String(options.port)],
                {
                    cwd: options.cwd,
                    env: options.env,
                    stdio: ["pipe", "pipe", "pipe"],
                },
            ),
            options.logFile,
        );
}

export function pythonPath(bundleRoot: string): string {
    return join(bundleRoot, "python", "bin", "python3");
}

/** Postgres as a service: the manager starts the server, and a periodic readiness probe reports a crash. */
export class PostgresService implements Service {
    readonly name = "postgres";
    private timer: ReturnType<typeof setInterval> | null = null;
    private exitCallback: ((reason: string) => void) | null = null;
    private requested = false;
    private misses = 0;

    constructor(
        private readonly manager: PostgresManager,
        private readonly afterStart: () => Promise<void> = async () =>
            undefined,
        private readonly probeEveryMs = 2000,
    ) {}

    onUnexpectedExit(callback: (reason: string) => void): void {
        this.exitCallback = callback;
    }

    async start(): Promise<void> {
        this.requested = false;
        await this.manager.initialize();
        await this.manager.start();
        await this.afterStart();
        this.misses = 0;
        this.timer = setInterval(() => {
            void this.probe();
        }, this.probeEveryMs);
    }

    private async probe(): Promise<void> {
        if (this.requested) return;
        if (await this.manager.isReady()) {
            this.misses = 0;
            return;
        }
        this.misses += 1;
        if (this.misses >= 3) {
            this.stopProbe();
            this.exitCallback?.("PostgreSQL stopped answering");
        }
    }

    private stopProbe(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async stop(): Promise<void> {
        this.requested = true;
        this.stopProbe();
        await this.manager.stop();
    }
}

/** Wraps an Electron utility process (used for the web server and the migration). */
export function fromUtilityProcess(
    child: UtilityProcess,
    logFile?: string,
): ProcessHandle {
    const log = logFile ? attachLog(child, logFile) : null;
    return {
        pid: child.pid,
        kill: (signal) => {
            // UtilityProcess.kill() takes no signal and always sends the default one, so a SIGKILL escalation
            // goes to the OS directly. ESRCH means the process has already gone.
            if (signal !== "SIGKILL" || child.pid === undefined)
                return child.kill();
            try {
                process.kill(child.pid, "SIGKILL");
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH")
                    return false;
                throw error;
            }
        },
        onExit: (callback) => {
            child.once("exit", (code) => reportExit(log, code, callback));
        },
    };
}
