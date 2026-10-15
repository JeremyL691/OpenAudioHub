"use client";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-settings";
import type { RecordingTitleMode } from "@/lib/recordings/filename";
import type { DesktopBridge } from "@/types/desktop-bridge";

const autoExportTitleOptions: {
    value: RecordingTitleMode;
    title: string;
    description: string;
}[] = [
    {
        value: "original",
        title: "Original name",
        description: "Keep the name from Plaud or the uploaded file.",
    },
    {
        value: "date",
        title: "Date",
        description: "Name by recording date, e.g. 2026-10-12.",
    },
    {
        value: "ai",
        title: "AI title",
        description: "Renamed to the AI title once transcription finishes.",
    },
];

const exportFormatOptions = [
    { label: "JSON", value: "json", description: "Structured data format" },
    { label: "TXT", value: "txt", description: "Plain text format" },
    { label: "SRT", value: "srt", description: "Subtitle format" },
    { label: "VTT", value: "vtt", description: "WebVTT subtitle format" },
];

const autoExportFormatOptions: {
    label: string;
    value: AutoExportFormat;
    description: string;
}[] = [
    {
        label: "MP3",
        value: "mp3",
        description: "Converted to MP3 for easy playback.",
    },
    {
        label: "Original file (.ogg)",
        value: "original",
        description: "Saved exactly as recorded, no conversion.",
    },
];

const backupFrequencyOptions = [
    { label: "Never", value: "never" },
    { label: "Daily", value: "daily" },
    { label: "Weekly", value: "weekly" },
    { label: "Monthly", value: "monthly" },
];

interface ExportJobStatus {
    id: string;
    // "expired" is a client-facing derived status: the server reports it
    // instead of "completed" once `expiresAt` has passed, even if the
    // row hasn't been swept from the DB yet (the cleanup worker keeps it
    // until the storage delete actually succeeds).
    status: "pending" | "processing" | "completed" | "failed" | "expired";
    createdAt: string;
    completedAt: string | null;
    expiresAt: string | null;
    recordingCount: number | null;
    fileSize: number | null;
    errorMessage: string | null;
}

type AutoExportFormat = "mp3" | "original";

const ACTIVE_STATUSES = new Set(["pending", "processing"]);
const POLL_INTERVAL_MS = 4000;

function formatRelativeTime(iso: string, now: number): string {
    const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["day", 86400],
        ["hour", 3600],
        ["minute", 60],
    ];
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    for (const [unit, seconds] of units) {
        if (Math.abs(diffSec) >= seconds) {
            return rtf.format(Math.round(diffSec / seconds), unit);
        }
    }
    return rtf.format(0, "minute");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

interface ExportSectionProps {
    onReRunOnboarding?: () => void;
}

