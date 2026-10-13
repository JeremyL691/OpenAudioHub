"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { RecordingPlayer } from "@/components/dashboard/recording-player";
import { LocalTime } from "@/components/local-time";
import { SummaryPanel } from "@/components/recording/ai/summary-panel";
import { PipelineStatus } from "@/components/recording/pipeline/pipeline-status";
import { TranscriptCard } from "@/components/recording/transcript/transcript-card";
import type { TranscriptOption } from "@/components/recording/transcript/types";
import { RecordingActionsMenu } from "@/components/recordings/recording-actions-menu";
import { RecordingDetailsCard } from "@/components/recordings/recording-details-card";
import { RecordingTitle } from "@/components/recordings/recording-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecordingTranscript } from "@/hooks/use-recording-transcript";
import { formatBytes } from "@/lib/format-bytes";
import { formatDurationMs } from "@/lib/format-duration";
import { recordingSource } from "@/lib/recordings/transcript-status";
import type { Recording } from "@/types/recording";

interface Transcription {
    text?: string;
    detectedLanguage?: string;
    transcriptionType?: string;
}

interface RecordingWorkstationProps {
    recording: Recording;
    transcription?: Transcription;
    /** All transcripts (one per source) for the in-panel source switcher. */
    transcripts?: TranscriptOption[];
    /**
     * User playback preferences forwarded into the embedded
     * RecordingPlayer. Server-resolved (with the same defaults as the
     * dashboard's Workstation) so callers don't need to know the
     * shape of user_settings; the page server-component reads them
     * once and hands them down here.
     */
    initialPlaybackSpeed?: number;
    initialVolume?: number;
    initialAutoPlayNext?: boolean;
    scrubberStyle?: "waveform" | "slider";
}

/**
 * Below xl the three sections are tabs. From xl the transcript runs down the
 * left and the summary and details stack on the right. The forceMount panels
 * stay in the DOM, so the grid can show them all, and the classes hide the
 * inactive ones below xl.
 */
const PANEL_CLASS = "data-[state=inactive]:hidden";

