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

interface TranscriptBodyProps {
    text: string;
    /** Timed segments from the pipeline. Only shown for the user's own transcript. */
    timeline: TimelineSegment[] | null | undefined;
    playbackTimeMs?: number;
    onSeekTimestamp?: (milliseconds: number) => void;
    /** Keep the segment that is playing centred in the scroll area. */
    followPlayback?: boolean;
    /** Show only the first N segments. The library preview uses this. */
    previewLimit?: number;
}

/**
 * The transcript text. With timed segments it is a clickable timeline that
 * follows playback. Without them it is the plain speaker text. Following scrolls
 * only the transcript's own scroll area, never the page.
 */
export function TranscriptBody({
    text,
    timeline,
    playbackTimeMs,
    onSeekTimestamp,
    followPlayback = false,
    previewLimit,
}: TranscriptBodyProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLLIElement>(null);

    const segments = timeline ?? [];
    const visible =
        previewLimit === undefined ? segments : segments.slice(0, previewLimit);
    const activeIndex =
        playbackTimeMs === undefined
            ? -1
            : visible.findIndex(
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
            className="relative bg-muted rounded-lg p-4 max-h-96 overflow-y-auto"
        >
            {timeline?.length ? (
                <>
                    <ol data-testid="transcript-timeline" className="space-y-1">
                        {visible.map((segment, index) => {
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
                                        aria-current={
                                            isActive ? "time" : undefined
                                        }
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
                    {visible.length < segments.length && (
                        <p
                            data-testid="transcript-preview-note"
                            className="mt-3 text-xs text-muted-foreground"
                        >
                            Showing the first {visible.length} of{" "}
                            {segments.length} segments.
                        </p>
                    )}
                </>
            ) : (
                <SpeakerTranscript text={text} className="text-sm" />
            )}
        </div>
    );
}
