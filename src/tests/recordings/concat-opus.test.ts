import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatToOpus, runFfmpeg } from "@/lib/transcription/ffmpeg";

describe("concatToOpus", () => {
    let dir: string;
    let mp3Path: string;
    let opusPath: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), "oah-concat-"));
        mp3Path = path.join(dir, "a.mp3");
        opusPath = path.join(dir, "b.ogg");
        await runFfmpeg(Buffer.alloc(0), [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100:duration=1",
            "-ac",
            "2",
            "-c:a",
            "libmp3lame",
            mp3Path,
        ]);
        await runFfmpeg(Buffer.alloc(0), [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=660:sample_rate=48000:duration=1",
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-f",
            "ogg",
            opusPath,
        ]);
    });

    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("joins inputs with different codecs, rates and channels into mono Opus", async () => {
        const outPath = path.join(dir, "merged.ogg");
        await concatToOpus([mp3Path, opusPath], outPath);

        const meta = await parseFile(outPath, { duration: true });
        const durationMs = (meta.format.duration ?? 0) * 1000;
        expect(Math.abs(durationMs - 2000)).toBeLessThanOrEqual(100);
        expect(meta.format.numberOfChannels).toBe(1);
    });

    it("joins matching Opus inputs without re-encoding", async () => {
        // A quote in the name exercises the concat list escaping.
        const quoted = path.join(dir, "it's.ogg");
        await copyFile(opusPath, quoted);
        const outPath = path.join(dir, "copied.ogg");
        await concatToOpus([opusPath, quoted], outPath);

        const meta = await parseFile(outPath, { duration: true });
        const durationMs = (meta.format.duration ?? 0) * 1000;
        expect(Math.abs(durationMs - 2000)).toBeLessThanOrEqual(100);
        expect(meta.format.codec).toBe("Opus");
    });

    it("rejects fewer than 2 inputs", async () => {
        await expect(
            concatToOpus([mp3Path], path.join(dir, "single.ogg")),
        ).rejects.toThrow("concatToOpus needs at least 2 inputs");
    });
});
