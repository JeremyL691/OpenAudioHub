"use client";

import { Mic } from "lucide-react";
import Link from "next/link";
import type * as React from "react";
import {
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    type PendingUpload,
    PendingUploadRow,
} from "@/components/dashboard/pending-upload-row";
import {
    type ListDensity,
    RecordingListToolbar,
    type SortOrder,
    type StatusFilter,
} from "@/components/dashboard/recording-list-toolbar";
import { RecordingRow } from "@/components/dashboard/recording-row";
import { MergeRecordingsDialog } from "@/components/recordings/merge-recordings-dialog";
import { dateGroupFallbackLabel, dateGroupLabel } from "@/lib/format-date";
import {
    type CollectionId,
    collectionLabel,
    inCollection,
} from "@/lib/recordings/collections";
import { recordingsZipDownloadPath } from "@/lib/recordings/filename";
import type { DateTimeFormat } from "@/types/common";
import type { Recording } from "@/types/recording";

export type { PendingUpload } from "@/components/dashboard/pending-upload-row";
export type {
    ListDensity,
    SortOrder,
    StatusFilter,
} from "@/components/dashboard/recording-list-toolbar";

interface TranscriptionData {
    text?: string;
    language?: string;
}

interface RecordingListProps {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    currentRecording: Recording | null;
    pendingUploads: PendingUpload[];
    inFlightActions: Map<string, "transcribing" | "summarizing">;
    onSelect: (recording: Recording) => void;
    onDelete: (recording: Recording) => Promise<void>;
    onTranscribe?: (recording: Recording) => void;
    onTranscribeInBrowser?: (recording: Recording) => void;
    onRename?: (recording: Recording) => void;
    initialDateTimeFormat: DateTimeFormat;
    initialSortOrder: SortOrder;
    initialDensity: ListDensity;
    initialChunkSize: number;
    initialCollection?: CollectionId | null;
    initialFilter?: StatusFilter;
    initialQuery?: string;
}

export interface RecordingListHandle {
    focusSearch: () => void;
    next: () => void;
    prev: () => void;
}

function persistSetting(field: string, value: unknown) {
    fetch("/api/settings/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
    }).catch(() => {});
}

