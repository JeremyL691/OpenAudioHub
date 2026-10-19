import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Download, Ellipsis, Pencil, RefreshCw, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/api";
import { downloadRecordings } from "@/lib/downloads";
import { formatClock, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { deleteRecording, type Recording, renameRecording, setStarred, sourceOf } from "@/lib/recordings";
import { buildSrt, buildTranscriptJson, buildVtt, downloadText, safeFileName } from "./exports";
import type { TranscriptRecord } from "./types";

export interface RecordingHeaderProps {
    variant: "page" | "pane";
    recording: Recording;
    transcript: TranscriptRecord | null;
    /** A transcription or pipeline job is running. Blocks transcribe and delete of the transcript. */
    busy: boolean;
    onTranscribe(): void;
}

/** Header of the recording view: back, title (rename in place), meta line, star, and the actions menu. */
export function RecordingHeader({ variant, recording, transcript, busy, onTranscribe }: RecordingHeaderProps) {
    const navigate = useNavigate();
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const starred = recording.starredAt !== null;
    const [starOverride, setStarOverride] = useState<boolean | null>(null);
    const effectiveStarred = starOverride ?? starred;

    // The server answer arrives as a refreshed recording; drop the local override once it has.
    useEffect(() => {
        setStarOverride(null);
    }, [recording.starredAt]);

    const toggleStar = async () => {
        const next = !effectiveStarred;
        setStarOverride(next);
        try {
            await setStarred(recording.id, next);
        } catch {
            setStarOverride(null);
            toast.error("Could not update the star");
        }
    };

    const exportTranscript = (format: "txt" | "srt" | "vtt" | "json") => {
        if (!transcript) return;
        const base = safeFileName(recording.filename);
        if (format === "txt") downloadText(`${base}.txt`, "text/plain", transcript.text);
        if (format === "json") downloadText(`${base}.json`, "application/json", buildTranscriptJson(transcript));
        if (format === "srt" && transcript.timeline) downloadText(`${base}.srt`, "application/x-subrip", buildSrt(transcript.timeline));
        if (format === "vtt" && transcript.timeline) downloadText(`${base}.vtt`, "text/vtt", buildVtt(transcript.timeline));
    };

    const confirmDelete = async () => {
        setDeleting(true);
        try {
            await deleteRecording(recording.id);
            toast.success("Recording deleted");
            navigate("/recordings");
        } catch (err) {
            toast.error(errorMessage(err, "Failed to delete recording"));
            setDeleting(false);
        }
    };

    const Heading = variant === "page" ? "h1" : "h2";
    const hasTimeline = Boolean(transcript?.timeline?.length);
    const meta = [
        formatDateTime(recording.startTime),
        formatClock(recording.duration / 1000),
        sourceOf(recording) === "upload" ? "Upload" : "Plaud",
    ];

    return (
        <header className={cn("flex items-start gap-3", variant === "page" ? "lg:shrink-0 lg:px-8 lg:pt-6 lg:pb-3" : "lg:px-8")}>
            {/* The pane variant gets its back control and "Open full view" link from the library's preview pane. */}
            {variant === "page" ? (
                <Button variant="ghost" size="icon" aria-label="Back to recordings" onClick={() => navigate("/recordings")} className="-ml-2 shrink-0">
                    <ArrowLeft />
                </Button>
            ) : null}
            <div className="min-w-0 flex-1 [contain:inline-size]">
                <TitleEditor as={Heading} recording={recording} />
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    {meta.map((part, i) => (
                        <Fragment key={i}>
                            {i > 0 ? <span aria-hidden="true">·</span> : null}
                            {i === 0 ? <time dateTime={recording.startTime}>{part}</time> : <span>{part}</span>}
                        </Fragment>
                    ))}
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <Button
                    variant="ghost"
                    size="icon"
                    data-testid="recording-star"
                    aria-label={effectiveStarred ? "Unstar" : "Star"}
                    aria-pressed={effectiveStarred}
                    onClick={() => void toggleStar()}
                >
                    <Star className={cn(effectiveStarred && "fill-primary text-primary")} />
                </Button>
                {variant === "page" ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Recording actions"
                                className="border border-border bg-background text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-muted dark:hover:bg-accent"
                            >
                                <Ellipsis />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem onSelect={() => void downloadRecordings([recording.id])}>
                                <Download />
                                Download audio
                            </DropdownMenuItem>
                            <DropdownMenuItem data-testid="recording-star-toggle" onSelect={() => void toggleStar()}>
                                <Star className={cn(effectiveStarred && "fill-current")} />
                                {effectiveStarred ? "Unstar" : "Star"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <ExportItem label="Export TXT" disabled={!transcript} onSelect={() => exportTranscript("txt")} />
                            <ExportItem label="Export SRT" disabled={!hasTimeline} onSelect={() => exportTranscript("srt")} />
                            <ExportItem label="Export VTT" disabled={!hasTimeline} onSelect={() => exportTranscript("vtt")} />
                            <ExportItem label="Export JSON" disabled={!transcript} onSelect={() => exportTranscript("json")} />
                            <DropdownMenuSeparator />
                            <DropdownMenuItem disabled={busy} onSelect={onTranscribe}>
                                <RefreshCw />
                                {transcript ? "Re-transcribe" : "Transcribe"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                                <Trash2 />
                                Delete recording
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
            </div>

            <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
                <DialogContent>
                    <DialogTitle>Delete this recording?</DialogTitle>
                    <DialogDescription>
                        This permanently removes the audio file, transcription, and AI summary from OpenAudioHub. The recording on your Plaud account is not affected, but it
                        will not be re-synced to OpenAudioHub.
                    </DialogDescription>
                    <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button variant="secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                            {deleting ? "Deleting…" : "Delete recording"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </header>
    );
}

function ExportItem({ label, disabled, onSelect }: { label: string; disabled: boolean; onSelect(): void }) {
    return (
        <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
            <Download />
            {label}
        </DropdownMenuItem>
    );
}

/** The title: a button that turns into a text field for an inline rename (Enter saves, Escape cancels, blur saves). */
function TitleEditor({ as: Tag, recording }: { as: "h1" | "h2"; recording: Recording }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    // Set once a rename has been decided, so the blur that follows Enter or Escape does nothing.
    const decided = useRef(false);

    const start = () => {
        decided.current = false;
        setDraft(recording.filename);
        setEditing(true);
    };

    const finish = async (commit: boolean) => {
        if (decided.current) return;
        decided.current = true;
        setEditing(false);
        if (!commit) return;
        // Same control-character and trim rules as the server (spec/recordings.md).
        const name = draft.replace(/[\u0000-\u001f\u007f]/g, "").trim();
        if (name === recording.filename) return;
        if (!name) {
            toast.error("Name cannot be empty");
            return;
        }
        if (name.length > 200) {
            toast.error("Name must be 200 characters or fewer");
            return;
        }
        try {
            await renameRecording(recording.id, name);
        } catch (err) {
            toast.error(errorMessage(err, "Could not rename the recording."));
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            void finish(false);
        }
    };

    if (editing) {
        return (
            <Tag className="text-[22px] font-bold leading-tight tracking-tight">
                <input
                    aria-label="Recording name"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={() => void finish(true)}
                    className="h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-[22px] font-bold text-foreground focus-visible:border-ring focus-visible:outline-none sm:h-9"
                />
            </Tag>
        );
    }

    return (
        <Tag className="min-w-0 text-[22px] font-bold leading-tight tracking-tight text-foreground">
            <button
                type="button"
                title="Rename"
                aria-label={`Rename ${recording.filename}`}
                onClick={start}
                className="group/title inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg px-1 -mx-1 py-0.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                <span className="truncate">{recording.filename}</span>
                <Pencil aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100" />
            </button>
        </Tag>
    );
}
