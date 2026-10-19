import { useSyncExternalStore } from "react";
import { catalogs, type MessageKey } from "@/locales/catalogs";

export type { MessageKey };

export type Locale = "en" | "zh-CN" | "ja" | "ko";

/** The interface languages, each shown in its own language in the picker. */
export const LOCALES: { value: Locale; label: string }[] = [
    { value: "en", label: "English" },
    { value: "zh-CN", label: "简体中文" },
    { value: "ja", label: "日本語" },
    { value: "ko", label: "한국어" },
];

const STORAGE_KEY = "locale";
const VALUES: readonly string[] = LOCALES.map((l) => l.value);

type FlatCatalog = Record<string, string>;

/** Flattens `{ a: { b: "x" } }` into `{ "a.b": "x" }`. */
function flatten(source: Record<string, unknown>, prefix = "", into: FlatCatalog = {}): FlatCatalog {
    for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object") flatten(value as Record<string, unknown>, path, into);
        else if (typeof value === "string") into[path] = value;
    }
    return into;
}

const flat: Record<Locale, FlatCatalog> = {
    en: flatten(catalogs.en),
    "zh-CN": flatten(catalogs["zh-CN"]),
    ja: flatten(catalogs.ja),
    ko: flatten(catalogs.ko),
};

/** A language tag maps to the closest language this build speaks, or null when it speaks none. */
export function matchLocale(tag: string): Locale | null {
    const lower = tag.toLowerCase();
    if (lower === "zh" || lower.startsWith("zh-")) {
        // Traditional Chinese falls back to Simplified Chinese until it has its own catalog.
        return "zh-CN";
    }
    if (lower === "ja" || lower.startsWith("ja-")) return "ja";
    if (lower === "ko" || lower.startsWith("ko-")) return "ko";
    if (lower === "en" || lower.startsWith("en-")) return "en";
    return null;
}

function isLocale(value: string): value is Locale {
    return VALUES.includes(value);
}

/** The language the desktop shell saved, handed to the page by its initialization script. */
function bridgeLocale(): string | null {
    const bridge = (window as unknown as { __openaudiohubDesktop?: { initialLocale?: unknown } }).__openaudiohubDesktop;
    const value = bridge?.initialLocale;
    return typeof value === "string" ? value : null;
}

/** The saved choice, else the desktop shell's, else the browser's languages, else English. */
export function detectLocale(): Locale {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && isLocale(saved)) return saved;
    } catch {
        // Storage can be blocked. The browser's languages are used instead.
    }
    const fromShell = bridgeLocale();
    if (fromShell) {
        if (isLocale(fromShell)) return fromShell;
        const matched = matchLocale(fromShell);
        if (matched) return matched;
    }
    const languages = typeof navigator !== "undefined" && Array.isArray(navigator.languages) ? navigator.languages : [];
    for (const tag of [...languages, typeof navigator !== "undefined" ? navigator.language : ""]) {
        if (!tag) continue;
        const matched = matchLocale(tag);
        if (matched) return matched;
    }
    return "en";
}

let current: Locale | null = null;
const listeners = new Set<() => void>();
let followingShell = false;

/** Applies a language chosen in the desktop shell's menu, without writing it back there. */
function followShellChoice(): void {
    if (followingShell) return;
    followingShell = true;
    const bridge = (window as unknown as {
        __openaudiohubDesktop?: { onLocaleChange?: (listener: (locale: string) => void) => (() => void) | void };
    }).__openaudiohubDesktop;
    try {
        bridge?.onLocaleChange?.((tag) => {
            const matched = matchLocale(tag);
            if (matched) adoptLocale(matched);
        });
    } catch {
        // A shell that cannot deliver the event leaves the page on its own choice.
    }
}

/** The language in use. Read once from storage and the browser, then kept in memory. */
export function getLocale(): Locale {
    if (current === null) {
        current = detectLocale();
        applyDocumentLanguage(current);
        followShellChoice();
    }
    return current;
}

function applyDocumentLanguage(locale: Locale): void {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
}

/** Saves the choice in this browser and applies it at once. */
export function setLocale(locale: Locale): void {
    current = locale;
    try {
        localStorage.setItem(STORAGE_KEY, locale);
    } catch {
        // Storage can be blocked. The choice still applies for this page.
    }
    applyDocumentLanguage(locale);
    listeners.forEach((listener) => listener());
}

/** Applies a choice made in the desktop shell's own menu, without writing it back there. */
export function adoptLocale(locale: Locale): void {
    current = locale;
    try {
        localStorage.setItem(STORAGE_KEY, locale);
    } catch {
        // Storage can be blocked. The choice still applies for this page.
    }
    applyDocumentLanguage(locale);
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function lookup(locale: Locale, key: string): string | undefined {
    return flat[locale][key] ?? flat.en[key];
}

/** Replaces `{name}` placeholders. A missing value leaves the placeholder as written. */
export function interpolate(text: string, params?: Record<string, string | number>): string {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The text for a key in the current language, falling back to English, then to the key itself. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
    return interpolate(lookup(getLocale(), key) ?? key, params);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * A message with a plural form. `base` names a group whose keys end in the
 * `Intl.PluralRules` categories (`base.one`, `base.other`, or `base.zero` and so on).
 */
export function tn(base: string, count: number, params?: Record<string, string | number>): string {
    const locale = getLocale();
    let rules = pluralRules.get(locale);
    if (!rules) {
        rules = new Intl.PluralRules(locale);
        pluralRules.set(locale, rules);
    }
    const category = rules.select(count);
    const text =
        flat[locale][`${base}.${category}`] ??
        flat.en[`${base}.${category}`] ??
        flat[locale][`${base}.other`] ??
        flat.en[`${base}.other`] ??
        base;
    return interpolate(text, { count, ...params });
}

/** The tag Intl uses for dates and numbers: the interface language. */
export function intlLocale(): string {
    return getLocale();
}

export interface I18n {
    locale: Locale;
    t: (key: MessageKey, params?: Record<string, string | number>) => string;
    tn: (base: string, count: number, params?: Record<string, string | number>) => string;
    setLocale: (locale: Locale) => void;
    intlLocale: string;
}

/** The current language and its helpers. Components re-render when the language changes. */
export function useI18n(): I18n {
    const locale = useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
    return { locale, t, tn, setLocale, intlLocale: locale };
}
