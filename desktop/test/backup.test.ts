import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, pruneBackups } from "../src/main/backup.js";
import { isLoopbackPortFree } from "../src/main/ports.js";
import { PostgresManager } from "../src/main/postgres.js";

describe("pruneBackups", () => {
    it("keeps the newest five dumps and leaves other files alone", () => {
        const dir = mkdtempSync(join(tmpdir(), "oah-backups-"));
        try {
            for (let day = 1; day <= 7; day += 1) {
                const file = join(dir, `2026-10-0${day}-backup.dump`);
                writeFileSync(file, "x");
                const when = new Date(Date.UTC(2026, 9, day));
                utimesSync(file, when, when);
            }
            writeFileSync(join(dir, "notes.txt"), "keep me");

            const removed = pruneBackups(dir, 5);

            expect(removed.sort()).toEqual([
                "2026-10-01-backup.dump",
                "2026-10-02-backup.dump",
            ]);
            expect(
                readdirSync(dir).filter((name) => name.endsWith(".dump")),
            ).toHaveLength(5);
            expect(existsSync(join(dir, "notes.txt"))).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** Staged binaries from `node desktop/scripts/stage-postgres.mjs`. The suite is skipped when they are absent. */
const binDir =
    process.env.OAH_POSTGRES_BIN ??
    fileURLToPath(new URL("../build/postgres/bin", import.meta.url));
const hasBinaries = existsSync(join(binDir, "pg_dump"));
const childEnv = { PATH: `${binDir}:/usr/bin:/bin`, TZ: "UTC", HOME: tmpdir() };
const PASSWORD = "backup-test-password-1234";

describe.skipIf(!hasBinaries)(
    "backupDatabase against a running PostgreSQL",
    () => {
        let root: string;
        let manager: PostgresManager;
        let port = 0;

        beforeAll(async () => {
            root = mkdtempSync(join(tmpdir(), "oah-backup-int-"));
            for (let candidate = 38530; candidate < 38580; candidate += 1) {
                if (await isLoopbackPortFree(candidate)) {
                    port = candidate;
                    break;
                }
            }
            manager = new PostgresManager({
                binDir,
                dataDir: join(root, "pgdata"),
                logFile: join(root, "postgres.log"),
                port,
                password: PASSWORD,
                childEnv,
                scratchDir: join(root, "scratch"),
            });
            await manager.initialize();
            await manager.start();
        }, 120_000);

        afterAll(async () => {
            await manager.stop();
            rmSync(root, { recursive: true, force: true });
        });

        it("writes a custom-format dump with the owner-only mode", () => {
            const dir = join(root, "backups");
            const file = backupDatabase({
                pgDumpBin: join(binDir, "pg_dump"),
                host: "127.0.0.1",
                port,
                user: "oah",
                database: "postgres",
                password: PASSWORD,
                dir,
                label: "from-0.0.1-to-0.0.2",
                env: childEnv,
            });

            expect(file.endsWith("-from-0.0.1-to-0.0.2.dump")).toBe(true);
            expect(readFileSync(file).subarray(0, 5).toString("latin1")).toBe(
                "PGDMP",
            );
            expect(statSync(file).mode & 0o777).toBe(0o600);
        }, 60_000);
    },
);
