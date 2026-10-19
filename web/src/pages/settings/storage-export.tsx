import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Spinner } from "@/components/ui/spinner";
import { Group, Loading, LoadError, NumberField, SettingSelect, useSettings, type SettingsPatch, type UserSettings } from "./shared";
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
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Coming soon</span>;
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
            {usage === null && !loadError ? <Loading label="Loading storage usage" /> : null}
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(loadError, "Storage usage could not be loaded.")}
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
                                    <div className="text-[11px] text-muted-foreground tabular-nums">{usedPercent(usage)}% used</div>
                                </>
                            }
                        />
                        <div className="min-w-0 space-y-1">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Storage used</div>
                            <div className="text-sm text-muted-foreground tabular-nums">
                                {usage.recordingCount} recordings · {Math.round(usage.totalDurationMs / 60000)} min total ·{" "}
                                {formatBytes(usage.recordingCount > 0 ? usage.usedBytes / usage.recordingCount : 0)} avg
                            </div>
                            {usage.diskFreeBytes !== null ? (
                                <div className="text-xs text-muted-foreground tabular-nums">{formatBytes(usage.diskFreeBytes)} free on disk</div>
                            ) : null}
                        </div>
                    </section>

                    {top3.length > 0 ? (
                        <section className="grid gap-3">
                            <div className="flex items-baseline justify-between gap-3">
                                <h2 className="text-sm font-medium">Storage breakdown</h2>
                                <p className="text-xs text-muted-foreground tabular-nums">
                                    Top {top3.length} = <span className="font-medium text-foreground">{usage.usedBytes > 0 ? Math.round((top3Bytes / usage.usedBytes) * 100) : 0}%</span>{" "}
                                    of {formatBytes(usage.usedBytes)}
                                </p>
                            </div>
                            <div role="img" aria-label={`Top ${top3.length} recordings account for ${usage.usedBytes > 0 ? Math.round((top3Bytes / usage.usedBytes) * 100) : 0} percent of storage`} className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
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
                                    <h3 className="text-sm font-medium">Largest recordings</h3>
                                    <p className="text-xs text-muted-foreground">Play a recording before you decide to delete it</p>
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
                            <span className="text-[13px]">Backend</span>
                            <span className="text-[13px] capitalize tabular-nums text-muted-foreground">
                                {usage.storageType === "s3" ? "S3" : "Local"}
                            </span>
                        </div>
                        <p className="px-4 py-3 text-xs text-muted-foreground">
                            The storage backend is set for the whole instance through environment variables.
                        </p>
                    </div>
                </>
            ) : null}

            <section className="grid gap-3">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <label htmlFor={`${ids}-auto-delete`} className="text-[13px] font-semibold">
                            Auto-delete old recordings
                        </label>
                        <p className="mt-0.5 text-xs text-muted-foreground">Delete recordings automatically once they pass the retention period.</p>
                    </div>
                    <Switch
                        id={`${ids}-auto-delete`}
                        aria-label="Auto-delete old recordings"
                        checked={settings.autoDeleteRecordings}
                        disabled={isSaving("autoDeleteRecordings")}
                        onCheckedChange={toggleAutoDelete}
                    />
                </div>
                {settings.autoDeleteRecordings ? (
                    <div className="grid gap-2 divide-y divide-border rounded-xl bg-muted px-4">
                        <div className="grid gap-2 py-3">
                            <label htmlFor={`${ids}-retention`} className="text-[13px] font-medium">
                                Retention period (days)
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
                            <p className="text-xs text-muted-foreground">Anything older than this gets deleted automatically (1-365 days)</p>
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

// ---------- export and backup ----------

/** Fields the desktop app reads for auto export and scheduled backups (spec/export-backup.md). */
interface DesktopExportSettings {
    autoExport: boolean;
    autoExportFolder: string | null;
    autoExportFormat: "mp3" | "ogg" | "original";
    autoExportTitleMode: "original" | "date" | "ai";
    backupFrequency: "daily" | "weekly" | "monthly" | "never" | null;
    backupFolder: string | null;
}

const AUTO_EXPORT_FORMAT_OPTIONS = [
    { value: "mp3", label: "MP3", description: "Converted to MP3 for easy playback." },
    { value: "ogg", label: "OGG", description: "Ogg container with Opus audio. Smaller files than MP3." },
    { value: "original", label: "Original format", description: "Saved exactly as recorded, with its own extension." },
];

const AUTO_EXPORT_TITLE_OPTIONS: { value: "original" | "date" | "ai"; title: string; description: string }[] = [
    { value: "original", title: "Original name", description: "Keep the name from Plaud or the uploaded file." },
    { value: "date", title: "Date", description: "Name by recording date, e.g. 2026-10-12." },
    { value: "ai", title: "AI title", description: "Renamed to the AI title once transcription finishes." },
];

/** One line describing what auto export writes, for the switch's hint. */
function autoExportSummary(format: DesktopExportSettings["autoExportFormat"]): string {
    if (format === "original") return "Save each new recording as its original file in a folder on this Mac.";
    if (format === "ogg") return "Save each new recording as an OGG (Opus) file in a folder on this Mac.";
    return "Save each new recording as an MP3 in a folder on this Mac.";
}

const BACKUP_FREQUENCY_OPTIONS = [
    { value: "never", label: "Never" },
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
];

const EXPORT_FORMATS = [
    { value: "json", label: "JSON" },
    { value: "txt", label: "TXT" },
    { value: "srt", label: "SRT" },
    { value: "vtt", label: "VTT" },
];

interface BackupJob {
    id: string;
    status: "pending" | "processing" | "completed" | "failed" | "expired";
    createdAt: string;
    completedAt: string | null;
    expiresAt: string | null;
    recordingCount: number | null;
    fileSize: number | null;
    errorMessage: string | null;
}

const JOB_LABEL: Record<BackupJob["status"], string> = {
    pending: "Queued",
    processing: "Building",
    completed: "Ready",
    failed: "Failed",
    expired: "Expired",
};

const JOB_TONE: Record<BackupJob["status"], StatusTone> = {
    pending: "neutral",
    processing: "info",
    completed: "success",
    failed: "warning",
    expired: "neutral",
};

const POLL_MS = 3000;

function filenameFrom(disposition: string | null, fallback: string): string {
    const match = disposition?.match(/filename="?([^";]+)"?/i);
    return match?.[1] ?? fallback;
}

function downloadBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportSection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const bridge = desktopBridge();
    const desktop = typeof bridge?.pickFolder === "function";
    const desktopSettings = settings as unknown as DesktopExportSettings;
    const [exporting, setExporting] = useState(false);
    const [jobs, setJobs] = useState<BackupJob[] | null>(null);
    const [jobsError, setJobsError] = useState(false);
    const [starting, setStarting] = useState(false);

    const loadJobs = useCallback(async () => {
        try {
            const data = await api<{ jobs: BackupJob[] }>("/api/backup");
            setJobs(data.jobs);
            setJobsError(false);
        } catch {
            setJobsError(true);
        }
    }, []);

    useEffect(() => {
        void loadJobs();
    }, [loadJobs]);

    const active = jobs?.some((j) => j.status === "pending" || j.status === "processing") ?? false;
    useEffect(() => {
        if (!active) return;
        const timer = window.setTimeout(() => void loadJobs(), POLL_MS);
        return () => window.clearTimeout(timer);
    }, [active, loadJobs]);

    const exportText = async () => {
        setExporting(true);
        try {
            const res = await fetch(`/api/export?format=${encodeURIComponent(settings.defaultExportFormat)}`, {
                credentials: "same-origin",
            });
            if (!res.ok) throw new Error(`Export failed (${res.status})`);
            const blob = await res.blob();
            downloadBlob(
                blob,
                filenameFrom(res.headers.get("content-disposition"), `recordings.${settings.defaultExportFormat}`),
            );
            toast.success("Export completed");
        } catch {
            toast.error("Could not export your recordings");
        } finally {
            setExporting(false);
        }
    };

    const startBackup = async () => {
        setStarting(true);
        try {
            const data = await api<{ job: BackupJob }>("/api/backup", { method: "POST", json: {} });
            toast.success(
                data.job.status === "completed"
                    ? "Backup ready to download"
                    : "Backup started -- large libraries may take a few minutes",
            );
            await loadJobs();
        } catch (err) {
            toast.error(errorMessage(err, "Failed to start backup"));
        } finally {
            setStarting(false);
        }
    };

    const chooseFolder = async (field: "autoExportFolder" | "backupFolder") => {
        const pickFolder = bridge?.pickFolder;
        if (!pickFolder) return;
        try {
            const path = await pickFolder();
            if (path) await save({ [field]: path } as SettingsPatch, "Could not save the folder.");
        } catch (err) {
            toast.error(errorMessage(err, "Could not open the folder picker."));
        }
    };

    const latest = jobs?.[0];
    const building = starting || active;

    return (
        <div className="grid gap-7">
            <div className="divide-y divide-border">
                <PlainRow htmlFor={`${ids}-format`} label="Default export format">
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
                            label="Auto-export new recordings"
                            hint={
                                !desktopSettings.autoExportFolder
                                    ? "Choose an export folder first."
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
                            label="Export folder"
                            hint="Each new recording is written to this folder once, when it arrives."
                        >
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    className={cn(
                                        "max-w-[16rem] truncate text-xs",
                                        desktopSettings.autoExportFolder ? "text-foreground" : "text-muted-foreground",
                                    )}
                                    title={desktopSettings.autoExportFolder ?? undefined}
                                >
                                    {desktopSettings.autoExportFolder ?? "No folder chosen"}
                                </span>
                                <Button variant="secondary" data-testid="auto-export-folder-choose" onClick={() => void chooseFolder("autoExportFolder")}>
                                    Choose…
                                </Button>
                            </div>
                        </PlainRow>
                        <PlainRow
                            htmlFor={`${ids}-auto-export-format`}
                            label="Auto-export format"
                            hint={AUTO_EXPORT_FORMAT_OPTIONS.find((o) => o.value === desktopSettings.autoExportFormat)?.description}
                        >
                            <SettingSelect
                                id={`${ids}-auto-export-format`}
                                testId="auto-export-format"
                                value={desktopSettings.autoExportFormat}
                                onValueChange={(v) => void save({ autoExportFormat: v } as SettingsPatch)}
                                options={AUTO_EXPORT_FORMAT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                                className="w-44 max-w-full"
                            />
                        </PlainRow>
                        <div className="space-y-2 py-3">
                            <span id={`${ids}-auto-export-file-name`} className="block text-[13px] font-medium">
                                File name
                            </span>
                            <div
                                role="radiogroup"
                                aria-labelledby={`${ids}-auto-export-file-name`}
                                data-testid="auto-export-title-mode"
                                className="divide-y divide-border rounded-xl bg-muted px-4"
                            >
                                {AUTO_EXPORT_TITLE_OPTIONS.map((option) => {
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
                                                <span className="block text-[13px] font-medium">{option.title}</span>
                                                <span className="block text-xs text-muted-foreground">{option.description}</span>
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
                        label="Auto-export new recordings"
                        badge={<ComingSoon />}
                        hint="Export new recordings on their own as they are synced"
                    >
                        <Switch id={`${ids}-auto-export`} disabled checked={false} onCheckedChange={() => undefined} />
                    </PlainRow>
                )}

                {desktop ? (
                    <>
                        <PlainRow
                            htmlFor={`${ids}-backup-frequency`}
                            label="Backup frequency"
                            hint="Scheduled backups are saved to the backup folder."
                        >
                            <SettingSelect
                                id={`${ids}-backup-frequency`}
                                testId="backup-frequency"
                                value={desktopSettings.backupFrequency ?? "never"}
                                onValueChange={(v) => void save({ backupFrequency: v } as SettingsPatch)}
                                options={BACKUP_FREQUENCY_OPTIONS}
                                className="w-36"
                            />
                        </PlainRow>
                        <PlainRow label="Backup folder" hint={desktopSettings.backupFolder ?? "Default: Documents/OpenAudioHub Backups"}>
                            <Button variant="secondary" data-testid="backup-folder-choose" onClick={() => void chooseFolder("backupFolder")}>
                                Choose folder…
                            </Button>
                        </PlainRow>
                    </>
                ) : (
                    <div className="space-y-2 py-3">
                        <div className="flex items-center gap-2">
                            <label htmlFor={`${ids}-backup-frequency`} className="text-[13px] font-medium">
                                Backup frequency
                            </label>
                            <ComingSoon />
                        </div>
                        <SettingSelect
                            id={`${ids}-backup-frequency`}
                            testId="backup-frequency"
                            value="never"
                            disabled
                            onValueChange={() => undefined}
                            options={BACKUP_FREQUENCY_OPTIONS}
                            className="w-36"
                        />
                        <p className="text-xs text-muted-foreground">Scheduled backups are available in the desktop app.</p>
                    </div>
                )}
            </div>

            <section className="grid gap-3 pt-4">
                <div className="space-y-2">
                    <span className="text-[13px] font-semibold">Manual Actions</span>
                    <div>
                        <Button variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent("oah:open-onboarding"))}>
                            <RefreshCw />
                            Re-run Onboarding
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">Start onboarding over and see it again the next time you visit</p>
                </div>
                <div className="flex gap-2 pt-2">
                    <Button variant="secondary" className="flex-1" disabled={exporting} onClick={() => void exportText()}>
                        {exporting ? <Spinner label="Exporting" /> : <Download />}
                        {exporting ? "Exporting…" : "Export text"}
                    </Button>
                    <Button
                        variant="secondary"
                        className="flex-1"
                        data-testid="backup-start"
                        disabled={building}
                        onClick={() => void startBackup()}
                    >
                        {building ? <Spinner label="Building archive" /> : <Download />}
                        {building ? "Building archive…" : "Create full backup"}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    &quot;Export text&quot; downloads transcripts + summaries instantly. &quot;Create full backup&quot; also bundles the original
                    audio into a zip archive; large libraries take a few minutes to build in the background, and you&apos;ll get an email when
                    it&apos;s ready.
                </p>
                {jobsError ? <LoadError message="Could not load backups." onRetry={() => void loadJobs()} /> : null}
                <p data-testid="last-backup" className="text-xs text-muted-foreground">
                    {jobs === null
                        ? jobsError
                            ? ""
                            : "Loading backups…"
                        : latest
                          ? `Last backup: ${JOB_LABEL[latest.status]} · ${formatDateTime(latest.createdAt)}`
                          : ""}
                </p>
                {jobs && jobs.length > 0 ? (
                    <Group>
                        {jobs.map((job) => (
                            <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                                <span className="flex items-center gap-2">
                                    <StatusBadge tone={JOB_TONE[job.status]}>{JOB_LABEL[job.status]}</StatusBadge>
                                    <span className="text-muted-foreground">{formatDateTime(job.createdAt)}</span>
                                </span>
                                <span className="flex items-center gap-3">
                                    {job.fileSize !== null ? (
                                        <span className="tabular-nums text-muted-foreground">{formatBytes(job.fileSize)}</span>
                                    ) : null}
                                    {job.status === "completed" ? (
                                        <a
                                            href={`/api/backup/${encodeURIComponent(job.id)}/download`}
                                            download
                                            className="font-medium text-link underline-offset-4 hover:underline"
                                        >
                                            Download backup
                                        </a>
                                    ) : null}
                                </span>
                            </div>
                        ))}
                    </Group>
                ) : null}
            </section>
        </div>
    );
}
