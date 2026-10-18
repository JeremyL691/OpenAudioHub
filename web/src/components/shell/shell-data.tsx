import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import { notifyNewRecordings } from "@/lib/sync-notify";
import { api, errorMessage } from "@/lib/api";
import { listRecordings, RECORDINGS_CHANGED, sourceOf, type Recording } from "@/lib/recordings";
import { startUploads } from "@/components/recordings/uploads";
import { setTheme, type ThemeChoice } from "@/lib/theme";

/** GET /api/plaud/connection (spec/plaud.md). */
export interface PlaudConnection {
    connected: boolean;
    plaudEmail?: string | null;
    needsReconnect?: boolean;
}

/** The fields of GET /api/settings/user that the shell reads. */
export interface UserSettings {
    onboardingCompleted?: boolean;
    theme?: string;
    syncInterval?: number;
    autoSyncEnabled?: boolean;
    syncOnMount?: boolean;
    syncNotifications?: boolean;
    browserNotifications?: boolean;
    notificationSound?: boolean;
    [key: string]: unknown;
}

/** Answer of POST /api/plaud/sync. */
interface SyncResult {
    success: boolean;
    newRecordings: number;
    updatedRecordings: number;
    errors: string[];
    needsReconnect: boolean;
}

export type SyncStatus = "idle" | "syncing" | "ok" | "failed";

export interface SyncState {
    status: SyncStatus;
    /** Epoch milliseconds of the last successful sync in this session. */
    lastSyncAt: number | null;
    /** The reason the last sync failed. */
    error: string | null;
}

export interface ShellData {
    /** Null until the first load. */
    recordings: Recording[] | null;
    /** Null until the first load. */
    connection: PlaudConnection | null;
    /** Number of AI providers, or null when unknown. */
    providerCount: number | null;
    /** Null until the first load. */
    settings: UserSettings | null;
    sync: SyncState;
    syncNow(options?: { quiet?: boolean }): Promise<void>;
    /** Reloads recordings, connection, providers and settings. */
    reload(): Promise<void>;
    updateSettings(patch: Record<string, unknown>): Promise<void>;
    openUploadPicker(): void;
}

const ShellDataContext = createContext<ShellData | null>(null);

const ONE_MINUTE = 60_000;
const FIVE_MINUTES = 300_000;
const PROCESSING_POLL = 10_000;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the recording started in the last 7 × 24 hours. */
export function isRecent(recording: Recording, now: number = Date.now()): boolean {
    return now - Date.parse(recording.startTime) <= RECENT_WINDOW_MS;
}

/** Counts for the sidebar collections (spec/ui-library.md 1.12, spec/ui-app.md 1.3). */
export function collectionCounts(recordings: Recording[]): { starred: number; recent: number; plaud: number; uploaded: number } {
    const now = Date.now();
    const counts = { starred: 0, recent: 0, plaud: 0, uploaded: 0 };
    for (const recording of recordings) {
        if (recording.starredAt) counts.starred++;
        if (isRecent(recording, now)) counts.recent++;
        if (sourceOf(recording) === "plaud") counts.plaud++;
        else counts.uploaded++;
    }
    return counts;
}

function storedTheme(): string | null {
    try {
        return localStorage.getItem("theme");
    } catch {
        return null;
    }
}

