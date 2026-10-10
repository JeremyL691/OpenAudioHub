/**
 * Runs the app's services in order and restarts them after crashes (PLAN T13.3, D-319).
 *
 * Start order: postgres, then the one-shot migration, then the pipeline and the web server together.
 * Stop order is the reverse, and the whole stop must finish within the budget (10 s by default).
 * A service that crashes is restarted with exponential backoff. A service that keeps crashing
 * (more than `maxRestarts` within `windowMs`) is marked failed and the supervisor reports it.
 * stop() may be called while start() is still running; start() then rejects with SupervisorStoppedError.
 */

export interface Service {
    readonly name: string;
    /** Resolves when the service is ready (listening, or finished for one-shot services). */
    start(): Promise<void>;
    /** Stops the service. Implementations must be idempotent. */
    stop(graceMs: number): Promise<void>;
    /** Registers a callback for unexpected exits (not requested by stop). */
    onUnexpectedExit(callback: (reason: string) => void): void;
}

export interface SupervisorOptions {
    /** Services in start order. They are stopped in reverse. */
    services: Service[];
    /** One-shot services are started in order and not restarted (for example migrations). */
    oneShot?: string[];
    /** Services started together after the sequential ones. Keyed by name in `services`. */
    parallel?: string[];
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    maxRestarts?: number;
    windowMs?: number;
    /** Time for one stop() call, shared by every service and counted from the moment stop() is called. */
    shutdownBudgetMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    log?: (message: string) => void;
}

export type SupervisorEvent =
    | { type: "started" }
    | {
          type: "restarting";
          service: string;
          attempt: number;
          delayMs: number;
          reason: string;
      }
    | { type: "failed"; service: string; reason: string }
    | { type: "stopped" };

/** Thrown by start() when stop() was requested while start() was still running. */
export class SupervisorStoppedError extends Error {
    constructor() {
        super("stopped while starting");
        this.name = "SupervisorStoppedError";
    }
}

/**
 * No service is given less than this to stop, even when the budget is spent. A zero grace would send
 * SIGKILL at once and skip the clean shutdown (a fast Postgres stop still needs a moment).
 */
const MIN_STOP_GRACE_MS = 500;

export class Supervisor {
    private readonly byName = new Map<string, Service>();
    private readonly crashTimes = new Map<string, number[]>();
    private readonly failed = new Set<string>();
    private readonly listeners: Array<(event: SupervisorEvent) => void> = [];
    /** Restarts whose start is still in progress. stop() waits for them. */
    private readonly restarts = new Set<Promise<void>>();
    private startPromise: Promise<void> | null = null;
    private stopPromise: Promise<void> | null = null;
    /** Epoch milliseconds by which the current stop() must finish. */
    private stopDeadline = 0;
    private stopping = false;
    private running = false;
    private readonly opts: Required<
        Omit<SupervisorOptions, "services" | "oneShot" | "parallel">
    > & {
        services: Service[];
        oneShot: string[];
        parallel: string[];
    };

    constructor(options: SupervisorOptions) {
        this.opts = {
            services: options.services,
            oneShot: options.oneShot ?? [],
            parallel: options.parallel ?? [],
            backoffBaseMs: options.backoffBaseMs ?? 1000,
            backoffMaxMs: options.backoffMaxMs ?? 30_000,
            maxRestarts: options.maxRestarts ?? 5,
            windowMs: options.windowMs ?? 120_000,
            shutdownBudgetMs: options.shutdownBudgetMs ?? 10_000,
            now: options.now ?? (() => Date.now()),
            setTimer:
                options.setTimer ??
                ((callback, ms) => setTimeout(callback, ms)),
            log: options.log ?? (() => undefined),
        };
        for (const service of options.services) {
            this.byName.set(service.name, service);
        }
    }

    onEvent(listener: (event: SupervisorEvent) => void): void {
        this.listeners.push(listener);
    }

