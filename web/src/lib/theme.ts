import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

const darkQuery: MediaQueryList | null =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;

const listeners = new Set<() => void>();
let listening = false;

/** The saved choice, or "system" when nothing valid is stored. index.html applies it before first paint. */
export function getTheme(): ThemeChoice {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && (CHOICES as readonly string[]).includes(saved)) return saved as ThemeChoice;
    } catch {
        // Storage can be blocked. Fall back to following the system.
    }
    return "system";
}

function applyTheme(choice: ThemeChoice): void {
    const dark = choice === "dark" || (choice === "system" && Boolean(darkQuery?.matches));
    document.documentElement.classList.toggle("dark", dark);
}

/** Starts following the system setting. Safe to call more than once. */
export function initTheme(): void {
    applyTheme(getTheme());
    if (listening || !darkQuery) return;
    listening = true;
    darkQuery.addEventListener("change", () => {
        if (getTheme() === "system") applyTheme("system");
    });
}

/** Saves the choice in this browser and applies it at once. */
export function setTheme(choice: ThemeChoice): void {
    try {
        localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        // Storage can be blocked. The choice still applies for this page.
    }
    applyTheme(choice);
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The current choice and a setter. Components re-render when it changes. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
    const choice = useSyncExternalStore(subscribe, getTheme, () => "system" as ThemeChoice);
    initTheme();
    return [choice, setTheme];
}
