// Formatting helpers. Numbers and dates follow the interface language unless a locale is passed.
import { intlLocale } from "./i18n";

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
    return value instanceof Date ? value : new Date(value);
}

/**
 * Long duration for lists and summaries, for example "1 h 35 min", "42 min" or "3 s".
 * Under one minute it reads in seconds, so a short clip never shows "0 min".
 */
export function formatDuration(totalSeconds: number, locale: string = intlLocale()): string {
    const nf = new Intl.NumberFormat(locale);
    const seconds = Math.max(0, totalSeconds);
    if (seconds < 59.5) return `${nf.format(Math.round(seconds))} s`;
    const minutes = Math.max(0, Math.round(seconds / 60));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours > 0) return `${nf.format(hours)} h ${nf.format(rest)} min`;
    return `${nf.format(rest)} min`;
}

/** Player clock, for example "3:05" or "1:02:05". Fractions are dropped. */
export function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const ss = String(seconds).padStart(2, "0");
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
    return `${minutes}:${ss}`;
}

/** File sizes in binary units, for example "3.40 MB". */
export function formatBytes(bytes: number, locale: string = intlLocale()): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Math.max(0, bytes);
    let unit = 0;
    // 1024-based with two decimals ("12.31 KB", "28.19 GB").
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = unit === 0 ? 0 : 2;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Absolute date, for example "Oct 16, 2026" in en-US. */
export function formatDate(value: DateInput, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }, locale: string = intlLocale()): string {
    return new Intl.DateTimeFormat(locale, options).format(toDate(value));
}

/** Absolute time, for example "9:41 AM". */
export function formatTime(value: DateInput, locale: string = intlLocale()): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(toDate(value));
}

/** Locale date and time, including seconds. */
export function formatDateTime(value: DateInput, locale: string = intlLocale()): string {
    return toDate(value).toLocaleString(locale);
}

/** Relative time, for example "5 minutes ago", "yesterday" or "in 2 hours". */
export function formatRelative(value: DateInput, now: Date = new Date(), locale: string = intlLocale()): string {
    const diffSeconds = (toDate(value).getTime() - now.getTime()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "long" });
    const abs = Math.abs(diffSeconds);
    if (abs < 60) return rtf.format(Math.round(diffSeconds), "second");
    if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), "hour");
    if (abs < 86400 * 30) return rtf.format(Math.round(diffSeconds / 86400), "day");
    return formatDate(value, { dateStyle: "medium" }, locale);
}
