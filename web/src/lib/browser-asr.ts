// In-browser transcription (spec/transcription.md "Browser transcription"): download the audio, decode it
// to 16 kHz mono here, run Whisper in a worker, then store the text on the server.
import { api } from "./api";
import type { AsrMessage, AsrRequest } from "./browser-asr.worker";

export const BROWSER_MODEL = "whisper-base";
const SAMPLE_RATE = 16_000;
// Longest recording the browser will transcribe. Decoding holds the whole file in memory (about 2 GB peak for
// 3 hours of stereo), so longer recordings go to a transcription provider instead.
const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;
const MAX_SAMPLES = (MAX_RECORDING_MS / 1000) * SAMPLE_RATE;
const TOO_LONG_MESSAGE = "This recording is too long to transcribe in the browser. Use a transcription provider instead.";
// A run that goes quiet for this long (a stalled model download, a wedged worker) is treated as hung.
const INACTIVITY_MS = 3 * 60 * 1000;
// Whisper sends nothing between "transcribe" and "done", so that step gets a cap that grows with the audio:
// 5 minutes plus 2 seconds per second of audio.
const TRANSCRIBE_BASE_MS = 5 * 60 * 1000;
const TRANSCRIBE_MS_PER_AUDIO_SECOND = 2_000;
const STALLED_MESSAGE = "Browser transcription stopped responding. Try again.";

export type BrowserAsrStage =
    | { stage: "decode" }
    | { stage: "model"; percent: number }
    | { stage: "transcribe" }
    | { stage: "save" };

type PendingRun = {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    onStage: (s: BrowserAsrStage) => void;
    // How long this run may take in the transcribe step before it counts as stalled.
    transcribeCapMs: number;
};

let worker: Worker | null = null;
let nextRequestId = 1;
// Every run in flight, keyed by request id, so replies reach the run that asked for them.
const pending = new Map<number, PendingRun>();
// One watchdog for the worker: the worker runs requests one at a time, so only the current step needs a deadline.
let watchdog: ReturnType<typeof setTimeout> | null = null;

function armWatchdog(ms: number) {
    disarmWatchdog();
    watchdog = setTimeout(stall, ms);
}

function disarmWatchdog() {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
}

// Terminates the worker and fails every waiting run. The singleton is reset, so the next attempt starts a fresh worker.
function stall() {
    watchdog = null;
    const w = worker;
    worker = null;
    w?.terminate();
    const error = new Error(STALLED_MESSAGE);
    const runs = [...pending.values()];
    pending.clear();
    for (const run of runs) run.reject(error);
}

// After a run ends, the next queued run (if any) starts and gets the model-step deadline until it reports.
function runEnded() {
    if (pending.size > 0) armWatchdog(INACTIVITY_MS);
    else disarmWatchdog();
}

function getWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(new URL("./browser-asr.worker.ts", import.meta.url), { type: "module" });
    w.addEventListener("message", (event: MessageEvent<AsrMessage>) => {
        const m = event.data;
        const run = pending.get(m.id);
        if (!run) return;
        if (m.type === "progress") {
            if (m.stage === "model") {
                armWatchdog(INACTIVITY_MS);
                run.onStage({ stage: "model", percent: m.percent });
            } else {
                armWatchdog(run.transcribeCapMs);
                run.onStage({ stage: "transcribe" });
            }
            return;
        }
        pending.delete(m.id);
        runEnded();
        if (m.type === "done") run.resolve(m.text);
        else run.reject(new Error(m.message));
    });
    w.addEventListener("error", (event: ErrorEvent) => {
        // A worker error leaves it unusable: drop it and fail every run that was waiting on it.
        if (worker === w) {
            worker = null;
            disarmWatchdog();
        }
        w.terminate();
        const message = event.message || "Browser transcription failed";
        const runs = [...pending.values()];
        pending.clear();
        for (const run of runs) run.reject(new Error(message));
    });
    worker = w;
    return w;
}

// The recording's length from its metadata (ms), so a long one is refused before its audio is downloaded.
// 0 when it cannot be read; the decoded length is checked as well.
async function recordingDurationMs(recordingId: string): Promise<number> {
    try {
        const detail = await api<{ recording: { duration: number } }>(`/api/recordings/${encodeURIComponent(recordingId)}`);
        return detail.recording.duration ?? 0;
    } catch {
        return 0;
    }
}

async function decode(recordingId: string): Promise<Float32Array> {
    if ((await recordingDurationMs(recordingId)) > MAX_RECORDING_MS) throw new Error(TOO_LONG_MESSAGE);
    const res = await fetch(`/api/recordings/${encodeURIComponent(recordingId)}/audio`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Could not download the audio.");
    const bytes = await res.arrayBuffer();
    // An offline context resamples to its own rate while decoding.
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const audio = await context.decodeAudioData(bytes);
    if (audio.length > MAX_SAMPLES) throw new Error(TOO_LONG_MESSAGE);
    // The mono copy is kept (not the AudioBuffer's own store) because the samples are transferred to the worker.
    if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return mono;
}

function run(request: Omit<AsrRequest, "id">, onStage: (s: BrowserAsrStage) => void): Promise<string> {
    const w = getWorker();
    const id = nextRequestId++;
    // Read before postMessage transfers the buffer away.
    const transcribeCapMs = TRANSCRIBE_BASE_MS + (request.samples.length / SAMPLE_RATE) * TRANSCRIBE_MS_PER_AUDIO_SECOND;
    return new Promise((resolve, reject) => {
        const idle = pending.size === 0;
        pending.set(id, { resolve, reject, onStage, transcribeCapMs });
        // An idle worker has nothing running, so this request gets the model-step deadline until it reports.
        if (idle) armWatchdog(INACTIVITY_MS);
        w.postMessage({ ...request, id } satisfies AsrRequest, [request.samples.buffer]);
    });
}

/**
 * Transcribes a recording on this device and saves the result. `language` is the user's default
 * transcription language, or null for auto-detect.
 */
export async function transcribeRecordingInBrowser(
    recordingId: string,
    language: string | null,
    onStage: (s: BrowserAsrStage) => void = () => {},
): Promise<{ transcription: string; detectedLanguage: string | null }> {
    onStage({ stage: "decode" });
    const samples = await decode(recordingId);
    const text = await run({ samples, model: BROWSER_MODEL, language: language && language !== "auto" ? language : null }, onStage);
    if (!text) throw new Error("No speech was recognized.");
    onStage({ stage: "save" });
    const detectedLanguage = language && language !== "auto" ? language : null;
    return api(`/api/recordings/${encodeURIComponent(recordingId)}/transcription/from-browser`, {
        method: "POST",
        json: { text, model: BROWSER_MODEL, detectedLanguage },
    });
}
