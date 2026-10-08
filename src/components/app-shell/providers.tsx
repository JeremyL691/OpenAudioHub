"use client";

import { usePathname, useRouter } from "next/navigation";
import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { toast } from "sonner";
import { useAutoSync } from "@/hooks/use-auto-sync";
import { useTranscribeQueue } from "@/hooks/use-transcribe-queue";
import { useUploadQueue } from "@/hooks/use-upload-queue";
import {
    requestNotificationPermission,
    showNewRecordingNotification,
    showSyncCompleteNotification,
} from "@/lib/notifications/browser";
import type { InitialSettings } from "@/lib/settings/initial-settings";
import { SYNC_CONFIG } from "@/lib/sync-config";

type AutoSyncState = ReturnType<typeof useAutoSync>;
type UploadState = ReturnType<typeof useUploadQueue>;
type TranscribeState = ReturnType<typeof useTranscribeQueue>;

interface SettingsState {
    settings: InitialSettings;
    setSettings: (next: InitialSettings) => void;
}

interface DialogState {
    paletteOpen: boolean;
    setPaletteOpen: (open: boolean) => void;
    shortcutsOpen: boolean;
    setShortcutsOpen: (open: boolean) => void;
    settingsOpen: boolean;
    setSettingsOpen: (open: boolean) => void;
    onboardingOpen: boolean;
    setOnboardingOpen: (open: boolean) => void;
    /** True while a page that owns a command palette is mounted. */
    paletteAvailable: boolean;
    setPaletteAvailable: (available: boolean) => void;
}

const SettingsContext = createContext<SettingsState | null>(null);
const SyncContext = createContext<AutoSyncState | null>(null);
const UploadContext = createContext<UploadState | null>(null);
const TranscribeContext = createContext<TranscribeState | null>(null);
const DialogContext = createContext<DialogState | null>(null);

function useRequiredContext<T>(
    context: React.Context<T | null>,
    name: string,
): T {
    const value = useContext(context);
    if (value === null) {
        throw new Error(`${name} must be used inside AppShellProviders`);
    }
    return value;
}

/** Saved settings as the app shell sees them. Refreshed on every navigation (see AppSettingsSync). */
export function useAppSettings(): SettingsState {
    return useRequiredContext(SettingsContext, "useAppSettings");
}

/** Sync status and the manual sync action. The auto-sync loop runs inside the provider. */
export function useSyncStatus(): AutoSyncState {
    return useRequiredContext(SyncContext, "useSyncStatus");
}

/** Upload queue state and the upload actions. */
export function useUploadStatus(): UploadState {
    return useRequiredContext(UploadContext, "useUploadStatus");
}

/** Per-recording transcribe state and the transcribe action. */
export function useTranscribeStatus(): TranscribeState {
    return useRequiredContext(TranscribeContext, "useTranscribeStatus");
}

/** Open state for the palette, shortcuts, settings, and onboarding dialogs. */
export function useDialogs(): DialogState {
    return useRequiredContext(DialogContext, "useDialogs");
}

function sameSettings(a: InitialSettings, b: InitialSettings): boolean {
    return (Object.keys(a) as (keyof InitialSettings)[]).every(
        (key) => a[key] === b[key],
    );
}

function SettingsStateProvider({
    initialSettings,
    children,
}: {
    initialSettings: InitialSettings;
    children: ReactNode;
}) {
    const [settings, setSettingsState] = useState(initialSettings);
    // Keep the previous object when nothing changed, so a navigation that
    // finds the same settings does not re-render the whole shell.
    const setSettings = useCallback((next: InitialSettings) => {
        setSettingsState((prev) => (sameSettings(prev, next) ? prev : next));
    }, []);
    const value = useMemo<SettingsState>(
        () => ({ settings, setSettings }),
        [settings, setSettings],
    );
    return (
        <SettingsContext.Provider value={value}>
            {children}
        </SettingsContext.Provider>
    );
}

/**
 * Pushes the server's saved settings into the shell. The (app) template
 * renders this on every navigation, but the layout does not re-render on
 * navigation. Without it, a change saved on /settings would not reach the
 * sync loop until a full page load.
 */
export function AppSettingsSync({ settings }: { settings: InitialSettings }) {
    const { setSettings } = useAppSettings();
    useEffect(() => {
        setSettings(settings);
    }, [settings, setSettings]);
    return null;
}

