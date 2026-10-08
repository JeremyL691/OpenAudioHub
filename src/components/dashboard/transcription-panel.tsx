"use client";

import { FileText, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { SummaryPanel } from "@/components/recording/ai/summary-panel";
import { PipelineStatus } from "@/components/recording/pipeline/pipeline-status";
import { SourceSwitcher } from "@/components/recording/transcript/source-switcher";
import { TranscriptBody } from "@/components/recording/transcript/transcript-body";
import { TranscriptMeta } from "@/components/recording/transcript/transcript-meta";
import type { TranscriptOption } from "@/components/recording/transcript/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePipelineStatus } from "@/hooks/use-pipeline-status";
import { useTranscriptionSummary } from "@/hooks/use-transcription-summary";
import { isOwnSource, OWN_SOURCE } from "@/lib/transcription/source";
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
 * The transcription card and the summary card for one recording. The pipeline
 * polling, the pipeline status, the transcript body, and the summary each live
 * in their own module (see docs/dev/DECISIONS.md, D-142).
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
    const [activeSource, setActiveSource] = useState<string | undefined>(
        undefined,
    );
    const {
        pipelineState,
        activeJob,
        isPipelineRunning,
        isPipelineActive,
        pipelineBusy,
        performPipelineAction,
    } = usePipelineStatus({
        recordingId: recording.id,
        isTranscribing,
        onTranscribeComplete,
        onJobCompleted: (state) => {
            if (state.transcription?.text.trim()) setActiveSource(OWN_SOURCE);
        },
    });

    const suppliedTranscriptList: TranscriptOption[] =
        transcripts && transcripts.length > 0
            ? transcripts
            : transcription?.text
              ? [
                    {
                        source: OWN_SOURCE,
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
        transcriptionText: activeTranscript?.text,
    });

    return (
        <div className="space-y-4">
            {/* Transcription Card */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />
                            Transcription
                        </CardTitle>
                        <div className="flex items-center gap-2">
                            {activeTranscript?.text && (
                                <Button
                                    onClick={onTranscribe}
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                        isTranscribing ||
                                        Boolean(isPipelineActive)
                                    }
                                >
                                    <RefreshCw className="size-4 mr-2" />
                                    Re-transcribe
                                </Button>
                            )}
                            {!activeTranscript?.text && !isTranscribing && (
                                <>
                                    <Button
                                        onClick={onTranscribe}
                                        size="sm"
                                        disabled={
                                            isTranscribing ||
                                            Boolean(isPipelineActive)
                                        }
                                    >
                                        <Sparkles className="size-4 mr-2" />
                                        Transcribe
                                    </Button>
                                    <TranscribeInBrowserButton
                                        recordingId={recording.id}
                                        disabled={isTranscribing}
                                        onComplete={
                                            // Falling back to `onTranscribe` here
                                            // would kick off a redundant SERVER
                                            // transcription right after a
                                            // successful browser one, possibly
                                            // overwriting it. Callers that care
                                            // about refreshing after a browser
                                            // transcription must pass
                                            // `onTranscribeComplete` explicitly.
                                            onTranscribeComplete ?? (() => {})
                                        }
                                    />
                                </>
                            )}
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {isTranscribing && !activeTranscript?.text ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <div className="animate-spin size-8 border-2 border-primary border-t-transparent rounded-full mb-4" />
                            <p className="text-sm text-muted-foreground">
                                Transcribing audio…
                            </p>
                        </div>
                    ) : activeTranscript?.text ? (
                        <div className="space-y-4">
                            <PipelineStatus
                                variant="inline"
                                job={activeJob}
                                isTranscribing={isTranscribing}
                                isPipelineRunning={Boolean(isPipelineRunning)}
                                busy={pipelineBusy}
                                onCancel={() =>
                                    void performPipelineAction("cancel")
                                }
                                onRetry={() =>
                                    void performPipelineAction("retry")
                                }
                            />
                            <SourceSwitcher
                                transcripts={transcriptList}
                                activeSource={activeTranscript.source}
                                onSelect={setActiveSource}
                            />
                            <TranscriptBody
                                text={activeTranscript.text}
                                timeline={timeline}
                                playbackTimeMs={playbackTimeMs}
                                onSeekTimestamp={onSeekTimestamp}
                            />
                            <TranscriptMeta transcript={activeTranscript} />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-10 text-center">
                            {isPipelineRunning ||
                            activeJob?.status === "paused" ||
                            activeJob?.status === "failed" ? (
                                <PipelineStatus
                                    variant="empty"
                                    job={activeJob}
                                    isTranscribing={isTranscribing}
                                    isPipelineRunning={Boolean(
                                        isPipelineRunning,
                                    )}
                                    busy={pipelineBusy}
                                    onCancel={() =>
                                        void performPipelineAction("cancel")
                                    }
                                    onRetry={() =>
                                        void performPipelineAction("retry")
                                    }
                                />
                            ) : (
                                <>
                                    <FileText className="size-10 text-muted-foreground mb-3" />
                                    <p className="text-sm text-muted-foreground">
                                        No transcription yet. Use the Transcribe
                                        button above.
                                    </p>
                                </>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Summary Card -- only show when a transcript exists */}
            {activeTranscript?.text && <SummaryPanel summary={summary} />}
        </div>
    );
}
