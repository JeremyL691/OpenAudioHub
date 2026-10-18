import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Cpu, Download, FileText, Languages, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePlayer } from "@/components/player/player-context";
import { useBrowserTranscription } from "./browser-transcribe";
import { downloadText, buildTranscriptJson, safeFileName, timecode } from "./exports";
import { isActiveStatus } from "./data";
import { phaseLabel } from "./pipeline-labels";
import type { PipelineState, ProviderRow, TimelineSegment, TranscriptRecord } from "./types";

const SOURCE_LABELS: Record<string, string> = {
    openaudiohub: "Your provider",
    plaud: "Plaud",
    mixed: "Mix",
};

export interface TranscriptCardProps {
    recordingId: string;
    recordingTitle: string;
    /** The transcript shown. Null when there is none. */
    transcript: TranscriptRecord | null;
    /** Every transcript source of the recording. The switcher shows only when there are two or more. */
    transcripts: TranscriptRecord[];
    selectedSource: string | null;
    onSelectSource(source: string): void;
    pipeline: PipelineState | null;
    /** The job is active (including the moment after a transcribe answered 202). */
    pipelineActive: boolean;
    /** A transcription request is in flight. */
    transcribing: boolean;
    /** Transcribe or re-transcribe is blocked: a run or job is active. */
    busy: boolean;
    onRequestTranscribe(): void;
    onCancelPipeline(): Promise<void>;
    onRetryPipeline(): Promise<void>;
    onChanged(): void;
}