/** Shared state for the shell and the Dashboard: recordings, Plaud connection and sync, providers, settings, uploads. */
export function ShellDataProvider({ children }: { children: ReactNode }) {
    const [recordings, setRecordings] = useState<Recording[] | null>(null);
    const [connection, setConnection] = useState<PlaudConnection | null>(null);
    const [providerCount, setProviderCount] = useState<number | null>(null);
    const [settings, setSettings] = useState<UserSettings | null>(null);
    const [sync, setSync] = useState<SyncState>({ status: "idle", lastSyncAt: null, error: null });
    const inputRef = useRef<HTMLInputElement>(null);
    const syncLock = useRef(false);
    // Read inside syncNow without making it change whenever settings load.
    const settingsRef = useRef<UserSettings | null>(null);
    settingsRef.current = settings;
    const mountSyncDone = useRef(false);
    const { pathname } = useLocation();

    const refreshRecordings = useCallback(async () => {
        try {
            setRecordings(await listRecordings());
        } catch {
            // Keep the last good list. The next change or poll tries again.
        }
    }, []);

    const refreshConnection = useCallback(async () => {
        try {
            setConnection(await api<PlaudConnection>("/api/plaud/connection"));
        } catch {
            setConnection({ connected: false });
        }
    }, []);

    const reload = useCallback(async () => {
        const [recs, providers, prefs] = await Promise.all([
            listRecordings().catch(() => null),
            api<{ providers: unknown[] }>("/api/settings/ai/providers").then(
                (body) => body.providers.length,
                () => null,
            ),
            api<UserSettings>("/api/settings/user").catch((): UserSettings => ({})),
        ]);
        if (recs) setRecordings(recs);
        setProviderCount(providers);
        setSettings(prefs);
        await refreshConnection();
    }, [refreshConnection]);

    // Reload on every route change, so Set up and counts follow the last change made elsewhere.
    useEffect(() => {
        void reload();
    }, [reload, pathname]);

    useEffect(() => {
        window.addEventListener(RECORDINGS_CHANGED, refreshRecordings);
        return () => window.removeEventListener(RECORDINGS_CHANGED, refreshRecordings);
    }, [refreshRecordings]);

    const processing = recordings?.some((r) => r.processing !== null) ?? false;
    useEffect(() => {
        if (!processing) return;
        // Announce the poll so every view of the list updates, not only this one. A finished
        // job clears `processing` and the interval stops.
        const id = window.setInterval(() => window.dispatchEvent(new Event(RECORDINGS_CHANGED)), PROCESSING_POLL);
        return () => window.clearInterval(id);
    }, [processing]);

    // Use the saved account theme only when this browser has no choice stored yet.
    useEffect(() => {
        const saved = settings?.theme;
        if (saved && storedTheme() === null && (saved === "light" || saved === "dark" || saved === "system")) {
            setTheme(saved as ThemeChoice);
        }
    }, [settings?.theme]);

    const syncNow = useCallback(
        async (options: { quiet?: boolean } = {}) => {
            if (syncLock.current) return;
            syncLock.current = true;
            setSync((s) => ({ ...s, status: "syncing" }));
            try {
                const result = await api<SyncResult>("/api/plaud/sync", { method: "POST" });
                const problem = result.errors?.[0] ?? null;
                const failed = !result.success || problem !== null;
                if (failed) {
                    const message = problem ?? "Sync failed";
                    setSync((s) => ({ status: "failed", lastSyncAt: s.lastSyncAt, error: message }));
                    if (!options.quiet) toast.error(`Sync failed: ${message}`);
                } else {
                    setSync({ status: "ok", lastSyncAt: Date.now(), error: null });
                    if (!options.quiet && result.newRecordings === 0) toast.success("Plaud is up to date");
                }
                if (!failed) notifyNewRecordings(result.newRecordings, settingsRef.current, !options.quiet);
                if (result.newRecordings > 0 || result.updatedRecordings > 0) void refreshRecordings();
            } catch (err) {
                const message = errorMessage(err, "Sync failed");
                setSync((s) => ({ status: "failed", lastSyncAt: s.lastSyncAt, error: message }));
                if (!options.quiet) toast.error(message);
            } finally {
                syncLock.current = false;
                void refreshConnection();
            }
        },
        [refreshConnection, refreshRecordings],
    );

    const connected = Boolean(connection?.connected && !connection.needsReconnect);

    // One sync when the shell first has the connection and the settings.
    useEffect(() => {
        if (mountSyncDone.current || !connection || !settings) return;
        mountSyncDone.current = true;
        if (connected && settings.syncOnMount !== false) void syncNow({ quiet: true });
    }, [connection, settings, connected, syncNow]);

    const autoSync = settings?.autoSyncEnabled !== false;
    const interval = Math.max(ONE_MINUTE, typeof settings?.syncInterval === "number" ? settings.syncInterval : FIVE_MINUTES);
    useEffect(() => {
        if (!connected || !autoSync) return;
        const id = window.setInterval(() => {
            if (!document.hidden) void syncNow({ quiet: true });
        }, interval);
        return () => window.clearInterval(id);
    }, [connected, autoSync, interval, syncNow]);

    const updateSettings = useCallback(async (patch: Record<string, unknown>) => {
        await api("/api/settings/user", { method: "PUT", json: patch });
        setSettings((s) => ({ ...(s ?? {}), ...patch }));
    }, []);

    const openUploadPicker = useCallback(() => inputRef.current?.click(), []);

    const value: ShellData = {
        recordings,
        connection,
        providerCount,
        settings,
        sync,
        syncNow,
        reload,
        updateSettings,
        openUploadPicker,
    };

    return (
        <ShellDataContext value={value}>
            {children}
            <input
                ref={inputRef}
                type="file"
                accept="audio/*,.mp3,.mp4,.m4a,.wav,.ogg,.opus,.webm,.aac,.flac"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="sr-only"
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length > 0) startUploads(files);
                }}
            />
        </ShellDataContext>
    );
}

/** The shared shell state. Only call it inside the shell. */
export function useShellData(): ShellData {
    const value = useContext(ShellDataContext);
    if (!value) throw new Error("useShellData must be used inside the shell");
    return value;
}
