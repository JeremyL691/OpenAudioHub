import { execFileSync, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { streamMp3ForDownload } from "@/lib/transcription/ffmpeg";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const itIfFfmpeg = hasFfmpeg ? it : it.skip;

describe("streamMp3ForDownload", () => {
    itIfFfmpeg("encodes a streamed source to MP3", async () => {
        const ogg = execFileSync("ffmpeg", [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=1",
            "-c:a",
            "libopus",
            "-f",
            "ogg",
            "pipe:1",
        ]);
        const mp3 = await buffer(streamMp3ForDownload(Readable.from([ogg])));
        // ffmpeg's MP3 muxer starts with an ID3v2 tag, then MPEG frames.
        expect(mp3.length).toBeGreaterThan(1000);
        expect(mp3.subarray(0, 3).toString("latin1")).toBe("ID3");
    });

    itIfFfmpeg("errors the stream when the input is not audio", async () => {
        await expect(
            buffer(streamMp3ForDownload(Readable.from([Buffer.from("nope")]))),
        ).rejects.toThrow(/ffmpeg exited/);
    });
});
