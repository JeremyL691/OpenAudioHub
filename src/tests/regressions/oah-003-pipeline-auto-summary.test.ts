import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression for defect fix ③: a transcript produced by the
// audio pipeline gets the automatic summary, as a direct transcription does.
// Before the fix the pipeline path never summarized.

const mocks = vi.hoisted(() => ({
    transaction: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    postProcess: vi.fn(),
    emitEvent: vi.fn(),
    consumeRateLimitBucket: vi.fn(),
    generateSummaryForRecording: vi.fn(),
    settings: {
        autoSummarize: false,
        autoSummarizePreset: null as string | null,
    },
}));

vi.mock("drizzle-orm", () => ({
    and: vi.fn(() => ({})),
    asc: vi.fn(() => ({})),
    desc: vi.fn(() => ({})),
    eq: vi.fn(() => ({})),
    inArray: vi.fn(() => ({})),
    isNotNull: vi.fn(() => ({})),
    isNull: vi.fn(() => ({})),
    sql: vi.fn(() => ({})),
}));

vi.mock("@/db", () => ({
    db: {
        transaction: mocks.transaction,
        select: mocks.select,
        update: mocks.update,
    },
}));

vi.mock("@/db/schema", () => {
    const columns = (table: string) =>
        new Proxy({}, { get: (_target, key) => `${table}.${String(key)}` });
    return {
        aiEnhancements: columns("aiEnhancements"),
        audioPipelineJobs: columns("audioPipelineJobs"),
        recordings: columns("recordings"),
        transcriptions: columns("transcriptions"),
        userSettings: columns("userSettings"),
    };
});

vi.mock("@/lib/env", () => ({
    env: {
        AUDIO_PIPELINE_BASE_URL: "http://pipeline.internal",
        AUDIO_PIPELINE_ENABLED: true,
        AUDIO_PIPELINE_TOKEN: "controlled-test-token",
        AUTO_SUMMARY_RATE_LIMIT_PER_HOUR: 60,
    },
}));

vi.mock("@/lib/encryption/fields", () => ({
    encryptJsonField: vi.fn((value: unknown) => JSON.stringify(value)),
    encryptText: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/transcription/postprocess", () => ({
    postProcessPipelineTranscription: mocks.postProcess,
}));

vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: mocks.emitEvent }));

vi.mock("@/lib/rate-limit", () => ({
    consumeRateLimitBucket: mocks.consumeRateLimitBucket,
}));

vi.mock("@/lib/summary/generate-summary", () => ({
    generateSummaryForRecording: mocks.generateSummaryForRecording,
}));

import { processJob } from "@/lib/transcription/audio-pipeline";

const job = {
    id: "core-job",
    userId: "user-1",
    recordingId: "recording-1",
    generation: 1,
    providerId: "provider-1",
    provider: "elevenlabs",
    model: "scribe_v1",
    language: "en",
    durationMs: 1000,
    status: "running",
    pipelineJobId: "pipeline-job",
    attempts: 0,
    leaseToken: "lease-token",
};

const pipelineResult = {
    schema_version: 1,
    text: "A synthetic transcript",
    timeline: [{ start_ms: 0, end_ms: 100, text: "A synthetic transcript" }],
    timestamp_source: "native",
    status: "completed",
    metadata: {
        duration_ms: 1000,
        timestamp_policy: {
            name: "chunk_end_guard_50ms_v1",
            normalized_segment_count: 0,
            ignored_blank_segment_count: 0,
        },
    },
};

// The persist transaction reads the job row; `status` decides whether this
// run may commit the result (only submitted or running jobs can).
function makeTransaction(status: string) {
    const rows = [
        { deletedAt: null },
        { generation: 1, status, configSnapshot: {} },
        { generation: 1 },
        { id: "transcription-1" },
    ];
    let selection = 0;
    const builder = () => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.for = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(async () => {
            const row = rows[selection++];
            return row ? [row] : [];
        });
        return chain;
    };
    return {
        select: vi.fn(builder),
        update: vi.fn(() => {
            const chain: Record<string, ReturnType<typeof vi.fn>> = {};
            chain.set = vi.fn(() => chain);
            chain.where = vi.fn(async () => undefined);
            return chain;
        }),
        delete: vi.fn(() => {
            const chain: Record<string, ReturnType<typeof vi.fn>> = {};
            chain.where = vi.fn(async () => undefined);
            return chain;
        }),
    };
}

