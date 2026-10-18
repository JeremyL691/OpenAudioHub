import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "@/lib/api";
import { listRecordings, RECORDINGS_CHANGED, type Recording } from "@/lib/recordings";
import { parseDensity, parsePageSize, parseSort, textKey, type Density, type SortOrder } from "./library-model";

export type LoadStatus = "loading" | "ready" | "error";

interface RecordingsState {
    status: LoadStatus;
    items: Recording[];
    error: string | null;
}

/** The account's recordings. Reloads on every RECORDINGS_CHANGED window event. */
export function useRecordings() {
    const [state, setState] = useState<RecordingsState>({ status: "loading", items: [], error: null });
    const latest = useRef(0);

    const reload = useCallback(async () => {
        const ticket = ++latest.current;
        try {
            const items = await listRecordings();
            if (ticket === latest.current) setState({ status: "ready", items, error: null });
        } catch (err) {
            const error = errorMessage(err, "Could not load recordings");
            if (ticket === latest.current) setState((prev) => ({ status: "error", items: prev.items, error }));
        }
    }, []);

    useEffect(() => {
        void reload();
        const onChange = () => void reload();
        window.addEventListener(RECORDINGS_CHANGED, onChange);
        return () => window.removeEventListener(RECORDINGS_CHANGED, onChange);
    }, [reload]);

    /** Applies a change at once, before the server answers and the event reloads the list. */
    const patchItem = useCallback((id: string, change: Partial<Recording>) => {
        setState((prev) => ({ ...prev, items: prev.items.map((r) => (r.id === id ? { ...r, ...change } : r)) }));
    }, []);

    const dropItems = useCallback((ids: string[]) => {
        setState((prev) => ({ ...prev, items: prev.items.filter((r) => !ids.includes(r.id)) }));
    }, []);

    return { ...state, reload, patchItem, dropItems };
}

export interface LibraryPrefs {
    sort: SortOrder;
    density: Density;
    pageSize: number;
    setSort(value: SortOrder): void;
    setDensity(value: Density): void;
}

/** Sort, density and page size from the user's settings. Changes are saved best effort. */
export function useLibraryPrefs(): LibraryPrefs {
    const [prefs, setPrefs] = useState<{ sort: SortOrder; density: Density; pageSize: number }>({
        sort: "newest",
        density: "comfortable",
        pageSize: 50,
    });

    useEffect(() => {
        let alive = true;
        api<Record<string, unknown>>("/api/settings/user")
            .then((body) => {
                if (!alive) return;
                setPrefs({
                    sort: parseSort(body.recordingListSortOrder),
                    density: parseDensity(body.listDensity),
                    pageSize: parsePageSize(body.itemsPerPage),
                });
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);

    const save = useCallback((json: Record<string, unknown>) => {
        api("/api/settings/user", { method: "PUT", json }).catch(() => undefined);
    }, []);

    const setSort = useCallback(
        (sort: SortOrder) => {
            setPrefs((prev) => ({ ...prev, sort }));
            save({ recordingListSortOrder: sort });
        },
        [save],
    );

    const setDensity = useCallback(
        (density: Density) => {
            setPrefs((prev) => ({ ...prev, density }));
            save({ listDensity: density });
        },
        [save],
    );

    return { ...prefs, setSort, setDensity };
}

/** Text of a recording's transcript, from the detail answer. Empty when there is none or it cannot be read. */
function transcriptText(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(transcriptText).join(" ");
    if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
        return (value as { text: string }).text;
    }
    return "";
}

async function fetchTranscriptText(id: string): Promise<string> {
    try {
        const body = await api<{ transcription?: unknown }>(`/api/recordings/${encodeURIComponent(id)}`);
        return transcriptText(body.transcription);
    } catch {
        return "";
    }
}

/**
 * Transcript texts for the search box. The list carries no text, so the texts of
 * transcribed recordings are read once, in small batches, when a search starts.
 */
export function useTranscriptTexts(items: Recording[], enabled: boolean): Record<string, string> {
    const [texts, setTexts] = useState<Record<string, string>>({});
    const requested = useRef(new Set<string>());

    useEffect(() => {
        if (!enabled) return;
        const missing = items.filter((r) => r.hasTranscript && !requested.current.has(textKey(r)));
        if (missing.length === 0) return;
        missing.forEach((r) => requested.current.add(textKey(r)));
        void (async () => {
            for (let i = 0; i < missing.length; i += 4) {
                const batch = missing.slice(i, i + 4);
                const results = await Promise.all(
                    batch.map(async (r) => [textKey(r), await fetchTranscriptText(r.id)] as const),
                );
                setTexts((prev) => {
                    const next = { ...prev };
                    for (const [key, text] of results) next[key] = text;
                    return next;
                });
            }
        })();
    }, [items, enabled]);

    return texts;
}

const DESKTOP_QUERY = "(min-width: 1024px)";

/** True from the lg breakpoint up, where the list and the detail pane sit side by side. */
export function useIsDesktop(): boolean {
    return useSyncExternalStore(
        (notify) => {
            const media = window.matchMedia(DESKTOP_QUERY);
            media.addEventListener("change", notify);
            return () => media.removeEventListener("change", notify);
        },
        () => window.matchMedia(DESKTOP_QUERY).matches,
        () => true,
    );
}
