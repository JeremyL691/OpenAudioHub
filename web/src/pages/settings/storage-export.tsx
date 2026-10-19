import { useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { downloadText } from "@/components/recording/exports";
import { Loading, NumberField, SettingSelect, useSettings, type SettingsPatch, type UserSettings } from "./shared";
import { t, useI18n } from "@/lib/i18n";
import { desktopBridge } from "./desktop";

// ---------- shared pieces ----------

/** A row in an undivided list: the label and hint on the left, the control on the right. */
function PlainRow({
    htmlFor,
    label,
    hint,
    badge,
    children,
}: {
    htmlFor?: string;
    label: ReactNode;
    hint?: ReactNode;
    badge?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-11 items-center justify-between gap-4 py-2.5">
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                    {htmlFor ? (
                        <label htmlFor={htmlFor} className="text-[13px] font-medium">
                            {label}
                        </label>
                    ) : (
                        <span className="text-[13px] font-medium">{label}</span>
                    )}
                    {badge}
                </div>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <div className="flex max-w-full shrink-0 items-center gap-2">{children}</div>
        </div>
    );
}

function ComingSoon() {
    const { t } = useI18n();
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t("settings.export.comingSoon")}</span>;
}

// ---------- storage ----------

interface StorageUsage {
    storageType: "local" | "s3";
    usedBytes: number;
    recordingCount: number;
    totalDurationMs: number;
    largest: { id: string; filename: string; filesize: number; duration: number; startTime: string }[];
    diskFreeBytes: number | null;
    quotaBytes: number | null;
}

/** The share of the disk (or quota) the recordings use, as a whole percentage. */
function usedPercent(usage: StorageUsage): number {
    const total = usage.quotaBytes ?? (usage.diskFreeBytes !== null ? usage.usedBytes + usage.diskFreeBytes : null);
    if (!total) return 0;
    return Math.min(100, Math.round((usage.usedBytes / total) * 100));
}

