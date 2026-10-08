"use client";

import { FileText, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { PipelineStatus } from "@/components/recording/pipeline/pipeline-status";
import { SourceSwitcher } from "@/components/recording/transcript/source-switcher";
import { TranscriptBody } from "@/components/recording/transcript/transcript-body";
import { TranscriptMeta } from "@/components/recording/transcript/transcript-meta";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { RecordingTranscript } from "@/hooks/use-recording-transcript";
import type { Recording } from "@/types/recording";

/** Segments the library preview shows before the rest is one click away. */
export const PREVIEW_SEGMENT_LIMIT = 6;

interface TranscriptCardProps {
    /**
     * `preview` is the library's side pane: condensed, with Re-transcribe and
     * the pipeline status above the text. `detail` is the full page, where the
     * actions menu owns Re-transcribe and the pipeline status sits under the
     * player, and where the timeline follows playback.
     */
    variant: "preview" | "detail";
    recording: Recording;
    transcript: RecordingTranscript;
    isTranscribing: boolean;
    onTranscribe: () => void;
    /** Refresh handler called after a browser-side transcription completes. */
    onTranscribeComplete?: () => void;
    playbackTimeMs?: number;
    onSeekTimestamp?: (milliseconds: number) => void;
}

/**
 * The transcript for one recording: the header actions, the source switcher,
 * the timed or plain text, and the metadata line.
 */
export function TranscriptCard({
    variant,
    recording,
    transcript,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    playbackTimeMs,
    onSeekTimestamp,
}: TranscriptCardProps) {
    const [followPlayback, setFollowPlayback] = useState(true);
    const {
        activeTranscript,
        transcriptList,
        setActiveSource,
        timeline,
        activeJob,
        isPipelineRunning,
        isPipelineActive,
        pipelineBusy,
        performPipelineAction,
    } = transcript;
    const isDetail = variant === "detail";
    const hasTimeline = Boolean(timeline?.length);
    const cancel = () => void performPipelineAction("cancel");
    const retry = () => void performPipelineAction("retry");

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <FileText className="size-5" />
                        Transcription
                    </CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                        {isDetail && activeTranscript?.text && hasTimeline && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Switch
                                    checked={followPlayback}
                                    onCheckedChange={setFollowPlayback}
                                    aria-label="Follow playback"
                                />
                                <span>Follow playback</span>
                            </div>
                        )}
                        {!isDetail && activeTranscript?.text && (
                            <Button
                                onClick={onTranscribe}
                                size="sm"
                                variant="outline"
                                disabled={
                                    isTranscribing || Boolean(isPipelineActive)
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
                        {!isDetail && (
                            <PipelineStatus
                                variant="inline"
                                job={activeJob}
                                isTranscribing={isTranscribing}
                                isPipelineRunning={Boolean(isPipelineRunning)}
                                busy={pipelineBusy}
                                onCancel={cancel}
                                onRetry={retry}
                            />
                        )}
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
                            followPlayback={isDetail && followPlayback}
                            previewLimit={
                                isDetail ? undefined : PREVIEW_SEGMENT_LIMIT
                            }
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
                                isPipelineRunning={Boolean(isPipelineRunning)}
                                busy={pipelineBusy}
                                onCancel={cancel}
                                onRetry={retry}
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
    );
}
