"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useDialogs } from "@/components/app-shell/providers";

/**
 * /settings is still a dialog page: it opens the settings dialog, which the
 * app shell mounts, and returns to the dashboard when that dialog closes.
 * T4.3 replaces it with a full settings page. Only one settings dialog exists,
 * so the top-bar Settings item and the `,` key behave the same here.
 */
export function SettingsPageContent() {
    const { push } = useRouter();
    const { settingsOpen, setSettingsOpen } = useDialogs();
    const wasOpen = useRef(false);

    useEffect(() => {
        setSettingsOpen(true);
    }, [setSettingsOpen]);

    useEffect(() => {
        if (settingsOpen) {
            wasOpen.current = true;
        } else if (wasOpen.current) {
            push("/dashboard");
        }
    }, [settingsOpen, push]);

    return null;
}
