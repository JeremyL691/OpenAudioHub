"use client";

import { useRouter } from "next/navigation";
import {
    createContext,
    type ReactNode,
    useContext,
    useMemo,
    useState,
} from "react";
import { toast } from "sonner";
import { useAutoSync } from "@/hooks/use-auto-sync";
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

interface DialogState {
    paletteOpen: boolean;
    setPaletteOpen: (open: boolean) => void;
    shortcutsOpen: boolean;
    setShortcutsOpen: (open: boolean) => void;
    settingsOpen: boolean;
    setSettingsOpen: (open: boolean) => void;
    onboardingOpen: boolean;
    setOnboardingOpen: (open: boolean) => void;
}

const SyncContext = createContext<AutoSyncState | null>(null);
const UploadContext = createContext<UploadState | null>(null);
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

/** Sync status and the manual sync action. The auto-sync loop runs inside the provider. */
export function useSyncStatus(): AutoSyncState {
    return useRequiredContext(SyncContext, "useSyncStatus");
}

/** Upload queue state and the upload actions. */
export function useUploadStatus(): UploadState {
    return useRequiredContext(UploadContext, "useUploadStatus");
}

/** Open state for the palette, shortcuts, settings, and onboarding dialogs. */
export function useDialogs(): DialogState {
    return useRequiredContext(DialogContext, "useDialogs");
}

function SyncProvider({
    initialSettings,
    children,
}: {
    initialSettings: InitialSettings;
    children: ReactNode;
}) {
    const sync = useAutoSync({
        interval: initialSettings.syncInterval ?? SYNC_CONFIG.defaultInterval,
        minInterval: SYNC_CONFIG.minInterval,
        syncOnMount: initialSettings.syncOnMount,
        syncOnVisibilityChange: initialSettings.syncOnVisibilityChange,
        enabled: initialSettings.autoSyncEnabled,
        onSuccess: (newRecordings) => {
            if (initialSettings.syncNotifications !== false) {
                if (newRecordings > 0) {
                    toast.success(
                        `Synced ${newRecordings} new recording${newRecordings !== 1 ? "s" : ""}`,
                    );
                } else {
                    toast.success("Sync complete - no new recordings");
                }
            }
            if (initialSettings.browserNotifications) {
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

function DialogProvider({
    initialSettings,
    children,
}: {
    initialSettings: InitialSettings;
    children: ReactNode;
}) {
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Auto-opens on first paint when onboarding is incomplete. Non-dismissible
    // while `mandatory` is set by the dialog's owner.
    const [onboardingOpen, setOnboardingOpen] = useState(
        () => !initialSettings.onboardingCompleted,
    );

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
        }),
        [paletteOpen, shortcutsOpen, settingsOpen, onboardingOpen],
    );

    return (
        <DialogContext.Provider value={value}>
            {children}
        </DialogContext.Provider>
    );
}

/**
 * App-shell state: one sync loop, one upload queue, and one set of dialog
 * flags per mount. The dashboard page and the dev demo page mount it for now,
 * so lifetimes match the old in-Workstation hooks. T4.2 moves the mount point
 * to the (app) layout, where the sidebar and top bar can share it (D-134).
 * Nothing here changes what a sync, upload, or dialog does.
 */
export function AppShellProviders({
    initialSettings,
    children,
}: {
    initialSettings: InitialSettings;
    children: ReactNode;
}) {
    return (
        <SyncProvider initialSettings={initialSettings}>
            <UploadProvider>
                <DialogProvider initialSettings={initialSettings}>
                    {children}
                </DialogProvider>
            </UploadProvider>
        </SyncProvider>
    );
}
