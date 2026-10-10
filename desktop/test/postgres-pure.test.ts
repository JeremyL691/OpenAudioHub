import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    isPostmasterFor,
    PostgresManager,
    readPgVersion,
} from "../src/main/postgres.js";

const BIN = "/Applications/OpenAudioHub.app/Contents/Resources/pg/bin";
const DATA = "/Users/me/Library/Application Support/OpenAudioHub/pgdata";

describe("isPostmasterFor", () => {
    it("matches a postgres server started on exactly this data directory", () => {
        expect(
            isPostmasterFor(`${BIN}/postgres -D ${DATA} -c port=38402`, DATA),
        ).toBe(true);
        expect(isPostmasterFor(`${BIN}/postmaster -D ${DATA}`, DATA)).toBe(
            true,
        );
    });

    it("accepts the -D<dir> form and a trailing slash on the data directory", () => {
        expect(isPostmasterFor(`${BIN}/postgres -D${DATA}`, DATA)).toBe(true);
        expect(isPostmasterFor(`${BIN}/postgres -D ${DATA}/`, DATA)).toBe(true);
    });

    it("does not match a sibling directory that shares the prefix", () => {
        expect(isPostmasterFor(`${BIN}/postgres -D ${DATA}-old`, DATA)).toBe(
            false,
        );
        expect(isPostmasterFor(`${BIN}/postgres -D ${DATA}/nested`, DATA)).toBe(
            false,
        );
        expect(isPostmasterFor(`${BIN}/postgres -D ${DATA}2 -l x`, DATA)).toBe(
            false,
        );
    });

    it("does not match when the data directory only appears outside -D", () => {
        expect(isPostmasterFor(`${BIN}/postgres ${DATA}`, DATA)).toBe(false);
        expect(
            isPostmasterFor(`${BIN}/postgres -l ${DATA}/log.txt`, DATA),
        ).toBe(false);
    });

    it("does not match an editor or other program that has the path in its arguments", () => {
        expect(isPostmasterFor(`/usr/bin/vim -D ${DATA}`, DATA)).toBe(false);
        expect(
            isPostmasterFor(`/usr/bin/vim ${BIN}/postgres -D ${DATA}`, DATA),
        ).toBe(false);
        expect(
            isPostmasterFor(`/usr/bin/tail -f ${DATA}/postmaster.pid`, DATA),
        ).toBe(false);
    });

    it("matches a postmaster of this data folder from another bundle path", () => {
        // Left by the app before it moved to /Applications or was replaced by an update.
        expect(
            isPostmasterFor(
                `/Users/me/Downloads/OpenAudioHub.app/Contents/Resources/pg/bin/postgres -D ${DATA}`,
                DATA,
            ),
        ).toBe(true);
    });

    it("does not match other postgres tools", () => {
        expect(isPostmasterFor(`${BIN}/psql -D ${DATA}`, DATA)).toBe(false);
    });

    it("returns false for empty or unrelated output", () => {
        expect(isPostmasterFor("", DATA)).toBe(false);
        expect(isPostmasterFor("\n", DATA)).toBe(false);
    });
});

describe("readPgVersion and interrupted initialization", () => {
    let root: string;
    let dataDir: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "oah-pg-pure-"));
        dataDir = join(root, "pgdata");
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("reports a complete cluster by its PG_VERSION", () => {
        mkdirSync(join(dataDir, "global"), { recursive: true });
        writeFileSync(join(dataDir, "PG_VERSION"), "16\n");
        writeFileSync(join(dataDir, "global", "pg_control"), "");

        expect(readPgVersion(dataDir)).toBe("16");
    });

    it("reports no cluster when PG_VERSION exists without pg_control", () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, "PG_VERSION"), "16\n");

        expect(readPgVersion(dataDir)).toBeNull();
    });

    it("moves an interrupted data directory aside and runs initdb again", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, "PG_VERSION"), "16\n");
        const notices: string[] = [];
        // The bin directory does not exist, so initdb fails after the move; the move is what is checked.
        const manager = new PostgresManager({
            binDir: join(root, "no-bin"),
            dataDir,
            logFile: join(root, "postgres.log"),
            port: 38402,
            password: "pw",
            childEnv: { PATH: "/usr/bin:/bin", TZ: "UTC" },
            scratchDir: join(root, "scratch"),
            log: (message) => notices.push(message),
        });

        await expect(manager.initialize()).rejects.toThrow("initdb failed");

        const aside = readdirSync(root).filter((name) =>
            /^pgdata\.failed-init-\d+$/.test(name),
        );
        expect(aside).toHaveLength(1);
        expect(readPgVersion(join(root, aside[0] as string))).toBeNull();
        expect(readdirSync(root)).not.toContain("pgdata");
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("interrupted");
    });
});
