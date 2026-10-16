"use client";

import { ArrowLeft, Loader2, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import {
    type ComponentProps,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
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
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRecordingTranscript } from "@/hooks/use-recording-transcript";
import { formatDurationMs } from "@/lib/format-duration";
import { setRecordingStarred } from "@/lib/recordings/star";
import { recordingSource } from "@/lib/recordings/transcript-status";
import { cn } from "@/lib/utils";
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

type SummaryData = ComponentProps<typeof SummaryPanel>["summary"];

/** Below 1440 px the sections are tabs. From 1440 px the transcript runs beside a right column. */
const WIDE_QUERY = "(min-width: 90rem)";
const PANEL_CLASS = "data-[state=inactive]:hidden";

function subscribeWide(onChange: () => void) {
    if (typeof window.matchMedia !== "function") return () => {};
    const query = window.matchMedia(WIDE_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
}

function getIsWide() {
    return (
        typeof window.matchMedia === "function" &&
        window.matchMedia(WIDE_QUERY).matches
    );
}

/** One layout renders at a time, so the panels mount once. */
function useIsWide() {
    return useSyncExternalStore(subscribeWide, getIsWide, () => false);
}

/** Stars or unstars a recording. The icon changes at once and reverts if the server refuses. */
export function RecordingStarButton({
    recordingId,
    starred: starredProp,
}: {
    recordingId: string;
    starred: boolean;
}) {
    const { refresh } = useRouter();
    const [starred, setStarred] = useState(starredProp);

    useEffect(() => {
        setStarred(starredProp);
    }, [starredProp]);

    const handleToggle = useCallback(async () => {
        const next = !starred;
        setStarred(next);
        try {
            await setRecordingStarred(recordingId, next);
            refresh();
        } catch {
            setStarred(!next);
            toast.error("Could not update the star");
        }
    }, [recordingId, refresh, starred]);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-10 shrink-0 sm:size-8"
                    data-testid="recording-star"
                    aria-pressed={starred}
                    aria-label={starred ? "Unstar" : "Star"}
                    onClick={handleToggle}
                >
                    <Star
                        className={cn(
                            "size-4",
                            starred && "fill-current text-primary",
                        )}
                        aria-hidden="true"
                    />
                </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
                {starred ? "Unstar" : "Star"}
            </TooltipContent>
        </Tooltip>
    );
}

/** The date, duration and source line under a recording's title. */
export function RecordingMeta({ recording }: { recording: Recording }) {
    return (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <LocalTime value={recording.startTime} />
            <span aria-hidden="true">·</span>
            <span>{formatDurationMs(recording.duration)}</span>
            <span aria-hidden="true">·</span>
            <span>{recordingSource(recording.deviceSn)}</span>
        </p>
    );
}

/** The summary once the recording has a transcript, otherwise a short note. */
export function RecordingSummary({
    hasTranscript,
    summary,
    title,
}: {
    hasTranscript: boolean;
    summary: SummaryData;
    title: string;
}) {
    if (hasTranscript) {
        return <SummaryPanel summary={summary} title={title} />;
    }
    return (
        <div className="rounded-2xl bg-card p-5 shadow-card">
            <h2 className="text-[17px] font-semibold">Summary</h2>
            <p className="mt-2 text-sm text-muted-foreground">
                A summary is available once the recording has a transcript.
            </p>
        </div>
    );
}

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
    const isWide = useIsWide();
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

    const transcriptPanel = (
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
    );
    const summaryPanel = (
        <RecordingSummary
            hasTranscript={hasTranscript}
            summary={transcript.summary}
            title={recording.filename}
        />
    );

    return (
        <div className="bg-background lg:h-[calc(100svh-3.25rem)] lg:overflow-hidden">
            <div className="container mx-auto max-w-7xl space-y-6 px-4 py-6 lg:flex lg:h-full lg:min-h-0 lg:max-w-none lg:flex-col lg:space-y-0 lg:px-0 lg:py-0">
                {/* Header */}
                <div className="flex items-start gap-3 lg:shrink-0 lg:px-8 lg:pt-6 lg:pb-3">
                    <Button
                        onClick={() => push("/recordings")}
                        variant="ghost"
                        size="icon"
                        className="size-10 shrink-0 sm:size-8"
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
                        <RecordingMeta recording={recording} />
                    </div>
                    <RecordingStarButton
                        recordingId={recording.id}
                        starred={recording.starred ?? false}
                    />
                    <RecordingActionsMenu
                        recordingId={recording.id}
                        starred={recording.starred ?? false}
                        title={filename}
                        transcript={transcript.activeTranscript ?? null}
                        timeline={transcript.timeline}
                        busy={transcriptBusy}
                        onTranscribe={handleTranscribe}
                        onDelete={() => setDeleteDialogOpen(true)}
                    />
                </div>

                {/* Player card, with the pipeline strip under it. On lg+ it is docked at the bottom as a bar. */}
                <div className="space-y-4 rounded-2xl bg-card p-5 shadow-card lg:order-last lg:shrink-0 lg:space-y-2 lg:rounded-none lg:border-t lg:border-border lg:bg-background/85 lg:px-8 lg:py-3 lg:shadow-none lg:backdrop-blur">
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

                {/* Sections: they scroll on their own on lg+, under the docked player */}
                <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:pt-4 lg:pb-8">
                    {isWide ? (
                        <div className="flex items-start gap-6">
                            <div className="min-w-0 flex-1">
                                {transcriptPanel}
                            </div>
                            <div className="w-[340px] shrink-0 space-y-4">
                                {summaryPanel}
                                <RecordingDetailsCard
                                    recording={displayRecording}
                                />
                            </div>
                        </div>
                    ) : (
                        <Tabs defaultValue="transcript" className="gap-4">
                            <TabsList className="w-full">
                                <TabsTrigger value="transcript">
                                    Transcript
                                </TabsTrigger>
                                <TabsTrigger value="summary">
                                    Summary
                                </TabsTrigger>
                                <TabsTrigger value="details">
                                    Details
                                </TabsTrigger>
                            </TabsList>

                            <TabsContent
                                value="transcript"
                                forceMount
                                className={PANEL_CLASS}
                            >
                                {transcriptPanel}
                            </TabsContent>

                            <TabsContent
                                value="summary"
                                forceMount
                                className={PANEL_CLASS}
                            >
                                {summaryPanel}
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
                    )}
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
