"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
    useDialogs,
    useSyncStatus,
    useTranscribeStatus,
    useUploadStatus,
} from "@/components/app-shell/providers";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { PlaudReconnectBanner } from "@/components/dashboard/plaud-reconnect-banner";
import {
    RecordingList,
    type RecordingListHandle,
} from "@/components/dashboard/recording-list";
import { WorkstationDetailPane } from "@/components/dashboard/workstation-detail-pane";
import { WorkstationEmptyState } from "@/components/dashboard/workstation-empty-state";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { useTheme } from "@/hooks/use-theme";
import {
    applyFilenameOverrides,
    reconcileFilenameOverrides,
} from "@/lib/recordings/filename-overrides";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { cn } from "@/lib/utils";
import type { Recording } from "@/types/recording";

interface TranscriptionData {
    text?: string;
    language?: string;
}

interface WorkstationProps {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    initialSettings: InitialSettings;
    /**
     * True when Plaud has rejected the stored token (connection row carries
     * an `invalidatedAt`). Seeds the reconnect banner on first paint; the
     * live sync result takes over once a sync runs. Server-supplied.
     */
    plaudNeedsReconnect: boolean;
    /** Recording to select on first paint (`/recordings?id=`). Server-supplied. */
    initialRecordingId?: string | null;
}

/**
 * Recordings composition root: the recording list, the detail pane (player +
 * transcription), and the command palette. Sync, uploads, transcribes, and the
 * global dialogs (shortcuts, onboarding) come from the app shell. Settings is
 * a page at `/settings`.
 *
 * State ownership is split:
 *  - selection / mobile master-detail toggle live here
 *  - sync, uploads, transcribes, and dialog flags -> AppShellProviders
 *    (read via useSyncStatus, useUploadStatus, useTranscribeStatus, useDialogs)
 *  - theme -> useTheme
 *  - list keys and ⌘K -> useListKeyboardNav
 *  - deletes stay here because they need access to currentRecording
 *    / visibleRecordings to pick the next selection.
 */