/** Total length of a day group, e.g. "35 min" or "1 h 35 min". */
function formatGroupDuration(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function RecordingList({
    recordings,
    transcriptions,
    currentRecording,
    pendingUploads,
    inFlightActions,
    onSelect,
    onDelete,
    onTranscribe,
    onTranscribeInBrowser,
    onRename,
    initialDateTimeFormat,
    initialSortOrder,
    initialDensity,
    initialChunkSize,
    initialCollection = null,
    initialFilter = "all",
    initialQuery = "",
    ref,
}: RecordingListProps & { ref?: React.Ref<RecordingListHandle> }) {
    const [dateTimeFormat] = useState<DateTimeFormat>(initialDateTimeFormat);
    const [sortOrder, setSortOrder] = useState<SortOrder>(initialSortOrder);
    const [density, setDensity] = useState<ListDensity>(initialDensity);
    const [query, setQuery] = useState(initialQuery);
    const [statusFilter, setStatusFilter] =
        useState<StatusFilter>(initialFilter);
    const [visibleCount, setVisibleCount] = useState(initialChunkSize);
    const [hasHydrated, setHasHydrated] = useState(false);
    const [selectMode, setSelectMode] = useState(false);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
    const [mergeOpen, setMergeOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

    useEffect(() => {
        setHasHydrated(true);
    }, []);

    const setSortOrderPersisted = useCallback((next: SortOrder) => {
        setSortOrder(next);
        persistSetting("recordingListSortOrder", next);
    }, []);

    const setDensityPersisted = useCallback((next: ListDensity) => {
        setDensity(next);
        persistSetting("listDensity", next);
    }, []);

    const handleSelectModeChange = useCallback((next: boolean) => {
        setSelectMode(next);
        if (!next) setCheckedIds(new Set());
    }, []);

    const toggleChecked = useCallback((recording: Recording) => {
        setCheckedIds((prev) => {
            const next = new Set(prev);
            if (next.has(recording.id)) next.delete(recording.id);
            else next.add(recording.id);
            return next;
        });
    }, []);

    const registerRowRef = useCallback(
        (id: string, el: HTMLButtonElement | null) => {
            if (el) rowRefs.current.set(id, el);
            else rowRefs.current.delete(id);
        },
        [],
    );

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const inScope = initialCollection
            ? recordings.filter((r) => inCollection(r, initialCollection))
            : recordings;
        const searched = q
            ? inScope.filter((r) => {
                  if (r.filename.toLowerCase().includes(q)) return true;
                  const t = transcriptions.get(r.id);
                  return !!t?.text && t.text.toLowerCase().includes(q);
              })
            : inScope;

        // Status chips filter the loaded list; they do not refetch.
        const base = searched.filter((r) => {
            const transcribed =
                r.hasTranscript === true || transcriptions.has(r.id);
            switch (statusFilter) {
                case "transcribed":
                    return transcribed;
                case "untranscribed":
                    return !transcribed;
                case "processing":
                    return inFlightActions.has(r.id) || r.pipelinePhase != null;
                default:
                    return true;
            }
        });

        const sorted = [...base];
        switch (sortOrder) {
            case "newest":
                sorted.sort(
                    (a, b) =>
                        new Date(b.startTime).getTime() -
                        new Date(a.startTime).getTime(),
                );
                break;
            case "oldest":
                sorted.sort(
                    (a, b) =>
                        new Date(a.startTime).getTime() -
                        new Date(b.startTime).getTime(),
                );
                break;
            case "name":
                sorted.sort((a, b) => a.filename.localeCompare(b.filename));
                break;
        }
        return sorted;
    }, [
        recordings,
        transcriptions,
        inFlightActions,
        initialCollection,
        query,
        statusFilter,
        sortOrder,
    ]);

    const visible = filtered.slice(0, visibleCount);

    const grouped = useMemo(() => {
        if (sortOrder === "name") {
            return [{ label: null as string | null, items: visible }];
        }
        const groups: { label: string; items: Recording[] }[] = [];
        for (const r of visible) {
            const label = hasHydrated
                ? dateGroupLabel(r.startTime)
                : dateGroupFallbackLabel(r.startTime);
            const last = groups[groups.length - 1];
            if (last && last.label === label) {
                last.items.push(r);
            } else {
                groups.push({ label, items: [r] });
            }
        }
        return groups;
    }, [visible, sortOrder, hasHydrated]);

    // Reset visibleCount when the filter changes so search results
    // aren't accidentally truncated.
    useEffect(() => {
        setVisibleCount(initialChunkSize);
    }, [initialChunkSize]);
    useEffect(() => {
        setVisibleCount((c) =>
            c > filtered.length
                ? Math.max(initialChunkSize, filtered.length)
                : c,
        );
    }, [filtered.length, initialChunkSize]);

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        setVisibleCount((c) =>
                            Math.min(c + initialChunkSize, filtered.length),
                        );
                    }
                }
            },
            { rootMargin: "200px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [filtered.length, initialChunkSize]);

    useImperativeHandle(
        ref,
        () => ({
            focusSearch: () => searchRef.current?.focus(),
            next: () => {
                const list = filtered;
                if (list.length === 0) return;
                const idx = currentRecording
                    ? list.findIndex((r) => r.id === currentRecording.id)
                    : -1;
                const nextIdx = Math.min(idx + 1, list.length - 1);
                const target = list[Math.max(0, nextIdx)];
                if (target) {
                    onSelect(target);
                    rowRefs.current
                        .get(target.id)
                        ?.scrollIntoView({ block: "nearest" });
                }
            },
            prev: () => {
                const list = filtered;
                if (list.length === 0) return;
                const idx = currentRecording
                    ? list.findIndex((r) => r.id === currentRecording.id)
                    : 0;
                const prevIdx = Math.max(0, idx - 1);
                const target = list[prevIdx];
                if (target) {
                    onSelect(target);
                    rowRefs.current
                        .get(target.id)
                        ?.scrollIntoView({ block: "nearest" });
                }
            },
        }),
        [filtered, currentRecording, onSelect],
    );

    const isCompact = density === "compact";
    const rowPadding = isCompact ? "px-2.5 py-1.5" : "px-2.5 py-2";

    // Drop ids for recordings that have since been deleted.
    const liveCheckedIds = useMemo(() => {
        const existing = new Set(recordings.map((r) => r.id));
        return [...checkedIds].filter((id) => existing.has(id));
    }, [recordings, checkedIds]);
    const downloadHref = liveCheckedIds.length
        ? recordingsZipDownloadPath(liveCheckedIds)
        : null;
    const selectedRecordings = useMemo(() => {
        const selected = new Set(liveCheckedIds);
        return recordings.filter((r) => selected.has(r.id));
    }, [recordings, liveCheckedIds]);

    return (
        <div>
            <div className="bg-background lg:sticky lg:top-0 lg:z-10">
                <div className="flex items-baseline justify-between gap-3 px-4 pt-4">
                    <h2 className="min-w-0 truncate text-[17px] font-semibold">
                        {initialCollection
                            ? collectionLabel(initialCollection)
                            : "All recordings"}
                    </h2>
                    <div className="flex shrink-0 items-baseline gap-3 text-xs tabular-nums text-muted-foreground">
                        <span>{filtered.length}</span>
                        {initialCollection && (
                            <Link
                                href="/recordings"
                                className="text-link hover:underline"
                            >
                                Clear
                            </Link>
                        )}
                    </div>
                </div>
                <RecordingListToolbar
                    query={query}
                    onQueryChange={setQuery}
                    onEnterSelectFirst={() => {
                        if (filtered.length > 0) onSelect(filtered[0]);
                    }}
                    searchRef={searchRef}
                    filteredCount={filtered.length}
                    totalCount={recordings.length}
                    statusFilter={statusFilter}
                    onStatusFilterChange={setStatusFilter}
                    sortOrder={sortOrder}
                    onSortOrderChange={setSortOrderPersisted}
                    density={density}
                    onDensityChange={setDensityPersisted}
                    selectMode={selectMode}
                    selectedCount={liveCheckedIds.length}
                    onSelectModeChange={handleSelectModeChange}
                    onSelectAll={() =>
                        setCheckedIds(new Set(filtered.map((r) => r.id)))
                    }
                    downloadHref={downloadHref}
                    onMerge={() => setMergeOpen(true)}
                />
            </div>

            {pendingUploads.length > 0 && (
                <div className="flex flex-col gap-0.5 px-2">
                    {pendingUploads.map((p) => (
                        <PendingUploadRow
                            key={p.id}
                            upload={p}
                            rowPadding={rowPadding}
                        />
                    ))}
                </div>
            )}

            <div data-testid="recording-list">
                {grouped.map((group, gi) => (
                    <div key={group.label ?? `__ungrouped-${gi.toString()}`}>
                        {group.label && (
                            <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-background/85 px-4 pt-3 pb-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:static">
                                <span className="text-[13px] font-semibold">
                                    {group.label}
                                </span>
                                <span className="text-xs tabular-nums text-muted-foreground">
                                    {group.items.length}{" "}
                                    {group.items.length === 1
                                        ? "recording"
                                        : "recordings"}
                                    {" · "}
                                    {formatGroupDuration(
                                        group.items.reduce(
                                            (sum, r) => sum + r.duration,
                                            0,
                                        ),
                                    )}
                                </span>
                            </div>
                        )}
                        <div className="flex flex-col gap-0.5 px-2">
                            {group.items.map((recording) => (
                                <RecordingRow
                                    key={recording.id}
                                    recording={recording}
                                    isSelected={
                                        currentRecording?.id === recording.id
                                    }
                                    inFlight={inFlightActions.get(recording.id)}
                                    isCompact={isCompact}
                                    rowPadding={rowPadding}
                                    dateTimeFormat={dateTimeFormat}
                                    onSelect={onSelect}
                                    onDelete={onDelete}
                                    onTranscribe={onTranscribe}
                                    onTranscribeInBrowser={
                                        onTranscribeInBrowser
                                    }
                                    onRename={onRename}
                                    registerRef={registerRowRef}
                                    selectMode={selectMode}
                                    checked={checkedIds.has(recording.id)}
                                    onToggleChecked={toggleChecked}
                                />
                            ))}
                        </div>
                    </div>
                ))}

                {filtered.length === 0 && pendingUploads.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Mic className="mb-2 size-8 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            {query
                                ? "No recordings match your search."
                                : statusFilter !== "all"
                                  ? "No recordings match this filter."
                                  : "No recordings yet."}
                        </p>
                    </div>
                )}

                <div ref={sentinelRef} className="h-4" aria-hidden="true" />
            </div>

            <MergeRecordingsDialog
                recordings={selectedRecordings}
                open={mergeOpen}
                onClose={() => setMergeOpen(false)}
                onMerged={() => handleSelectModeChange(false)}
            />
        </div>
    );
}
