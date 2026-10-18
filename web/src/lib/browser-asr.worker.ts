// Runs a Whisper model on the user's device. The page sends 16 kHz mono samples; nothing leaves the machine
// except the one-time model download from the Hugging Face hub.
import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from "@huggingface/transformers";
// The package's exports map hides dist/, so the runtime files are addressed by path.
import ortMjs from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasm from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url";

// `id` ties every reply to the request that caused it, so the page can route concurrent runs.
export type AsrRequest = { id: number; samples: Float32Array; model: string; language: string | null };
export type AsrMessage = { id: number } & (
    | { type: "progress"; stage: "model"; percent: number }
    | { type: "progress"; stage: "transcribe" }
    | { type: "done"; text: string }
    | { type: "error"; message: string }
);

env.allowLocalModels = false;
// The runtime is bundled with the app instead of fetched from a CDN.
const wasm = env.backends.onnx.wasm;
if (wasm) {
    wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
    // Threads need cross-origin isolation, which the app does not enable.
    wasm.numThreads = 1;
}

const loaded = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function load(model: string, onPercent: (percent: number) => void) {
    let ready = loaded.get(model);
    if (!ready) {
        const files = new Map<string, { loaded: number; total: number }>();
        // pipeline()'s overloads are too large for the type checker; the task fixes the result type.
        const create = pipeline as unknown as (task: string, model: string, options: object) => Promise<AutomaticSpeechRecognitionPipeline>;
        ready = create("automatic-speech-recognition", `onnx-community/${model}`, {
            dtype: "q8",
            device: "wasm",
            progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
                if (p.status !== "progress" || !p.file || !p.total) return;
                files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
                let done = 0;
                let total = 0;
                for (const f of files.values()) {
                    done += f.loaded;
                    total += f.total;
                }
                onPercent(Math.round((done / total) * 100));
            },
        });
        loaded.set(model, ready);
        ready.catch(() => loaded.delete(model));
    }
    return ready;
}

async function transcribe(request: AsrRequest): Promise<void> {
    const { id, samples, model, language } = request;
    const post = (m: AsrMessage) => self.postMessage(m);
    try {
        const asr = await load(model, (percent) => post({ id, type: "progress", stage: "model", percent }));
        post({ id, type: "progress", stage: "transcribe" });
        const result = await asr(samples, {
            chunk_length_s: 30,
            stride_length_s: 5,
            task: "transcribe",
            ...(language ? { language } : {}),
        });
        const text = (Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text).trim();
        post({ id, type: "done", text });
    } catch (error) {
        post({ id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
}

// One WASM thread: run requests strictly one after another so two long runs never interleave.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<AsrRequest>) => {
    queue = queue.then(() => transcribe(event.data));
};
