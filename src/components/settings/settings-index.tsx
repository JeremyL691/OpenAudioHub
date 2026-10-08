"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
    isSettingsSection,
    SETTINGS_STORAGE_KEY,
} from "@/components/settings-nav-config";

const DEFAULT_SECTION = "providers";

function readLastSection(): string | null {
    try {
        return localStorage.getItem(SETTINGS_STORAGE_KEY);
    } catch {
        return null;
    }
}

/**
 * `/settings` has no page of its own. It forwards to one section: the section
 * named in the URL hash (emails sent before T5.8 use `/settings#notifications`), else the
 * one the viewer opened last, else Providers.
 */
export function SettingsIndex() {
    const { replace } = useRouter();

    useEffect(() => {
        const fromHash = window.location.hash.slice(1);
        const lastSection = readLastSection();
        let target = DEFAULT_SECTION;
        if (isSettingsSection(fromHash)) {
            target = fromHash;
        } else if (isSettingsSection(lastSection)) {
            target = lastSection;
        }
        replace(`/settings/${target}`);
    }, [replace]);

    return null;
}
