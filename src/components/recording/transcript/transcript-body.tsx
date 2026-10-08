"use client";

import { useEffect, useRef } from "react";
import { SpeakerTranscript } from "@/components/recordings/rich-content";
import type { TimelineSegment } from "@/hooks/use-pipeline-status";

export function formatTimestamp(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const HEIGHT_CLASS = {
    preview: "max-h-[60vh]",
    detail: "max-h-[70vh]",
} as const;

interface TranscriptBodyProps {
    text: string;
    /** Timed segments from the pipeline. Only shown for the user's own transcript. */
    timeline: TimelineSegment[] | null | undefined;
    playbackTimeMs?: number;
    onSeekTimestamp?: (milliseconds: number) => void;
    /** Keep the segment that is playing centred in the scroll area. */
    followPlayback?: boolean;
    /** Called when the reader scrolls by hand, so follow-playback stops overriding them. */
    onUserScroll?: () => void;
    /** Sets the scroll area height. The library preview is the shorter of the two. */
    variant?: "preview" | "detail";
}

/**
 * The transcript text. With timed segments it is a clickable timeline that
 * follows playback. Without them it is the plain speaker text. Every segment
 * stays in the scroll area, so nothing is cut off. Following scrolls only the
 * transcript's own scroll area, never the page.
 */
export function TranscriptBody({
    text,
    timeline,
    playbackTimeMs,
    onSeekTimestamp,
    followPlayback = false,
    onUserScroll,
    variant = "detail",
}: TranscriptBodyProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLLIElement>(null);

    const segments = timeline ?? [];
    const activeIndex =
        playbackTimeMs === undefined
            ? -1
            : segments.findIndex(
                  (segment) =>
                      playbackTimeMs >= segment.start_ms &&
                      playbackTimeMs < segment.end_ms,
              );

    // activeIndex is the trigger: the effect re-centres whenever the playing
    // segment changes. The body itself reads only the refs.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
    useEffect(() => {
        const container = scrollRef.current;
        const active = activeRef.current;
        if (!followPlayback || !container || !active) return;
        const top =
            active.offsetTop -
            (container.clientHeight - active.clientHeight) / 2;
        container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }, [activeIndex, followPlayback]);

    return (
        <div
            ref={scrollRef}
            onWheel={onUserScroll}
            onTouchMove={onUserScroll}
            className={`relative bg-muted rounded-lg p-4 overflow-y-auto ${HEIGHT_CLASS[variant]}`}
        >
            {timeline?.length ? (
                <ol data-testid="transcript-timeline" className="space-y-1">
                    {segments.map((segment, index) => {
                        const isActive = index === activeIndex;
                        return (
                            <li
                                ref={isActive ? activeRef : undefined}
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
                                    className={`relative w-full rounded px-2 py-1 text-left text-sm leading-relaxed hover:bg-background/70 disabled:cursor-default ${isActive ? "bg-background font-medium" : ""}`}
                                >
                                    {isActive && (
                                        <span
                                            aria-hidden="true"
                                            className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand-gradient"
                                        />
                                    )}
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
