"use client";

import { SpeakerTranscript } from "@/components/recordings/rich-content";
import type { TimelineSegment } from "@/hooks/use-pipeline-status";

export function formatTimestamp(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface TranscriptBodyProps {
    text: string;
    /** Timed segments from the pipeline. Only shown for the user's own transcript. */
    timeline: TimelineSegment[] | null | undefined;
    playbackTimeMs?: number;
    onSeekTimestamp?: (milliseconds: number) => void;
}

/**
 * The transcript text. With timed segments it is a clickable timeline that
 * follows playback. Without them it is the plain speaker text.
 */
export function TranscriptBody({
    text,
    timeline,
    playbackTimeMs,
    onSeekTimestamp,
}: TranscriptBodyProps) {
    return (
        <div className="bg-muted rounded-lg p-4 max-h-96 overflow-y-auto">
            {timeline?.length ? (
                <ol data-testid="transcript-timeline" className="space-y-1">
                    {timeline.map((segment, index) => {
                        const isActive =
                            playbackTimeMs !== undefined &&
                            playbackTimeMs >= segment.start_ms &&
                            playbackTimeMs < segment.end_ms;
                        return (
                            <li
                                data-testid="transcript-segment"
                                data-start-ms={segment.start_ms}
                                data-active={isActive}
                                key={`${segment.start_ms}-${index}`}
                            >
                                <button
                                    type="button"
                                    disabled={!onSeekTimestamp}
                                    aria-current={isActive ? "time" : undefined}
                                    onClick={() => {
                                        onSeekTimestamp?.(segment.start_ms);
                                    }}
                                    className={`w-full rounded px-2 py-1 text-left text-sm leading-relaxed hover:bg-background/70 disabled:cursor-default ${isActive ? "bg-background font-medium" : ""}`}
                                >
                                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                                        {formatTimestamp(segment.start_ms)}
                                    </span>
                                    {segment.text}
                                </button>
                            </li>
                        );
                    })}
                </ol>
            ) : (
                <SpeakerTranscript text={text} className="text-sm" />
            )}
        </div>
    );
}
