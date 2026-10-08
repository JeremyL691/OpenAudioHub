import { describe, expect, it, vi } from "vitest";
import {
    decodeRecordingCursor,
    encodeRecordingCursor,
    resolvePrimaryTranscript,
    serializeRecording,
    serializeRecordingDetail,
    serializeSummary,
    type serializeTranscript,
} from "@/lib/v1/serialize";

// Contract snapshots for the /api/v1 response shapes (PLAN T0.8). Encryption is
// replaced with a visible prefix so snapshots show which fields were decrypted.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (value: string | null) =>
        value == null ? value : `decrypted:${value}`,
    decryptJsonField: (value: unknown) => value,
}));

type RecordingRow = Parameters<typeof serializeRecording>[0];
type DeviceRow = NonNullable<Parameters<typeof serializeRecording>[1]>;
type TranscriptionRow = NonNullable<Parameters<typeof serializeTranscript>[0]>;
type EnhancementRow = NonNullable<Parameters<typeof serializeSummary>[0]>;

function row<T>(value: Partial<T>): T {
    return value as T;
}

const recording = row<RecordingRow>({
    id: "rec-1",
    userId: "user-1",
    deviceSn: "SN123",
    plaudFileId: "plaud-1",
    filename: "enc-title",
    duration: 60_000,
    startTime: new Date("2026-01-01T00:00:00Z"),
    endTime: new Date("2026-01-01T00:01:00Z"),
    filesize: 1024,
    fileMd5: "a".repeat(32),
    storageType: "local",
    storagePath: "audio/rec-1.mp3",
    downloadedAt: null,
    plaudVersion: "1",
    timezone: null,
    zonemins: null,
    scene: null,
    isTrash: false,
    waveformPeaks: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:02:00Z"),
    updatedAt: new Date("2026-01-01T00:03:00Z"),
});

const device = row<DeviceRow>({
    serialNumber: "SN123",
    name: "Plaud Note",
    model: "Note",
});

const riffadoTranscript = row<TranscriptionRow>({
    id: "tr-1",
    recordingId: "rec-1",
    userId: "user-1",
    text: "enc-own-text",
    detectedLanguage: "en",
    transcriptionType: "server",
    provider: "Custom",
    model: "whisper-1",
    timeline: null,
    timelineSource: null,
    source: "riffado",
    createdAt: new Date("2026-01-01T00:04:00Z"),
});

const plaudTranscript = row<TranscriptionRow>({
    id: "tr-2",
    recordingId: "rec-1",
    userId: "user-1",
    text: "enc-plaud-text",
    detectedLanguage: null,
    transcriptionType: "server",
    provider: "plaud",
    model: "plaud-native",
    timeline: null,
    timelineSource: null,
    source: "plaud",
    createdAt: new Date("2026-01-01T00:05:00Z"),
});

const enhancement = row<EnhancementRow>({
    id: "ai-1",
    recordingId: "rec-1",
    userId: "user-1",
    summary: "enc-summary",
    actionItems: ["Review the timeline"],
    keyPoints: ["Roadmap update"],
    provider: "Custom",
    model: "fake-chat-1",
    source: "riffado",
    createdAt: new Date("2026-01-01T00:06:00Z"),
});

describe("/api/v1 contract", () => {
    it("serializes a recording with device and links", () => {
        expect(
            serializeRecording(recording, device, {
                hasTranscription: true,
                hasSummary: true,
            }),
        ).toMatchSnapshot();
    });

    it("serializes a recording without a device", () => {
        expect(
            serializeRecording(recording, null, {
                hasTranscription: false,
                hasSummary: false,
            }),
        ).toMatchSnapshot();
    });

    it("serializes a recording detail with every transcript and the summary", () => {
        expect(
            serializeRecordingDetail(
                recording,
                device,
                [riffadoTranscript, plaudTranscript],
                enhancement,
                "plaud",
            ),
        ).toMatchSnapshot();
    });

    it("serializes a summary, mapping non-array fields to null", () => {
        expect(
            serializeSummary(
                row<EnhancementRow>({
                    ...enhancement,
                    actionItems: "not-an-array",
                    keyPoints: null,
                }),
            ),
        ).toMatchSnapshot();
    });

    it("picks the preferred source, then the user's own transcript", () => {
        expect(
            resolvePrimaryTranscript(
                [riffadoTranscript, plaudTranscript],
                "plaud",
            )?.source,
        ).toBe("plaud");
        expect(
            resolvePrimaryTranscript(
                [riffadoTranscript, plaudTranscript],
                "missing",
            )?.source,
        ).toBe("riffado");
        expect(resolvePrimaryTranscript([], "plaud")).toBeNull();
    });

    it("round-trips the pagination cursor and rejects malformed input", () => {
        const cursor = {
            updatedAt: new Date("2026-01-01T00:03:00Z"),
            id: "rec-1",
        };
        const encoded = encodeRecordingCursor(cursor);
        expect(encoded).toMatchSnapshot();
        expect(decodeRecordingCursor(encoded)).toEqual(cursor);
        expect(decodeRecordingCursor("not-a-cursor")).toBeNull();
    });
});
