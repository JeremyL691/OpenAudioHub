"use client";

import {
    FileText,
    Keyboard,
    Loader2,
    Mic,
    Monitor,
    Moon,
    RefreshCw,
    Settings,
    Sparkles,
    Sun,
    Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { Kbd as UiKbd } from "@/components/ui/kbd";
import { type DateTimeFormat, formatDateTime } from "@/lib/format-date";
import { formatDurationMs } from "@/lib/format-duration";
import type { Recording } from "@/types/recording";

export const RECORDING_CAP = 200;

interface TranscriptionData {
    text?: string;
    language?: string;
}

// Mirror of the helper in `recording-list.tsx`; kept local on both sides.
export function transcriptSnippet(
    text: string | undefined,
    maxChars = 140,
): string | null {
    if (!text) return null;
    const stripped = text
        .replace(/\[[^\]]+\]/g, " ")
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!stripped) return null;
    if (stripped.length <= maxChars) return stripped;
    return `${stripped.slice(0, maxChars - 1).trimEnd()}…`;
}

const PILL_CLASS =
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground";

export function Row({
    icon,
    title,
    subtitle,
    accessory,
}: {
    icon: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    accessory?: ReactNode;
}) {
    return (
        <>
            <span aria-hidden="true" className="shrink-0">
                {icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{title}</span>
                {subtitle ? (
                    <span className="truncate text-xs text-muted-foreground">
                        {subtitle}
                    </span>
                ) : null}
            </span>
            {accessory ? (
                <span className="ml-auto flex shrink-0 items-center gap-2">
                    {accessory}
                </span>
            ) : null}
        </>
    );
}

export function Kbd({ children }: { children: ReactNode }) {
    return <UiKbd>{children}</UiKbd>;
}

export function RecordingsGroup({
    recordings,
    transcriptions,
    currentRecording,
    inFlightActions,
    dateTimeFormat,
    onSelectRecording,
    runAction,
}: {
    recordings: Recording[];
    transcriptions: Map<string, TranscriptionData>;
    currentRecording: Recording | null;
    inFlightActions: Map<string, "transcribing" | "summarizing">;
    dateTimeFormat: DateTimeFormat;
    onSelectRecording: (r: Recording) => void;
    runAction: (fn: () => void) => () => void;
}) {
    if (recordings.length === 0) return null;
    const overflowCount = Math.max(0, recordings.length - RECORDING_CAP);

    return (
        <CommandGroup heading="Recent">
            {recordings.map((r) => {
                const snippet = transcriptSnippet(
                    transcriptions.get(r.id)?.text,
                );
                const inFlight = inFlightActions.get(r.id);
                const isCurrent = currentRecording?.id === r.id;

                let stateIcon: ReactNode;
                let stateLabel: string;
                if (inFlight) {
                    stateIcon = (
                        <Loader2 className="size-4 animate-spin text-primary" />
                    );
                    stateLabel =
                        inFlight === "transcribing"
                            ? "Transcribing"
                            : "Summarizing";
                } else if (!r.hasTranscript) {
                    stateIcon = (
                        <Mic className="size-4 text-muted-foreground" />
                    );
                    stateLabel = "Audio only";
                } else if (!r.hasSummary) {
                    stateIcon = (
                        <FileText className="size-4 text-foreground/70" />
                    );
                    stateLabel = "Transcribed";
                } else {
                    stateIcon = <Sparkles className="size-4 text-primary" />;
                    stateLabel = "Transcribed & summarized";
                }

                const durationText =
                    r.duration != null ? formatDurationMs(r.duration) : null;
                const timeText = formatDateTime(r.startTime, dateTimeFormat);
                const subtitle: ReactNode = snippet
                    ? snippet
                    : durationText
                      ? `${durationText} · ${timeText}`
                      : timeText;

                const searchValue = [r.filename, r.id, snippet ?? ""].join(" ");

                let accessory: ReactNode = null;
                if (inFlight === "transcribing") {
                    accessory = (
                        <span className={PILL_CLASS}>
                            <Loader2 className="size-3 animate-spin" />
                            Transcribing
                        </span>
                    );
                } else if (inFlight === "summarizing") {
                    accessory = (
                        <span className={PILL_CLASS}>
                            <Loader2 className="size-3 animate-spin" />
                            Summarizing
                        </span>
                    );
                } else if (!r.hasTranscript) {
                    // A hint, not a control: a button inside this option would be
                    // nested-interactive. ⌘↵ transcribes the highlighted recording.
                    accessory = (
                        <span className={PILL_CLASS}>
                            <Kbd>⌘↵</Kbd>
                            Transcribe
                        </span>
                    );
                } else if (isCurrent) {
                    accessory = (
                        <span className={PILL_CLASS}>
                            <span
                                aria-hidden="true"
                                className="inline-block size-1.5 rounded-full bg-primary"
                            />
                            Selected
                        </span>
                    );
                }

                return (
                    <CommandItem
                        key={r.id}
                        value={searchValue}
                        onSelect={runAction(() => onSelectRecording(r))}
                    >
                        <Row
                            icon={
                                <span title={stateLabel} aria-hidden="true">
                                    {stateIcon}
                                </span>
                            }
                            title={r.filename}
                            subtitle={subtitle}
                            accessory={accessory}
                        />
                    </CommandItem>
                );
            })}
            {overflowCount > 0 && (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                    +{overflowCount} more · refine your search to narrow the
                    list
                </div>
            )}
        </CommandGroup>
    );
}

export function ActionsGroup({
    onSync,
    onUpload,
    onOpenSettings,
    onOpenShortcuts,
    runAction,
}: {
    onSync: () => void;
    onUpload: () => void;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
    runAction: (fn: () => void) => () => void;
}) {
    return (
        <CommandGroup heading="Actions">
            <CommandItem onSelect={runAction(onSync)}>
                <Row
                    icon={
                        <RefreshCw className="size-4 text-muted-foreground" />
                    }
                    title="Sync device"
                />
            </CommandItem>
            <CommandItem onSelect={runAction(onUpload)}>
                <Row
                    icon={<Upload className="size-4 text-muted-foreground" />}
                    title="Upload audio"
                />
            </CommandItem>
            <CommandItem onSelect={runAction(onOpenSettings)}>
                <Row
                    icon={<Settings className="size-4 text-muted-foreground" />}
                    title="Open settings"
                    accessory={<Kbd>,</Kbd>}
                />
            </CommandItem>
            <CommandItem onSelect={runAction(onOpenShortcuts)}>
                <Row
                    icon={<Keyboard className="size-4 text-muted-foreground" />}
                    title="Keyboard shortcuts"
                    accessory={<Kbd>?</Kbd>}
                />
            </CommandItem>
        </CommandGroup>
    );
}

export function ThemeGroup({
    currentTheme,
    onSetTheme,
    runAction,
}: {
    currentTheme: "light" | "dark" | "system";
    onSetTheme: (t: "light" | "dark" | "system") => void;
    runAction: (fn: () => void) => () => void;
}) {
    return (
        <CommandGroup heading="Theme">
            <CommandItem onSelect={runAction(() => onSetTheme("light"))}>
                <Row
                    icon={<Sun className="size-4 text-muted-foreground" />}
                    title="Light"
                    accessory={
                        currentTheme === "light" ? (
                            <span className={PILL_CLASS}>Active</span>
                        ) : null
                    }
                />
            </CommandItem>
            <CommandItem onSelect={runAction(() => onSetTheme("dark"))}>
                <Row
                    icon={<Moon className="size-4 text-muted-foreground" />}
                    title="Dark"
                    accessory={
                        currentTheme === "dark" ? (
                            <span className={PILL_CLASS}>Active</span>
                        ) : null
                    }
                />
            </CommandItem>
            <CommandItem onSelect={runAction(() => onSetTheme("system"))}>
                <Row
                    icon={<Monitor className="size-4 text-muted-foreground" />}
                    title="Auto"
                    accessory={
                        currentTheme === "system" ? (
                            <span className={PILL_CLASS}>Active</span>
                        ) : null
                    }
                />
            </CommandItem>
        </CommandGroup>
    );
}

export function PaletteFooter({
    showTranscribeHint,
}: {
    showTranscribeHint: boolean;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd>
                    navigate
                </span>
                <span className="inline-flex items-center gap-1">
                    <Kbd>↵</Kbd>
                    select
                </span>
                <span className="inline-flex items-center gap-1">
                    <Kbd>esc</Kbd>
                    close
                </span>
                {showTranscribeHint && (
                    <span className="inline-flex items-center gap-1">
                        <Kbd>⌘</Kbd>
                        <Kbd>↵</Kbd>
                        transcribe
                    </span>
                )}
            </div>
            <span className="inline-flex items-center gap-1">
                <Kbd>⌘K</Kbd>
                toggle
            </span>
        </div>
    );
}
