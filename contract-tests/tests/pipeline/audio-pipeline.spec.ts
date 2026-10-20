// The long-recording pipeline end to end, over HTTP, against a real ffmpeg, the real speech
// detection model and a fake provider (see run.sh pipeline mode and spec/audio-pipeline.md).
// These tests need a server started with AUDIO_PIPELINE_ENABLED=true.
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
    configureAccount,
    fakeAiControl,
    fakeAiRequests,
    newUserContext,
    uploadRecording,
} from "../../helpers/api";
import { speechFixtureOrSkip } from "../../helpers/speech";

/** One configured account per test, so the runs cannot interfere with each other. */
let counter = 0;
async function newAccount(): Promise<APIRequestContext> {
    counter += 1;
    const api = await newUserContext(`pipeline-${Date.now()}-${counter}`);
    await configureAccount(api);
    return api;
}

interface PipelineStatus {
    job: {
        id: string;
        status: string;
        phase: string | null;
        progress: number;
        errorType: string | null;
        error: string | null;
    } | null;
    timeline: {
        start_ms: number;
        end_ms: number;
        text: string;
        chunk_index: number;
    }[] | null;
    timestampSource: string | null;
    transcription: { text: string; language?: string; source: string } | null;
}

async function status(api: APIRequestContext, id: string): Promise<PipelineStatus> {
    const res = await api.get(`/api/recordings/${id}/audio-pipeline`);
    expect(res.status(), "pipeline status").toBe(200);
    return (await res.json()) as PipelineStatus;
}

/** Waits for a status the job cannot leave on its own. */
async function waitForStatus(
    api: APIRequestContext,
    id: string,
    wanted: string[],
    timeoutMs: number,
): Promise<PipelineStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: PipelineStatus | null = null;
    while (Date.now() < deadline) {
        last = await status(api, id);
        if (last.job && wanted.includes(last.job.status)) return last;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
        `job ${id} stayed at ${last?.job?.status ?? "no job"} (phase ${last?.job?.phase}), wanted ${wanted.join("/")}`,
    );
}

/** Starts a transcription run and reports the body when the server refuses it. */
async function startTranscription(api: APIRequestContext, id: string): Promise<void> {
    const res = await api.post(`/api/recordings/${id}/transcribe`);
    const status = res.status();
    expect(status, `start transcription: ${status === 200 || status === 202 ? "" : await res.text()}`).toBeLessThan(
        300,
    );
}

/** Uploads the generated speech recording and starts a transcription run. */
async function startRun(api: APIRequestContext): Promise<string> {
    const speech = speechFixtureOrSkip();
    const id = await uploadSpeech(api, speech);
    await fakeAiControl("/__reset");
    await fakeAiControl("/__transcription", { proportional: true });
    await startTranscription(api, id);
    return id;
}

