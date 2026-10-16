"use client";

import {
    Pause,
    Play,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from "lucide-react";
import { Waveform } from "@/components/dashboard/waveform";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { PLAYBACK_SPEED_OPTIONS } from "@/hooks/use-playback-engine";
import { formatTimeLike } from "@/lib/format-duration";

interface Props {
    isPlaying: boolean;
    onTogglePlay: () => void;
    currentTime: number;
    duration: number;
    onSeekRatio: (ratio: number) => void;
    playbackSpeed: number;
    onCycleSpeed: () => void;
    volume: number;
    onVolumeChange: (volume: number) => void;
    onToggleMute: () => void;
    scrubberStyle: "waveform" | "slider";
    waveformPeaks: number[] | null;
}

const SKIP_SECONDS = 15;

/**
 * Controls for the recording player: a full-width scrubber (waveform when
 * peaks are decoded, slider otherwise) above a transport row. The row holds
 * the time on the left, skip-back / play / skip-forward centred, and mute,
 * volume and speed on the right.
 *
 * Pure presentation -- all state lives in usePlaybackEngine, and the
 * parent wires this component's callbacks to that hook's handlers.
 */
export function RecordingPlayerControls({
    isPlaying,
    onTogglePlay,
    currentTime,
    duration,
    onSeekRatio,
    playbackSpeed,
    onCycleSpeed,
    volume,
    onVolumeChange,
    onToggleMute,
    scrubberStyle,
    waveformPeaks,
}: Props) {
    const seekDisabled = !duration || duration === 0;
    const seekRatio = duration > 0 ? currentTime / duration : 0;
    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    const speedLabel =
        PLAYBACK_SPEED_OPTIONS.find((opt) => opt.value === playbackSpeed)
            ?.label || "1x";
    const speakerIcon =
        volume === 0 ? (
            <VolumeX className="size-4" />
        ) : (
            <Volume2 className="size-4" />
        );

    const skipBy = (seconds: number) => {
        if (seekDisabled) return;
        onSeekRatio(
            Math.max(0, Math.min(1, (currentTime + seconds) / duration)),
        );
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="min-w-0" data-testid="player-scrubber">
                {scrubberStyle === "waveform" && waveformPeaks ? (
                    <Waveform
                        peaks={waveformPeaks}
                        progress={seekRatio}
                        durationSeconds={duration}
                        onSeek={onSeekRatio}
                        disabled={seekDisabled}
                        height={64}
                    />
                ) : (
                    <Slider
                        aria-label="Seek"
                        value={[progress]}
                        onValueChange={(value) =>
                            onSeekRatio((value[0] ?? 0) / 100)
                        }
                        onValueCommit={(value) =>
                            onSeekRatio((value[0] ?? 0) / 100)
                        }
                        max={100}
                        step={0.1}
                        className="w-full py-3 sm:py-0"
                        disabled={seekDisabled}
                    />
                )}
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                {/*
                  Fixed-width digits (tabular-nums) and `formatTimeLike` pad
                  currentTime to duration's segment structure, so the
                  `M:SS / H:MM:SS` line never resizes mid-playback.
                */}
                <span
                    data-testid="player-time"
                    className="justify-self-start text-xs tabular-nums text-muted-foreground lg:whitespace-nowrap"
                    aria-live="off"
                >
                    <span className="text-foreground">
                        {formatTimeLike(currentTime, duration)}
                    </span>
                    <span className="mx-1 opacity-40">/</span>
                    <span>{formatTimeLike(duration, duration)}</span>
                </span>

                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => skipBy(-SKIP_SECONDS)}
                        disabled={seekDisabled}
                        className="size-10 rounded-full text-muted-foreground sm:size-8"
                        aria-label={`Skip back ${SKIP_SECONDS} seconds`}
                    >
                        <SkipBack className="size-4" />
                    </Button>
                    <Button
                        onClick={onTogglePlay}
                        data-testid="player-play"
                        size="icon"
                        aria-label={isPlaying ? "Pause" : "Play"}
                        className="size-11 rounded-full bg-primary text-primary-foreground sm:size-11"
                    >
                        {isPlaying ? (
                            <Pause className="size-5" />
                        ) : (
                            <Play className="size-5" />
                        )}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => skipBy(SKIP_SECONDS)}
                        disabled={seekDisabled}
                        className="size-10 rounded-full text-muted-foreground sm:size-8"
                        aria-label={`Skip forward ${SKIP_SECONDS} seconds`}
                    >
                        <SkipForward className="size-4" />
                    </Button>
                </div>

                <div className="flex items-center justify-self-end gap-1 sm:gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onToggleMute}
                        className="size-10 rounded-full text-muted-foreground sm:size-8"
                        aria-label={volume === 0 ? "Unmute" : "Mute"}
                        title={volume === 0 ? "Unmute" : "Mute"}
                    >
                        {speakerIcon}
                    </Button>
                    <Slider
                        value={[volume]}
                        onValueChange={(value) =>
                            onVolumeChange(value[0] ?? 75)
                        }
                        max={100}
                        className="hidden w-20 sm:flex"
                        aria-label="Volume"
                    />
                    <Button
                        onClick={onCycleSpeed}
                        data-testid="player-speed"
                        variant="secondary"
                        size="sm"
                        className="w-12 px-0 tabular-nums"
                        title="Click to cycle playback speed"
                        aria-label={`Playback speed ${speedLabel}. Click to change.`}
                    >
                        {speedLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}
