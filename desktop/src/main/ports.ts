import { createServer } from "node:net";
import type { DesktopPorts } from "./config.js";

/** Ports the project already uses for other stacks and tests (PLAN §18 item 6). */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([
    3000, 3100, 3210, 3299, 5432, 8100, 18787, 54329,
]);

const PORT_ORDER = ["app", "pipeline", "postgres"] as const;

/** True when nothing is listening on 127.0.0.1:port. */
export function isLoopbackPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}

export interface PortChoice {
    ports: DesktopPorts;
    /** Services whose saved port was busy and moved to a new one. */
    moved: Array<keyof DesktopPorts>;
}

/**
 * Keeps each saved port that is free. A busy port moves to the next free number above it, skipping
 * reserved ports and ports already given to another service. The caller saves the result and tells
 * the user when `moved` is not empty, because the browser origin (and its local storage) changes.
 */
export async function choosePorts(
    saved: DesktopPorts,
    isFree: (port: number) => Promise<boolean> = isLoopbackPortFree,
    maxScan = 100,
): Promise<PortChoice> {
    const ports: DesktopPorts = { ...saved };
    const taken = new Set<number>();
    const kept = new Set<keyof DesktopPorts>();

    // Pass 1: every saved port that is still free stays where it is.
    for (const key of PORT_ORDER) {
        const port = saved[key];
        if (
            !RESERVED_PORTS.has(port) &&
            !taken.has(port) &&
            (await isFree(port))
        ) {
            kept.add(key);
            taken.add(port);
        }
    }

    // Pass 2: move the busy ones upward, never onto a port another service saved.
    const savedPorts = new Set(Object.values(saved));
    const moved: Array<keyof DesktopPorts> = [];
    for (const key of PORT_ORDER) {
        if (kept.has(key)) continue;
        let candidate = saved[key] + 1;
        let scanned = 0;
        while (
            taken.has(candidate) ||
            savedPorts.has(candidate) ||
            RESERVED_PORTS.has(candidate) ||
            !(await isFree(candidate))
        ) {
            candidate += 1;
            scanned += 1;
            if (scanned > maxScan || candidate > 65535) {
                throw new Error(`no free port for ${key} near ${saved[key]}`);
            }
        }
        ports[key] = candidate;
        taken.add(candidate);
        moved.push(key);
    }
    return { ports, moved };
}
