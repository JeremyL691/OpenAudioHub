"use client";

import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineJob } from "@/hooks/use-pipeline-status";

export function pipelinePhaseLabel(phase: string): string {
    const labels: Record<string, string> = {
        queued: "Waiting to process audio",
        download: "Reading original audio",
        decode: "Preparing audio",
        vad: "Detecting speech",
        chunking: "Preparing speech segments",
        transcribing: "Transcribing speech",
        completed: "Transcription complete",
        needs_alignment: "Transcript saved without timestamps",
        paused_disk: "Paused for disk space",
        failed: "Transcription failed",
        cancelled: "Transcription cancelled",
    };
    return labels[phase] ?? "Processing transcription";
}

function progressValue(job: PipelineJob | null | undefined): number {
    return Math.max(0, Math.min(1, job?.progress ?? 0));
}

interface PipelineStatusProps {
    /**
     * `inline` sits above a transcript that already exists. `empty` replaces
     * the "no transcription yet" message when there is no transcript.
     */
    variant: "inline" | "empty";
    job: PipelineJob | null | undefined;
    isTranscribing: boolean;
    isPipelineRunning: boolean;
    busy: boolean;
    onCancel: () => void;
    onRetry: () => void;
}

/**
 * Pipeline state for one recording. The two variants keep the markup each
 * place has always had. Only the state logic is shared.
 */
export function PipelineStatus(props: PipelineStatusProps) {
    return props.variant === "inline" ? (
        <InlinePipelineStatus {...props} />
    ) : (
        <EmptyPipelineStatus {...props} />
    );
}

function InlinePipelineStatus({
    job,
    isTranscribing,
    isPipelineRunning,
    busy,
    onCancel,
    onRetry,
}: PipelineStatusProps) {
    return (
        <>
            {isTranscribing || isPipelineRunning ? (
                <div
                    data-testid="pipeline-status"
                    data-phase={job?.phase ?? ""}
                    className="space-y-2 rounded-md border p-3"
                    aria-live="polite"
                >
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium">
                            {isTranscribing
                                ? "Queueing transcription…"
                                : pipelinePhaseLabel(job?.phase ?? "queued")}
                        </p>
                        {isPipelineRunning && (
                            <Button
                                data-testid="pipeline-cancel"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={onCancel}
                            >
                                Cancel
                            </Button>
                        )}
                    </div>
                    {isPipelineRunning && (
                        <progress
                            className="h-2 w-full accent-primary"
                            max={1}
                            value={progressValue(job)}
                            aria-label="Audio preprocessing progress"
                        />
                    )}
                </div>
            ) : null}
            {job?.status === "failed" && (
                <div
                    data-testid="pipeline-status"
                    data-phase={job?.phase ?? ""}
                    className="flex flex-col gap-3 rounded-md border border-destructive/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                    role="alert"
                >
                    <div>
                        <p className="text-sm font-medium">
                            Transcription failed
                        </p>
                        {job.error && (
                            <p className="text-sm text-muted-foreground">
                                {job.error}
                            </p>
                        )}
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="pipeline-retry"
                        onClick={onRetry}
                    >
                        Retry
                    </Button>
                </div>
            )}
            {job?.status === "needs_alignment" && (
                <p
                    data-testid="pipeline-status"
                    data-phase={job?.phase ?? ""}
                    className="rounded-md border p-3 text-sm"
                    aria-live="polite"
                >
                    Transcript saved. The provider returned no validated
                    timestamps, so playback positioning is unavailable.
                </p>
            )}
            {job?.status === "paused" && (
                <div
                    data-testid="pipeline-status"
                    data-phase={job?.phase ?? ""}
                    className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                    aria-live="polite"
                >
                    <p className="text-sm">
                        Paused because the pipeline needs more disk space. It
                        will resume automatically when space is available.
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="pipeline-cancel"
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                </div>
            )}
        </>
    );
}

function EmptyPipelineStatus({
    job,
    isPipelineRunning,
    busy,
    onCancel,
    onRetry,
}: PipelineStatusProps) {
    if (isPipelineRunning) {
        return (
            <div
                data-testid="pipeline-status"
                data-phase={job?.phase ?? ""}
                className="w-full max-w-md space-y-3 rounded-md border p-4 text-left"
            >
                <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                        {pipelinePhaseLabel(job?.phase ?? "queued")}
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        data-testid="pipeline-cancel"
                        onClick={onCancel}
                    >
                        Cancel
                    </Button>
                </div>
                <progress
                    className="h-2 w-full accent-primary"
                    max={1}
                    value={progressValue(job)}
                    aria-label="Audio preprocessing progress"
                />
            </div>
        );
    }
    if (job?.status === "paused") {
        return (
            <div
                data-testid="pipeline-status"
                data-phase={job?.phase ?? ""}
                className="flex flex-col gap-3 rounded-md border p-4 text-left sm:flex-row sm:items-center sm:justify-between"
                aria-live="polite"
            >
                <p className="text-sm">
                    Paused because the pipeline needs more disk space. It will
                    resume automatically when space is available.
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="pipeline-cancel"
                    onClick={onCancel}
                >
                    Cancel
                </Button>
            </div>
        );
    }
    if (job?.status === "failed") {
        return (
            <div
                data-testid="pipeline-status"
                data-phase={job?.phase ?? ""}
                className="space-y-3"
                role="alert"
            >
                <FileText className="mx-auto size-10 text-muted-foreground" />
                <p className="text-sm font-medium">Transcription failed</p>
                {job.error && (
                    <p className="text-sm text-muted-foreground">{job.error}</p>
                )}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid="pipeline-retry"
                    onClick={onRetry}
                >
                    Retry
                </Button>
            </div>
        );
    }
    return null;
}