export function Workstation({
    recordings,
    transcriptions,
    initialSettings,
    plaudNeedsReconnect,
    initialRecordingId = null,
}: WorkstationProps) {
    const { push, refresh } = useRouter();
    const [currentRecording, setCurrentRecording] = useState<Recording | null>(
        () =>
            recordings.find((r) => r.id === initialRecordingId) ??
            (recordings.length > 0 ? recordings[0] : null),
    );
    const {
        paletteOpen,
        setPaletteOpen,
        shortcutsOpen,
        setShortcutsOpen,
        onboardingOpen,
        setPaletteAvailable,
    } = useDialogs();
    const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
    const [filenameOverrides, setFilenameOverrides] = useState<
        Map<string, string>
    >(() => new Map());
    // On <lg viewports the list and detail panes can't coexist -- we
    // toggle between them instead of stacking. Desktop ignores this
    // state entirely (both panes render via the grid). A preselected
    // recording opens on the detail pane.
    const [mobileView, setMobileView] = useState<"list" | "detail">(() =>
        recordings.some((r) => r.id === initialRecordingId) ? "detail" : "list",
    );

    const { theme, setTheme } = useTheme(initialSettings.theme);
    const listRef = useRef<RecordingListHandle>(null);

    // Filter out optimistically-hidden (deleted) rows.
    const visibleRecordings = useMemo(
        () =>
            applyFilenameOverrides(
                recordings.filter((r) => !hiddenIds.has(r.id)),
                filenameOverrides,
            ),
        [recordings, hiddenIds, filenameOverrides],
    );

    const currentTranscription = currentRecording
        ? transcriptions.get(currentRecording.id)
        : undefined;

    const selectedRecording = currentRecording
        ? (visibleRecordings.find((r) => r.id === currentRecording.id) ??
          currentRecording)
        : null;

    // Keep currentRecording in sync with the recordings prop (updated
    // after refresh()). If the previously-selected recording is no
    // longer present (e.g. just deleted), clear the selection.
    useEffect(() => {
        setCurrentRecording((prev) => {
            if (!prev) return prev;
            const updated = recordings.find((r) => r.id === prev.id);
            return updated ?? null;
        });
        // When server data comes back, clear any optimistic hides whose
        // rows no longer exist server-side (deletion confirmed).
        setHiddenIds((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            const ids = new Set(recordings.map((r) => r.id));
            for (const id of prev) {
                if (ids.has(id)) next.add(id); // still present -> keep hidden until confirmed
            }
            return next.size === prev.size ? prev : next;
        });
        setFilenameOverrides((prev) =>
            reconcileFilenameOverrides(recordings, prev),
        );
    }, [recordings]);

    // The auto-sync loop runs in the app shell; this reads its state.
    const { isAutoSyncing, lastSyncResult, manualSync } = useSyncStatus();

    const handleSync = useCallback(async () => {
        await manualSync();
    }, [manualSync]);

    // Prefer the live sync result once we have one; fall back to the
    // server-rendered flag on first paint (before any sync runs). A
    // change in `plaudNeedsReconnect` only happens when fresh server
    // truth arrives (e.g. a `router.refresh()` after another tab's sync
    // invalidated the token), so it always resets the override rather
    // than letting a stale client-side result keep masking it.
    const [reconnectOverride, setReconnectOverride] = useState<boolean | null>(
        null,
    );
    const prevPlaudNeedsReconnect = useRef(plaudNeedsReconnect);
    useEffect(() => {
        if (plaudNeedsReconnect !== prevPlaudNeedsReconnect.current) {
            prevPlaudNeedsReconnect.current = plaudNeedsReconnect;
            setReconnectOverride(null);
        }
    }, [plaudNeedsReconnect]);
    useEffect(() => {
        if (typeof lastSyncResult?.needsReconnect === "boolean") {
            setReconnectOverride(lastSyncResult.needsReconnect);
        }
    }, [lastSyncResult]);
    const showReconnect = reconnectOverride ?? plaudNeedsReconnect;

    const handleReconnected = useCallback(() => {
        refresh();
        manualSync();
    }, [refresh, manualSync]);

    // Uploads and transcribes run in the app shell; this reads their state.
    const { pendingUploads, triggerUpload } = useUploadStatus();
    const { inFlightActions, transcribeById } = useTranscribeStatus();

    const isCurrentTranscribing =
        currentRecording !== null &&
        inFlightActions.get(currentRecording.id) === "transcribing";

    const handleTranscribe = useCallback(async () => {
        if (!currentRecording) return;
        await transcribeById(currentRecording.id);
    }, [currentRecording, transcribeById]);

    const handleDelete = useCallback(
        async (recording: Recording) => {
            const id = recording.id;
            // Optimistic hide.
            setHiddenIds((prev) => new Set(prev).add(id));
            const wasCurrent = currentRecording?.id === id;
            if (wasCurrent) {
                const idx = visibleRecordings.findIndex((r) => r.id === id);
                const next =
                    visibleRecordings[idx + 1] ??
                    visibleRecordings[idx - 1] ??
                    null;
                setCurrentRecording(next);
            }
            try {
                const res = await fetch(`/api/recordings/${id}`, {
                    method: "DELETE",
                });
                if (!res.ok) throw new Error("Delete failed");
                toast.success("Recording deleted");
                refresh();
            } catch (err) {
                // Rollback
                setHiddenIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
                if (wasCurrent) setCurrentRecording(recording);
                throw err;
            }
        },
        [currentRecording, visibleRecordings, refresh],
    );

    const handleRenamed = useCallback(
        (filename: string) => {
            const id = currentRecording?.id;
            if (!id) return;
            setFilenameOverrides((prev) => new Map(prev).set(id, filename));
            refresh();
        },
        [currentRecording?.id, refresh],
    );

    // List keys and ⌘K. The shell owns `?` and `,`. Disabled while any modal
    // is open so the modal owns keyboard focus exclusively. The shortcuts
    // dialog itself uses these very keys to navigate its rows.
    useListKeyboardNav({
        onNext: () => listRef.current?.next(),
        onPrev: () => listRef.current?.prev(),
        onFocusSearch: () => listRef.current?.focusSearch(),
        onOpenPalette: () => setPaletteOpen(true),
        enabled: !onboardingOpen && !paletteOpen && !shortcutsOpen,
    });

    // The ⌘K button and shortcut appear only where this palette is mounted.
    useEffect(() => {
        setPaletteAvailable(true);
        return () => setPaletteAvailable(false);
    }, [setPaletteAvailable]);

    return (
        <>
            <div className="bg-background">
                <div className="container mx-auto max-w-7xl px-4 py-6">
                    <h1 className="sr-only">Recordings</h1>

                    <PlaudReconnectBanner
                        show={showReconnect}
                        onReconnected={handleReconnected}
                    />

                    {visibleRecordings.length === 0 &&
                    pendingUploads.length === 0 ? (
                        <WorkstationEmptyState
                            isSyncing={isAutoSyncing}
                            onSync={handleSync}
                            onUpload={triggerUpload}
                        />
                    ) : (
                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                            {/*
                              Mobile master/detail: on <lg, only one
                              pane renders at a time. `mobileView ===
                              "detail"` hides the list (via `hidden`)
                              while keeping its state mounted, so
                              scroll position, search query, and
                              selection survive the back-navigation.
                              The `lg:block` override brings the list
                              back on desktop where both panes coexist.
                            */}
                            <div
                                className={cn(
                                    "lg:col-span-1 lg:block",
                                    mobileView === "detail" && "hidden",
                                )}
                            >
                                <RecordingList
                                    ref={listRef}
                                    recordings={visibleRecordings}
                                    transcriptions={transcriptions}
                                    currentRecording={currentRecording}
                                    pendingUploads={pendingUploads}
                                    inFlightActions={inFlightActions}
                                    onSelect={(r) => {
                                        setCurrentRecording(r);
                                        // Tapping a row on mobile
                                        // reveals the detail pane.
                                        // Desktop ignores this state.
                                        setMobileView("detail");
                                    }}
                                    onDelete={handleDelete}
                                    onTranscribe={(recording) => {
                                        void transcribeById(recording.id);
                                    }}
                                    initialDateTimeFormat={
                                        initialSettings.dateTimeFormat
                                    }
                                    initialSortOrder={
                                        initialSettings.recordingListSortOrder
                                    }
                                    initialDensity={initialSettings.listDensity}
                                    initialChunkSize={
                                        initialSettings.itemsPerPage
                                    }
                                />
                            </div>

                            <WorkstationDetailPane
                                currentRecording={selectedRecording}
                                currentTranscription={currentTranscription}
                                isCurrentTranscribing={isCurrentTranscribing}
                                visibleRecordings={visibleRecordings}
                                onTranscribe={handleTranscribe}
                                onTranscribeComplete={refresh}
                                onSelectRecording={setCurrentRecording}
                                onRenamed={handleRenamed}
                                onBackToList={() => setMobileView("list")}
                                hiddenOnMobile={mobileView === "list"}
                                initialPlaybackSpeed={
                                    initialSettings.defaultPlaybackSpeed
                                }
                                initialVolume={initialSettings.defaultVolume}
                                initialAutoPlayNext={
                                    initialSettings.autoPlayNext
                                }
                                scrubberStyle={initialSettings.playerScrubber}
                            />
                        </div>
                    )}
                </div>
            </div>

            <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                recordings={visibleRecordings}
                transcriptions={transcriptions}
                currentRecording={currentRecording}
                inFlightActions={inFlightActions}
                currentTheme={theme}
                dateTimeFormat={initialSettings.dateTimeFormat}
                onSelectRecording={(r) => {
                    setCurrentRecording(r);
                    setMobileView("detail");
                }}
                onSync={handleSync}
                onUpload={triggerUpload}
                onOpenSettings={() => push("/settings")}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onSetTheme={setTheme}
                onTranscribeRecording={transcribeById}
            />
        </>
    );
}