/** Ring that shows the used share. */
function UsageRing({ percent, label }: { percent: number; label: ReactNode }) {
    const radius = 52;
    const circumference = 2 * Math.PI * radius;
    const dash = (Math.max(0, Math.min(100, percent)) / 100) * circumference;
    return (
        <div className="relative size-32 shrink-0">
            <svg viewBox="0 0 128 128" className="size-full -rotate-90" aria-hidden="true">
                <circle cx="64" cy="64" r={radius} fill="none" strokeWidth="10" className="stroke-muted" />
                <circle
                    cx="64"
                    cy="64"
                    r={radius}
                    fill="none"
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${circumference}`}
                    className="stroke-primary"
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">{label}</div>
        </div>
    );
}

export function StorageSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);

    useEffect(() => {
        api<StorageUsage>("/api/settings/storage")
            .then(setUsage)
            .catch((err: unknown) => setLoadError(err));
    }, []);

    const toggleAutoDelete = (next: boolean) => {
        const patch: SettingsPatch = { autoDeleteRecordings: next, retentionDays: next ? settings.retentionDays : null };
        void save(patch);
    };

    const top3 = usage ? usage.largest.slice(0, 3) : [];
    const top3Bytes = top3.reduce((sum, r) => sum + r.filesize, 0);
    const segmentColors = ["bg-primary/40", "bg-primary/70", "bg-primary"];

    return (
        <div className="grid gap-7">
            {usage === null && !loadError ? <Loading label={t("settings.storage.loading")} /> : null}
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(loadError, t("settings.storage.loadFailed"))}
                </p>
            ) : null}

            {usage ? (
                <>
                    <section className="flex items-center gap-5 rounded-2xl bg-card p-5 text-card-foreground shadow-card">
                        <UsageRing
                            percent={usedPercent(usage)}
                            label={
                                <>
                                    <div className="text-xl font-semibold leading-tight tabular-nums">{formatBytes(usage.usedBytes)}</div>
                                    <div className="text-[11px] text-muted-foreground tabular-nums">{t("settings.storage.percentUsed", { percent: usedPercent(usage) })}</div>
                                </>
                            }
                        />
                        <div className="min-w-0 space-y-1">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t("settings.storage.used")}</div>
                            <div className="text-sm text-muted-foreground tabular-nums">
                                {t("settings.storage.summary", {
                                    count: usage.recordingCount,
                                    minutes: Math.round(usage.totalDurationMs / 60000),
                                    average: formatBytes(usage.recordingCount > 0 ? usage.usedBytes / usage.recordingCount : 0),
                                })}
                            </div>
                            {usage.diskFreeBytes !== null ? (
                                <div className="text-xs text-muted-foreground tabular-nums">{t("settings.storage.freeOnDisk", { size: formatBytes(usage.diskFreeBytes) })}</div>
                            ) : null}
                        </div>
                    </section>

                    {top3.length > 0 ? (
                        <section className="grid gap-3">
                            <div className="flex items-baseline justify-between gap-3">
                                <h2 className="text-sm font-medium">{t("settings.storage.breakdown")}</h2>
                                <p className="text-xs text-muted-foreground tabular-nums">
                                    {t("settings.storage.topShare", { count: top3.length })}<span className="font-medium text-foreground">{usage.usedBytes > 0 ? Math.round((top3Bytes / usage.usedBytes) * 100) : 0}%</span>
                                    {t("settings.storage.ofTotal", { size: formatBytes(usage.usedBytes) })}
                                </p>
                            </div>
                            <div role="img" aria-label={t("settings.storage.shareAria", { count: top3.length, percent: usage.usedBytes > 0 ? Math.round((top3Bytes / usage.usedBytes) * 100) : 0 })} className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                                {top3.map((r, index) => (
                                    <div
                                        key={r.id}
                                        className={cn("h-full", segmentColors[index])}
                                        style={{ width: `${usage.usedBytes > 0 ? (r.filesize / usage.usedBytes) * 100 : 0}%` }}
                                    />
                                ))}
                            </div>
                            <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                                <div className="px-4 pb-2 pt-3">
                                    <h3 className="text-sm font-medium">{t("settings.storage.largest")}</h3>
                                    <p className="text-xs text-muted-foreground">{t("settings.storage.largestHint")}</p>
                                </div>
                                <ul className="divide-y divide-border">
                                    {top3.map((r, index) => (
                                        <li key={r.id}>
                                            <Link
                                                to={`/recordings/${encodeURIComponent(r.id)}`}
                                                className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-accent/50"
                                            >
                                                <span className={cn("size-2.5 shrink-0 rounded-sm", segmentColors[index])} aria-hidden="true" />
                                                <span className="min-w-0 flex-1 truncate">{r.filename}</span>
                                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                                    {formatDuration(r.duration / 1000)}
                                                </span>
                                                <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums">{formatBytes(r.filesize)}</span>
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </section>
                    ) : null}

                    <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                        <div className="flex items-center justify-between gap-4 px-4 py-3">
                            <span className="text-[13px]">{t("settings.storage.backend")}</span>
                            <span className="text-[13px] capitalize tabular-nums text-muted-foreground">
                                {usage.storageType === "s3" ? t("settings.storage.backendS3") : t("settings.storage.backendLocal")}
                            </span>
                        </div>
                        <p className="px-4 py-3 text-xs text-muted-foreground">{t("settings.storage.backendFixed")}</p>
                    </div>
                </>
            ) : null}

            <section className="grid gap-3">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <label htmlFor={`${ids}-auto-delete`} className="text-[13px] font-semibold">
                            {t("settings.storage.autoDelete")}
                        </label>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.storage.autoDeleteHint")}</p>
                    </div>
                    <Switch
                        id={`${ids}-auto-delete`}
                        aria-label={t("settings.storage.autoDelete")}
                        checked={settings.autoDeleteRecordings}
                        disabled={isSaving("autoDeleteRecordings")}
                        onCheckedChange={toggleAutoDelete}
                    />
                </div>
                {settings.autoDeleteRecordings ? (
                    <div className="grid gap-2 divide-y divide-border rounded-xl bg-muted px-4">
                        <div className="grid gap-2 py-3">
                            <label htmlFor={`${ids}-retention`} className="text-[13px] font-medium">
                                {t("settings.storage.retention")}
                            </label>
                            <div className="[&>input]:w-full">
                                <NumberField
                                    id={`${ids}-retention`}
                                    testId="retention-days"
                                    value={settings.retentionDays}
                                    min={1}
                                    max={365}
                                    allowEmpty
                                    placeholder="30"
                                    disabled={isSaving("retentionDays")}
                                    onCommit={(v) => void save({ retentionDays: v })}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">{t("settings.storage.retentionHint")}</p>
                        </div>
                    </div>
                ) : null}
            </section>
        </div>
    );
}

function formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
}

// ---------- export ----------

/** Fields the desktop app reads for auto export (spec/export.md). */
interface DesktopExportSettings {
    autoExport: boolean;
    autoExportFolder: string | null;
    autoExportFormat: "mp3" | "ogg" | "original";
    autoExportTitleMode: "original" | "date" | "ai";
}

const AUTO_EXPORT_FORMAT_KEYS: { value: DesktopExportSettings["autoExportFormat"]; labelKey: "settings.export.formatMp3" | "settings.export.formatOgg" | "settings.export.formatOriginal"; descriptionKey: "settings.export.formatMp3Description" | "settings.export.formatOggDescription" | "settings.export.formatOriginalDescription" }[] = [
    { value: "mp3", labelKey: "settings.export.formatMp3", descriptionKey: "settings.export.formatMp3Description" },
    { value: "ogg", labelKey: "settings.export.formatOgg", descriptionKey: "settings.export.formatOggDescription" },
    { value: "original", labelKey: "settings.export.formatOriginal", descriptionKey: "settings.export.formatOriginalDescription" },
];

const AUTO_EXPORT_TITLE_KEYS: { value: "original" | "date" | "ai"; titleKey: "settings.export.nameOriginal" | "settings.export.nameDate" | "settings.export.nameAi"; descriptionKey: "settings.export.nameOriginalDescription" | "settings.export.nameDateDescription" | "settings.export.nameAiDescription" }[] = [
    { value: "original", titleKey: "settings.export.nameOriginal", descriptionKey: "settings.export.nameOriginalDescription" },
    { value: "date", titleKey: "settings.export.nameDate", descriptionKey: "settings.export.nameDateDescription" },
    { value: "ai", titleKey: "settings.export.nameAi", descriptionKey: "settings.export.nameAiDescription" },
];

/** One line describing what auto export writes, for the switch's hint. */
function autoExportSummary(format: DesktopExportSettings["autoExportFormat"]): string {
    if (format === "original") return t("settings.export.summaryOriginal");
    if (format === "ogg") return t("settings.export.summaryOgg");
    return t("settings.export.summaryMp3");
}

const EXPORT_FORMATS = [
    { value: "json", label: "JSON" },
    { value: "txt", label: "TXT" },
    { value: "srt", label: "SRT" },
    { value: "vtt", label: "VTT" },
];

function filenameFrom(disposition: string | null, fallback: string): string {
    const match = disposition?.match(/filename="?([^";]+)"?/i);
    return match?.[1] ?? fallback;
}

export function ExportSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const bridge = desktopBridge();
    const desktop = typeof bridge?.pickFolder === "function";
    const desktopSettings = settings as unknown as DesktopExportSettings;
    const [exporting, setExporting] = useState(false);

    const exportText = async () => {
        setExporting(true);
        try {
            const res = await fetch(`/api/export?format=${encodeURIComponent(settings.defaultExportFormat)}`, {
                credentials: "same-origin",
            });
            if (!res.ok) throw new Error(`Export failed (${res.status})`);
            const text = await res.text();
            const name = filenameFrom(
                res.headers.get("content-disposition"),
                `recordings.${settings.defaultExportFormat}`,
            );
            const saved = await downloadText(
                name,
                res.headers.get("content-type") ?? "text/plain",
                text,
            );
            if (saved) toast.success(t("settings.export.exportCompleted"));
        } catch {
            toast.error(t("settings.export.exportError"));
        } finally {
            setExporting(false);
        }
    };

    const chooseFolder = async () => {
        const pickFolder = bridge?.pickFolder;
        if (!pickFolder) return;
        try {
            const path = await pickFolder();
            if (path) await save({ autoExportFolder: path } as SettingsPatch, t("settings.export.folderSaveFailed"));
        } catch (err) {
            toast.error(errorMessage(err, t("settings.export.folderPickerFailed")));
        }
    };

    return (
        <div className="grid gap-7">
            <div className="divide-y divide-border">
                <PlainRow htmlFor={`${ids}-format`} label={t("settings.export.defaultFormat")}>
                    <SettingSelect
                        id={`${ids}-format`}
                        testId="export-format"
                        value={settings.defaultExportFormat}
                        disabled={isSaving("defaultExportFormat")}
                        onValueChange={(v) => void save({ defaultExportFormat: v as UserSettings["defaultExportFormat"] })}
                        options={EXPORT_FORMATS}
                        className="w-40"
                    />
                </PlainRow>

                {desktop ? (
                    <>
                        <PlainRow
                            htmlFor={`${ids}-auto-export`}
                            label={t("settings.export.autoExportTitle")}
                            hint={
                                !desktopSettings.autoExportFolder
                                    ? t("settings.export.chooseFolderFirst")
                                    : autoExportSummary(desktopSettings.autoExportFormat)
                            }
                        >
                            <Switch
                                id={`${ids}-auto-export`}
                                data-testid="auto-export-switch"
                                checked={Boolean(desktopSettings.autoExport)}
                                disabled={!desktopSettings.autoExportFolder}
                                onCheckedChange={(next) => void save({ autoExport: next } as SettingsPatch)}
                            />
                        </PlainRow>
                        <PlainRow
                            label={t("settings.export.exportFolder")}
                            hint={t("settings.export.exportFolderHint")}
                        >
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    className={cn(
                                        "max-w-[16rem] truncate text-xs",
                                        desktopSettings.autoExportFolder ? "text-foreground" : "text-muted-foreground",
                                    )}
                                    title={desktopSettings.autoExportFolder ?? undefined}
                                >
                                    {desktopSettings.autoExportFolder ?? t("settings.export.noFolder")}
                                </span>
                                <Button variant="secondary" data-testid="auto-export-folder-choose" onClick={() => void chooseFolder()}>
                                    {t("settings.export.choose")}
                                </Button>
                            </div>
                        </PlainRow>
                        <PlainRow
                            htmlFor={`${ids}-auto-export-format`}
                            label={t("settings.export.autoExportFormat")}
                            hint={t(AUTO_EXPORT_FORMAT_KEYS.find((o) => o.value === desktopSettings.autoExportFormat)?.descriptionKey ?? "settings.export.formatOriginalDescription")}
                        >
                            <SettingSelect
                                id={`${ids}-auto-export-format`}
                                testId="auto-export-format"
                                value={desktopSettings.autoExportFormat}
                                onValueChange={(v) => void save({ autoExportFormat: v } as SettingsPatch)}
                                options={AUTO_EXPORT_FORMAT_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                                className="w-44 max-w-full"
                            />
                        </PlainRow>
                        <div className="space-y-2 py-3">
                            <span id={`${ids}-auto-export-file-name`} className="block text-[13px] font-medium">
                                {t("settings.export.fileName")}
                            </span>
                            <div
                                role="radiogroup"
                                aria-labelledby={`${ids}-auto-export-file-name`}
                                data-testid="auto-export-title-mode"
                                className="divide-y divide-border rounded-xl bg-muted px-4"
                            >
                                {AUTO_EXPORT_TITLE_KEYS.map((option) => {
                                    const inputId = `${ids}-auto-export-title-mode-${option.value}`;
                                    return (
                                        <label
                                            key={option.value}
                                            htmlFor={inputId}
                                            className="flex cursor-pointer items-start gap-3 py-3 font-normal"
                                        >
                                            <input
                                                type="radio"
                                                id={inputId}
                                                name={`${ids}-auto-export-title-mode`}
                                                value={option.value}
                                                data-testid={`auto-export-title-mode-${option.value}`}
                                                checked={desktopSettings.autoExportTitleMode === option.value}
                                                onChange={() => void save({ autoExportTitleMode: option.value } as SettingsPatch)}
                                                className="mt-0.5 size-4 shrink-0 accent-primary"
                                            />
                                            <span className="min-w-0 flex-1 space-y-0.5">
                                                <span className="block text-[13px] font-medium">{t(option.titleKey)}</span>
                                                <span className="block text-xs text-muted-foreground">{t(option.descriptionKey)}</span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                ) : (
                    <PlainRow
                        htmlFor={`${ids}-auto-export`}
                        label={t("settings.export.autoExportLabel")}
                        badge={<ComingSoon />}
                        hint={t("settings.export.autoExportDesktopHint")}
                    >
                        <Switch id={`${ids}-auto-export`} disabled checked={false} onCheckedChange={() => undefined} />
                    </PlainRow>
                )}
            </div>

            <section className="grid gap-3 pt-4">
                <div className="space-y-2">
                    <span className="text-[13px] font-semibold">{t("settings.export.manualActions")}</span>
                    <div>
                        <Button variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent("oah:open-onboarding"))}>
                            <RefreshCw />
                            {t("settings.export.rerunOnboarding")}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t("settings.export.onboardingRestartHint")}</p>
                </div>
                <div className="flex gap-2 pt-2">
                    <Button variant="secondary" className="flex-1" disabled={exporting} onClick={() => void exportText()}>
                        {exporting ? <Spinner label={t("settings.export.exporting")} /> : <Download />}
                        {exporting ? t("settings.export.downloading") : t("settings.export.exportText")}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("settings.export.exportHint")}</p>
            </section>
        </div>
    );
}
