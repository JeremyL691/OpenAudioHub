import { Check, Cpu, Download, Ellipsis, Pencil, Play, Sparkles, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MiniWaveform } from "@/components/ui/mini-waveform";
import { RecordingStatusBadge } from "@/components/ui/status-badge";
import { recordingStage } from "@/components/recording/pipeline-labels";
import { cn } from "@/lib/cn";
import { downloadRecordings } from "@/lib/downloads";
import { formatClock } from "@/lib/format";
import type { Recording } from "@/lib/recordings";
import { formatAgo, rowLabel, sourceLabel } from "./library-model";

export interface RowActions {
    onOpen(recording: Recording): void;
    onRename(recording: Recording): void;
    onTranscribe(recording: Recording): void;
    onTranscribeInBrowser(recording: Recording): void;
    onDelete(recording: Recording): void;
}

export interface RecordingRowProps {
    recording: Recording;
    /** The recording shown in the detail pane. */
    selected: boolean;
    selectMode: boolean;
    checked: boolean;
    compact: boolean;
    /** A transcribe request for this row is in flight. */
    transcribing: boolean;
    /** Opens the row, or toggles it in select mode. */
    onActivate(id: string): void;
    actions: RowActions;
}

/**
 * One recording, laid out as follows: a waveform, the name with the duration, the relative
 * time and source with the status badge, and a row menu that appears on hover. The row
 * menu is a sibling of the row button, so there are no nested interactive elements.
 */
export function RecordingRow({ recording: r, selected, selectMode, checked, compact, transcribing, onActivate, actions }: RecordingRowProps) {
    const stage = recordingStage(r);
    const ago = formatAgo(r.startTime);
    const meta = ago ? `${ago} · ${sourceLabel(r)}` : sourceLabel(r);
    const onSelected = selected && !selectMode;

    return (
        <div data-testid="recording-row" data-id={r.id} data-selected={selected ? "true" : "false"} className="group relative">
            <button
                type="button"
                aria-label={rowLabel(r)}
                aria-pressed={selectMode ? checked : undefined}
                aria-current={!selectMode && selected ? "true" : undefined}
                onClick={() => onActivate(r.id)}
                className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    compact ? "py-1.5" : "py-2",
                    !selectMode && "pr-9",
                    onSelected ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
            >
                {selectMode ? (
                    <span
                        data-testid="recording-row-checkbox"
                        data-checked={checked ? "true" : "false"}
                        aria-hidden="true"
                        className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded border",
                            checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50",
                        )}
                    >
                        {checked ? <Check className="size-3" /> : null}
                    </span>
                ) : null}

                {compact ? null : (
                    <MiniWaveform
                        peaks={r.waveformPeaks}
                        bars={17}
                        className={cn("h-6 w-14 shrink-0", onSelected ? "text-primary-foreground/80" : "text-waveform-unplayed")}
                    />
                )}

                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span data-testid="recording-row-name" className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.filename}</span>
                        {r.starredAt ? (
                            <>
                                <Star aria-hidden="true" className="size-3 shrink-0 fill-current text-primary" />
                                <span className="sr-only">Starred</span>
                            </>
                        ) : null}
                        <span className={cn("shrink-0 text-xs tabular-nums", onSelected ? "text-primary-foreground" : "text-muted-foreground")}>
                            {formatClock(r.duration / 1000)}
                        </span>
                    </span>
                    <span className="mt-1 flex min-w-0 items-center gap-2">
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate text-xs tabular-nums",
                                onSelected ? "text-primary-foreground" : "text-muted-foreground",
                            )}
                        >
                            {meta}
                        </span>
                        <RecordingStatusBadge stage={transcribing && stage === "untranscribed" ? "transcribing" : stage} inverted={onSelected} />
                    </span>
                </span>
            </button>

            {selectMode ? null : (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
                    <RowMenu recording={r} transcribing={transcribing} actions={actions} />
                </div>
            )}
        </div>
    );
}

function RowMenu({ recording, transcribing, actions }: { recording: Recording; transcribing: boolean; actions: RowActions }) {
    const transcribeDisabled = transcribing || recording.processing !== null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Row actions">
                    <Ellipsis />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => actions.onOpen(recording)}>
                    <Play />
                    Open
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.onRename(recording)}>
                    <Pencil />
                    Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={transcribeDisabled} onSelect={() => actions.onTranscribe(recording)}>
                    <Sparkles />
                    Transcribe
                </DropdownMenuItem>
                <DropdownMenuItem disabled={transcribeDisabled} onSelect={() => actions.onTranscribeInBrowser(recording)}>
                    <Cpu />
                    Transcribe in browser
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadRecordings([recording.id])}>
                    <Download />
                    Download audio
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => actions.onDelete(recording)}>
                    <Trash2 />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
