import { recordingStage, RECORDING_STAGE_LABELS, type RecordingStage } from "@/components/recording/pipeline-labels";
import { formatDate, formatDuration, formatTime } from "@/lib/format";
import { sourceOf, type Recording } from "@/lib/recordings";
import { t, tn, type MessageKey } from "@/lib/i18n";

// Pure helpers for the library list: parsing URL and settings values, filtering,
// sorting, day grouping and labels. No React here.

export type Collection = "starred" | "recent" | "plaud" | "uploaded";
export type StatusFilter = "all" | "transcribed" | "processing" | "untranscribed";
export type SortOrder = "newest" | "oldest" | "name";
export type Density = "comfortable" | "compact";

/** The collection labels, as translation keys resolved when read. */
export const COLLECTION_LABELS: Record<Collection, string> = {
    starred: "library.collections.starred",
    recent: "library.collections.recent",
    plaud: "library.collections.plaud",
    uploaded: "library.collections.uploaded",
};

/** The collection name in the current language. */
export function collectionLabel(collection: Collection): string {
    return t(COLLECTION_LABELS[collection] as MessageKey);
}

export const STATUS_FILTERS: { value: StatusFilter; labelKey: MessageKey }[] = [
    { value: "all", labelKey: "library.filterAll" },
    { value: "transcribed", labelKey: "library.filterTranscribed" },
    { value: "processing", labelKey: "library.filterProcessing" },
    { value: "untranscribed", labelKey: "library.filterUntranscribed" },
];

const COLLECTION_KEYS = Object.keys(COLLECTION_LABELS) as Collection[];
const SEARCH_LIMIT = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function parseCollection(value: string | null): Collection | null {
    return COLLECTION_KEYS.find((key) => key === value) ?? null;
}

export function parseFilter(value: string | null): StatusFilter {
    return value === "transcribed" || value === "processing" || value === "untranscribed" ? value : "all";
}

export function parseSort(value: unknown): SortOrder {
    return value === "oldest" || value === "name" ? value : "newest";
}

export function parseDensity(value: unknown): Density {
    return value === "compact" ? "compact" : "comfortable";
}

export function parsePageSize(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 50;
}

/** A seeded search from ?q=. Longer than 200 characters is ignored. */
export function seedQuery(raw: string | null): string {
    return raw !== null && raw.length <= SEARCH_LIMIT ? raw : "";
}

export function inCollection(r: Recording, collection: Collection | null, nowMs: number): boolean {
    switch (collection) {
        case null:
            return true;
        case "starred":
            return r.starredAt !== null;
        case "recent":
            return Date.parse(r.startTime) >= nowMs - WEEK_MS;
        case "plaud":
            return sourceOf(r) === "plaud";
        case "uploaded":
            return sourceOf(r) === "upload";
    }
}

export function matchesStatus(r: Recording, filter: StatusFilter): boolean {
    switch (filter) {
        case "all":
            return true;
        case "transcribed":
            return r.hasTranscript;
        case "processing":
            return r.processing !== null;
        case "untranscribed":
            return !r.hasTranscript;
    }
}

/** Cache key for a transcript text. Changing the recording (for example a new transcript) refreshes it. */
export function textKey(r: Recording): string {
    return `${r.id}:${r.updatedAt}`;
}

/** `needle` must already be trimmed and lower case. */
export function matchesQuery(r: Recording, needle: string, texts: Record<string, string>): boolean {
    if (!needle) return true;
    if (r.filename.toLowerCase().includes(needle)) return true;
    return (texts[textKey(r)] ?? "").toLowerCase().includes(needle);
}

export function sortRecordings(list: Recording[], order: SortOrder): Recording[] {
    const copy = [...list];
    if (order === "name") return copy.sort((a, b) => a.filename.localeCompare(b.filename));
    const direction = order === "oldest" ? 1 : -1;
    return copy.sort((a, b) => direction * (Date.parse(a.startTime) - Date.parse(b.startTime)));
}

