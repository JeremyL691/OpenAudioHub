"use client";

import { useEffect } from "react";

interface ShortcutHandlers {
    onNext?: () => void;
    onPrev?: () => void;
    onFocusSearch?: () => void;
    onOpenPalette?: () => void;
    onOpenShortcuts?: () => void;
    onOpenSettings?: () => void;
    /** When false, j/k/Enter/etc. are ignored (e.g. a modal is open). */
    enabled?: boolean;
}

function isInputTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
}

/**
 * Keyboard shortcuts. Each mount listens only for the keys whose handlers it
 * passes: the app shell owns `?` and `,`, and the dashboard owns list
 * navigation, `/`, and ⌘K. The player owns its own Space/← /→/↑/↓ handlers;
 * we deliberately don't overlap them here.
 */
export function useListKeyboardNav({
    onNext,
    onPrev,
    onFocusSearch,
    onOpenPalette,
    onOpenShortcuts,
    onOpenSettings,
    enabled = true,
}: ShortcutHandlers) {
    useEffect(() => {
        if (!enabled) return;
        const handler = (e: KeyboardEvent) => {
            // ⌘K / Ctrl+K always opens the palette, even when an input
            // has focus — matches Linear / Raycast convention.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                if (onOpenPalette) {
                    e.preventDefault();
                    onOpenPalette();
                }
                return;
            }

            if (isInputTarget(e.target)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            const actions: Record<string, (() => void) | undefined> = {
                j: onNext,
                k: onPrev,
                "/": onFocusSearch,
                "?": onOpenShortcuts,
                ",": onOpenSettings,
            };
            const action = actions[e.key];
            if (!action) return;
            e.preventDefault();
            action();
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        enabled,
        onNext,
        onPrev,
        onFocusSearch,
        onOpenPalette,
        onOpenShortcuts,
        onOpenSettings,
    ]);
}