function SyncProvider({ children }: { children: ReactNode }) {
    const { settings } = useAppSettings();
    const sync = useAutoSync({
        interval: settings.syncInterval ?? SYNC_CONFIG.defaultInterval,
        minInterval: SYNC_CONFIG.minInterval,
        syncOnMount: settings.syncOnMount,
        syncOnVisibilityChange: settings.syncOnVisibilityChange,
        enabled: settings.autoSyncEnabled,
        onSuccess: (newRecordings) => {
            if (settings.syncNotifications !== false) {
                if (newRecordings > 0) {
                    toast.success(
                        `Synced ${newRecordings} new recording${newRecordings !== 1 ? "s" : ""}`,
                    );
                } else {
                    toast.success("Sync complete - no new recordings");
                }
            }
            if (settings.browserNotifications) {
                (async () => {
                    const granted = await requestNotificationPermission();
                    if (!granted) return;
                    if (newRecordings > 0) {
                        showNewRecordingNotification(newRecordings);
                    } else {
                        showSyncCompleteNotification();
                    }
                })();
            }
        },
        onError: (error) => {
            toast.error(error);
        },
    });

    return <SyncContext.Provider value={sync}>{children}</SyncContext.Provider>;
}

function UploadProvider({ children }: { children: ReactNode }) {
    const { refresh } = useRouter();
    const uploads = useUploadQueue({ onUploadComplete: refresh });
    return (
        <UploadContext.Provider value={uploads}>
            {children}
        </UploadContext.Provider>
    );
}

function TranscribeProvider({ children }: { children: ReactNode }) {
    const { refresh } = useRouter();
    const transcribe = useTranscribeQueue({ onTranscribeComplete: refresh });
    return (
        <TranscribeContext.Provider value={transcribe}>
            {children}
        </TranscribeContext.Provider>
    );
}

function DialogProvider({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { settings } = useAppSettings();
    const onboardingRequired = !settings.onboardingCompleted;
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Auto-opens on first paint when onboarding is incomplete. Non-dismissible
    // while `mandatory` is set by the dialog's owner.
    const [onboardingOpen, setOnboardingOpen] = useState(
        () => !settings.onboardingCompleted,
    );
    const [paletteAvailable, setPaletteAvailable] = useState(false);

    // These flags used to live in the dashboard, so leaving it reset them.
    // The shell stays mounted across pages, so reset them on route change.
    // Adjusting state during render (React's documented pattern) keeps the
    // reset in the same render as the navigation, with no stale frame.
    const [seenPath, setSeenPath] = useState(pathname);
    if (seenPath !== pathname) {
        setSeenPath(pathname);
        setPaletteOpen(false);
        setShortcutsOpen(false);
        setSettingsOpen(false);
        setOnboardingOpen(onboardingRequired);
    }
    const [seenRequired, setSeenRequired] = useState(onboardingRequired);
    if (seenRequired !== onboardingRequired) {
        setSeenRequired(onboardingRequired);
        setOnboardingOpen(onboardingRequired);
    }

    const value = useMemo<DialogState>(
        () => ({
            paletteOpen,
            setPaletteOpen,
            shortcutsOpen,
            setShortcutsOpen,
            settingsOpen,
            setSettingsOpen,
            onboardingOpen,
            setOnboardingOpen,
            paletteAvailable,
            setPaletteAvailable,
        }),
        [
            paletteOpen,
            shortcutsOpen,
            settingsOpen,
            onboardingOpen,
            paletteAvailable,
        ],
    );

    return (
        <DialogContext.Provider value={value}>
            {children}
        </DialogContext.Provider>
    );
}

/**
 * App-shell state, mounted by the (app) layout: the saved settings, one sync
 * loop, one upload queue, one transcribe queue, and the open flags for the
 * global dialogs. Pages read these through the hooks above. Nothing here
 * changes what a sync, upload, transcribe, or dialog does.
 */
export function AppShellProviders({
    initialSettings,
    children,
}: {
    initialSettings: InitialSettings;
    children: ReactNode;
}) {
    return (
        <SettingsStateProvider initialSettings={initialSettings}>
            <SyncProvider>
                <UploadProvider>
                    <TranscribeProvider>
                        <DialogProvider>{children}</DialogProvider>
                    </TranscribeProvider>
                </UploadProvider>
            </SyncProvider>
        </SettingsStateProvider>
    );
}