export interface RowGroup {
    key: string;
    /** Day label. Empty when the list is not grouped by day. */
    label: string;
    rows: Recording[];
    totalMs: number;
}

/** Groups already-sorted rows by local day. Name order is one group with no heading. */
export function groupRows(list: Recording[], order: SortOrder, now: Date): RowGroup[] {
    if (order === "name") {
        return list.length === 0 ? [] : [{ key: "all", label: "", rows: list, totalMs: sum(list) }];
    }
    const groups: RowGroup[] = [];
    const byKey = new Map<string, RowGroup>();
    for (const r of list) {
        const day = new Date(r.startTime);
        const key = localDayKey(day);
        let group = byKey.get(key);
        if (!group) {
            group = { key, label: dayLabel(day, now), rows: [], totalMs: 0 };
            byKey.set(key, group);
            groups.push(group);
        }
        group.rows.push(r);
        group.totalMs += r.duration;
    }
    return groups;
}

function sum(list: Recording[]): number {
    return list.reduce((total, r) => total + r.duration, 0);
}

function localDayKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(d: Date, now: Date): string {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const key = localDayKey(d);
    if (key === localDayKey(today)) return t("library.today");
    if (key === localDayKey(yesterday)) return t("library.yesterday");
    return formatDate(d, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
}

/** Short clip length for rows, for example "3 s" or "42 min". */
export function formatClipDuration(ms: number): string {
    const seconds = Math.max(0, ms / 1000);
    if (seconds < 60) return `${Math.round(seconds)} s`;
    return formatDuration(seconds);
}

export function sourceLabel(r: Recording): string {
    return sourceOf(r) === "plaud" ? t("dashboard.sourcePlaud") : t("dashboard.sourceUpload");
}

export interface RowStatus {
    stage: RecordingStage;
    label: string;
}

export function statusOf(r: Recording): RowStatus {
    const stage = recordingStage(r);
    return { stage, label: t(RECORDING_STAGE_LABELS[stage]) };
}

/** Relative time in the row's meta line, for example "less than a minute ago" or "12 minutes ago". */
export function formatAgo(value: string, now: number = Date.now()): string {
    const time = Date.parse(value);
    if (Number.isNaN(time)) return "";
    const seconds = Math.max(0, (now - time) / 1000);
    if (seconds < 60) return t("library.lessThanMinute");
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return tn("library.minutesAgo", minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return tn("library.hoursAgo", hours);
    const days = Math.floor(hours / 24);
    if (days < 30) return tn("library.daysAgo", days);
    return formatDate(value, { dateStyle: "medium" });
}

/** The row's full accessible name: name, starred, date, duration, source and status. */
export function rowLabel(r: Recording): string {
    const status = statusOf(r);
    const when = `${formatDate(r.startTime, { month: "short", day: "numeric", year: "numeric" })}, ${formatTime(r.startTime)}`;
    return [r.filename, r.starredAt ? t("library.starred") : null, `${formatClipDuration(r.duration)}`, when, sourceLabel(r), status.label]
        .filter(Boolean)
        .join(", ");
}

/** "3 of 3 recordings" in the list header, or "1 matching of 3 recordings" while a search or filter narrows it. */
export function countLabel(shown: number, total: number, narrowed = false): string {
    return tn(narrowed ? "library.countMatching" : "library.countOf", total, { shown });
}

/** Day heading summary, for example "3 recordings · 0 min" or "2 recordings · 1 h 5 min". Whole minutes, rounded down. */
export function groupSummary(count: number, totalMs: number): string {
    const minutes = Math.floor(totalMs / 60000);
    const hours = Math.floor(minutes / 60);
    const span = hours > 0 ? t("common.duration.hours", { hours, minutes: minutes % 60 }) : t("common.duration.minutes", { value: minutes });
    return `${tn("library.groupRecordings", count, { count })} · ${span}`;
}
