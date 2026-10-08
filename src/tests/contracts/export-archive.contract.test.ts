import { Readable } from "node:stream";
import unzipper from "unzipper";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_SOURCE } from "@/lib/brand/legacy";
import { buildAndUploadExportArchive } from "@/lib/export/build-archive";
import type { StorageProvider } from "@/lib/storage/types";

// Contract snapshots for the export archive (PLAN T0.8): manifest.json and
// timeline.json. The fixtures match the timeline case in
// src/tests/export/build-archive.test.ts. Only createdAt, the one wall-clock
// value, is normalized.
const { dbMock } = vi.hoisted(() => ({ dbMock: { select: vi.fn() } }));

vi.mock("@/db", () => ({ db: dbMock }));
vi.mock("@/db/schema", () => ({
    recordings: "recordings",
    transcriptions: "transcriptions",
    aiEnhancements: "aiEnhancements",
    audioPipelineJobs: "audioPipelineJobs",
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string | null) =>
        value == null ? value : `decrypted:${value}`,
    decryptJsonField: (value: unknown) => value,
}));

type Row = Record<string, unknown>;

function mockSelectSequence(results: Row[][]) {
    let call = 0;
    dbMock.select.mockImplementation(() => ({
        from: () => ({
            where: () => Promise.resolve(results[call++] ?? []),
        }),
    }));
}

class CapturingStorage implements StorageProvider {
    files = new Map<string, Buffer>();
    uploaded: Buffer | null = null;

    async uploadFile(key: string, buffer: Buffer): Promise<string> {
        this.files.set(key, buffer);
        return key;
    }
    async downloadFile(key: string): Promise<Buffer> {
        const buffer = this.files.get(key);
        if (!buffer) throw new Error("not found");
        return buffer;
    }
    async downloadStream(key: string): Promise<Readable> {
        const buffer = this.files.get(key);
        if (!buffer) throw new Error(`not found: ${key}`);
        return Readable.from(buffer);
    }
    async uploadStream(
        key: string,
        stream: Readable,
        _contentType: string,
    ): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        this.uploaded = Buffer.concat(chunks);
        return key;
    }
    async exists(key: string): Promise<boolean> {
        return this.files.has(key);
    }
    async getSignedUrl(): Promise<string> {
        return "https://example.com/signed";
    }
    async deleteFile(key: string): Promise<void> {
        this.files.delete(key);
    }
    async testConnection(): Promise<boolean> {
        return true;
    }
}

async function readEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
    const entries = new Map<string, Buffer>();
    const directory = await unzipper.Open.buffer(buffer);
    for (const file of directory.files) {
        entries.set(file.path, await file.buffer());
    }
    return entries;
}

describe("export archive contract", () => {
    let storage: CapturingStorage;

    beforeEach(() => {
        vi.clearAllMocks();
        storage = new CapturingStorage();
    });

    it("writes manifest.json and timeline.json with the documented shape", async () => {
        storage.files.set("audio/normalized.mp3", Buffer.from("audio"));
        mockSelectSequence([
            [
                {
                    id: "rec-normalized",
                    userId: "user-1",
                    filename: "enc-filename",
                    startTime: new Date("2026-01-01T00:00:00Z"),
                    endTime: new Date("2026-01-01T00:01:00Z"),
                    duration: 60000,
                    filesize: 5,
                    deviceSn: "SN1",
                    storagePath: "audio/normalized.mp3",
                },
            ],
            [
                {
                    recordingId: "rec-normalized",
                    text: "enc-transcript",
                    source: LEGACY_SOURCE,
                    timeline: [
                        {
                            start_ms: 900,
                            end_ms: 1000,
                            text: "last word",
                            timestamp_source: "normalized",
                            speaker_id: "speaker_0",
                            chunk_index: 4,
                            timestamp_correction: {
                                reason: "chunk_end_guard",
                                original_end_ms: 1025,
                                normalized_end_ms: 1000,
                                chunk_index: 4,
                            },
                        },
                    ],
                    timelineSource: "normalized",
                },
            ],
            [
                {
                    recordingId: "rec-normalized",
                    status: "completed",
                    generation: 2,
                    configSnapshot: {
                        timestamp_policy: {
                            name: "chunk_end_guard_50ms_v1",
                            normalized_segment_count: 1,
                            ignored_blank_segment_count: 2,
                        },
                    },
                },
            ],
            [],
        ]);

        await buildAndUploadExportArchive({
            userId: "user-1",
            storage,
            storageKey: "exports/user-1/contract.zip",
        });

        const entries = await readEntries(storage.uploaded as Buffer);
        const names = [...entries.keys()].sort();
        expect(names).toMatchSnapshot();

        const manifest = JSON.parse(
            entries.get("manifest.json")?.toString("utf-8") ?? "{}",
        );
        expect({ ...manifest, createdAt: "<normalized>" }).toMatchSnapshot();

        const timelineName = names.find((name) =>
            name.endsWith("/timeline.json"),
        );
        expect(
            JSON.parse(
                entries.get(timelineName ?? "")?.toString("utf-8") ?? "{}",
            ),
        ).toMatchSnapshot();
    });
});