    private emit(event: SupervisorEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    isFailed(name: string): boolean {
        return this.failed.has(name);
    }

    /**
     * Starts the services. Throws when a sequential service fails to start, and rejects with
     * SupervisorStoppedError when stop() is called first. A second call returns the same promise.
     */
    start(): Promise<void> {
        if (!this.startPromise) {
            this.running = true;
            this.stopping = false;
            this.startPromise = this.launch();
        }
        return this.startPromise;
    }

    private async launch(): Promise<void> {
        const sequential = this.opts.services.filter(
            (s) => !this.opts.parallel.includes(s.name),
        );
        for (const service of sequential) {
            await this.startWithRetry(service);
        }
        // allSettled, not all: a failed service must not return while its sibling is still starting. stop()
        // waits for this promise, so the sibling would otherwise be left running outside the stop order.
        const results = await Promise.allSettled(
            this.opts.services
                .filter((s) => this.opts.parallel.includes(s.name))
                .map((service) => this.startWithRetry(service)),
        );
        const failure = results.find(
            (result): result is PromiseRejectedResult =>
                result.status === "rejected",
        );
        if (failure) throw failure.reason;
        this.emit({ type: "started" });
    }

    private async startWithRetry(service: Service): Promise<void> {
        if (this.stopping) throw new SupervisorStoppedError();
        service.onUnexpectedExit((reason) => this.handleExit(service, reason));
        await service.start();
        // stop() cannot see a service that is still starting. The check after the start lets stop() stop
        // what has started, and the check before the next start keeps the remaining services from starting.
        if (this.stopping) throw new SupervisorStoppedError();
        this.opts.log(`started ${service.name}`);
    }

    private handleExit(service: Service, reason: string): void {
        if (this.stopping) return;
        if (this.opts.oneShot.includes(service.name)) {
            this.failed.add(service.name);
            this.emit({ type: "failed", service: service.name, reason });
            return;
        }
        const now = this.opts.now();
        const recent = (this.crashTimes.get(service.name) ?? []).filter(
            (t) => now - t < this.opts.windowMs,
        );
        recent.push(now);
        this.crashTimes.set(service.name, recent);
        if (recent.length > this.opts.maxRestarts) {
            this.failed.add(service.name);
            this.emit({ type: "failed", service: service.name, reason });
            return;
        }
        const delayMs = Math.min(
            this.opts.backoffBaseMs * 2 ** (recent.length - 1),
            this.opts.backoffMaxMs,
        );
        this.emit({
            type: "restarting",
            service: service.name,
            attempt: recent.length,
            delayMs,
            reason,
        });
        this.opts.setTimer(() => {
            if (this.stopping) return;
            const restart: Promise<void> = service
                .start()
                .then(async () => {
                    this.opts.log(`restarted ${service.name}`);
                    // stop() can run while this start is in progress, and it does not see the service yet.
                    // Stop it here. shutdown() waits for this chain, so the stop is finished before stop() resolves.
                    if (this.stopping)
                        await this.stopOne(service, this.graceMs());
                })
                .catch((error: unknown) =>
                    this.handleExit(
                        service,
                        error instanceof Error ? error.message : String(error),
                    ),
                )
                .finally(() => {
                    this.restarts.delete(restart);
                });
            this.restarts.add(restart);
        }, delayMs);
    }

    /**
     * Stops everything in reverse start order, after any start or restart still in flight has settled.
     * The services in `parallel` stop together first, and the others stop one at a time. All of them share
     * one deadline. One failing service does not stop the others. Calling stop() again while a stop is
     * running returns the same promise, so each service is stopped once.
     */
    stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        if (!this.running) return Promise.resolve();
        this.stopping = true;
        this.stopDeadline = this.opts.now() + this.opts.shutdownBudgetMs;
        this.stopPromise = this.shutdown().finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }

    private async shutdown(): Promise<void> {
        // initdb can take minutes, so start() may still be running. Waiting for it (and for any restart) means
        // every service that has started is in the stop order below. A failed start is not an error here.
        await this.startPromise?.catch(() => undefined);
        await Promise.allSettled([...this.restarts]);
        const order = [...this.opts.services].reverse();
        const parallel = order.filter((s) =>
            this.opts.parallel.includes(s.name),
        );
        const sequential = order.filter(
            (s) => !this.opts.parallel.includes(s.name),
        );
        await Promise.all(
            parallel.map((service) => this.stopOne(service, this.graceMs())),
        );
        for (const service of sequential) {
            await this.stopOne(service, this.graceMs());
        }
        this.running = false;
        this.startPromise = null;
        this.emit({ type: "stopped" });
    }

    /** The grace for the next service: what is left of the shutdown budget, never less than MIN_STOP_GRACE_MS. */
    private graceMs(): number {
        return Math.max(MIN_STOP_GRACE_MS, this.stopDeadline - this.opts.now());
    }

    /** Stops one service within its grace. A failure or a timeout is logged and does not stop the others. */
    private async stopOne(service: Service, graceMs: number): Promise<void> {
        try {
            await withTimeout(service.stop(graceMs), graceMs);
        } catch (error) {
            this.opts.log(
                `stop ${service.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}
