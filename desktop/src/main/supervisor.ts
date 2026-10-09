/**
 * Runs the app's services in order and restarts them after crashes (PLAN T13.3, D-319).
 *
 * Start order: postgres, then the one-shot migration, then the pipeline and the web server together.
 * Stop order is the reverse, and the whole stop must finish within the budget (5 s by default).
 * A service that crashes is restarted with exponential backoff. A service that keeps crashing
 * (more than `maxRestarts` within `windowMs`) is marked failed and the supervisor reports it.
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

export class Supervisor {
    private readonly byName = new Map<string, Service>();
    private readonly crashTimes = new Map<string, number[]>();
    private readonly failed = new Set<string>();
    private readonly listeners: Array<(event: SupervisorEvent) => void> = [];
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
            shutdownBudgetMs: options.shutdownBudgetMs ?? 5000,
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

    /** Starts the services. Throws when a sequential service fails to start. */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.stopping = false;
        const sequential = this.opts.services.filter(
            (s) => !this.opts.parallel.includes(s.name),
        );
        for (const service of sequential) {
            await this.startWithRetry(service);
        }
        await Promise.all(
            this.opts.services
                .filter((s) => this.opts.parallel.includes(s.name))
                .map((service) => this.startWithRetry(service)),
        );
        this.emit({ type: "started" });
    }

    private async startWithRetry(service: Service): Promise<void> {
        service.onUnexpectedExit((reason) => this.handleExit(service, reason));
        await service.start();
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
            service
                .start()
                .then(() => this.opts.log(`restarted ${service.name}`))
                .catch((error: unknown) =>
                    this.handleExit(
                        service,
                        error instanceof Error ? error.message : String(error),
                    ),
                );
        }, delayMs);
    }

    /**
     * Stops everything in reverse start order. Each stop gets an equal share of the budget and
     * one failing service does not stop the others.
     */
    async stop(): Promise<void> {
        if (!this.running) return;
        this.stopping = true;
        const order = [...this.opts.services].reverse();
        const share = Math.max(
            1,
            Math.floor(this.opts.shutdownBudgetMs / Math.max(1, order.length)),
        );
        for (const service of order) {
            try {
                await withTimeout(service.stop(share), share);
            } catch (error) {
                this.opts.log(
                    `stop ${service.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        this.running = false;
        this.emit({ type: "stopped" });
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