/** The transcript card: pipeline state, source switcher, toolbar, timeline or plain text. */
export function TranscriptCard(props: TranscriptCardProps) {
    const { transcript, transcripts, selectedSource, onSelectSource, pipeline, pipelineActive, transcribing, busy, onRequestTranscribe } = props;
    const [follow, setFollow] = useState(true);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const browser = useBrowserTranscription(props.recordingId, props.onChanged);
    const job = pipeline?.job ?? null;
    const timed = Boolean(transcript?.timeline?.length);
    const noTimestamps = job?.status === "needs_alignment";

    const confirmDelete = async () => {
        if (!transcript) return;
        setDeleting(true);
        try {
            const source = transcript.source || "openaudiohub";
            await api(`/api/recordings/${encodeURIComponent(props.recordingId)}/transcription?source=${encodeURIComponent(source)}`, { method: "DELETE" });
            toast.success("Transcript deleted");
            setDeleteOpen(false);
            props.onChanged();
        } catch (err) {
            toast.error(errorMessage(err, "Could not delete the transcript"));
        } finally {
            setDeleting(false);
        }
    };

    const exportText = (format: "txt" | "json") => {
        if (!transcript) return;
        const base = safeFileName(props.recordingTitle);
        if (format === "txt") downloadText(`${base}.txt`, "text/plain", transcript.text);
        else downloadText(`${base}.json`, "application/json", buildTranscriptJson(transcript));
    };

    return (
        <Card className="grid content-start gap-4 rounded-none bg-transparent p-0 shadow-none" data-testid="transcript-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[17px] font-semibold tracking-tight">Transcript</h2>
                <div className="flex flex-wrap items-center gap-3">
                    {timed ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch aria-label="Follow playback" checked={follow} onCheckedChange={setFollow} />
                            <span aria-hidden="true">Follow playback</span>
                        </div>
                    ) : null}
                    {!transcript ? (
                        <>
                            <Button variant="primary" className="gap-1.5 px-3" disabled={busy || browser.running} onClick={onRequestTranscribe}>
                                <Sparkles aria-hidden="true" />
                                {transcribing ? "Transcribing…" : "Transcribe"}
                            </Button>
                            <Button
                                variant="secondary"
                                className="gap-1.5 px-3"
                                title="Run Whisper right here in your browser. No API key needed, and the audio never leaves your device."
                                disabled={busy || browser.running}
                                onClick={browser.start}
                            >
                                <Cpu aria-hidden="true" />
                                {browser.label ?? "Transcribe in browser"}
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            {transcripts.length > 1 ? (
                <div data-testid="source-switcher" role="group" aria-label="Transcript source" className="flex flex-wrap gap-1">
                    {transcripts.map((t) => {
                        const label = SOURCE_LABELS[t.source] ?? t.source;
                        const active = (selectedSource ?? transcript?.source) === t.source;
                        return (
                            <Button key={t.source} size="sm" variant={active ? "primary" : "secondary"} aria-pressed={active} onClick={() => onSelectSource(t.source)}>
                                {label}
                            </Button>
                        );
                    })}
                </div>
            ) : null}

            <PipelineBlock
                job={job}
                queued={pipelineActive && !job}
                phase={job?.phase ?? null}
                onCancel={() => void props.onCancelPipeline()}
                onRetry={() => void props.onRetryPipeline()}
            />

            {transcript ? (
                <>
                    <div data-testid="transcript-toolbar" className="flex flex-wrap items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" aria-label="Download transcript as TXT" onClick={() => exportText("txt")}>
                            <Download aria-hidden="true" /> TXT
                        </Button>
                        <Button variant="ghost" size="sm" aria-label="Download transcript as JSON" onClick={() => exportText("json")}>
                            <Download aria-hidden="true" /> JSON
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setDeleteOpen(true)}>
                            <Trash2 aria-hidden="true" /> Delete
                        </Button>
                    </div>
                    {noTimestamps ? (
                        <p className="text-xs text-muted-foreground">
                            This transcript was saved without timestamps. The timeline and the SRT and VTT exports are not available for it.
                        </p>
                    ) : null}
                    {timed ? (
                        <Timeline segments={transcript.timeline ?? []} follow={follow} onManualScroll={() => setFollow(false)} />
                    ) : (
                        <PlainText text={transcript.text} />
                    )}
                    <TranscriptMeta transcript={transcript} />
                </>
            ) : pipelineActive || job?.status === "failed" ? null : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                    <FileText aria-hidden="true" className="mb-3 size-10 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No transcription yet. Use the Transcribe button above.</p>
                </div>
            )}

            <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
                <DialogContent>
                    <DialogTitle>Delete this transcript?</DialogTitle>
                    <DialogDescription>The transcript and its summary will be removed. You can transcribe and summarize again later.</DialogDescription>
                    <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button variant="secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                            {deleting ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}

/** Pipeline status: running, paused for disk space, failed or needing attention. Nothing is shown for a finished job. */
function PipelineBlock({
    job,
    queued,
    phase,
    onCancel,
    onRetry,
}: {
    job: PipelineState["job"];
    queued: boolean;
    phase: string | null;
    onCancel(): void;
    onRetry(): void;
}) {
    if (queued && !job) {
        return (
            <div data-testid="pipeline-status" data-phase="queued" role="status" className="grid gap-2 rounded-lg bg-muted p-3 text-sm">
                Queueing transcription…
            </div>
        );
    }
    if (!job) return null;

    if (job.status === "failed") {
        return (
            <div data-testid="pipeline-status" data-phase={phase ?? "failed"} role="alert" className="grid gap-2 rounded-lg bg-muted p-3 text-sm">
                <p className="font-medium text-destructive">Transcription failed</p>
                {job.error ? <p className="text-xs text-muted-foreground">{job.error}</p> : null}
                <div>
                    <Button variant="secondary" size="sm" data-testid="pipeline-retry" onClick={onRetry}>
                        Retry
                    </Button>
                </div>
            </div>
        );
    }

    if (job.status === "paused_disk") {
        return (
            <div data-testid="pipeline-status" data-phase="paused_disk" className="grid gap-2 rounded-lg bg-muted p-3 text-sm">
                <p>Waiting for disk space. Processing picks up again on its own once room is free.</p>
                <div>
                    <Button variant="secondary" size="sm" data-testid="pipeline-cancel" onClick={onCancel}>
                        Cancel
                    </Button>
                </div>
            </div>
        );
    }

    if (!isActiveStatus(job.status)) return null;

    const label = phaseLabel(job.phase ?? job.status);
    const running = job.status === "running";
    return (
        <div data-testid="pipeline-status" data-phase={job.phase ?? job.status} role="status" className="grid gap-2 rounded-lg bg-muted p-3 text-sm">
            <p>{label}</p>
            {running ? (
                <div
                    role="progressbar"
                    aria-label="Audio preprocessing progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(job.progress * 100)}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
                >
                    <div className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
            ) : null}
            <div>
                <Button variant="secondary" size="sm" data-testid="pipeline-cancel" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

/** Timed transcript: one row per segment, the playing one highlighted and kept in view. */
function Timeline({ segments, follow, onManualScroll }: { segments: TimelineSegment[]; follow: boolean; onManualScroll(): void }) {
    const player = usePlayer();
    const ms = (player?.time ?? 0) * 1000;
    const activeIndex = segments.findIndex((s) => ms >= s.start_ms && ms < s.end_ms);
    const activeRef = useRef<HTMLLIElement | null>(null);

    useEffect(() => {
        if (!follow || activeIndex < 0) return;
        activeRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }, [activeIndex, follow]);

    return (
        <ol
            data-testid="transcript-timeline"
            className="grid max-h-[60vh] gap-1 overflow-y-auto pr-1 lg:max-h-[calc(100vh-18rem)]"
            onWheel={onManualScroll}
            onTouchMove={onManualScroll}
        >
            {segments.map((seg, i) => {
                const active = i === activeIndex;
                return (
                    <li
                        key={`${seg.start_ms}-${i}`}
                        ref={active ? activeRef : undefined}
                        data-testid="transcript-segment"
                        data-start-ms={seg.start_ms}
                        data-active={active ? "true" : "false"}
                        aria-current={active ? "time" : undefined}
                        className="rounded-lg data-[active=true]:bg-transcript-active"
                    >
                        <button
                            type="button"
                            onClick={() => player?.seek(seg.start_ms / 1000)}
                            className="flex w-full gap-3 rounded-lg px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
                        >
                            <span className="w-16 shrink-0 pt-[3px] text-xs tabular-nums text-muted-foreground">{timecode(seg.start_ms)}</span>
                            <span className="min-w-0 text-[15px] leading-7 text-foreground">
                                {seg.speaker_id ? <SpeakerLabel name={seg.speaker_id} /> : null}
                                {seg.text}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ol>
    );
}

const SPEAKER_LINE = /^(SPEAKER_\d+|Speaker \d+|UNKNOWN):\s*(.*)$/;
const SPEAKER_COLORS = ["bg-tile-blue", "bg-tile-green", "bg-tile-orange", "bg-tile-purple", "bg-tile-teal", "bg-tile-pink"];

/** Plain transcript text. Lines such as "SPEAKER_00: ..." are shown as speaker turns. */
function PlainText({ text }: { text: string }) {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    return (
        <div className="grid gap-3 text-[15px] leading-7 text-foreground">
            {lines.map((line, i) => {
                const match = SPEAKER_LINE.exec(line);
                if (!match) return <p key={i}>{line}</p>;
                return (
                    <p key={i}>
                        <SpeakerLabel name={match[1]} />
                        {match[2]}
                    </p>
                );
            })}
        </div>
    );
}

function SpeakerLabel({ name }: { name: string }) {
    const digits = /(\d+)/.exec(name)?.[1];
    const index = digits ? Math.max(0, Number(digits) - 1) : 0;
    const color = SPEAKER_COLORS[index % SPEAKER_COLORS.length];
    const label = name.startsWith("SPEAKER_") ? `Speaker ${Number(digits) + 1}` : name;
    return (
        <span className="mr-2 inline-flex items-center gap-1.5 align-middle text-xs font-semibold text-foreground">
            <span aria-hidden="true" className={cn("size-2 rounded-full", color)} />
            {label}:
        </span>
    );
}

function TranscriptMeta({ transcript }: { transcript: TranscriptRecord }) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-2 py-0.5">{SOURCE_LABELS[transcript.source] ?? transcript.source}</span>
            {transcript.detectedLanguage ? <span className="inline-flex items-center gap-1"><Languages className="size-3" aria-hidden="true" />Language: {transcript.detectedLanguage}</span> : null}
            <span>{transcript.text.trim().split(/\s+/u).filter(Boolean).length} words</span>
            <span>{transcript.text.length} characters</span>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Transcribe dialog: provider and model choice
// ---------------------------------------------------------------------------

export interface TranscribeDialogProps {
    open: boolean;
    onOpenChange(open: boolean): void;
    hasTranscript: boolean;
    onSubmit(body: { providerId?: string; model?: string }): void;
}

/** Choice of provider and model for a transcription run. Empty choices use the defaults. */
export function TranscribeDialog({ open, onOpenChange, hasTranscript, onSubmit }: TranscribeDialogProps) {
    const [providers, setProviders] = useState<ProviderRow[] | null>(null);
    const [providerId, setProviderId] = useState("default");
    const [model, setModel] = useState("");

    useEffect(() => {
        if (!open || providers) return;
        let alive = true;
        api<{ providers: ProviderRow[] }>("/api/settings/ai/providers")
            .then((body) => alive && setProviders(body.providers.filter((p) => p.provider !== "OpenCode Go")))
            .catch(() => alive && setProviders([]));
        return () => {
            alive = false;
        };
    }, [open, providers]);

    const chosen = providers?.find((p) => p.id === providerId);
    const defaultRow = providers?.find((p) => p.isDefaultTranscription);
    const options = [
        {
            value: "default",
            label: defaultRow ? `Default (${defaultRow.provider})` : "Default provider",
        },
        ...(providers ?? []).map((p) => ({ value: p.id, label: p.provider })),
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>{hasTranscript ? "Re-transcribe recording" : "Transcribe recording"}</DialogTitle>
                <DialogDescription>Replaces the current transcript. The summary is removed with it.</DialogDescription>
                <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        onSubmit({
                            ...(providerId !== "default" ? { providerId } : {}),
                            ...(model.trim() ? { model: model.trim() } : {}),
                        });
                    }}
                >
                    <Field label="Provider">
                        <Select value={providerId} onValueChange={setProviderId} options={options} />
                    </Field>
                    <Field label="Model" hint={`Leave empty to use ${chosen?.defaultModel ?? "the provider's default model"}.`}>
                        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={chosen?.defaultModel ?? ""} autoComplete="off" />
                    </Field>
                    <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button variant="secondary" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary">
                            {hasTranscript ? "Re-transcribe" : "Transcribe"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

