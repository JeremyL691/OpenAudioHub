"use client";

import { Pause, Play } from "lucide-react";
import { ProgressBar } from "@/components/app/progress-bar";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format-duration";

interface PlayerMiniBarProps {
    title: string;
    isPlaying: boolean;
    /** Seconds. */
    currentTime: number;
    /** Seconds. */
    duration: number;
    onToggle: () => void;
}

/**
 * Compact player that sticks under the top bar once the full player scrolls
 * away. It renders into the app shell's mini-player anchor, so it stays in the
 * content column. It is driven by the same playback engine as the full player.
 */
export function PlayerMiniBar({
    title,
    isPlaying,
    currentTime,
    duration,
    onToggle,
}: PlayerMiniBarProps) {
    const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

    return (
        <section
            data-testid="mini-player"
            aria-label="Now playing"
            className="absolute inset-x-0 top-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70"
        >
            <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2">
                <Button
                    size="icon"
                    variant="outline"
                    onClick={onToggle}
                    className="size-10 shrink-0"
                    aria-label={isPlaying ? "Pause" : "Play"}
                >
                    {isPlaying ? (
                        <Pause className="size-4" aria-hidden="true" />
                    ) : (
                        <Play className="size-4" aria-hidden="true" />
                    )}
                </Button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{title}</p>
                    <ProgressBar
                        value={progress}
                        label="Playback progress"
                        className="mt-1 h-1"
                    />
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDuration(currentTime)} / {formatDuration(duration)}
                </span>
            </div>
        </section>
    );
}

interface MiniPlayerVisibility {
    hasRecording: boolean;
    /** The player is laid out. False in a hidden pane, such as the phone list view. */
    playerRendered: boolean;
    /** The full player intersects the viewport. */
    playerInView: boolean;
}

/** The compact bar shows only when the full player is laid out and scrolled away. */
export function shouldShowMiniPlayer({
    hasRecording,
    playerRendered,
    playerInView,
}: MiniPlayerVisibility): boolean {
    return hasRecording && playerRendered && !playerInView;
}