function queryResult(result: unknown[]) {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(async () => result);
    return chain;
}

// Pipeline endpoints: the job is completed, its result is ready, and the
// acknowledgement is accepted. Returns the ack counter for assertions.
function stubPipeline() {
    let acks = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/jobs/pipeline-job")) {
            return Response.json({
                status: "completed",
                phase: "completed",
                progress: 1,
            });
        }
        if (url.endsWith("/v1/jobs/pipeline-job/result")) {
            return Response.json(pipelineResult);
        }
        if (url.endsWith("/v1/jobs/pipeline-job/ack")) {
            acks += 1;
            return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected pipeline request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { acks: () => acks };
}

function summaryEvents() {
    return mocks.emitEvent.mock.calls
        .map(([name]) => name)
        .filter((name) => String(name).startsWith("summary."));
}

describe("pipeline transcripts get the automatic summary (oah-003)", () => {
    beforeEach(() => {
        mocks.settings.autoSummarize = false;
        mocks.settings.autoSummarizePreset = null;
        mocks.consumeRateLimitBucket.mockResolvedValue({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAt: new Date(),
        });
        mocks.generateSummaryForRecording.mockResolvedValue({});
        mocks.postProcess.mockResolvedValue(undefined);
        mocks.emitEvent.mockResolvedValue(undefined);
        mocks.select.mockImplementation((fields?: Record<string, unknown>) => {
            if (fields && "autoSummarize" in fields) {
                return queryResult([{ ...mocks.settings }]);
            }
            return queryResult([{ pipelineJobId: job.pipelineJobId }]);
        });
        mocks.update.mockImplementation(() => {
            const chain: Record<string, ReturnType<typeof vi.fn>> = {};
            chain.set = vi.fn(() => chain);
            chain.where = vi.fn(async () => undefined);
            return chain;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("with auto-summarize on, a committed result is summarized with the chosen preset", async () => {
        mocks.settings.autoSummarize = true;
        mocks.settings.autoSummarizePreset = "meeting-notes";
        mocks.transaction.mockImplementation(async (callback) =>
            callback(makeTransaction("running")),
        );
        const pipeline = stubPipeline();

        await processJob(job);

        expect(mocks.generateSummaryForRecording).toHaveBeenCalledTimes(1);
        expect(mocks.generateSummaryForRecording).toHaveBeenCalledWith(
            "user-1",
            "recording-1",
            { presetId: "meeting-notes", trigger: "auto" },
        );
        expect(summaryEvents()).toEqual(["summary.completed"]);
        expect(pipeline.acks()).toBe(1);
    });

    it("with auto-summarize off, a committed result is not summarized", async () => {
        mocks.settings.autoSummarize = false;
        mocks.transaction.mockImplementation(async (callback) =>
            callback(makeTransaction("running")),
        );
        stubPipeline();

        await processJob(job);

        expect(mocks.postProcess).toHaveBeenCalledTimes(1);
        expect(mocks.generateSummaryForRecording).not.toHaveBeenCalled();
        expect(summaryEvents()).toEqual([]);
    });

    it("a replayed result does not summarize a second time", async () => {
        mocks.settings.autoSummarize = true;
        // First run commits the result; the replay finds the job already completed.
        const statuses = ["running", "completed"];
        mocks.transaction.mockImplementation(async (callback) =>
            callback(makeTransaction(statuses.shift() ?? "completed")),
        );
        stubPipeline();

        await processJob(job);
        await processJob(job);

        expect(mocks.postProcess).toHaveBeenCalledTimes(1);
        expect(mocks.generateSummaryForRecording).toHaveBeenCalledTimes(1);
        expect(summaryEvents()).toEqual(["summary.completed"]);
    });

    it("a failed summary is reported and does not block the acknowledgement", async () => {
        mocks.settings.autoSummarize = true;
        mocks.generateSummaryForRecording.mockRejectedValueOnce(
            new Error("provider down"),
        );
        mocks.transaction.mockImplementation(async (callback) =>
            callback(makeTransaction("running")),
        );
        const pipeline = stubPipeline();

        await expect(processJob(job)).resolves.toBeUndefined();

        expect(mocks.emitEvent).toHaveBeenCalledWith(
            "summary.failed",
            "user-1",
            "recording-1",
            { error: "provider down" },
        );
        expect(pipeline.acks()).toBe(1);
    });
});