test.describe("audio pipeline", () => {
    test("a long recording is transcribed through the pipeline with a merged timeline", async () => {
        const api = await newAccount();
        const id = await startRun(api);

        // It really is a pipeline run, not a synchronous transcription.
        const started = await status(api, id);
        expect(started.job, "a pipeline job exists").not.toBeNull();

        const done = await waitForStatus(api, id, ["completed"], 150_000);
        expect(done.job?.status).toBe("completed");
        expect(done.transcription?.text, "the transcript is saved").toContain("part of the recording");
        expect(done.timeline, "a timeline is stored").not.toBeNull();

        const timeline = done.timeline ?? [];
        expect(timeline.length, "the timeline has entries").toBeGreaterThan(1);
        // Timestamps come from the chunk offsets, so they must grow and the last one must sit
        // past the chunk length: a per-chunk clock would restart instead.
        for (let i = 1; i < timeline.length; i += 1) {
            expect(
                timeline[i].start_ms,
                `entry ${i} starts after the previous one`,
            ).toBeGreaterThanOrEqual(timeline[i - 1].start_ms);
        }
        const last = timeline[timeline.length - 1];
        // Milliseconds, and past the 120 s target chunk length: a per-chunk clock would restart
        // and leave the last entry inside the first chunk.
        expect(last.end_ms, "the timeline covers more than one chunk").toBeGreaterThan(120_000);
        expect(
            new Set(timeline.map((item) => item.chunk_index)).size,
            "entries come from more than one chunk",
        ).toBeGreaterThan(1);
        // The stored timeline reaches past the first chunk, and every entry keeps the chunk it
        // came from, so the offsets of the later chunks were applied and not lost with the
        // per-chunk clock. The fake provider sees one chunk at a time, so the exact offset of
        // each entry is checked by the server's own tests in `pipeline/merge.rs`.
        const chunkIndexes = [...new Set(timeline.map((item) => item.chunk_index))].sort(
            (a, b) => a - b,
        );
        // Each chunk is placed after the one before it: with the offsets applied, the first entry
        // of a later chunk starts after the last entry of the earlier one. A clock that restarted
        // per chunk would put every chunk's entries around zero and break this order.
        for (const index of chunkIndexes.slice(1)) {
            const previous = timeline.filter((item) => item.chunk_index === index - 1);
            const current = timeline.filter((item) => item.chunk_index === index);
            expect(
                Math.min(...current.map((item) => item.start_ms)),
                `chunk ${index} starts after chunk ${index - 1}`,
            ).toBeGreaterThan(Math.max(...previous.map((item) => item.end_ms)) - 1000);
        }

        // More than one provider call, because the recording is longer than one chunk.
        const calls = await fakeAiRequests("/audio/transcriptions");
        expect(calls.length, "the provider was called more than once").toBeGreaterThan(1);
    });

    test("cancelling a run stops it and stores no transcript", async () => {
        const api = await newAccount();
        const speech = speechFixtureOrSkip();
        const id = await uploadSpeech(api, speech);
        // A slow provider keeps the job in its transcribing phase long enough to cancel it.
        await fakeAiControl("/__reset");
        await fakeAiControl("/__transcription", { proportional: true, delayMs: 4000 });
        await startTranscription(api, id);

        await waitForStatus(api, id, ["running", "queued"], 60_000);
        const cancel = await api.post(`/api/recordings/${id}/audio-pipeline`, {
            data: { action: "cancel" },
        });
        expect(cancel.status(), "cancel is accepted").toBe(200);

        const after = await waitForStatus(api, id, ["cancelled", "completed"], 60_000);
        expect(after.job?.status, "the job ends cancelled").toBe("cancelled");
        expect(after.transcription, "a cancelled run stores nothing").toBeNull();

        // A second cancel is refused, because the job already left the changeable states.
        const again = await api.post(`/api/recordings/${id}/audio-pipeline`, {
            data: { action: "cancel" },
        });
        expect(again.status(), "cancel twice").toBe(409);

        await fakeAiControl("/__transcription", { delayMs: 0 });
    });

    test("a provider that fails a few times does not lose the run", async () => {
        const api = await newAccount();
        const speech = speechFixtureOrSkip();
        const id = await uploadSpeech(api, speech);
        // The first two calls of the first chunk fail with a server error.
        await fakeAiControl("/__reset");
        await fakeAiControl("/__transcription", { proportional: true, failNext: 2, status: 500 });
        await startTranscription(api, id);

        const done = await waitForStatus(api, id, ["completed"], 180_000);
        expect(done.job?.status).toBe("completed");
        expect(done.job?.errorType, "the retry is not recorded as a failure").toBeNull();
        const calls = await fakeAiRequests("/audio/transcriptions");
        // Every chunk was sent again after its failures, so there are more calls than chunks.
        expect(calls.length, "the failed calls were retried").toBeGreaterThan(2);
    });

    test("a provider that never answers fails the run after its retries", async () => {
        const api = await newAccount();
        // A short recording keeps the six attempts per chunk inside the test's patience.
        const speech = speechFixtureOrSkip(2);
        const id = await uploadSpeech(api, speech);
        // Every answer arrives after the server's own provider timeout (run.sh sets 3 s).
        await fakeAiControl("/__reset");
        await fakeAiControl("/__transcription", { proportional: true, delayMs: 6000 });
        await startTranscription(api, id);

        const failed = await waitForStatus(api, id, ["failed"], 240_000);
        expect(failed.job?.status).toBe("failed");
        expect(failed.job?.errorType, "the failure carries an error type").toBeTruthy();
        expect(failed.transcription, "a failed run stores no transcript").toBeNull();

        await fakeAiControl("/__transcription", { delayMs: 0 });
    });

    test("a failed run can be retried and then completes", async () => {
        const api = await newAccount();
        const speech = speechFixtureOrSkip(2);
        const id = await uploadSpeech(api, speech);
        // Fail permanently for a moment, so the run reaches `failed` quickly.
        await fakeAiControl("/__reset");
        await fakeAiControl("/__transcription", {
            proportional: true,
            failNext: 100,
            status: 400,
        });
        await startTranscription(api, id);
        await waitForStatus(api, id, ["failed"], 180_000);

        const before = (await fakeAiRequests("/audio/transcriptions")).length;
        // The provider recovers, and the run is sent again from the recording's page.
        await fakeAiControl("/__transcription", { failNext: 0 });
        const retry = await api.post(`/api/recordings/${id}/audio-pipeline`, {
            data: { action: "retry" },
        });
        expect(retry.status(), "retry is accepted").toBe(200);

        const done = await waitForStatus(api, id, ["completed"], 240_000);
        expect(done.job?.status).toBe("completed");
        expect(done.transcription?.text).toContain("part of the recording");

        // Chunks that already succeeded are kept, so a chunk is not sent a second time.
        const after = (await fakeAiRequests("/audio/transcriptions")).length;
        expect(after, "the retry sends at least the unfinished work").toBeGreaterThan(before);
    });
});

/** Uploads the generated speech file. */
async function uploadSpeech(
    api: APIRequestContext,
    speech: { buffer: Buffer; seconds: number },
): Promise<string> {
    return uploadRecording(api, "speech.wav", "audio/wav", {
        name: "speech.wav",
        buffer: speech.buffer,
        mimeType: "audio/wav",
    });
}