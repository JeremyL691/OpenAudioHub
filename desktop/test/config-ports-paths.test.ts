import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    DEFAULT_PORTS,
    defaultConfig,
    loadConfig,
    saveConfig,
} from "../src/main/config.js";
import { resolvePaths } from "../src/main/paths.js";
import { choosePorts, RESERVED_PORTS } from "../src/main/ports.js";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oah-config-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
    it("uses the D-310 default ports when no file exists", () => {
        expect(loadConfig(join(dir, "config.json")).config).toEqual(
            defaultConfig(),
        );
        expect(defaultConfig().ports).toEqual({
            app: 38400,
            pipeline: 38401,
            postgres: 38402,
        });
    });

    it("round-trips the ports and the bound user with 0600 permissions", () => {
        const path = join(dir, "config.json");
        const config = { ...defaultConfig(), boundUserId: "user_1" };

        saveConfig(path, config);

        expect(loadConfig(path).config).toEqual(config);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it("moves an unreadable file aside and falls back to the defaults", () => {
        const path = join(dir, "config.json");
        writeFileSync(path, "garbage");

        const loaded = loadConfig(
            path,
            () => new Date("2026-10-08T23:00:00.000Z"),
        );

        expect(loaded.config).toEqual(defaultConfig());
        expect(loaded.replacedCorruptFile).toBeDefined();
        expect(readFileSync(loaded.replacedCorruptFile as string, "utf8")).toBe(
            "garbage",
        );
    });

    it("rejects out-of-range ports", () => {
        const path = join(dir, "config.json");
        writeFileSync(
            path,
            JSON.stringify({
                schemaVersion: 1,
                ports: { app: 80, pipeline: 38401, postgres: 38402 },
            }),
        );

        expect(loadConfig(path).replacedCorruptFile).toBeDefined();
        expect(
            readdirSync(dir).some((name) =>
                name.startsWith("config.json.corrupt-"),
            ),
        ).toBe(true);
    });

    it("refuses a file with a newer schemaVersion and leaves it in place", () => {
        const path = join(dir, "config.json");
        const newer = JSON.stringify({
            schemaVersion: 2,
            ports: { app: 38400, pipeline: 38401, postgres: 38402 },
            lastVersion: "1.3.0",
            boundUserId: "user_1",
        });
        writeFileSync(path, newer);

        expect(() => loadConfig(path)).toThrow(
            "config.json was written by a newer OpenAudioHub; install the newer version",
        );
        // Nothing was renamed or replaced, so lastVersion and boundUserId survive.
        expect(readFileSync(path, "utf8")).toBe(newer);
        expect(readdirSync(dir).some((name) => name.includes("corrupt"))).toBe(
            false,
        );
    });

    it("keeps the known fields of a same-version file", () => {
        const path = join(dir, "config.json");
        writeFileSync(
            path,
            JSON.stringify({
                schemaVersion: 1,
                ports: { app: 38400, pipeline: 38401, postgres: 38402 },
                lastVersion: "1.2.0",
                launchAtLogin: true,
            }),
        );

        const loaded = loadConfig(path);

        expect(loaded.config.lastVersion).toBe("1.2.0");
        expect(loaded.config.launchAtLogin).toBe(true);
        expect(loaded.replacedCorruptFile).toBeUndefined();
    });
});

describe("choosePorts", () => {
    it("keeps the saved ports when they are free", async () => {
        const result = await choosePorts(
            { ...DEFAULT_PORTS },
            async () => true,
        );

        expect(result.ports).toEqual(DEFAULT_PORTS);
        expect(result.moved).toEqual([]);
    });

    it("moves a busy port to the next free number and reports it", async () => {
        const busy = new Set([38400]);
        const result = await choosePorts(
            { ...DEFAULT_PORTS },
            async (port) => !busy.has(port),
        );

        expect(result.ports.app).toBe(38403);
        expect(result.moved).toEqual(["app"]);
    });

    it("skips reserved ports and ports already given to another service", async () => {
        const result = await choosePorts(
            { app: 38400, pipeline: 38401, postgres: 38401 },
            async () => true,
        );

        expect(new Set(Object.values(result.ports)).size).toBe(3);
        for (const port of Object.values(result.ports)) {
            expect(RESERVED_PORTS.has(port)).toBe(false);
        }
    });

    it("fails when no free port is found in the scan range", async () => {
        await expect(
            choosePorts({ ...DEFAULT_PORTS }, async () => false, 5),
        ).rejects.toThrow(/no free port/);
    });
});

describe("resolvePaths", () => {
    it("uses the Application Support folder by default", () => {
        const paths = resolvePaths({}, "/Users/tester");

        expect(paths.userData).toBe(
            "/Users/tester/Library/Application Support/OpenAudioHub",
        );
        expect(paths.logs).toBe("/Users/tester/Library/Logs/OpenAudioHub");
        expect(paths.secrets.endsWith("/secrets.json")).toBe(true);
    });

    it("moves the whole layout, logs included, under OAH_USER_DATA_DIR", () => {
        const paths = resolvePaths(
            { OAH_USER_DATA_DIR: "/tmp/oah-run" },
            "/Users/tester",
        );

        expect(paths.userData).toBe("/tmp/oah-run");
        expect(paths.logs).toBe("/tmp/oah-run/logs");
        expect(paths.pgdata).toBe("/tmp/oah-run/pgdata");
    });
});
