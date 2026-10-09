"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A boolean saved in localStorage, so a collapsed card stays collapsed on later
 * visits. The first render uses `defaultOpen`, then the saved value is read
 * after mount. When storage is unavailable the value lives in memory only.
 */
export function usePersistedToggle(key: string, defaultOpen = true) {
    const [open, setOpen] = useState(defaultOpen);

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(key);
            if (saved === "open" || saved === "closed") {
                setOpen(saved === "open");
            }
        } catch {}
    }, [key]);

    const toggle = useCallback(() => {
        const next = !open;
        setOpen(next);
        try {
            window.localStorage.setItem(key, next ? "open" : "closed");
        } catch {}
    }, [key, open]);

    return [open, toggle] as const;
}
