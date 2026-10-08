import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The local storage backend (F17). Each test writes into a fresh temp directory.
vi.mock("@/lib/env", () => ({ env: { LOCAL_STORAGE_PATH: "/unused" } }));

import { LocalStorage } from "@/lib/storage/local-storage";

describe("LocalStorage", () => {
    let dir: string;
    let storage: LocalStorage;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "oah-local-storage-"));
        storage = new LocalStorage(dir);
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("stores a file and returns the same bytes", async () => {
        const data = Buffer.from("audio-bytes");
        await storage.uploadFile("user-1/clip.m4a", data, "audio/mp4");

        expect(await storage.exists("user-1/clip.m4a")).toBe(true);
        expect(await storage.downloadFile("user-1/clip.m4a")).toEqual(data);
    });

    it("deletes a file", async () => {
        await storage.uploadFile("a.txt", Buffer.from("x"), "text/plain");
        await storage.deleteFile("a.txt");

        expect(await storage.exists("a.txt")).toBe(false);
        await expect(storage.downloadFile("a.txt")).rejects.toThrow(
            "Failed to download file from local storage",
        );
    });

    it("refuses keys that escape the storage directory", async () => {
        await expect(
            storage.uploadFile("../escape.txt", Buffer.from("x"), "text/plain"),
        ).rejects.toThrow("Failed to upload file to local storage");
        await expect(storage.exists("/etc/passwd")).resolves.toBe(false);
        await expect(storage.downloadFile("../../etc/passwd")).rejects.toThrow(
            "path traversal",
        );
    });

    it("links to the audio route, with the key encoded", async () => {
        await expect(storage.getSignedUrl("user 1/clip.m4a", 60)).resolves.toBe(
            "/api/recordings/audio/user%201%2Fclip.m4a",
        );
    });

    it("passes the connection test and leaves no test file behind", async () => {
        await expect(storage.testConnection()).resolves.toBe(true);
        const { readdir } = await import("node:fs/promises");
        await expect(readdir(dir)).resolves.toEqual([]);
    });
});