export function RecordingWorkstation({
    recording,
    transcription,
    transcripts,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
}: RecordingWorkstationProps) {
    const { push, refresh } = useRouter();
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [filename, setFilename] = useState(recording.filename);
    const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
    const seekRef = useRef<((milliseconds: number) => void) | null>(null);

    useEffect(() => {
        setFilename(recording.filename);
    }, [recording.filename]);

    const displayRecording = useMemo(
        () =>
            filename === recording.filename
                ? recording
                : { ...recording, filename },
        [recording, filename],
    );

    const handleRenamed = useCallback(
        (next: string) => {
            setFilename(next);
            refresh();
        },
        [refresh],
    );

    // The player hands over its seek function once; the timeline reaches it
    // through seekTo. Clicking a segment therefore moves the audio.
    const handleRegisterSeek = useCallback(
        (seek: (milliseconds: number) => void) => {
            seekRef.current = seek;
        },
        [],
    );
    const seekTo = useCallback((milliseconds: number) => {
        seekRef.current?.(milliseconds);
    }, []);

    const transcript = useRecordingTranscript({
        recording: displayRecording,
        transcription,
        transcripts,
        isTranscribing,
        onTranscribeComplete: refresh,
    });
    const hasTranscript = Boolean(transcript.activeTranscript?.text);
    // Without a transcript, the transcript card shows the pipeline state itself (with its
    // own controls). The banner above is hidden in those states so there is one status surface.
    const cardShowsPipelineStatus =
        !hasTranscript &&
        (isTranscribing ||
            Boolean(transcript.isPipelineRunning) ||
            transcript.activeJob?.status === "paused" ||
            transcript.activeJob?.status === "failed");
    const transcriptBusy =
        isTranscribing || Boolean(transcript.isPipelineActive);

    const handleTranscribe = useCallback(async () => {
        setIsTranscribing(true);
        try {
            const response = await fetch(
                `/api/recordings/${recording.id}/transcribe`,
                {
                    method: "POST",
                },
            );

            if (response.ok) {
                toast.success("Transcription complete");
                refresh();
            } else {
                const error = await response.json();
                toast.error(error.error || "Transcription failed");
            }
        } catch {
            toast.error("Failed to transcribe recording");
        } finally {
            setIsTranscribing(false);
        }
    }, [recording.id, refresh]);

    const handleDelete = useCallback(async () => {
        setIsDeleting(true);
        try {
            const response = await fetch(`/api/recordings/${recording.id}`, {
                method: "DELETE",
            });

            if (response.ok) {
                toast.success("Recording deleted");
                setDeleteDialogOpen(false);
                push("/recordings");
                refresh();
            } else {
                const error = await response.json().catch(() => ({}));
                toast.error(error.error || "Failed to delete recording");
                setIsDeleting(false);
            }
        } catch {
            toast.error("Failed to delete recording");
            setIsDeleting(false);
        }
    }, [recording.id, refresh, push]);

    return (
        <div className="bg-background lg:h-[calc(100svh-3.25rem)] lg:overflow-hidden">
            <div className="container mx-auto max-w-7xl px-4 py-6 lg:flex lg:h-full lg:min-h-0 lg:max-w-none lg:flex-col lg:px-0 lg:py-0">
                {/* Header */}
                <div className="mb-6 flex items-start gap-4 lg:mb-0 lg:shrink-0 lg:px-8 lg:pt-6 lg:pb-3">
                    <Button
                        onClick={() => push("/recordings")}
                        variant="outline"
                        size="icon"
                        aria-label="Back to recordings"
                    >
                        <ArrowLeft className="size-4" />
                    </Button>
                    {/* contain: a long title truncates here instead of setting the
                        row's minimum width, which overflowed the page at 1280 px. */}
                    <div className="min-w-0 flex-1 [contain:inline-size]">
                        <h1 className="min-w-0">
                            <RecordingTitle
                                recordingId={recording.id}
                                filename={filename}
                                onRenamed={handleRenamed}
                                className="text-[22px] font-bold tracking-tight"
                            />
                        </h1>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                            <LocalTime value={recording.startTime} />
                            <span aria-hidden="true">·</span>
                            <span>{formatDurationMs(recording.duration)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatBytes(recording.filesize)}</span>
                            <Badge variant="outline">
                                {recordingSource(recording.deviceSn)}
                            </Badge>
                        </p>
                    </div>
                    <RecordingActionsMenu
                        recordingId={recording.id}
                        title={filename}
                        transcript={transcript.activeTranscript ?? null}
                        timeline={transcript.timeline}
                        busy={transcriptBusy}
                        onTranscribe={handleTranscribe}
                        onDelete={() => setDeleteDialogOpen(true)}
                    />
                </div>

                {/* Player and the pipeline strip under it */}
                <div className="space-y-4 lg:order-last lg:shrink-0 lg:space-y-2 lg:border-t lg:border-border lg:bg-muted/40 lg:px-8">
                    <RecordingPlayer
                        recording={displayRecording}
                        initialPlaybackSpeed={initialPlaybackSpeed}
                        initialVolume={initialVolume}
                        initialAutoPlayNext={initialAutoPlayNext}
                        scrubberStyle={scrubberStyle}
                        onRenamed={handleRenamed}
                        onRegisterSeek={handleRegisterSeek}
                        onPlaybackTimeChange={setPlaybackTimeMs}
                        hideIdentity
                    />
                    {!cardShowsPipelineStatus && (
                        <PipelineStatus
                            variant="inline"
                            job={transcript.activeJob}
                            isTranscribing={isTranscribing}
                            isPipelineRunning={Boolean(
                                transcript.isPipelineRunning,
                            )}
                            busy={transcript.pipelineBusy}
                            onCancel={() =>
                                void transcript.performPipelineAction("cancel")
                            }
                            onRetry={() =>
                                void transcript.performPipelineAction("retry")
                            }
                        />
                    )}
                    {transcript.activeJob?.status === "needs_alignment" && (
                        <p className="text-sm text-muted-foreground">
                            This transcript was saved without timestamps. The
                            timeline and the SRT and VTT exports are not
                            available for it.
                        </p>
                    )}
                </div>

                {/* Sections: one tab at a time */}
                <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:pb-8">
                    <Tabs defaultValue="transcript" className="mt-6 gap-4">
                        <TabsList>
                            <TabsTrigger value="transcript">
                                Transcript
                            </TabsTrigger>
                            <TabsTrigger value="summary">Summary</TabsTrigger>
                            <TabsTrigger value="details">Details</TabsTrigger>
                        </TabsList>

                        <TabsContent
                            value="transcript"
                            forceMount
                            className={PANEL_CLASS}
                        >
                            <TranscriptCard
                                variant="detail"
                                recording={displayRecording}
                                transcript={transcript}
                                isTranscribing={isTranscribing}
                                onTranscribe={handleTranscribe}
                                onTranscribeComplete={refresh}
                                playbackTimeMs={playbackTimeMs}
                                onSeekTimestamp={seekTo}
                            />
                        </TabsContent>

                        <TabsContent
                            value="summary"
                            forceMount
                            className={PANEL_CLASS}
                        >
                            {hasTranscript ? (
                                <SummaryPanel
                                    summary={transcript.summary}
                                    title={recording.filename}
                                />
                            ) : (
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Summary</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm text-muted-foreground">
                                            A summary is available once the
                                            recording has a transcript.
                                        </p>
                                    </CardContent>
                                </Card>
                            )}
                        </TabsContent>

                        <TabsContent
                            value="details"
                            forceMount
                            className={PANEL_CLASS}
                        >
                            <RecordingDetailsCard
                                recording={displayRecording}
                            />
                        </TabsContent>
                    </Tabs>
                </div>
            </div>

            <Dialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                    if (!isDeleting) setDeleteDialogOpen(open);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete this recording?</DialogTitle>
                        <DialogDescription>
                            This permanently removes the audio file,
                            transcription, and AI summary from OpenAudioHub. The
                            recording on your Plaud account is not affected, but
                            it will not be re-synced to OpenAudioHub.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setDeleteDialogOpen(false)}
                            disabled={isDeleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={isDeleting}
                        >
                            {isDeleting ? (
                                <>
                                    <Loader2 className="size-4 mr-2 animate-spin" />
                                    Deleting…
                                </>
                            ) : (
                                "Delete recording"
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
