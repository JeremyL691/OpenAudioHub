import { describe, expect, it } from "vitest";
import {
    type Service,
    Supervisor,
    type SupervisorEvent,
} from "../src/main/supervisor.js";

interface FakeOptions {
    startFails?: boolean;
    log: string[];
}

function fakeService(name: string, options: FakeOptions) {
    let exitCallback: ((reason: string) => void) | null = null;
    let running = false;
    const service: Service & {
        crash(reason?: string): void;
        running(): boolean;
    } = {
        name,
        async start() {
            options.log.push(`start:${name}`);
            if (options.startFails) throw new Error(`${name} cannot start`);
            running = true;
        },
        async stop() {
            options.log.push(`stop:${name}`);
            running = false;
        },
        onUnexpectedExit(callback) {
            exitCallback = callback;
        },
        crash(reason = "exited with code 1") {
            running = false;
            exitCallback?.(reason);
        },
        running: () => running,
    };
    return service;
}

function harness(
    extra: {
        maxRestarts?: number;
        oneShot?: string[];
        parallel?: string[];
        startFails?: string[];
    } = {},
) {
    const log: string[] = [];
    const timers: Array<{ ms: number; run: () => void }> = [];
    let now = 0;
    const names = ["postgres", "migrate", "pipeline", "next"];
    const services = names.map((name) =>
        fakeService(name, {
            log,
            startFails: extra.startFails?.includes(name) ?? false,
        }),
    );
    const events: SupervisorEvent[] = [];
    const supervisor = new Supervisor({
        services,
        oneShot: extra.oneShot ?? ["migrate"],
        parallel: extra.parallel ?? ["pipeline", "next"],
        maxRestarts: extra.maxRestarts ?? 5,
        windowMs: 120_000,
        backoffBaseMs: 1000,
        backoffMaxMs: 8000,
        shutdownBudgetMs: 5000,
        now: () => now,
        setTimer: (callback, ms) => timers.push({ ms, run: callback }),
    });
    supervisor.onEvent((event) => events.push(event));
    const advance = (ms: number) => {
        now += ms;
        const due = timers.splice(0);
        for (const timer of due) timer.run();
    };
    return {
        supervisor,
        services,
        log,
        timers,
        events,
        advance,
        setNow: (value: number) => {
            now = value;
        },
    };
}

describe("Supervisor start and stop", () => {
    it("starts postgres, then the migration, then the pipeline and the server", async () => {
        const h = harness();

        await h.supervisor.start();

        expect(h.log.slice(0, 2)).toEqual(["start:postgres", "start:migrate"]);
        expect(h.log.slice(2).sort()).toEqual(["start:next", "start:pipeline"]);
        expect(h.events.map((e) => e.type)).toEqual(["started"]);
    });

    it("stops in reverse order: server, pipeline, migration, postgres", async () => {
        const h = harness();
        await h.supervisor.start();
        h.log.length = 0;

        await h.supervisor.stop();

        expect(h.log.slice(0, 2).sort()).toEqual([
            "stop:next",
            "stop:pipeline",
        ]);
        expect(h.log.slice(2)).toEqual(["stop:migrate", "stop:postgres"]);
        expect(h.events.at(-1)?.type).toBe("stopped");
    });

    it("throws when a sequential service cannot start", async () => {
        const h = harness({ startFails: ["postgres"] });

        await expect(h.supervisor.start()).rejects.toThrow(
            "postgres cannot start",
        );
    });
});

describe("Supervisor restarts", () => {
    it("restarts a crashed service after an exponential backoff", async () => {
        const h = harness();
        await h.supervisor.start();
        const pipeline = h.services.find((s) => s.name === "pipeline");
        (pipeline as unknown as { crash(reason?: string): void }).crash(
            "SIGSEGV",
        );

        const restart = h.events.find((e) => e.type === "restarting");
        expect(restart).toMatchObject({
            service: "pipeline",
            attempt: 1,
            delayMs: 1000,
        });
        expect(h.timers).toHaveLength(1);
        h.advance(1000);
        expect(h.log).toContain("start:pipeline");
        expect(pipeline?.running()).toBe(true);
    });

    it("doubles the delay for repeated crashes and caps it", async () => {
        const h = harness({ maxRestarts: 10 });
        await h.supervisor.start();
        const next = h.services.find((s) => s.name === "next") as unknown as {
            crash(reason?: string): void;
        };
        const delays: number[] = [];
        for (let i = 0; i < 5; i += 1) {
            next.crash();
            const last = h.events
                .filter((e) => e.type === "restarting")
                .at(-1) as { delayMs: number };
            delays.push(last.delayMs);
            h.advance(last.delayMs);
        }

        expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    });

    it("marks a service failed after too many crashes in the window", async () => {
        const h = harness({ maxRestarts: 2 });
        await h.supervisor.start();
        const next = h.services.find((s) => s.name === "next") as unknown as {
            crash(reason?: string): void;
        };

        next.crash();
        h.advance(1000);
        next.crash();
        h.advance(2000);
        next.crash("crash loop");

        expect(h.supervisor.isFailed("next")).toBe(true);
        expect(h.events.at(-1)).toMatchObject({
            type: "failed",
            service: "next",
            reason: "crash loop",
        });
    });

    it("does not restart anything once stop has begun", async () => {
        const h = harness();
        await h.supervisor.start();
        const pipeline = h.services.find(
            (s) => s.name === "pipeline",
        ) as unknown as { crash(reason?: string): void };

        const stopping = h.supervisor.stop();
        pipeline.crash("exit during shutdown");
        await stopping;

        expect(h.events.some((e) => e.type === "restarting")).toBe(false);
    });

    it("reports a failed one-shot migration without retrying it", async () => {
        const h = harness({ oneShot: ["migrate"] });
        await h.supervisor.start();
        const migrate = h.services.find(
            (s) => s.name === "migrate",
        ) as unknown as { crash(reason?: string): void };

        migrate.crash("migration failed");

        expect(h.events.at(-1)).toMatchObject({
            type: "failed",
            service: "migrate",
        });
        expect(h.timers).toHaveLength(0);
    });
});
