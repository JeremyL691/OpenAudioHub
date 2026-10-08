"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
    useAppSettings,
    useDialogs,
    useSyncStatus,
} from "@/components/app-shell/providers";
import { ShortcutsDialog } from "@/components/dashboard/shortcuts-dialog";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { type Provider, SettingsDialog } from "@/components/settings-dialog";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";

const EMPTY_PROVIDERS: Provider[] = [];

/**
 * Dialogs that open from any page: settings, keyboard shortcuts, and
 * onboarding. Also owns the global `?` and `,` keys. The command palette stays
 * with the dashboard because it searches that page's recordings.
 */
export function AppDialogs() {
    const { refresh } = useRouter();
    const { settings } = useAppSettings();
    const { manualSync } = useSyncStatus();
    const {
        paletteOpen,
        settingsOpen,
        setSettingsOpen,
        shortcutsOpen,
        setShortcutsOpen,
        onboardingOpen,
        setOnboardingOpen,
    } = useDialogs();
    const [providers, setProviders] = useState<Provider[]>(EMPTY_PROVIDERS);

    // Settings dialog needs the provider list at open-time so the
    // Providers section seeds correctly. Fetching on open (rather
    // than on mount) avoids loading a list the user may never see.
    useEffect(() => {
        if (settingsOpen) {
            fetch("/api/settings/ai/providers")
                .then((res) => res.json())
                .then((data) => setProviders(data.providers || []))
                .catch(() => setProviders([]));
        }
    }, [settingsOpen]);

    // Disabled while any modal is open so the modal owns the keyboard.
    useListKeyboardNav({
        onOpenShortcuts: () => setShortcutsOpen(true),
        onOpenSettings: () => setSettingsOpen(true),
        enabled:
            !settingsOpen && !onboardingOpen && !paletteOpen && !shortcutsOpen,
    });

    const handleReconnected = useCallback(() => {
        refresh();
        manualSync();
    }, [refresh, manualSync]);

    return (
        <>
            <ShortcutsDialog
                open={shortcutsOpen}
                onOpenChange={setShortcutsOpen}
            />

            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                initialProviders={providers}
                onReRunOnboarding={() => {
                    setSettingsOpen(false);
                    setOnboardingOpen(true);
                }}
                onPlaudReconnected={handleReconnected}
            />

            <OnboardingDialog
                open={onboardingOpen}
                onOpenChange={setOnboardingOpen}
                onComplete={() => {
                    setOnboardingOpen(false);
                    refresh();
                }}
                mandatory={!settings.onboardingCompleted}
            />
        </>
    );
}
