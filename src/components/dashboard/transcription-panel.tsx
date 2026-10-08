"use client";

import { SummaryPanel } from "@/components/recording/ai/summary-panel";
import { TranscriptCard } from "@/components/recording/transcript/transcript-card";
import type { TranscriptOption } from "@/components/recording/transcript/types";
import { useRecordingTranscript } from "@/hooks/use-recording-transcript";
import type { Recording } from "@/types/recording";

export type { TranscriptOption } from "@/components/recording/transcript/types";

interface Transcription {
    text?: string;
    language?: string;
}

interface TranscriptionPanelProps {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. When
     * more than one is present a source switcher is shown. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    onTranscribe: () => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    onSeekTimestamp?: (milliseconds: number) => void;
    playbackTimeMs?: number;
}

/**
 * The library preview's transcript card and summary card for one recording.
 * The state comes from useRecordingTranscript and the cards from
 * TranscriptCard (preview variant) and SummaryPanel (see D-142 and D-144).
 */
export function TranscriptionPanel({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onSeekTimestamp,
    playbackTimeMs,
}: TranscriptionPanelProps) {
    const transcript = useRecordingTranscript({
        recording,
        transcription,
        transcripts,
        isTranscribing,
        onTranscribeComplete,
    });

    return (
        <div className="space-y-4">
            <TranscriptCard
                variant="preview"
                recording={recording}
                transcript={transcript}
                isTranscribing={isTranscribing}
                onTranscribe={onTranscribe}
                onTranscribeComplete={onTranscribeComplete}
                playbackTimeMs={playbackTimeMs}
                onSeekTimestamp={onSeekTimestamp}
            />

            {/* Summary Card -- only show when a transcript exists */}
            {transcript.activeTranscript?.text && (
                <SummaryPanel
                    summary={transcript.summary}
                    title={recording.filename}
                />
            )}
        </div>
    );
}
