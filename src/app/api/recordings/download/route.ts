import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import {
    loadAudioAsMp3,
    uniqueArchiveName,
} from "@/lib/recordings/download-audio";
import {
    buildDownloadFilename,
    contentDispositionAttachment,
    dateRecordingTitle,
} from "@/lib/recordings/filename";
import { createUserStorageProvider } from "@/lib/storage/factory";

const MAX_IDS = 100;
const RECORDING_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/recordings/download?ids=a,b,c
 *
 * Streams one ZIP holding each selected recording as MP3. A recording whose
 * audio fails to load is skipped and listed in `errors.txt`.
 */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const ids = [
        ...new Set(
            (new URL(request.url).searchParams.get("ids") ?? "")
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ];
    if (
        ids.length === 0 ||
        ids.length > MAX_IDS ||
        !ids.every((id) => RECORDING_ID.test(id))
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `ids must be 1 to ${MAX_IDS} recording ids`,
            400,
        );
    }

    const rows = await db
        .select({
            id: recordings.id,
            filename: recordings.filename,
            storagePath: recordings.storagePath,
        })
        .from(recordings)
        .where(
            and(
                inArray(recordings.id, ids),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        );
    if (rows.length === 0) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    const storage = await createUserStorageProvider(session.user.id);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const used = new Set<string>();

    void (async () => {
        const errors: string[] = [];
        for (const row of rows) {
            const name = uniqueArchiveName(
                buildDownloadFilename(
                    decryptText(row.filename),
                    row.storagePath,
                    row.id,
                    "mp3",
                ),
                used,
            );
            try {
                const mp3 = await loadAudioAsMp3(storage, row.storagePath);
                archive.append(mp3, { name, store: true });
            } catch (error) {
                console.error(`[download] ${row.id} failed:`, error);
                errors.push(`${name}: could not be converted`);
            }
        }
        if (errors.length > 0) {
            archive.append(`${errors.join("\n")}\n`, { name: "errors.txt" });
        }
        await archive.finalize();
    })().catch((error: Error) => archive.destroy(error));

    return new Response(Readable.toWeb(archive) as ReadableStream<Uint8Array>, {
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": contentDispositionAttachment(
                `OpenAudioHub-${dateRecordingTitle(new Date())}.zip`,
            ),
            "Cache-Control": "private, no-store",
        },
    });
});
