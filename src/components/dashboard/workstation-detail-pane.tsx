"use client";

import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { RecordingPlayer } from "@/components/dashboard/recording-player";
import { TranscriptCard } from "@/components/recording/transcript/transcript-card";
import { RecordingDetailsCard } from "@/components/recordings/recording-details-card";
import { RecordingTitle } from "@/components/recordings/recording-title";
import {
    RecordingMeta,
    RecordingStarButton,
    RecordingSummary,
} from "@/components/recordings/recording-workstation";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecordingTranscript } from "@/hooks/use-recording-transcript";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
}

interface Props {
    currentRecording: Recording | null;
    currentTranscription: TranscriptionData | undefined;
    isCurrentTranscribing: boolean;
    visibleRecordings: Recording[];
    onTranscribe: () => void;
    /** Called after a browser-side transcription completes (refresh data). */
    onTranscribeComplete?: () => void;
    onSelectRecording: (r: Recording) => void;
    onRenamed?: (filename: string) => void;
    onBackToList: () => void;
    /** When true, the pane is hidden (mobile list view active). */
    hiddenOnMobile: boolean;
    initialPlaybackSpeed: number | undefined;
    initialVolume: number | undefined;
    initialAutoPlayNext: boolean | undefined;
    scrubberStyle: "waveform" | "slider" | undefined;
}

interface PaneTabsProps {
    recording: Recording;
    transcription: TranscriptionData | undefined;
    isTranscribing: boolean;
    onTranscribe: () => void;
    onTranscribeComplete?: () => void;
    onSeekTimestamp: (milliseconds: number) => void;
    playbackTimeMs: number;
}

/** Transcript, summary and details as tabs. The hook lives here so it only runs for a selected recording. */
function PaneTabs({
    recording,
    transcription,
    isTranscribing,
    onTranscribe,
    onTranscribeComplete,
    onSeekTimestamp,
    playbackTimeMs,
}: PaneTabsProps) {
    const transcript = useRecordingTranscript({
        recording,
        transcription,
        isTranscribing,
        onTranscribeComplete,
    });
    const hasTranscript = Boolean(transcript.activeTranscript?.text);

    return (
        <Tabs defaultValue="transcript" className="gap-4">
            <TabsList className="w-full">
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="details">Details</TabsTrigger>
            </TabsList>
            <TabsContent value="transcript">
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
            </TabsContent>
            <TabsContent value="summary">
                <RecordingSummary
                    hasTranscript={hasTranscript}
                    summary={transcript.summary}
                    title={recording.filename}
                />
            </TabsContent>
            <TabsContent value="details">
                <RecordingDetailsCard recording={recording} />
            </TabsContent>
        </Tabs>
    );
}

/**
 * Right-hand detail pane: header, player and tabs for the selected recording.
 * On lg+ this is a column next to the recording list; on <lg the list and
 * detail toggle via `mobileView` -- both stay mounted so scroll
 * position / search query / selection survive a back-navigation.
 *
 * Auto-advance on player ended (when `autoPlayNext` is on) moves to
 * the next recording in `visibleRecordings`; the back-affordance is
 * mobile-only because desktop has both panes visible at once.
 */
export function WorkstationDetailPane({
    currentRecording,
    currentTranscription,
    isCurrentTranscribing,
    visibleRecordings,
    onTranscribe,
    onTranscribeComplete,
    onSelectRecording,
    onRenamed,
    onBackToList,
    hiddenOnMobile,
    initialPlaybackSpeed,
    initialVolume,
    initialAutoPlayNext,
    scrubberStyle,
}: Props) {
    const seekToMillisecondsRef = useRef<(milliseconds: number) => void>(
        () => {},
    );
    const registerSeekToMilliseconds = useCallback(
        (seek: (milliseconds: number) => void) => {
            seekToMillisecondsRef.current = seek;
        },
        [],
    );
    const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
    return (
        <div
            className={cn(
                "space-y-6 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:space-y-0",
                hiddenOnMobile && "hidden",
            )}
        >
            {/*
              Mobile back affordance. Returns to the list view without
              dropping the selected recording -- reopening shows the
              same detail. Hidden on lg+ where both panes are visible
              at once.
            */}
            <Button
                variant="ghost"
                size="sm"
                onClick={onBackToList}
                className="-ml-2 h-9 gap-1 px-2 lg:hidden"
            >
                <ArrowLeft className="size-4" />
                Back to recordings
            </Button>
            {currentRecording ? (
                <>
                    <div className="flex justify-end lg:shrink-0 lg:px-8 lg:pt-6 lg:pb-3">
                        <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 px-2"
                            data-testid="open-full-view"
                        >
                            <Link href={`/recordings/${currentRecording.id}`}>
                                Open full view
                                <ArrowUpRight
                                    className="size-4"
                                    aria-hidden="true"
                                />
                            </Link>
                        </Button>
                    </div>
                    {/* lg:contents lets the title row and the player be direct flex items, so the player can dock at the bottom. */}
                    <div className="space-y-4 lg:contents lg:space-y-0">
                        <div className="flex items-start gap-3 lg:shrink-0 lg:px-8">
                            <div className="min-w-0 flex-1 [contain:inline-size]">
                                <h2 className="min-w-0">
                                    <RecordingTitle
                                        recordingId={currentRecording.id}
                                        filename={currentRecording.filename}
                                        onRenamed={onRenamed}
                                        className="text-[22px] font-bold tracking-tight"
                                    />
                                </h2>
                                <RecordingMeta recording={currentRecording} />
                            </div>
                            <RecordingStarButton
                                recordingId={currentRecording.id}
                                starred={currentRecording.starred ?? false}
                            />
                        </div>
                        <div className="rounded-2xl bg-card p-5 shadow-card lg:order-last lg:shrink-0 lg:rounded-none lg:border-t lg:border-border lg:bg-background/85 lg:px-8 lg:py-3 lg:shadow-none lg:backdrop-blur">
                            <RecordingPlayer
                                recording={currentRecording}
                                initialPlaybackSpeed={initialPlaybackSpeed}
                                initialVolume={initialVolume}
                                initialAutoPlayNext={initialAutoPlayNext}
                                scrubberStyle={scrubberStyle}
                                onRegisterSeek={registerSeekToMilliseconds}
                                onPlaybackTimeChange={setPlaybackTimeMs}
                                onRenamed={onRenamed}
                                onEnded={() => {
                                    const currentIndex =
                                        visibleRecordings.findIndex(
                                            (r) => r.id === currentRecording.id,
                                        );
                                    if (
                                        currentIndex >= 0 &&
                                        currentIndex <
                                            visibleRecordings.length - 1
                                    ) {
                                        onSelectRecording(
                                            visibleRecordings[currentIndex + 1],
                                        );
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-8 lg:pt-4 lg:pb-6">
                        <PaneTabs
                            recording={currentRecording}
                            transcription={currentTranscription}
                            isTranscribing={isCurrentTranscribing}
                            onTranscribe={onTranscribe}
                            onTranscribeComplete={onTranscribeComplete}
                            onSeekTimestamp={(milliseconds) => {
                                seekToMillisecondsRef.current(milliseconds);
                            }}
                            playbackTimeMs={playbackTimeMs}
                        />
                    </div>
                </>
            ) : (
                <div className="py-16 text-center lg:flex-1 lg:justify-center">
                    <p className="text-muted-foreground">
                        Select a recording to view details and transcription
                    </p>
                </div>
            )}
        </div>
    );
}
