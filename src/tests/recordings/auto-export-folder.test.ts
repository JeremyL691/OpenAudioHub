import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWritableFolder } from "@/lib/recordings/auto-export-folder";

describe("isWritableFolder", () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "oah-folder-"));
        await writeFile(path.join(dir, "file.txt"), "x");
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("accepts an existing writable directory", async () => {
        expect(await isWritableFolder(dir)).toBe(true);
    });

    it("rejects relative paths, files, missing paths and non-strings", async () => {
        expect(await isWritableFolder("relative/dir")).toBe(false);
        expect(await isWritableFolder(path.join(dir, "file.txt"))).toBe(false);
        expect(await isWritableFolder(path.join(dir, "missing"))).toBe(false);
        expect(await isWritableFolder(42)).toBe(false);
        expect(await isWritableFolder(null)).toBe(false);
    });
});
