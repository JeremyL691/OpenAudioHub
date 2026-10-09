import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopbackPortFree } from "../src/main/ports.js";
import {
    PortInUseError,
    PostgresManager,
    readPgVersion,
} from "../src/main/postgres.js";

/** Staged binaries from `node desktop/scripts/stage-postgres.mjs`. The suite is skipped when they are absent. */
const binDir =
    process.env.OAH_POSTGRES_BIN ??
    fileURLToPath(new URL("../build/postgres/bin", import.meta.url));
const hasBinaries = existsSync(join(binDir, "initdb"));

const childEnv = { PATH: `${binDir}:/usr/bin:/bin`, TZ: "UTC", HOME: tmpdir() };
const PASSWORD = "integration-password-1234";
const TEST_PORT_BASE = 38520;

let root: string;
let manager: PostgresManager | null = null;
let port = 0;
let blocker: Server | null = null;
let blockerSockets: Set<Socket> = new Set();

async function freePortFrom(start: number): Promise<number> {
    for (let candidate = start; candidate < start + 50; candidate += 1) {
        if (await isLoopbackPortFree(candidate)) return candidate;
    }
    throw new Error("no free test port");
}

function newManager(
    overrides: { dataDir?: string; port?: number } = {},
): PostgresManager {
    return new PostgresManager({
        binDir,
        dataDir: overrides.dataDir ?? join(root, "pgdata"),
        logFile: join(root, "postgres.log"),
        port: overrides.port ?? port,
        password: PASSWORD,
        childEnv,
        scratchDir: join(root, "scratch"),
    });
}

async function query<T>(sql: string): Promise<T[]> {
    const client = postgres({
        host: "127.0.0.1",
        port,
        username: "oah",
        password: PASSWORD,
        database: "postgres",
        max: 1,
        connect_timeout: 5,
        idle_timeout: 1,
    });
    try {
        return (await client.unsafe(sql)) as unknown as T[];
    } finally {
        await client.end({ timeout: 2 });
    }
}

beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "oah-pg-"));
    port = await freePortFrom(TEST_PORT_BASE + Math.floor(Math.random() * 40));
});

afterEach(async () => {
    if (manager) {
        await manager.stop().catch(() => undefined);
        manager = null;
    }
    if (blocker) {
        for (const socket of blockerSockets) socket.destroy();
        blockerSockets = new Set();
        await new Promise<void>((done) => blocker?.close(() => done()));
        blocker = null;
    }
    rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasBinaries)(
    "PostgresManager with the staged PostgreSQL 16",
    () => {
        it(
            "creates a PostgreSQL 16 cluster with the D-306 settings and starts it",
            { timeout: 180_000 },
            async () => {
                manager = newManager();

                const created = await manager.initialize();
                expect(created.created).toBe(true);
                expect(readPgVersion(join(root, "pgdata"))).toBe("16");
                expect(
                    readFileSync(
                        join(root, "pgdata", "postgresql.conf"),
                        "utf8",
                    ),
                ).toContain("listen_addresses = '127.0.0.1'");

                await manager.start();
                expect(await manager.isReady()).toBe(true);

                const [settings] = await query<{
                    tz: string;
                    log_tz: string;
                    enc: string;
                    collate: string;
                    ctype: string;
                    checksums: string;
                }>(
                    `select current_setting('timezone') as tz, current_setting('log_timezone') as log_tz,
                    current_setting('server_encoding') as enc,
                    (select datcollate from pg_database where datname = 'postgres') as collate,
                    (select datctype from pg_database where datname = 'postgres') as ctype,
                    current_setting('data_checksums') as checksums`,
                );
                expect(settings.tz).toBe("UTC");
                expect(settings.log_tz).toBe("UTC");
                expect(settings.enc).toBe("UTF8");
                expect(settings.collate).toBe("C");
                expect(settings.ctype).toBe("en_US.UTF-8");
                expect(settings.checksums).toBe("on");
            },
        );

        it(
            "keeps committed rows after kill -9 and restarts from the write-ahead log",
            { timeout: 180_000 },
            async () => {
                manager = newManager();
                await manager.initialize();
                await manager.start();
                await query(
                    "create table durability (id int primary key, note text)",
                );
                await query(
                    "insert into durability values (1, 'committed before the crash')",
                );

                const pid = Number.parseInt(
                    readFileSync(
                        join(root, "pgdata", "postmaster.pid"),
                        "utf8",
                    ).split("\n")[0] ?? "",
                    10,
                );
                process.kill(pid, "SIGKILL");
                await new Promise((done) => setTimeout(done, 1500));

                await manager.start();
                const rows = await query<{ note: string }>(
                    "select note from durability where id = 1",
                );
                expect(rows[0]?.note).toBe("committed before the crash");
            },
        );

        it(
            "reports a busy port as PortInUseError so the caller can choose another",
            { timeout: 180_000 },
            async () => {
                manager = newManager();
                await manager.initialize();
                blocker = createServer();
                blocker.on("connection", (socket) =>
                    blockerSockets.add(socket),
                );
                await new Promise<void>((done) =>
                    blocker?.listen({ host: "127.0.0.1", port }, () => done()),
                );

                await expect(manager.start()).rejects.toBeInstanceOf(
                    PortInUseError,
                );
            },
        );

        it(
            "refuses a data directory written by another major version",
            { timeout: 180_000 },
            async () => {
                const dataDir = join(root, "pgdata");
                await newManager().initialize();
                writeFileSync(join(dataDir, "PG_VERSION"), "15\n");
                manager = newManager({ dataDir });

                await expect(manager.initialize()).rejects.toThrow(
                    /belongs to PostgreSQL 15/,
                );
            },
        );

        it(
            "stops with fast shutdown and leaves no postmaster behind",
            { timeout: 180_000 },
            async () => {
                manager = newManager();
                await manager.initialize();
                await manager.start();
                const pidFile = join(root, "pgdata", "postmaster.pid");
                const pid = Number.parseInt(
                    readFileSync(pidFile, "utf8").split("\n")[0] ?? "",
                    10,
                );

                await manager.stop();

                expect(existsSync(pidFile)).toBe(false);
                expect(() => process.kill(pid, 0)).toThrow();
                expect(await manager.isReady()).toBe(false);
            },
        );
    },
);

describe("PostgresManager without binaries", () => {
    it("is a no-op for version detection when the cluster does not exist", () => {
        expect(readPgVersion(resolve(root, "missing"))).toBeNull();
    });
});
