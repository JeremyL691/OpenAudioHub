import { transcribeInBrowser } from "@/lib/transcription/browser-transcriber";
import type { TranscriptionModel } from "@/types/transcription";

export type BrowserTranscriptionPhase =
    | "downloading-audio"
    | "decoding-audio"
    | "loading-model"
    | "transcribing";

/**
 * Fetch the recording's audio, run Whisper in the browser, and save the text to
 * the server. Audio never leaves the machine for the transcription itself. Throws
 * with a message the user can read. The caller decides how to show progress.
 */
export async function runBrowserTranscription(
    recordingId: string,
    model: TranscriptionModel,
    onPhase: (phase: BrowserTranscriptionPhase) => void,
): Promise<void> {
    onPhase("downloading-audio");
    const audioRes = await fetch(`/api/recordings/${recordingId}/audio`);
    if (!audioRes.ok) {
        throw new Error(`Failed to fetch audio (${audioRes.status})`);
    }
    const blob = await audioRes.blob();
    const file = new File([blob], `recording-${recordingId}`, {
        type: blob.type || "audio/mpeg",
    });

    onPhase("decoding-audio");
    const result = await transcribeInBrowser(file, model, (status) => {
        if (status === "decoding-audio") onPhase("decoding-audio");
        if (status === "loading-model") onPhase("loading-model");
        if (status === "transcribing") onPhase("transcribing");
    });

    const postRes = await fetch(
        `/api/recordings/${recordingId}/transcription/from-browser`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                text: result.text,
                detectedLanguage: result.detectedLanguage,
                model,
            }),
        },
    );
    if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to save transcription");
    }
}
