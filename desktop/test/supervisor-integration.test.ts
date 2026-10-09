import { spawn } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromChildProcess, ProcessService } from "../src/main/services.js";
import { Supervisor, type SupervisorEvent } from "../src/main/supervisor.js";

// Stands in for a service. It logs start, stop and crash lines with its pid, exits with code 3 on
// SIGUSR2 (a crash), and ignores SIGTERM in the "ignore-term" mode.
const CHILD = `
const fs = require("node:fs");
const [log, name, mode] = process.argv.slice(2);
const record = (event) => fs.appendFileSync(log, event + " " + name + " " + process.pid + "\\n");
record("start");
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => { record("stop"); process.exit(0); });
}
process.on("SIGUSR2", () => { record("crash"); process.exit(3); });
setInterval(() => {}, 1000);
`;

interface LogEvent {
    event: "start" | "stop" | "crash";
    name: string;
    pid: number;
}

let dir: string;
let logPath: string;
let supervisors: Supervisor[];

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-supervisor-"));
    logPath = join(dir, "events.log");
    writeFileSync(join(dir, "child.cjs"), CHILD);
    supervisors = [];
});

afterEach(async () => {
    for (const supervisor of supervisors) await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
});

function readEvents(): LogEvent[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [event, name, pid] = line.split(" ");
            return {
                event: event as LogEvent["event"],
                name,
                pid: Number(pid),
            };
        });
}

function pidsOf(name: string, event: LogEvent["event"] = "start"): number[] {
    return readEvents()
        .filter((e) => e.name === name && e.event === event)
        .map((e) => e.pid);
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function waitUntil(condition: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("condition not met in time");
}

function serviceFor(name: string, mode = "normal"): ProcessService {
    const factory = () =>
        fromChildProcess(
            spawn(
                process.execPath,
                [join(dir, "child.cjs"), logPath, name, mode],
                { stdio: "ignore" },
            ),
        );
    return new ProcessService(name, factory, () =>
        waitUntil(() => pidsOf(name).length > 0, 10_000),
    );
}

function supervisorFor(
    services: ProcessService[],
    options: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
): Supervisor {
    const supervisor = new Supervisor({ services, ...options });
    supervisors.push(supervisor);
    return supervisor;
}

describe("supervisor with real child processes", () => {
    it("starts services in order and stops them in reverse", async () => {
        const supervisor = supervisorFor(
            [
                serviceFor("postgres"),
                serviceFor("pipeline"),
                serviceFor("next"),
            ],
            { parallel: ["pipeline", "next"] },
        );

        await supervisor.start();
        await supervisor.stop();

        const starts = readEvents()
            .filter((e) => e.event === "start")
            .map((e) => e.name);
        expect(starts[0]).toBe("postgres");
        expect(new Set(starts.slice(1))).toEqual(new Set(["pipeline", "next"]));
        const stops = readEvents()
            .filter((e) => e.event === "stop")
            .map((e) => e.name);
        expect(stops).toEqual(["next", "pipeline", "postgres"]);
    }, 20_000);

    it("restarts a crashed service and keeps the others running", async () => {
        const supervisor = supervisorFor(
            [serviceFor("pipeline"), serviceFor("next")],
            {
                parallel: ["pipeline", "next"],
                backoffBaseMs: 50,
                backoffMaxMs: 100,
            },
        );
        await supervisor.start();
        const [firstPipeline] = pidsOf("pipeline");
        const [nextPid] = pidsOf("next");

        process.kill(firstPipeline, "SIGUSR2");
        await waitUntil(() => pidsOf("pipeline").length === 2);

        const [, restarted] = pidsOf("pipeline");
        expect(restarted).not.toBe(firstPipeline);
        expect(pidsOf("pipeline", "crash")).toEqual([firstPipeline]);
        expect(isAlive(restarted)).toBe(true);
        expect(isAlive(nextPid)).toBe(true);
    }, 20_000);

    it("leaves no child process behind after stop", async () => {
        const supervisor = supervisorFor(
            [serviceFor("postgres"), serviceFor("next")],
            { parallel: ["next"] },
        );
        await supervisor.start();
        const pids = readEvents()
            .filter((e) => e.event === "start")
            .map((e) => e.pid);
        expect(pids).toHaveLength(2);

        await supervisor.stop();

        for (const pid of pids) {
            await waitUntil(() => !isAlive(pid), 3_000);
            expect(isAlive(pid)).toBe(false);
        }
    }, 20_000);

    it("kills a service that ignores SIGTERM within the shutdown budget", async () => {
        const supervisor = supervisorFor(
            [serviceFor("stubborn", "ignore-term")],
            { shutdownBudgetMs: 1_500 },
        );
        await supervisor.start();
        const [pid] = pidsOf("stubborn");

        const started = Date.now();
        await supervisor.stop();
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(3_000);
        await waitUntil(() => !isAlive(pid), 3_000);
        expect(isAlive(pid)).toBe(false);
    }, 20_000);

    it("reports a service that keeps crashing as failed", async () => {
        const events: SupervisorEvent[] = [];
        const supervisor = supervisorFor([serviceFor("pipeline")], {
            maxRestarts: 2,
            backoffBaseMs: 20,
            backoffMaxMs: 40,
            windowMs: 60_000,
        });
        supervisor.onEvent((event) => events.push(event));
        await supervisor.start();

        // Crashes 1 and 2 are restarted; crash 3 exceeds maxRestarts and is reported.
        for (let crash = 1; crash <= 3; crash++) {
            const current = pidsOf("pipeline").at(-1);
            if (current === undefined) throw new Error("no running pipeline");
            process.kill(current, "SIGUSR2");
            if (crash < 3) {
                await waitUntil(() => pidsOf("pipeline").length === crash + 1);
            }
        }

        await waitUntil(() => events.some((e) => e.type === "failed"));
        expect(supervisor.isFailed("pipeline")).toBe(true);
    }, 20_000);
});
