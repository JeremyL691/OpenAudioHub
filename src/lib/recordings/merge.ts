import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { parseFile } from "music-metadata";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import {
    decryptJsonField,
    decryptText,
    encryptText,
} from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { autoExportRecording } from "@/lib/recordings/auto-export";
import { audioExtension } from "@/lib/recordings/filename";
import {
    pickTranscript,
    stitchTranscripts,
} from "@/lib/recordings/merge-transcript";
import { createUserStorageProvider } from "@/lib/storage/factory";
import type { TimelineSegment } from "@/lib/transcription/audio-pipeline-repair";
import { concatToOpus } from "@/lib/transcription/ffmpeg";
import { upsertTranscription } from "@/lib/transcription/persist";
import { getPreferredTranscriptSource } from "@/lib/v1/serialize";

/** Longest merged recording; transcription refuses anything longer. */
export const MAX_MERGED_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Concatenate the user's recordings, in the given order, into one new
 * recording. The originals are left untouched. Returns the new id.
 */
export async function mergeRecordings(
    userId: string,
    ids: readonly string[],
    title?: string,
): Promise<string> {
    const rows = await db
        .select({
            id: recordings.id,
            filename: recordings.filename,
            startTime: recordings.startTime,
            storagePath: recordings.storagePath,
        })
        .from(recordings)
        .where(
            and(
                inArray(recordings.id, [...ids]),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        );
    if (rows.length !== ids.length) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const parts = ids.map((id) => byId.get(id) as (typeof rows)[number]);

    const storage = await createUserStorageProvider(userId);
    const workDir = await mkdtemp(join(tmpdir(), "oah-merge-"));
    try {
        const inputPaths: string[] = [];
        const offsetsMs: number[] = [];
        let totalMs = 0;
        for (const [index, part] of parts.entries()) {
            const inputPath = join(
                workDir,
                `in-${index}.${audioExtension(part.storagePath)}`,
            );
            await pipeline(
                await storage.downloadStream(part.storagePath),
                createWriteStream(inputPath),
            );
            // Measured from the file, so transcript offsets match the audio.
            const durationMs = await probeDurationMs(inputPath);
            if (durationMs === 0) {
                throw new AppError(
                    ErrorCode.INVALID_FILE_FORMAT,
                    `"${decryptText(part.filename)}" has no readable audio`,
                    422,
                );
            }
            inputPaths.push(inputPath);
            offsetsMs.push(totalMs);
            totalMs += durationMs;
        }
        if (totalMs > MAX_MERGED_DURATION_MS) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Merged recording would be longer than 24 hours",
                422,
            );
        }

        const outPath = join(workDir, "merged.ogg");
        await concatToOpus(inputPaths, outPath);
        const durationMs = (await probeDurationMs(outPath)) || totalMs;
        const { size } = await stat(outPath);
        const md5 = createHash("md5");
        for await (const chunk of createReadStream(outPath)) md5.update(chunk);

        const fileId = `merged-${nanoid()}`;
        const storageKey = `${userId}/${fileId}.ogg`;
        await storage.uploadStream(
            storageKey,
            createReadStream(outPath),
            "audio/ogg",
        );

        const startTime = new Date(
            Math.min(...parts.map((part) => part.startTime.getTime())),
        );
        const filename =
            title?.trim() || `${decryptText(parts[0].filename)} (merged)`;
        let id: string;
        try {
            const [inserted] = await db
                .insert(recordings)
                .values({
                    userId,
                    deviceSn: "local",
                    plaudFileId: fileId,
                    filename: encryptText(filename),
                    duration: durationMs,
                    startTime,
                    endTime: new Date(startTime.getTime() + durationMs),
                    filesize: size,
                    fileMd5: md5.digest("hex"),
                    storageType: env.DEFAULT_STORAGE_TYPE,
                    storagePath: storageKey,
                    downloadedAt: new Date(),
                    plaudVersion: "1",
                    isTrash: false,
                })
                .returning({ id: recordings.id });
            id = inserted.id;
        } catch (dbError) {
            await storage.deleteFile(storageKey).catch((cleanupErr) => {
                console.error(
                    "Failed to clean up merged audio after DB insert error:",
                    cleanupErr,
                );
            });
            throw dbError;
        }

        await carryOverTranscript(userId, id, ids, offsetsMs);
        await autoExportRecording(userId, id);
        return id;
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

async function probeDurationMs(filePath: string): Promise<number> {
    try {
        const { format } = await parseFile(filePath, { duration: true });
        return Math.round((format.duration ?? 0) * 1000);
    } catch (err) {
        console.error("Audio metadata parse failed:", err);
        return 0;
    }
}

/** Stitch the originals' transcripts onto the merged recording when every one has a transcript. */
async function carryOverTranscript(
    userId: string,
    mergedId: string,
    ids: readonly string[],
    offsetsMs: readonly number[],
): Promise<void> {
    const rows = await db
        .select({
            recordingId: transcriptions.recordingId,
            source: transcriptions.source,
            createdAt: transcriptions.createdAt,
            text: transcriptions.text,
            timeline: transcriptions.timeline,
            timelineSource: transcriptions.timelineSource,
            detectedLanguage: transcriptions.detectedLanguage,
        })
        .from(transcriptions)
        .where(
            and(
                inArray(transcriptions.recordingId, [...ids]),
                eq(transcriptions.userId, userId),
            ),
        );
    const preferred = await getPreferredTranscriptSource(userId);
    const picked = ids.map((id) =>
        pickTranscript(
            rows.filter((row) => row.recordingId === id),
            preferred,
        ),
    );
    const stitched = stitchTranscripts(
        picked.map((row) =>
            row
                ? {
                      text: decryptText(row.text),
                      timeline: decryptJsonField<TimelineSegment[]>(
                          row.timeline,
                      ),
                  }
                : null,
        ),
        offsetsMs,
    );
    if (!stitched) return;

    const same = <T>(values: T[]): T | null =>
        values.every((value) => value === values[0]) ? values[0] : null;
    await upsertTranscription({
        userId,
        recordingId: mergedId,
        text: stitched.text,
        detectedLanguage: same(
            picked.map((row) => row?.detectedLanguage ?? null),
        ),
        source: "openaudiohub",
        provider: "merge",
        model: "concat",
        timeline: stitched.timeline,
        timelineSource: stitched.timeline
            ? (same(picked.map((row) => row?.timelineSource ?? null)) as
                  | "native"
                  | "aligned"
                  | null)
            : null,
    });
}
