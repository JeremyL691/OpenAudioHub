import { execFileSync } from "node:child_process";
import { test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../.dev-artifacts");

/**
 * A speech recording long enough to be cut into more than one chunk, built once per run
 * from `espeak-ng` and `ffmpeg` so the repository holds no audio file. Returns null when
 * either tool is missing, which lets the pipeline tests skip instead of failing.
 */
export function speechFixture(
    sentences = 15,
): { buffer: Buffer; seconds: number } | null {
    const target = resolve(root, `speech-pipeline-${sentences}.wav`);
    if (!existsSync(target)) {
        mkdirSync(root, { recursive: true });
        try {
            execFileSync(
                "bash",
                [resolve(__dirname, "../fixtures/make-speech.sh"), target, String(sentences)],
                { stdio: "ignore" },
            );
        } catch {
            return null;
        }
    }
    const buffer = readFileSync(target);
    // The generator writes a canonical 44-byte WAV header; the length follows from its byte rate.
    const byteRate = buffer.readUInt32LE(28);
    const seconds = (buffer.length - 44) / byteRate;
    return { buffer, seconds };
}

/**
 * The generated speech, or a skipped test when the generator cannot run. Skipping keeps a
 * machine without `espeak-ng` from reporting a failure that says nothing about the server.
 */
export function speechFixtureOrSkip(
    sentences = 15,
): { buffer: Buffer; seconds: number } {
    const speech = speechFixture(sentences);
    if (!speech) {
        test.skip(true, "speech fixture needs espeak-ng and ffmpeg");
        throw new Error("unreachable");
    }
    return speech;
}