export function ExportSection({ onReRunOnboarding }: ExportSectionProps) {
    const { isLoadingSettings, isSavingSettings, setIsLoadingSettings } =
        useSettings();
    const [defaultExportFormat, setDefaultExportFormat] = useState("json");
    const [autoExport, setAutoExport] = useState(false);
    const [autoExportFolder, setAutoExportFolder] = useState<string | null>(
        null,
    );
    const [autoExportFormat, setAutoExportFormat] =
        useState<AutoExportFormat>("mp3");
    const [autoExportTitleMode, setAutoExportTitleMode] =
        useState<RecordingTitleMode>("original");
    const [desktopBridge, setDesktopBridge] = useState<DesktopBridge | null>(
        null,
    );
    const [backupFrequency, setBackupFrequency] = useState<string | null>(null);
    const [backupFolder, setBackupFolder] = useState<string | null>(null);
    const [lastScheduledBackupAt, setLastScheduledBackupAt] = useState<
        string | null
    >(null);
    const [isExporting, setIsExporting] = useState(false);
    const [isStartingBackup, setIsStartingBackup] = useState(false);
    const [backupJob, setBackupJob] = useState<ExportJobStatus | null>(null);

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setDefaultExportFormat(data.defaultExportFormat ?? "json");
                    setAutoExport(data.autoExport ?? false);
                    setAutoExportFolder(data.autoExportFolder ?? null);
                    setAutoExportFormat(data.autoExportFormat ?? "mp3");
                    setAutoExportTitleMode(
                        data.autoExportTitleMode ?? "original",
                    );
                    setBackupFrequency(data.backupFrequency ?? null);
                    setBackupFolder(data.backupFolder ?? null);
                    setLastScheduledBackupAt(
                        data.lastScheduledBackupAt ?? null,
                    );
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoadingSettings(false);
            }
        };
        fetchSettings();
    }, [setIsLoadingSettings]);

    // Pick up the most recent job on load -- covers reopening Settings
    // after starting a backup elsewhere, or arriving from the
    // "export ready" email.
    useEffect(() => {
        const fetchJobs = async () => {
            try {
                const response = await fetch("/api/backup");
                if (!response.ok) return;
                const data = await response.json();
                if (data.jobs?.[0]) setBackupJob(data.jobs[0]);
            } catch {
                // Non-fatal -- the user can still start a fresh backup.
            }
        };
        fetchJobs();
    }, []);

    // Poll while a job is active. Stops itself once the job leaves
    // pending/processing, so there's no polling overhead once idle.
    // Single-flight by construction: the next poll is only scheduled
    // from the previous one's `finally`, so a slow response (>4s)
    // can't cause overlapping in-flight requests and duplicate
    // terminal-state handling (extra toasts).
    useEffect(() => {
        if (!backupJob || !ACTIVE_STATUSES.has(backupJob.status)) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;

        const poll = async () => {
            try {
                const response = await fetch(`/api/backup/${backupJob.id}`);
                if (!cancelled && response.ok) {
                    const data = await response.json();
                    if (!cancelled) {
                        setBackupJob(data.job);
                        if (data.job.status === "completed") {
                            toast.success("Backup ready to download");
                        } else if (data.job.status === "failed") {
                            toast.error("Backup failed to build");
                        }
                    }
                }
            } catch {
                // Transient -- the next tick will retry.
            } finally {
                if (!cancelled) {
                    timer = setTimeout(poll, POLL_INTERVAL_MS);
                }
            }
        };
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [backupJob]);

    // Detect the desktop bridge after mount so server and client first
    // renders match (the bridge only exists in the Electron window).
    useEffect(() => {
        const bridge = window.__openaudiohubDesktop;
        if (bridge?.version === 1) setDesktopBridge(bridge);
    }, []);

    const handleExportBackupSettingChange = async (updates: {
        defaultExportFormat?: string;
        autoExport?: boolean;
        autoExportFolder?: string | null;
        autoExportFormat?: AutoExportFormat;
        autoExportTitleMode?: RecordingTitleMode;
        backupFrequency?: string | null;
        backupFolder?: string | null;
    }) => {
        const previousValues: Record<string, unknown> = {};
        if (updates.defaultExportFormat !== undefined) {
            previousValues.defaultExportFormat = defaultExportFormat;
            setDefaultExportFormat(updates.defaultExportFormat);
        }
        if (updates.autoExport !== undefined) {
            previousValues.autoExport = autoExport;
            setAutoExport(updates.autoExport);
        }
        if (updates.autoExportFolder !== undefined) {
            previousValues.autoExportFolder = autoExportFolder;
            setAutoExportFolder(updates.autoExportFolder);
        }
        if (updates.autoExportFormat !== undefined) {
            previousValues.autoExportFormat = autoExportFormat;
            setAutoExportFormat(updates.autoExportFormat);
        }
        if (updates.autoExportTitleMode !== undefined) {
            previousValues.autoExportTitleMode = autoExportTitleMode;
            setAutoExportTitleMode(updates.autoExportTitleMode);
        }
        if (updates.backupFrequency !== undefined) {
            previousValues.backupFrequency = backupFrequency;
            setBackupFrequency(updates.backupFrequency);
        }
        if (updates.backupFolder !== undefined) {
            previousValues.backupFolder = backupFolder;
            setBackupFolder(updates.backupFolder);
        }

        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(updates),
            });

            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            if (updates.defaultExportFormat !== undefined) {
                const prev = previousValues.defaultExportFormat;
                if (typeof prev === "string") setDefaultExportFormat(prev);
            }
            if (updates.autoExport !== undefined) {
                const prev = previousValues.autoExport;
                if (typeof prev === "boolean") setAutoExport(prev);
            }
            if (updates.autoExportFolder !== undefined) {
                const prev = previousValues.autoExportFolder;
                if (typeof prev === "string" || prev === null)
                    setAutoExportFolder(prev);
            }
            if (updates.autoExportFormat !== undefined) {
                const prev = previousValues.autoExportFormat;
                if (prev === "mp3" || prev === "original")
                    setAutoExportFormat(prev);
            }
            if (updates.autoExportTitleMode !== undefined) {
                const prev = previousValues.autoExportTitleMode;
                if (prev === "original" || prev === "date" || prev === "ai")
                    setAutoExportTitleMode(prev);
            }
            if (updates.backupFrequency !== undefined) {
                const prev = previousValues.backupFrequency;
                if (typeof prev === "string" || prev === null)
                    setBackupFrequency(prev);
            }
            if (updates.backupFolder !== undefined) {
                const prev = previousValues.backupFolder;
                if (typeof prev === "string" || prev === null)
                    setBackupFolder(prev);
            }
            toast.error("Failed to save settings. Changes reverted.");
        }
    };

    const handleChooseFolder = async () => {
        if (!desktopBridge) return;
        let path: string | null;
        try {
            path = await desktopBridge.pickFolder();
        } catch {
            toast.error("Couldn't open the folder picker");
            return;
        }
        // null means the user canceled the picker.
        if (path) handleExportBackupSettingChange({ autoExportFolder: path });
    };

    const handleChooseBackupFolder = async () => {
        if (!desktopBridge) return;
        let path: string | null;
        try {
            path = await desktopBridge.pickFolder();
        } catch {
            toast.error("Couldn't open the folder picker");
            return;
        }
        if (path) handleExportBackupSettingChange({ backupFolder: path });
    };

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const response = await fetch(
                `/api/export?format=${defaultExportFormat}`,
            );
            if (!response.ok) throw new Error("Export failed");

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download =
                response.headers
                    .get("Content-Disposition")
                    ?.split("filename=")[1]
                    ?.replace(/"/g, "") || `export.${defaultExportFormat}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            toast.success("Export completed");
        } catch {
            toast.error("Failed to export recordings");
        } finally {
            setIsExporting(false);
        }
    };

    const handleStartBackup = async () => {
        setIsStartingBackup(true);
        try {
            const response = await fetch("/api/backup", { method: "POST" });
            if (!response.ok) throw new Error("Backup request failed");
            const data = await response.json();
            setBackupJob(data.job);
            toast.success(
                ACTIVE_STATUSES.has(data.job.status)
                    ? "Backup started -- this can take a few minutes for large libraries"
                    : "Backup ready to download",
            );
        } catch {
            toast.error("Failed to start backup");
        } finally {
            setIsStartingBackup(false);
        }
    };

    if (isLoadingSettings) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title="Export & Backup"
                description="Take your data with you: recordings, transcripts, and summaries."
                icon={Download}
            />
            <div className="divide-y divide-border">
                <div className="flex items-center justify-between gap-4 py-3">
                    <Label
                        className="text-[13px] font-medium"
                        htmlFor="export-format"
                    >
                        Default export format
                    </Label>
                    <Select
                        value={defaultExportFormat}
                        onValueChange={(value) => {
                            setDefaultExportFormat(value);
                            handleExportBackupSettingChange({
                                defaultExportFormat: value,
                            });
                        }}
                        disabled={isSavingSettings}
                    >
                        <SelectTrigger
                            id="export-format"
                            data-testid="export-format"
                            className="w-44 max-w-full"
                        >
                            <SelectValue>
                                {exportFormatOptions.find(
                                    (opt) => opt.value === defaultExportFormat,
                                )?.label || "JSON"}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {exportFormatOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    <div>
                                        <div>{option.label}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {option.description}
                                        </div>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex items-center justify-between gap-4 py-3">
                    <div className="space-y-0.5 flex-1">
                        <div className="flex items-center gap-2">
                            <Label
                                htmlFor="auto-export"
                                className="text-[13px] font-medium"
                            >
                                Auto-export new recordings
                            </Label>
                            {!desktopBridge && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                    Coming soon
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {desktopBridge
                                ? autoExportFormat === "original"
                                    ? "Save each new recording as its original file in a folder on this Mac."
                                    : "Save each new recording as an MP3 in a folder on this Mac."
                                : "Automatically export recordings when they are synced"}
                        </p>
                    </div>
                    <Switch
                        id="auto-export"
                        className={desktopBridge ? undefined : "opacity-60"}
                        checked={autoExport}
                        onCheckedChange={(checked) => {
                            handleExportBackupSettingChange({
                                autoExport: checked,
                            });
                        }}
                        disabled={desktopBridge ? !autoExportFolder : true}
                    />
                </div>

                {desktopBridge && (
                    <>
                        <div className="flex items-center justify-between gap-4 py-3">
                            <Label
                                htmlFor="auto-export-folder"
                                className="text-[13px] font-medium"
                            >
                                Export folder
                            </Label>
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    id="auto-export-folder-path"
                                    title={autoExportFolder ?? undefined}
                                    className={`min-w-0 max-w-[16rem] truncate text-xs ${
                                        autoExportFolder
                                            ? ""
                                            : "text-muted-foreground"
                                    }`}
                                >
                                    {autoExportFolder ?? "No folder chosen"}
                                </span>
                                <Button
                                    id="auto-export-folder"
                                    data-testid="auto-export-folder"
                                    aria-describedby="auto-export-folder-path"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleChooseFolder}
                                >
                                    Choose…
                                </Button>
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-4 py-3">
                            <div className="space-y-0.5 flex-1">
                                <Label
                                    className="text-[13px] font-medium"
                                    htmlFor="auto-export-format"
                                >
                                    Auto-export format
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                    {
                                        autoExportFormatOptions.find(
                                            (opt) =>
                                                opt.value === autoExportFormat,
                                        )?.description
                                    }
                                </p>
                            </div>
                            <Select
                                value={autoExportFormat}
                                onValueChange={(value) => {
                                    handleExportBackupSettingChange({
                                        autoExportFormat:
                                            value as AutoExportFormat,
                                    });
                                }}
                                disabled={isSavingSettings}
                            >
                                <SelectTrigger
                                    id="auto-export-format"
                                    data-testid="auto-export-format"
                                    className="w-44 max-w-full"
                                >
                                    <SelectValue>
                                        {autoExportFormatOptions.find(
                                            (opt) =>
                                                opt.value === autoExportFormat,
                                        )?.label || "MP3"}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    {autoExportFormatOptions.map((option) => (
                                        <SelectItem
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2 py-3">
                            <span
                                id="auto-export-file-name"
                                className="block text-[13px] font-medium"
                            >
                                File name
                            </span>
                            <div
                                role="radiogroup"
                                aria-labelledby="auto-export-file-name"
                                data-testid="auto-export-title-mode"
                                className="divide-y divide-border rounded-xl bg-muted/60 px-4"
                            >
                                {autoExportTitleOptions.map((option) => {
                                    const inputId = `auto-export-title-mode-${option.value}`;
                                    return (
                                        <Label
                                            key={option.value}
                                            htmlFor={inputId}
                                            className="flex cursor-pointer items-start gap-3 py-3 font-normal"
                                        >
                                            <input
                                                type="radio"
                                                id={inputId}
                                                name="auto-export-title-mode"
                                                value={option.value}
                                                data-testid={inputId}
                                                checked={
                                                    autoExportTitleMode ===
                                                    option.value
                                                }
                                                onChange={() =>
                                                    handleExportBackupSettingChange(
                                                        {
                                                            autoExportTitleMode:
                                                                option.value,
                                                        },
                                                    )
                                                }
                                                className="mt-0.5 size-4 shrink-0 accent-primary"
                                            />
                                            <span className="min-w-0 flex-1 space-y-0.5">
                                                <span className="block text-[13px] font-medium">
                                                    {option.title}
                                                </span>
                                                <span className="block text-xs text-muted-foreground">
                                                    {option.description}
                                                </span>
                                            </span>
                                        </Label>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}

                <div className="space-y-2 py-3">
                    <div className="flex items-center gap-2">
                        <Label
                            className="text-[13px] font-medium"
                            htmlFor="backup-frequency"
                        >
                            Backup frequency
                        </Label>
                        {!desktopBridge && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                                Coming soon
                            </span>
                        )}
                    </div>
                    <Select
                        value={backupFrequency || "never"}
                        onValueChange={(value) => {
                            const frequency = value === "never" ? null : value;
                            setBackupFrequency(frequency);
                            handleExportBackupSettingChange({
                                backupFrequency: frequency,
                            });
                        }}
                        disabled={!desktopBridge}
                    >
                        <SelectTrigger
                            id="backup-frequency"
                            className={`w-44 max-w-full ${desktopBridge ? "" : "opacity-60"}`}
                        >
                            <SelectValue>
                                {backupFrequencyOptions.find(
                                    (opt) =>
                                        opt.value ===
                                        (backupFrequency || "never"),
                                )?.label || "Never"}
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                            {backupFrequencyOptions.map((option) => (
                                <SelectItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        {desktopBridge
                            ? "How often to automatically create backups"
                            : "Scheduled backups are available in the desktop app."}
                    </p>
                    {desktopBridge && (
                        <p
                            className="text-xs text-muted-foreground"
                            data-testid="last-backup"
                        >
                            {lastScheduledBackupAt
                                ? `Last backup: ${formatRelativeTime(lastScheduledBackupAt, Date.now())}`
                                : "No backup yet"}
                        </p>
                    )}
                </div>

                {desktopBridge && (
                    <div className="flex items-center justify-between gap-4 py-3">
                        <Label
                            htmlFor="backup-folder"
                            className="text-[13px] font-medium"
                        >
                            Backup folder
                        </Label>
                        <div className="flex min-w-0 items-center gap-3">
                            <span
                                id="backup-folder-path"
                                title={backupFolder ?? undefined}
                                className={`min-w-0 max-w-[16rem] truncate text-xs ${
                                    backupFolder ? "" : "text-muted-foreground"
                                }`}
                            >
                                {backupFolder ??
                                    "Documents/OpenAudioHub Backups (default)"}
                            </span>
                            <Button
                                id="backup-folder"
                                data-testid="backup-folder"
                                aria-describedby="backup-folder-path"
                                variant="outline"
                                size="sm"
                                onClick={handleChooseBackupFolder}
                            >
                                Choose…
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            <div className="pt-4 space-y-3">
                <div className="space-y-2">
                    <Label className="text-[13px] font-semibold text-muted-foreground">
                        Manual Actions
                    </Label>
                    <Button
                        onClick={async () => {
                            try {
                                await fetch("/api/settings/user", {
                                    method: "PUT",
                                    headers: {
                                        "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                        onboardingCompleted: false,
                                    }),
                                });
                                onReRunOnboarding?.();
                            } catch {
                                toast.error("Failed to reset onboarding");
                            }
                        }}
                        variant="outline"
                        className="h-10 w-full sm:h-8 sm:w-auto"
                    >
                        <RefreshCw className="size-4 mr-2" />
                        Re-run Onboarding
                    </Button>
                    <p className="text-xs text-muted-foreground">
                        Reset onboarding to see it again on your next visit
                    </p>
                    <div className="flex gap-2 pt-2">
                        <Button
                            onClick={handleExport}
                            disabled={isExporting}
                            variant="outline"
                            className="flex-1"
                        >
                            {isExporting ? (
                                <>
                                    <div className="animate-spin size-4 mr-2 border-2 border-primary border-t-transparent rounded-full" />
                                    Exporting…
                                </>
                            ) : (
                                <>
                                    <Download className="size-4 mr-2" />
                                    Export text
                                </>
                            )}
                        </Button>
                        <Button
                            data-testid="backup-start"
                            onClick={handleStartBackup}
                            disabled={
                                isStartingBackup ||
                                (backupJob !== null &&
                                    ACTIVE_STATUSES.has(backupJob.status))
                            }
                            variant="outline"
                            className="flex-1"
                        >
                            {isStartingBackup ||
                            (backupJob !== null &&
                                ACTIVE_STATUSES.has(backupJob.status)) ? (
                                <>
                                    <div className="animate-spin size-4 mr-2 border-2 border-primary border-t-transparent rounded-full" />
                                    Building archive…
                                </>
                            ) : (
                                <>
                                    <Download className="size-4 mr-2" />
                                    Create full backup
                                </>
                            )}
                        </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        "Export text" downloads transcripts + summaries
                        instantly. "Create full backup" also bundles the
                        original audio into a zip archive; large libraries take
                        a few minutes to build in the background, and you'll get
                        an email when it's ready.
                    </p>
                    {backupJob && (
                        <div className="rounded-lg bg-muted/60 p-3 text-[13px] space-y-1">
                            {backupJob.status === "completed" && (
                                <div className="flex items-center justify-between gap-2">
                                    <span>
                                        Backup ready
                                        {backupJob.recordingCount !== null &&
                                            ` \u2014 ${backupJob.recordingCount} recording${backupJob.recordingCount === 1 ? "" : "s"}`}
                                        {backupJob.fileSize !== null &&
                                            ` (${formatBytes(backupJob.fileSize)})`}
                                    </span>
                                    <Button asChild size="sm">
                                        <a
                                            href={`/api/backup/${backupJob.id}/download`}
                                        >
                                            <Download className="size-4 mr-2" />
                                            Download
                                        </a>
                                    </Button>
                                </div>
                            )}
                            {ACTIVE_STATUSES.has(backupJob.status) && (
                                <span className="text-muted-foreground">
                                    Building your archive
                                    {backupJob.status === "pending"
                                        ? " (queued)"
                                        : ""}
                                    …
                                </span>
                            )}
                            {backupJob.status === "failed" && (
                                <span className="text-destructive">
                                    Backup failed to build. Try again, or
                                    contact support if it keeps failing.
                                </span>
                            )}
                            {backupJob.status === "expired" && (
                                <span className="text-muted-foreground">
                                    That backup has expired. Create a new one to
                                    download it again.
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
