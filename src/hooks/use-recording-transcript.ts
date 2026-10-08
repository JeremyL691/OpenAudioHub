"use client";

import { useEffect, useState } from "react";
import type { TranscriptOption } from "@/components/recording/transcript/types";
import { usePipelineStatus } from "@/hooks/use-pipeline-status";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import { isOwnSource, OWN_SOURCE } from "@/lib/transcription/source";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    language?: string;
    source?: string;
}

interface UseRecordingTranscriptOptions {
    recording: Recording;
    /** Back-compat single transcript. Used only when `transcripts` is absent. */
    transcription?: Transcription;
    /** All transcripts for the recording, one per source, primary first. */
    transcripts?: TranscriptOption[];
    isTranscribing: boolean;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
}

/**
 * Everything one recording's transcript needs: the pipeline job and its
 * polling, the transcript list with the pipeline's result merged in, the
 * active source, the timeline, and the summary. The transcript card and the
 * summary panel both read from it, so the pipeline is polled once per view.
 */
export function useRecordingTranscript({
    recording,
    transcription,
    transcripts,
    isTranscribing,
    onTranscribeComplete,
}: UseRecordingTranscriptOptions) {
    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const pipeline = usePipelineStatus({
        recordingId: recording.id,
        isTranscribing,
        onTranscribeComplete,
        onJobCompleted: (state) => {
            if (state.transcription?.text.trim()) setActiveSource(OWN_SOURCE);
        },
    });
    const { pipelineState } = pipeline;

    const suppliedTranscriptList: TranscriptOption[] =
        transcripts && transcripts.length > 0
            ? transcripts
            : transcription?.text
              ? [
                    {
                        source: transcription.source ?? OWN_SOURCE,
                        text: transcription.text,
                        language: transcription.language,
                    },
                ]
              : [];
    const pipelineTranscriptReady = ["completed", "needs_alignment"].includes(
        pipelineState?.job?.status ?? "",
    )
        ? (pipelineState?.transcription ?? null)
        : null;
    const transcriptList: TranscriptOption[] = pipelineTranscriptReady
        ? [
              ...suppliedTranscriptList.filter((t) => !isOwnSource(t.source)),
              pipelineTranscriptReady,
          ]
        : suppliedTranscriptList;

    const activeTranscript =
        transcriptList.find((t) => t.source === activeSource) ??
        transcriptList[0];

    useEffect(() => {
        if (pipelineTranscriptReady?.text.trim()) {
            setActiveSource((current) => current ?? OWN_SOURCE);
        }
    }, [pipelineTranscriptReady?.text]);

    const timeline = isOwnSource(activeTranscript?.source)
        ? pipelineState?.timeline
        : null;

    const summary = useTranscriptionSummary({
        recordingId: recording?.id,
        transcriptionSource: activeTranscript?.source,
        transcriptionText: activeTranscript?.text,
    });

    return {
        ...pipeline,
        transcriptList,
        activeTranscript,
        activeSource,
        setActiveSource,
        timeline,
        summary,
    };
}

export type RecordingTranscript = ReturnType<typeof useRecordingTranscript>;
