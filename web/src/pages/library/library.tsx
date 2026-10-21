import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { LibraryEmpty } from "@/components/recordings/library-empty";
import { DeleteDialog, MergeDialog, RenameDialog } from "@/components/recordings/library-dialogs";
import { LibraryHeader } from "@/components/recordings/library-header";
import { RecordingList } from "@/components/recordings/recording-list";
import { RecordingRow, type RowActions } from "@/components/recordings/recording-row";
import { useIsDesktop, useLibraryPrefs, useRecordings, useTranscriptSearch } from "@/components/recordings/hooks";
import {
    countLabel,
    groupRows,
    inCollection,
    matchesQuery,
    matchesStatus,
    parseCollection,
    parseFilter,
    seedQuery,
    sortRecordings,
    type StatusFilter,
} from "@/components/recordings/library-model";
import { startUploads, useUploads } from "@/components/recordings/uploads";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { api, errorMessage } from "@/lib/api";
import { downloadRecordings } from "@/lib/downloads";
import { deleteRecording, type Recording } from "@/lib/recordings";
import { transcribeInBrowser as runBrowserTranscription } from "@/components/recording/browser-transcribe";
import { PreviewPane } from "./preview-pane";

/** The Library page at /recordings: the list, the detail pane beside it, and the bulk and row actions. */
export default function LibraryPage() {
    const [params, setParams] = useSearchParams();
    const { t } = useI18n();
    const collection = parseCollection(params.get("collection"));
    const urlId = params.get("id");
    const qParam = params.get("q");
    const filterParam = params.get("filter");

    const lib = useRecordings();
    const prefs = useLibraryPrefs();
    const isDesktop = useIsDesktop();
    const uploads = useUploads();

    const [query, setQuery] = useState(() => seedQuery(qParam));
    const [filter, setFilter] = useState<StatusFilter>(() => parseFilter(filterParam));
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const [limit, setLimit] = useState(prefs.pageSize);
    const [transcribing, setTranscribing] = useState<ReadonlySet<string>>(() => new Set());
    const [renaming, setRenaming] = useState<Recording | null>(null);
    const [deleting, setDeleting] = useState<Recording | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [merging, setMerging] = useState<Recording[] | null>(null);
    const [downloading, setDownloading] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    // Address changes (sidebar collections, top-bar search, chip links) reach the controls.
    useEffect(() => {
        setQuery(seedQuery(qParam));
    }, [qParam]);
    useEffect(() => {
        setFilter(parseFilter(filterParam));
    }, [filterParam]);

    const needle = query.trim().toLowerCase();
    const search = useTranscriptSearch(lib.items, needle);

    const inScope = useMemo(() => {
        const nowMs = Date.now();
        return lib.items.filter((r) => inCollection(r, collection, nowMs));
    }, [lib.items, collection]);

    const visible = useMemo(
        () => sortRecordings(inScope.filter((r) => matchesStatus(r, filter) && matchesQuery(r, needle, search.ids)), prefs.sort),
        [inScope, filter, needle, search.ids, prefs.sort],
    );

    // Pages: the list shows the first `limit` rows and grows as its end comes into view.
    // Any change of filter, search, sort or collection starts again from the first page.
    useEffect(() => {
        setLimit(prefs.pageSize);
    }, [prefs.pageSize, collection, filter, needle, prefs.sort]);
    const loadMore = useCallback(() => setLimit((current) => current + prefs.pageSize), [prefs.pageSize]);
    const shown = visible.slice(0, limit);
    const groups = groupRows(shown, prefs.sort, new Date());

    // Selections are dropped when their recording goes away.
    useEffect(() => {
        setSelected((prev) => {
            const alive = new Set(lib.items.map((r) => r.id));
            const next = new Set([...prev].filter((id) => alive.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [lib.items]);

    // The detail pane: the id from the address, else the first row. An unknown id falls back to the first row.
    const known = lib.items.some((r) => r.id === urlId);
    const requestedId = urlId !== null && (known || lib.status === "loading") ? urlId : null;
    const detailId = requestedId ?? visible[0]?.id ?? null;
    const detailMounted = detailId !== null && (isDesktop || urlId !== null);

    const select = useCallback(
        (id: string | null) => {
            setParams((prev) => {
                const next = new URLSearchParams(prev);
                if (id) next.set("id", id);
                else next.delete("id");
                return next;
            });
        },
        [setParams],
    );

    function toggle(id: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function activate(id: string) {
        if (selectMode) toggle(id);
        else select(id);
    }

    async function transcribe(recording: Recording) {
        setTranscribing((prev) => new Set(prev).add(recording.id));
        try {
            await api(`/api/recordings/${encodeURIComponent(recording.id)}/transcribe`, { method: "POST", json: {} });
            toast.success(t("library.transcriptionStarted"));
        } catch (err) {
            toast.error(errorMessage(err, t("recording.transcribe.failed")));
        } finally {
            setTranscribing((prev) => {
                const next = new Set(prev);
                next.delete(recording.id);
                return next;
            });
            void lib.reload();
        }
    }

    async function transcribeInBrowser(recording: Recording) {
        setTranscribing((prev) => new Set(prev).add(recording.id));
        // Shows its own progress and result toasts.
        await runBrowserTranscription(recording.id);
        setTranscribing((prev) => {
            const next = new Set(prev);
            next.delete(recording.id);
            return next;
        });
        void lib.reload();
    }

    async function confirmDelete() {
        const target = deleting;
        if (!target) return;
        const index = visible.findIndex((r) => r.id === target.id);
        const nextId = index >= 0 ? (visible[index + 1]?.id ?? visible[index - 1]?.id ?? null) : (visible[0]?.id ?? null);
        setDeleteBusy(true);
        try {
            await deleteRecording(target.id);
            lib.dropItems([target.id]);
            toast.success(t("library.deleted"));
            if (urlId === target.id) select(nextId);
            setDeleting(null);
        } catch (err) {
            toast.error(errorMessage(err, t("library.deleteFailed")));
        } finally {
            setDeleteBusy(false);
        }
    }

    function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length > 0) startUploads(files);
    }

    const actions: RowActions = {
        onOpen: (r) => select(r.id),
        onRename: (r) => setRenaming(r),
        onTranscribe: (r) => void transcribe(r),
        onTranscribeInBrowser: (r) => void transcribeInBrowser(r),
        onDelete: (r) => setDeleting(r),
    };

    const selectedIds = lib.items.filter((r) => selected.has(r.id)).map((r) => r.id);

    async function downloadSelected() {
        setDownloading(true);
        try {
            await downloadRecordings(selectedIds);
        } finally {
            setDownloading(false);
        }
    }

    const countText = countLabel(visible.length, inScope.length, needle.length > 0 || filter !== "all");

    let emptyText: string | null = null;
    if (visible.length === 0) {
        if (needle && search.status === "searching") emptyText = t("library.searching");
        else if (needle && search.status === "error") emptyText = t("library.searchFailed");
        else if (needle) emptyText = t("library.noMatchSearch");
        else if (filter !== "all") emptyText = t("library.noMatchFilter");
        else if (collection && inScope.length === 0) emptyText = t("library.noCollection");
    }

    const libraryEmpty = lib.status === "ready" && lib.items.length === 0 && uploads.pending.length === 0;

    return (
        <div className="flex h-full min-h-0 w-full flex-col">
            <h1 className="sr-only">{t("library.recordingsHeading")}</h1>
            <input ref={fileInput} type="file" accept="audio/*,.mp3,.mp4,.m4a,.wav,.ogg,.opus,.webm,.aac,.flac" multiple hidden onChange={onFilesChosen} />

            {libraryEmpty ? (
                <LibraryEmpty onUpload={() => fileInput.current?.click()} />
            ) : (
                <div className="flex min-h-0 flex-1">
                    <RecordingList
                        className={cn("w-full lg:flex lg:w-[380px] lg:shrink-0 lg:border-r lg:border-border", urlId !== null ? "hidden" : "flex")}
                        header={
                            <LibraryHeader
                                collection={collection}
                                total={inScope.length}
                                countText={countText}
                                filter={filter}
                                onFilterChange={setFilter}
                                query={query}
                                onQueryChange={setQuery}
                                onSearchEnter={() => select(visible[0]?.id ?? null)}
                                sort={prefs.sort}
                                onSortChange={prefs.setSort}
                                density={prefs.density}
                                onDensityChange={prefs.setDensity}
                                selectMode={selectMode}
                                onEnterSelectMode={() => setSelectMode(true)}
                                onCancelSelectMode={() => {
                                    setSelectMode(false);
                                    setSelected(new Set());
                                }}
                                selectedIds={selectedIds}
                                onSelectAll={() => setSelected(new Set(visible.map((r) => r.id)))}
                                onBulkDownload={() => void downloadSelected()}
                                bulkDownloading={downloading}
                                onMerge={() => setMerging(lib.items.filter((r) => selected.has(r.id)))}
                            />
                        }
                        status={lib.status}
                        error={lib.error}
                        onRetry={() => void lib.reload()}
                        groups={groups}
                        showHeadings={prefs.sort !== "name"}
                        pending={uploads.pending}
                        emptyText={emptyText}
                        searchStatus={needle ? search.status : "idle"}
                        onSearchRetry={search.retry}
                        renderRow={(r) => (
                            <RecordingRow
                                recording={r}
                                selected={detailId === r.id}
                                selectMode={selectMode}
                                checked={selected.has(r.id)}
                                compact={prefs.density === "compact"}
                                transcribing={transcribing.has(r.id)}
                                onActivate={activate}
                                actions={actions}
                            />
                        )}
                        hasMore={limit < visible.length}
                        onNeedMore={loadMore}
                    />

                    <div className={cn("min-h-0 min-w-0 flex-1", urlId !== null ? "flex" : "hidden", "lg:flex")}>
                        {detailMounted && detailId ? <PreviewPane id={detailId} onBack={() => select(null)} /> : null}
                    </div>
                </div>
            )}

            <RenameDialog
                target={renaming}
                onClose={() => setRenaming(null)}
                onRenamed={(id, filename) => {
                    lib.patchItem(id, { filename });
                    setRenaming(null);
                }}
            />
            <MergeDialog
                sources={merging}
                onClose={() => setMerging(null)}
                onMerged={() => {
                    setMerging(null);
                    setSelectMode(false);
                    setSelected(new Set());
                }}
            />
            <DeleteDialog
                target={deleting}
                busy={deleteBusy}
                onCancel={() => {
                    if (!deleteBusy) setDeleting(null);
                }}
                onConfirm={() => void confirmDelete()}
            />
        </div>
    );
}
