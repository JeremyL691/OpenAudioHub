"use client";

import {
    Check,
    Cpu,
    Download,
    Loader2,
    MoreHorizontal,
    Pencil,
    Play,
    Sparkles,
    Star,
    Trash2,
} from "lucide-react";
import { MiniWaveform } from "@/components/app/mini-waveform";
import { StatusBadge } from "@/components/app/status-badge";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTime } from "@/lib/format-date";
import { formatDurationMs } from "@/lib/format-duration";
import { recordingAudioDownloadPath } from "@/lib/recordings/filename";
import {
    recordingSource,
    transcriptStatus,
} from "@/lib/recordings/transcript-status";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type { Recording } from "@/types/recording";

export function RecordingRow({
    recording,
    isSelected,
    inFlight,
    isCompact,
    rowPadding,
    dateTimeFormat,
    onSelect,
    onDelete,
    onTranscribe,
    onTranscribeInBrowser,
    onRename,
    registerRef,
    selectMode,
    checked,
    onToggleChecked,
}: {
    recording: Recording;
    isSelected: boolean;
    inFlight: "transcribing" | "summarizing" | undefined;
    isCompact: boolean;
    rowPadding: string;
    dateTimeFormat: DateTimeFormat;
    onSelect: (recording: Recording) => void;
    onDelete: (recording: Recording) => Promise<void>;
    onTranscribe?: (recording: Recording) => void;
    onTranscribeInBrowser?: (recording: Recording) => void;
    onRename?: (recording: Recording) => void;
    registerRef: (id: string, el: HTMLButtonElement | null) => void;
    selectMode: boolean;
    checked: boolean;
    onToggleChecked: (recording: Recording) => void;
}) {
    const confirm = useConfirm();
    return (
        <div
            data-testid="recording-row"
            data-id={recording.id}
            className="group/row relative"
        >
            <button
                ref={(el) => {
                    registerRef(recording.id, el);
                }}
                type="button"
                aria-pressed={selectMode ? checked : undefined}
                onClick={() =>
                    selectMode
                        ? onToggleChecked(recording)
                        : onSelect(recording)
                }
                className={cn(
                    "w-full rounded-lg text-left transition-colors",
                    rowPadding,
                    "flex items-center gap-3",
                    !selectMode && "pr-9",
                    isSelected
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-accent",
                )}
            >
                {selectMode && (
                    // Visual only: the row button carries aria-pressed.
                    <span
                        aria-hidden="true"
                        data-testid="recording-row-checkbox"
                        data-checked={checked}
                        className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded border",
                            checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/50",
                        )}
                    >
                        {checked && <Check className="size-3" />}
                    </span>
                )}
                <MiniWaveform
                    peaks={recording.waveformPeaks}
                    className={cn(
                        "w-14 shrink-0",
                        isSelected && "text-primary-foreground/80",
                    )}
                />
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                            {recording.filename}
                        </h3>
                        {recording.starred && (
                            <>
                                <Star
                                    aria-hidden="true"
                                    className={cn(
                                        "size-3 shrink-0 fill-current",
                                        !isSelected && "text-primary",
                                    )}
                                />
                                <span className="sr-only">Starred</span>
                            </>
                        )}
                        <span
                            className={cn(
                                "shrink-0 text-xs tabular-nums",
                                isSelected
                                    ? "text-primary-foreground"
                                    : "text-muted-foreground",
                            )}
                        >
                            {formatDurationMs(recording.duration)}
                        </span>
                    </div>
                    <div
                        className={cn(
                            "flex min-w-0 items-center gap-2",
                            isCompact ? "mt-px" : "mt-1",
                        )}
                    >
                        <p
                            className={cn(
                                "min-w-0 flex-1 truncate text-xs tabular-nums",
                                isSelected
                                    ? "text-primary-foreground"
                                    : "text-muted-foreground",
                            )}
                        >
                            {formatDateTime(
                                recording.startTime,
                                dateTimeFormat,
                            )}
                            {" · "}
                            {recordingSource(recording.deviceSn)}
                        </p>
                        {inFlight ? (
                            <span
                                className={cn(
                                    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                                    isSelected
                                        ? "bg-primary-foreground text-primary"
                                        : "bg-info text-info-foreground",
                                )}
                            >
                                <Loader2
                                    className="size-3 motion-safe:animate-spin"
                                    aria-hidden="true"
                                />
                                {inFlight === "transcribing"
                                    ? "Transcribing"
                                    : "Summarizing"}
                            </span>
                        ) : (
                            <StatusBadge
                                className={cn(
                                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                    isSelected &&
                                        "bg-primary-foreground text-primary",
                                )}
                                status={transcriptStatus({
                                    hasTranscript: recording.hasTranscript,
                                    hasSummary: recording.hasSummary,
                                    pipelinePhase: recording.pipelinePhase,
                                })}
                            />
                        )}
                    </div>
                </div>
            </button>
            {!selectMode && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className={cn(
                                    isSelected &&
                                        "text-primary-foreground hover:bg-primary-foreground/20 hover:text-primary-foreground",
                                )}
                                aria-label="Row actions"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() => onSelect(recording)}
                            >
                                <Play />
                                Open
                            </DropdownMenuItem>
                            {onRename ? (
                                <DropdownMenuItem
                                    onSelect={() => onRename(recording)}
                                >
                                    <Pencil />
                                    Rename
                                </DropdownMenuItem>
                            ) : null}
                            {onTranscribe ? (
                                <DropdownMenuItem
                                    onSelect={() => onTranscribe(recording)}
                                    disabled={inFlight === "transcribing"}
                                >
                                    <Sparkles />
                                    Transcribe
                                </DropdownMenuItem>
                            ) : null}
                            {onTranscribeInBrowser ? (
                                <DropdownMenuItem
                                    onSelect={() =>
                                        onTranscribeInBrowser(recording)
                                    }
                                    disabled={inFlight === "transcribing"}
                                >
                                    <Cpu />
                                    Transcribe in browser
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                                onSelect={() => {
                                    window.location.assign(
                                        recordingAudioDownloadPath(
                                            recording.id,
                                        ),
                                    );
                                }}
                            >
                                <Download />
                                Download audio
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                onSelect={(e) => {
                                    // Keep menu mounted so confirm dialog can take focus.
                                    e.preventDefault();
                                    void confirm({
                                        title: "Delete this recording?",
                                        description: (
                                            <>
                                                <span className="font-medium text-foreground">
                                                    {recording.filename}
                                                </span>
                                                <br />
                                                The audio file and any
                                                transcript or summary will be
                                                removed. If the file is still on
                                                your Plaud device, the next sync
                                                will re-download it.
                                            </>
                                        ),
                                        confirmLabel: "Delete",
                                        pendingLabel: "Deleting…",
                                        destructive: true,
                                        onConfirm: () => onDelete(recording),
                                    });
                                }}
                            >
                                <Trash2 />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </div>
    );
}
