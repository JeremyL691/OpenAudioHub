"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { useAppSettings, useDialogs } from "@/components/app-shell/providers";
import { ShortcutsDialog } from "@/components/dashboard/shortcuts-dialog";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";

/**
 * Dialogs that open from any page: keyboard shortcuts and onboarding. Also owns
 * the global `?` and `,` keys. Settings is a page now, so `,` navigates to it.
 * The command palette stays with the dashboard because it searches that page's
 * recordings.
 */
export function AppDialogs() {
    const { push, refresh } = useRouter();
    const pathname = usePathname();
    const { settings } = useAppSettings();
    const {
        paletteOpen,
        shortcutsOpen,
        setShortcutsOpen,
        onboardingOpen,
        setOnboardingOpen,
    } = useDialogs();

    const openSettings = useCallback(() => {
        if (!pathname.startsWith("/settings")) push("/settings");
    }, [pathname, push]);

    // Disabled while any modal is open so the modal owns the keyboard.
    useListKeyboardNav({
        onOpenShortcuts: () => setShortcutsOpen(true),
        onOpenSettings: openSettings,
        enabled: !onboardingOpen && !paletteOpen && !shortcutsOpen,
    });

    return (
        <>
            <ShortcutsDialog
                open={shortcutsOpen}
                onOpenChange={setShortcutsOpen}
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
