import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "@/lib/api";
import { listRecordings, RECORDINGS_CHANGED, searchTranscripts, type Recording } from "@/lib/recordings";
import { parseDensity, parsePageSize, parseSort, type Density, type SortOrder } from "./library-model";

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

export type SearchStatus = "idle" | "searching" | "ready" | "error";

/**
 * The recordings whose transcript text matches the query.
 *
 * The server answers which ids match in one request. The list the page already has carries every
 * other field, so nothing else is fetched: the old code asked for each transcribed recording's
 * detail in turn, which cost one request per recording in a large library.
 *
 * The request is debounced and cancellable. A response that belongs to a query the user has
 * already replaced is dropped, so a slow answer cannot overwrite a newer one.
 */
export function useTranscriptSearch(items: Recording[], needle: string): {
    ids: ReadonlySet<string>;
    status: SearchStatus;
    retry(): void;
} {
    const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
    const [status, setStatus] = useState<SearchStatus>("idle");
    const [attempt, setAttempt] = useState(0);
    const latest = useRef(0);
    // A search is about the library as it is now: a recording that was just transcribed, renamed
    // or deleted has to be asked about again, which is what this signature changes on.
    const library = items
        .map((r) => `${r.id}:${r.hasTranscript ? 1 : 0}:${r.filename}`)
        .sort()
        .join("|");

    useEffect(() => {
        if (!needle) {
            latest.current += 1;
            setIds(new Set());
            setStatus("idle");
            return;
        }
        const ticket = ++latest.current;
        const controller = new AbortController();
        // A new query cannot answer with the previous query's text matches: leaving them in place
        // would keep showing a recording whose transcript no longer contains what is being looked
        // for, for as long as the request runs and after it fails.
        setIds(new Set());
        setStatus("searching");
        const timer = window.setTimeout(() => {
            void (async () => {
                try {
                    const found = await searchTranscripts(needle, controller.signal);
                    if (ticket !== latest.current) return;
                    setIds(new Set(found));
                    setStatus("ready");
                } catch (error) {
                    if (controller.signal.aborted || ticket !== latest.current) return;
                    setStatus("error");
                }
            })();
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            window.clearTimeout(timer);
            controller.abort();
        };
    }, [needle, attempt, library]);

    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { ids, status, retry };
}

/** How long the search box waits after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 300;

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
