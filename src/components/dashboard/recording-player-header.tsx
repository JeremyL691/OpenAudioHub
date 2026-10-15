"use client";

import { AudioWaveform, Download, Loader2 } from "lucide-react";
import { LocalTimeRange } from "@/components/local-time";
import { RecordingTitle } from "@/components/recordings/recording-title";
import { Button } from "@/components/ui/button";
import { CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes } from "@/lib/format-bytes";
import { formatDuration } from "@/lib/format-duration";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

interface Props {
    recording: Recording;
    /** Resolved playback duration in seconds (0 when not yet loaded). */
    duration: number;
    scrubberStyle: "waveform" | "slider";
    waveformStatus: "idle" | "ready" | "decoding" | "skipped" | "error";
    onDecodeWaveform: () => void;
    onRenamed?: (filename: string) => void;
    /**
     * Leave out the title, the download button, and the date, duration, and
     * size. The detail page shows them in its own header and actions menu,
     * so only the waveform status line remains.
     */
    hideIdentity?: boolean;
}

/**
 * Title + compact metadata row + waveform-status footer for the
 * RecordingPlayer card. Lifted out so the parent's render reads as
 * "header + controls + audio element" instead of a 100-line JSX block.
 *
 * The metadata order is information-density-first: recorded date and
 * start–end time, then how long (duration), then how big (file size). Falls
 * back to recording.duration / 1000 before the audio element reports
 * a real duration so the line doesn't flicker on first paint.
 */
export function RecordingPlayerHeader({
    recording,
    duration,
    scrubberStyle,
    waveformStatus,
    onDecodeWaveform,
    onRenamed,
    hideIdentity = false,
}: Props) {
    const waveformNotice =
        scrubberStyle === "waveform" &&
        (waveformStatus === "decoding" ||
            waveformStatus === "skipped" ||
            waveformStatus === "error");
    if (hideIdentity && !waveformNotice) return null;

    const metaParts: string[] = [
        formatDuration(duration || recording.duration / 1000),
        formatBytes(recording.filesize),
    ];

    return (
        <CardHeader
            className={cn(
                "gap-1 lg:min-w-0 lg:shrink-0 lg:gap-0 lg:px-0 lg:py-0",
                !hideIdentity && "2xl:w-64",
            )}
        >
            {!hideIdentity && (
                <>
                    <CardTitle className="min-w-0 text-lg lg:text-sm lg:font-semibold">
                        <RecordingTitle
                            recordingId={recording.id}
                            filename={recording.filename}
                            onRenamed={onRenamed}
                            className="text-lg lg:text-sm"
                        />
                    </CardTitle>
                    <CardAction>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="size-10 sm:size-8"
                                    aria-label="Download audio"
                                >
                                    <Download className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                    <a
                                        href={recordingAudioDownloadPath(
                                            recording.id,
                                        )}
                                        download
                                        rel="nofollow noreferrer"
                                    >
                                        Download MP3
                                    </a>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                    <a
                                        href={`/api/recordings/download?ids=${recording.id}&format=original`}
                                        download
                                        rel="nofollow noreferrer"
                                        data-testid="download-original"
                                    >
                                        Download original
                                    </a>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </CardAction>
                </>
            )}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground 2xl:flex-nowrap 2xl:overflow-hidden 2xl:whitespace-nowrap">
                {!hideIdentity && (
                    <span>
                        Recorded{" "}
                        <LocalTimeRange
                            start={recording.startTime}
                            durationMs={recording.duration}
                        />
                    </span>
                )}
                {(hideIdentity ? [] : metaParts).map((part) => (
                    <span key={part} className="inline-flex items-center gap-2">
                        <span aria-hidden="true" className="opacity-40">
                            ·
                        </span>
                        <span>{part}</span>
                    </span>
                ))}
                {scrubberStyle === "waveform" &&
                    waveformStatus === "decoding" && (
                        <span className="inline-flex items-center gap-1">
                            <span aria-hidden="true" className="opacity-40">
                                ·
                            </span>
                            <Loader2 className="size-3 animate-spin" />
                            Analyzing audio…
                        </span>
                    )}
                {scrubberStyle === "waveform" &&
                    waveformStatus === "skipped" && (
                        <button
                            type="button"
                            onClick={onDecodeWaveform}
                            className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                            title="Decode waveform in your browser (may take a few seconds)"
                        >
                            <span aria-hidden="true" className="opacity-40">
                                ·
                            </span>
                            <AudioWaveform className="size-3" />
                            Generate waveform
                        </button>
                    )}
                {scrubberStyle === "waveform" && waveformStatus === "error" && (
                    <button
                        type="button"
                        onClick={onDecodeWaveform}
                        className="inline-flex items-center gap-1 text-destructive underline-offset-2 hover:underline"
                    >
                        <span aria-hidden="true" className="opacity-40">
                            ·
                        </span>
                        <AudioWaveform className="size-3" />
                        Retry waveform
                    </button>
                )}
            </div>
        </CardHeader>
    );
}
