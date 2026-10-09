"use client";

import { ChevronDown, FileText, RefreshCw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { TranscribeInBrowserButton } from "@/components/dashboard/transcribe-in-browser-button";
import { PipelineStatus } from "@/components/recording/pipeline/pipeline-status";
import { SourceSwitcher } from "@/components/recording/transcript/source-switcher";
import { TranscriptBody } from "@/components/recording/transcript/transcript-body";
import { TranscriptMeta } from "@/components/recording/transcript/transcript-meta";
import { TranscriptToolbar } from "@/components/recording/transcript/transcript-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { usePersistedToggle } from "@/hooks/use-persisted-toggle";
import type { RecordingTranscript } from "@/hooks/use-recording-transcript";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

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
 * the download and delete toolbar, the timed or plain text, and the metadata
 * line.
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
    const router = useRouter();
    const confirm = useConfirm();
    const [followPlayback, setFollowPlayback] = useState(true);
    const contentId = useId();
    const [open, toggleOpen] = usePersistedToggle("oah.card.transcript.open");
    const expandThen = (action: () => void) => () => {
        if (!open) toggleOpen();
        action();
    };
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
        refreshPipelineState,
    } = transcript;
    const isDetail = variant === "detail";
    const hasTimeline = Boolean(timeline?.length);
    const cancel = () => void performPipelineAction("cancel");
    const retry = () => void performPipelineAction("retry");

    const deleteTranscript = () => {
        if (!activeTranscript) return;
        const source = activeTranscript.source;
        void confirm({
            title: "Delete this transcript?",
            description:
                "The transcript and its summary will be removed. You can transcribe and summarize again later.",
            confirmLabel: "Delete",
            pendingLabel: "Deleting…",
            destructive: true,
            onConfirm: async () => {
                const response = await fetch(
                    `/api/recordings/${recording.id}/transcription?source=${encodeURIComponent(source)}`,
                    { method: "DELETE" },
                );
                if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as {
                        error?: string;
                    };
                    throw new Error(
                        body.error ?? "Failed to delete transcript",
                    );
                }
            },
        }).then((deleted) => {
            if (!deleted) return;
            toast.success("Transcript deleted");
            void refreshPipelineState();
            router.refresh();
        });
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-expanded={open}
                            aria-controls={contentId}
                            aria-label={
                                open
                                    ? "Collapse transcription"
                                    : "Expand transcription"
                            }
                            onClick={toggleOpen}
                        >
                            <ChevronDown
                                className={cn(
                                    "size-4 transition-transform",
                                    !open && "-rotate-90",
                                )}
                            />
                        </Button>
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="size-5" />
                            Transcription
                        </CardTitle>
                    </div>
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
                                onClick={expandThen(onTranscribe)}
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
                                    onClick={expandThen(onTranscribe)}
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
            <CardContent id={contentId} hidden={!open}>
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
                        <TranscriptToolbar
                            title={recording.filename}
                            text={activeTranscript.text}
                            language={activeTranscript.language}
                            timeline={timeline}
                            deleteDisabled={
                                isTranscribing || Boolean(isPipelineActive)
                            }
                            onDelete={deleteTranscript}
                        />
                        <TranscriptBody
                            text={activeTranscript.text}
                            timeline={timeline}
                            playbackTimeMs={playbackTimeMs}
                            onSeekTimestamp={onSeekTimestamp}
                            followPlayback={isDetail && followPlayback}
                            onUserScroll={() => setFollowPlayback(false)}
                            variant={variant}
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
