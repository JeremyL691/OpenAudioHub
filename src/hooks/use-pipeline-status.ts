"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface TimelineSegment {
    start_ms: number;
    end_ms: number;
    text: string;
}

export interface PipelineJob {
    id: string;
    status: string;
    phase: string;
    progress: number;
    errorType: string | null;
    error: string | null;
    updatedAt: string;
}

export interface PipelineState {
    job: PipelineJob | null;
    timeline: TimelineSegment[] | null;
    timestampSource: string | null;
    transcription: { text: string; language?: string; source: string } | null;
}

interface UsePipelineStatusOptions {
    recordingId: string;
    isTranscribing: boolean;
    onTranscribeComplete?: () => void;
    /**
     * Runs when a job this page watched finishes with a transcript. It runs
     * before `onTranscribeComplete`, as it always has.
     */
    onJobCompleted?: (state: PipelineState) => void;
}

/**
 * Polls the audio pipeline for a recording and exposes the cancel and retry
 * actions. The polling cadence is unchanged: 2 s while a job is active, 500 ms
 * while a transcription is queued from this page, and 5 s otherwise.
 */
export function usePipelineStatus({
    recordingId,
    isTranscribing,
    onTranscribeComplete,
    onJobCompleted,
}: UsePipelineStatusOptions) {
    const [pipelineState, setPipelineState] = useState<PipelineState | null>(
        null,
    );
    const [pipelineBusy, setPipelineBusy] = useState(false);
    const observedActiveJobs = useRef(new Set<string>());
    // The latest callback, read inside the poll, so a new function identity on
    // each render does not restart polling.
    const onJobCompletedRef = useRef(onJobCompleted);
    useEffect(() => {
        onJobCompletedRef.current = onJobCompleted;
    }, [onJobCompleted]);

    const refreshPipelineState = useCallback(
        async (signal?: AbortSignal): Promise<PipelineState | null> => {
            try {
                const response = await fetch(
                    `/api/recordings/${recordingId}/audio-pipeline`,
                    { signal },
                );
                if (!response.ok) return null;
                const state = (await response.json()) as PipelineState;
                setPipelineState(state);
                return state;
            } catch {
                return null;
            }
        },
        [recordingId],
    );

    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let active = true;
        const poll = async () => {
            const state = await refreshPipelineState(controller.signal);
            if (!active || controller.signal.aborted) return;
            const job = state?.job;
            if (
                job &&
                ["queued", "submitted", "running", "paused"].includes(
                    job.status,
                )
            ) {
                observedActiveJobs.current.add(job.id);
            }
            if (
                state &&
                job &&
                [
                    "completed",
                    "needs_alignment",
                    "failed",
                    "cancelled",
                ].includes(job.status)
            ) {
                const wasActive = observedActiveJobs.current.delete(job.id);
                if (
                    wasActive &&
                    ["completed", "needs_alignment"].includes(job.status)
                ) {
                    onJobCompletedRef.current?.(state);
                    onTranscribeComplete?.();
                }
            }
            timer = setTimeout(
                poll,
                job &&
                    ["queued", "submitted", "running", "paused"].includes(
                        job.status,
                    )
                    ? 2_000
                    : isTranscribing
                      ? 500
                      : 5_000,
            );
        };
        void poll();
        return () => {
            active = false;
            controller.abort();
            if (timer) clearTimeout(timer);
        };
    }, [refreshPipelineState, isTranscribing, onTranscribeComplete]);

    const performPipelineAction = async (action: "retry" | "cancel") => {
        if (pipelineBusy) return;
        setPipelineBusy(true);
        try {
            const response = await fetch(
                `/api/recordings/${recordingId}/audio-pipeline`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action }),
                },
            );
            if (!response.ok) {
                toast.error(
                    action === "retry"
                        ? "Could not retry transcription"
                        : "Could not cancel transcription",
                );
                return;
            }
            toast.success(
                action === "retry" ? "Retry queued" : "Transcription cancelled",
            );
            await refreshPipelineState();
        } catch {
            toast.error(
                action === "retry"
                    ? "Could not retry transcription"
                    : "Could not cancel transcription",
            );
        } finally {
            setPipelineBusy(false);
        }
    };

    const activeJob = pipelineState?.job;
    const isPipelineRunning =
        activeJob &&
        ["queued", "submitted", "running"].includes(activeJob.status);
    const isPipelineActive =
        isPipelineRunning || activeJob?.status === "paused";

    return {
        pipelineState,
        activeJob,
        isPipelineRunning,
        isPipelineActive,
        pipelineBusy,
        performPipelineAction,
    };
}
