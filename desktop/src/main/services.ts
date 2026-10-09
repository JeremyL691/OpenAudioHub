import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
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

/** A service backed by a child process. A stop request sets `requested` so the exit is not reported as a crash. */
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
    ) {}

    onUnexpectedExit(callback: (reason: string) => void): void {
        this.exitCallback = callback;
    }

    async start(): Promise<void> {
        this.requested = false;
        const handle = this.factory();
        this.handle = handle;
        handle.onExit((code) => {
            if (this.handle !== handle) return;
            this.handle = null;
            if (!this.requested)
                this.exitCallback?.(`exited with code ${code ?? "signal"}`);
        });
        await this.readiness(handle);
    }

    async stop(graceMs: number): Promise<void> {
        this.requested = true;
        const handle = this.handle;
        if (!handle) return;
        handle.kill("SIGTERM");
        const exited = await waitFor(() => this.handle !== handle, graceMs);
        if (!exited) {
            handle.kill("SIGKILL");
            await waitFor(() => this.handle !== handle, 1000);
        }
        this.handle = null;
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

/**
 * Appends a child's stdout and stderr to a log file. Without a reader the pipe fills up and the child
 * blocks, so every piped service gets a sink (PLAN T13.3 logs).
 */
function attachLog(
    child: {
        stdout: NodeJS.ReadableStream | null;
        stderr: NodeJS.ReadableStream | null;
    },
    logFile: string,
): WriteStream {
    const sink = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    child.stdout?.pipe(sink, { end: false });
    child.stderr?.pipe(sink, { end: false });
    return sink;
}

/** Wraps a Node child process as a ProcessHandle. Its output goes to `logFile` when one is given. */
export function fromChildProcess(
    child: ChildProcess,
    logFile?: string,
): ProcessHandle {
    const sink = logFile ? attachLog(child, logFile) : null;
    return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        onExit: (callback) => {
            // "close" follows the last output chunk, so the log has everything the child wrote.
            child.once("close", (code) => {
                sink?.end();
                callback(code);
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
    const sink = logFile ? attachLog(child, logFile) : null;
    return {
        pid: child.pid,
        kill: () => child.kill(),
        onExit: (callback) => {
            child.once("exit", (code) => {
                sink?.end();
                callback(code);
            });
        },
    };
}
