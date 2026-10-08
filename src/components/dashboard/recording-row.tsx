"use client";

import {
    Cpu,
    Download,
    Loader2,
    MoreHorizontal,
    Pencil,
    Play,
    Sparkles,
    Trash2,
} from "lucide-react";
import { StatusBadge } from "@/components/app/status-badge";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
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
    snippet,
    isCompact,
    rowPadding,
    dateTimeFormat,
    onSelect,
    onDelete,
    onTranscribe,
    onTranscribeInBrowser,
    onRename,
    registerRef,
}: {
    recording: Recording;
    isSelected: boolean;
    inFlight: "transcribing" | "summarizing" | undefined;
    snippet: string | null;
    isCompact: boolean;
    rowPadding: string;
    dateTimeFormat: DateTimeFormat;
    onSelect: (recording: Recording) => void;
    onDelete: (recording: Recording) => Promise<void>;
    onTranscribe?: (recording: Recording) => void;
    onTranscribeInBrowser?: (recording: Recording) => void;
    onRename?: (recording: Recording) => void;
    registerRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
    const confirm = useConfirm();
    return (
        <div
            data-testid="recording-row"
            data-id={recording.id}
            className={cn(
                "group/row relative",
                isSelected
                    ? "bg-accent shadow-[inset_2px_0_0_0_var(--color-primary)]"
                    : null,
            )}
        >
            <button
                ref={(el) => {
                    registerRef(recording.id, el);
                }}
                type="button"
                onClick={() => onSelect(recording)}
                className={cn(
                    "w-full text-left transition-colors hover:bg-accent/60",
                    rowPadding,
                )}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h3 className="min-w-0 truncate text-sm font-medium">
                            {recording.filename}
                        </h3>
                        {inFlight ? (
                            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-primary">
                                <Loader2
                                    className="size-3 animate-spin"
                                    aria-hidden="true"
                                />
                                {inFlight === "transcribing"
                                    ? "Transcribing"
                                    : "Summarizing"}
                            </span>
                        ) : (
                            <span className="ml-auto shrink-0">
                                <StatusBadge
                                    status={transcriptStatus({
                                        hasTranscript: recording.hasTranscript,
                                        hasSummary: recording.hasSummary,
                                        pipelinePhase: recording.pipelinePhase,
                                    })}
                                />
                            </span>
                        )}
                    </div>
                    <div
                        className={cn(
                            "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
                            isCompact ? "mt-0.5" : "mt-1",
                        )}
                    >
                        <Badge
                            variant="outline"
                            className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
                        >
                            {recordingSource(recording.deviceSn)}
                        </Badge>
                        <span className="min-w-0 truncate">
                            {snippet ?? (
                                <>
                                    {formatDurationMs(recording.duration)}
                                    {" · "}
                                    {formatDateTime(
                                        recording.startTime,
                                        dateTimeFormat,
                                    )}
                                </>
                            )}
                        </span>
                    </div>
                </div>
            </button>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Row actions"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <MoreHorizontal className="size-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onSelect(recording)}>
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
                                    recordingAudioDownloadPath(recording.id),
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
                                            The audio file and any transcript or
                                            summary will be removed. If the file
                                            is still on your Plaud device, the
                                            next sync will re-download it.
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
        </div>
    );
}
