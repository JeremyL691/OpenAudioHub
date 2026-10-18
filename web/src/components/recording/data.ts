import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import type { PipelineJobStatus, PipelineState, RecordingDetailData } from "./types";

/** Pipeline states that block delete and cancel, and keep the view polling. */
export const ACTIVE_JOB_STATUSES: readonly PipelineJobStatus[] = ["queued", "running", "paused_disk"];

export function isActiveStatus(status: PipelineJobStatus | undefined): boolean {
    return status !== undefined && ACTIVE_JOB_STATUSES.includes(status);
}

/** Loads one recording with its transcript, and reloads on any change to the list (RECORDINGS_CHANGED). */
export function useRecordingDetail(id: string) {
    const [state, setState] = useState<{
        data: RecordingDetailData | null;
        status: "loading" | "ready" | "missing" | "error";
        message: string | null;
    }>({ data: null, status: "loading", message: null });

    const reload = useCallback(async () => {
        try {
            const data = await api<RecordingDetailData>(`/api/recordings/${encodeURIComponent(id)}`);
            setState({ data, status: "ready", message: null });
        } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
                setState({ data: null, status: "missing", message: null });
                return;
            }
            setState((prev) => ({
                data: prev.data,
                status: prev.data ? "ready" : "error",
                message: errorMessage(err, "Could not load this recording."),
            }));
        }
    }, [id]);

    useEffect(() => {
        void reload();
        const onChange = () => void reload();
        window.addEventListener(RECORDINGS_CHANGED, onChange);
        return () => window.removeEventListener(RECORDINGS_CHANGED, onChange);
    }, [reload]);

    return { ...state, reload };
}

export async function fetchPipeline(id: string): Promise<PipelineState | null> {
    try {
        return await api<PipelineState>(`/api/recordings/${encodeURIComponent(id)}/audio-pipeline`);
    } catch {
        return null;
    }
}

/**
 * Tracks the audio pipeline job of one recording. It polls every 2 seconds while a job is active, and
 * calls onSettled once when an active job reaches a final state (so the caller can reload the transcript).
 * `queue()` shows "queued" at once after a transcribe answer 202, before the first poll.
 */
export function usePipelineWatch(id: string, onSettled: () => void) {
    const [pipeline, setPipeline] = useState<PipelineState | null>(null);
    const [queuedLocally, setQueuedLocally] = useState(false);
    const status = pipeline?.job?.status;
    const active = isActiveStatus(status) || queuedLocally;

    const settledRef = useRef(onSettled);
    useEffect(() => {
        settledRef.current = onSettled;
    });

    const refresh = useCallback(async () => {
        const next = await fetchPipeline(id);
        if (next) {
            setPipeline(next);
            if (next.job) setQueuedLocally(false);
        }
        return next;
    }, [id]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const wasActive = useRef(false);
    useEffect(() => {
        const nowActive = isActiveStatus(status);
        if (wasActive.current && !nowActive && pipeline) settledRef.current();
        wasActive.current = nowActive;
    }, [status, pipeline]);

    useEffect(() => {
        if (!active) return;
        const timer = window.setTimeout(() => void refresh(), 2000);
        return () => window.clearTimeout(timer);
    }, [active, pipeline, refresh]);

    const queue = useCallback(() => {
        setQueuedLocally(true);
        void refresh();
    }, [refresh]);

    return { pipeline, active, refresh, queue };
}
