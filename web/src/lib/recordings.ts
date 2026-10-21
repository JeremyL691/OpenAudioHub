import { api } from "./api";

/** One row of GET /api/recordings (spec/recordings.md). Times are ISO strings; durations are ms. */
export interface Recording {
    id: string;
    filename: string;
    duration: number;
    startTime: string;
    endTime: string;
    filesize: number;
    deviceSn: string;
    plaudFileId: string;
    storageType: string;
    waveformPeaks: number[] | null;
    starredAt: string | null;
    createdAt: string;
    updatedAt: string;
    hasTranscript: boolean;
    hasSummary: boolean;
    processing: { kind: "transcribe" | "pipeline" | "summary"; progress: number } | null;
}

/** Where a recording came from: uploads and merges are local, everything else is Plaud. */
export function sourceOf(r: Pick<Recording, "deviceSn">): "plaud" | "upload" {
    return r.deviceSn === "local" ? "upload" : "plaud";
}

export async function listRecordings(): Promise<Recording[]> {
    const body = await api<{ recordings: Recording[] }>("/api/recordings");
    return body.recordings;
}

/** Uploads files one by one; resolves with the titles the server stored. Stops at the first failure. */
export async function uploadRecordings(files: File[]): Promise<string[]> {
    const titles: string[] = [];
    for (const file of files) {
        const form = new FormData();
        form.append("file", file, file.name);
        const body = await api<{ filename: string }>("/api/recordings/upload", { method: "POST", body: form });
        titles.push(body.filename);
    }
    window.dispatchEvent(new Event(RECORDINGS_CHANGED));
    return titles;
}

export async function setStarred(id: string, starred: boolean): Promise<void> {
    await api(`/api/recordings/${encodeURIComponent(id)}/star`, { method: "PUT", json: { starred } });
    window.dispatchEvent(new Event(RECORDINGS_CHANGED));
}

export async function renameRecording(id: string, filename: string): Promise<string> {
    const body = await api<{ filename: string }>(`/api/recordings/${encodeURIComponent(id)}`, { method: "PATCH", json: { filename } });
    window.dispatchEvent(new Event(RECORDINGS_CHANGED));
    return body.filename;
}

export async function deleteRecording(id: string): Promise<void> {
    await api(`/api/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
    window.dispatchEvent(new Event(RECORDINGS_CHANGED));
}

export async function mergeRecordings(ids: string[], title?: string): Promise<string> {
    const body = await api<{ id: string }>("/api/recordings/merge", { method: "POST", json: { ids, title } });
    window.dispatchEvent(new Event(RECORDINGS_CHANGED));
    return body.id;
}

/** Fired on window after any change to the list, so every view can reload. */
export const RECORDINGS_CHANGED = "oah:recordings-changed";

/**
 * The ids of the recordings whose text matches the query.
 *
 * The answer is ids only: the list already carries every other field, and the transcript text
 * never leaves the server for a search.
 */
export async function searchTranscripts(q: string, signal?: AbortSignal): Promise<string[]> {
    const body = await api<{ recordingIds?: unknown }>(`/api/recordings/search?q=${encodeURIComponent(q)}`, {
        signal,
    });
    const ids = Array.isArray(body.recordingIds) ? body.recordingIds : [];
    return ids.filter((id): id is string => typeof id === "string");
}
