import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    describeShortage,
    freeBytesAt,
    MIN_FREE_BYTES,
    type StatfsFn,
} from "../src/main/disk.js";

const MB = 1024 * 1024;

/** A fake volume: only the listed paths exist, and each reports the same free space. */
function fakeVolume(
    existing: Record<string, { bavail: number; bsize: number }>,
    calls: string[] = [],
): StatfsFn {
    return (path) => {
        calls.push(path);
        const stats = existing[path];
        if (!stats) {
            throw Object.assign(new Error(`ENOENT: ${path}`), {
                code: "ENOENT",
            });
        }
        return stats;
    };
}

describe("freeBytesAt", () => {
    it("multiplies the available blocks by the block size", () => {
        const statfs = fakeVolume({ "/vol": { bavail: 2048, bsize: 4096 } });
        expect(freeBytesAt("/vol", statfs)).toBe(2048 * 4096);
    });

    it("walks up from a path that does not exist yet to the nearest existing folder", () => {
        const calls: string[] = [];
        const statfs = fakeVolume(
            { "/vol/OpenAudioHub": { bavail: 100, bsize: 512 } },
            calls,
        );

        expect(freeBytesAt("/vol/OpenAudioHub/pgdata/logs", statfs)).toBe(
            100 * 512,
        );
        expect(calls).toEqual([
            "/vol/OpenAudioHub/pgdata/logs",
            "/vol/OpenAudioHub/pgdata",
            "/vol/OpenAudioHub",
        ]);
    });

    it("resolves a relative path before walking up", () => {
        const calls: string[] = [];
        const statfs = fakeVolume(
            { [process.cwd()]: { bavail: 1, bsize: 1 } },
            calls,
        );

        expect(freeBytesAt("not-created-yet/child", statfs)).toBe(1);
        expect(calls[0]).toBe(join(process.cwd(), "not-created-yet/child"));
    });

    it("returns null when no ancestor can be measured, without looping", () => {
        const calls: string[] = [];
        expect(freeBytesAt("/a/b/c", fakeVolume({}, calls))).toBeNull();
        expect(calls).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    });

    it("returns null for a volume that cannot be read, without walking up", () => {
        const calls: string[] = [];
        const statfs: StatfsFn = (path) => {
            calls.push(path);
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        };
        expect(freeBytesAt("/vol/data", statfs)).toBeNull();
        expect(calls).toEqual(["/vol/data"]);
    });

    it("reads the real volume of an existing folder and of a missing one under it", () => {
        const folder = tmpdir();
        const free = freeBytesAt(folder);
        expect(free).toEqual(expect.any(Number));
        expect(free as number).toBeGreaterThan(0);
        expect(freeBytesAt(join(folder, "oah-missing", "pgdata"))).toEqual(
            expect.any(Number),
        );
    });
});

describe("describeShortage", () => {
    it("names the free space, the folder and what to do", () => {
        const text = describeShortage(8 * MB + 512, "/Volumes/oah/data");
        expect(text).toBe(
            "Only 8 MB are free on the disk that holds /Volumes/oah/data. Free at least 200 MB on that disk and open OpenAudioHub again.",
        );
    });

    it("rounds the free space down to whole megabytes", () => {
        expect(describeShortage(MB - 1, "/x")).toContain("Only 0 MB are free");
    });

    it("states the minimum the App needs", () => {
        expect(MIN_FREE_BYTES).toBe(200 * MB);
        expect(describeShortage(0, "/x")).toContain("Free at least 200 MB");
    });
});
