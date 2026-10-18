import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { type ThemeChoice } from "@/lib/theme";
import { type SectionDef } from "./nav";

// ---------- settings record ----------

export interface CustomPrompt {
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
}

export interface SummaryPromptConfig {
    selectedPrompt: string;
    customPrompts: CustomPrompt[];
}

/** The fields the web settings sections read and write. Fields not listed here are left alone by PUT. */
export interface UserSettings {
    userEmail: string;
    autoTranscribe: boolean;
    autoSummarize: boolean;
    autoSummarizePreset: string | null;
    syncInterval: number;
    autoSyncEnabled: boolean;
    syncOnMount: boolean;
    syncOnVisibilityChange: boolean;
    syncNotifications: boolean;
    defaultPlaybackSpeed: number;
    defaultVolume: number;
    autoPlayNext: boolean;
    playerScrubber: "waveform" | "slider";
    defaultTranscriptionLanguage: string | null;
    transcriptionQuality: "fast" | "balanced" | "accurate";
    speakerDiarization: boolean;
    diarizationSpeakerCount: number | null;
    dateTimeFormat: "relative" | "absolute" | "iso";
    recordingListSortOrder: "newest" | "oldest" | "name";
    itemsPerPage: number;
    theme: ThemeChoice;
    autoDeleteRecordings: boolean;
    retentionDays: number | null;
    browserNotifications: boolean;
    notificationSound: boolean;
    defaultExportFormat: "json" | "txt" | "srt" | "vtt";
    onboardingCompleted: boolean;
    recordingTitleMode: "original" | "date" | "ai";
    syncTitleToPlaud: boolean;
    aiOutputLanguage: string | null;
    importPlaudContent: boolean;
    transcriptMode: "plaud_only" | "keep_both";
    preferredTranscriptSource: "plaud" | "openaudiohub";
    summaryPrompt?: SummaryPromptConfig | null;
    titleGenerationPrompt?: SummaryPromptConfig | null;
    emailNotifications: boolean;
    notificationEmail: string | null;
    barkNotifications: boolean;
    barkPushUrl: string | null;
    barkPushUrlSet: boolean;
    marketingEmailConsent: boolean;
}

export type SettingsPatch = Partial<UserSettings>;

/** The settings that are switches. */
export type BoolSettingKey = {
    [K in keyof UserSettings]-?: NonNullable<UserSettings[K]> extends boolean ? K : never;
}[keyof UserSettings];

export interface SettingsContextValue {
    settings: UserSettings;
    /**
     * Saves the changed fields at once. Returns false when the save failed. On failure it shows `failure`
     * as a toast (null for no toast) and reverts the fields, unless `keepOnFailure` is true, in which case
     * the new values stay on screen.
     */
    save: (patch: SettingsPatch, failure?: string | null, keepOnFailure?: boolean) => Promise<boolean>;
    /** True while a save for this field is running. Its control is disabled meanwhile. */
    isSaving: (field: keyof UserSettings) => boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export const SAVE_FAILED = "Failed to save settings. Changes reverted.";

/** Loads the account's settings once and gives the sections a save function. */
export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<UserSettings | null>(null);
    const [failed, setFailed] = useState(false);
    const [saving, setSaving] = useState<Set<string>>(() => new Set());
    const current = useRef<UserSettings | null>(null);

    useEffect(() => {
        let alive = true;
        api<UserSettings>("/api/settings/user")
            .then((data) => {
                if (!alive) return;
                current.current = data;
                setSettings(data);
            })
            .catch(() => {
                if (alive) setFailed(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    const save = useCallback(async (patch: SettingsPatch, failure: string | null = SAVE_FAILED, keepOnFailure = false): Promise<boolean> => {
        const base = current.current;
        if (!base) return false;
        const keys = Object.keys(patch) as (keyof UserSettings)[];
        const previous: SettingsPatch = {};
        for (const key of keys) (previous as Record<string, unknown>)[key] = base[key];

        const next = { ...base, ...patch };
        current.current = next;
        setSettings(next);
        setSaving((s) => new Set([...s, ...keys]));
        try {
            await api("/api/settings/user", { method: "PUT", json: patch });
            return true;
        } catch {
            if (!keepOnFailure) {
                const reverted = { ...(current.current ?? base), ...previous };
                current.current = reverted;
                setSettings(reverted);
            }
            if (failure) toast.error(failure);
            return false;
        } finally {
            setSaving((s) => {
                const out = new Set(s);
                for (const key of keys) out.delete(key);
                return out;
            });
        }
    }, []);

    const value = useMemo<SettingsContextValue | null>(
        () =>
            settings
                ? {
                      settings,
                      save,
                      isSaving: (field) => saving.has(field),
                  }
                : null,
        [settings, save, saving],
    );

    if (failed) {
        return (
            <p role="alert" className="text-sm text-destructive">
                Settings could not be loaded. Reload the page to try again.
            </p>
        );
    }
    if (!value) {
        return (
            <div className="flex justify-center py-12">
                <Spinner label="Loading settings" />
            </div>
        );
    }
    return <SettingsContext value={value}>{children}</SettingsContext>;
}

export function useSettings(): SettingsContextValue {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
    return ctx;
}

// ---------- layout pieces ----------

/** The page of one section: a tile, the title and a one-line description. `action` sits at the right of the header. */
export function SectionFrame({ section, action, children }: { section: SectionDef; action?: ReactNode; children: ReactNode }) {
    const Icon: LucideIcon = section.icon;
    return (
        <div data-testid={`settings-section-${section.id}`} className="mx-auto flex w-full min-w-0 max-w-3xl animate-in flex-col gap-7 fade-in-0 duration-200">
            {section.id !== "providers" ? (
                <header className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", section.tile)} aria-hidden="true">
                            <Icon className="size-5 text-primary-foreground" />
                        </span>
                        <div className="min-w-0">
                            <h1 className="text-[22px] font-bold tracking-tight text-foreground">{section.title}</h1>
                            <p className="mt-0.5 text-[13px] text-muted-foreground">{section.description}</p>
                        </div>
                    </div>
                    {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
                </header>
            ) : null}
            {children}
        </div>
    );
}

/** A labelled list of rows, shown as a grouped muted container. The label, when given, sits above it. */
export function Group({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-1.5">
            {label ? (
                <div className="flex items-end justify-between gap-4">
                    <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold text-foreground">{label}</h2>
                </div>
            ) : null}
            <div className="divide-y divide-border rounded-xl bg-muted px-4">{children}</div>
        </section>
    );
}

/** One row of a grouped list: label and hint on the left, the control on the right. */
export function Row({
    htmlFor,
    label,
    hint,
    children,
    className,
}: {
    htmlFor?: string;
    label: ReactNode;
    hint?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex min-h-11 items-center justify-between gap-4 py-2.5", className)}>
            <div className="min-w-0 flex-1 space-y-0.5">
                {htmlFor ? (
                    <Label htmlFor={htmlFor} className="block text-[13px] font-medium">
                        {label}
                    </Label>
                ) : (
                    <p className="text-[13px] font-medium text-foreground">{label}</p>
                )}
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <div className="flex min-w-0 max-w-full shrink-0 items-center justify-end gap-2">{children}</div>
        </div>
    );
}

/** A label above its control, with an optional hint under it. */
export function StackedField({ htmlFor, label, hint, children }: { htmlFor?: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
    return (
        <div className="grid gap-2">
            <Label htmlFor={htmlFor} className="text-[13px] font-medium">
                {label}
            </Label>
            {children}
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
    );
}

/** A switch bound to one boolean setting. It saves at once. */
export function ToggleRow({
    id,
    field,
    label,
    hint,
    className,
}: {
    id: string;
    field: BoolSettingKey;
    label: string;
    hint?: string;
    className?: string;
}) {
    const { settings, save, isSaving } = useSettings();
    return (
        <Row htmlFor={id} label={label} hint={hint} className={className}>
            <Switch
                id={id}
                className="h-[22px] w-[38px] p-px"
                checked={Boolean(settings[field])}
                disabled={isSaving(field)}
                onCheckedChange={(next) => void save({ [field]: next } as SettingsPatch)}
            />
        </Row>
    );
}

// ---------- option select (with test id support) ----------

export interface Option {
    value: string;
    label: string;
    /** Shown under the label in the list only. The trigger shows the label. */
    description?: string;
    disabled?: boolean;
}

export interface OptionGroup {
    label: string;
    options: Option[];
}

export interface SettingSelectProps {
    id?: string;
    testId?: string;
    value: string;
    onValueChange: (value: string) => void;
    options?: Option[];
    groups?: OptionGroup[];
    disabled?: boolean;
    placeholder?: string;
    "aria-label"?: string;
    className?: string;
}

/** Single choice from a list. Options must use non-empty values. */
export function SettingSelect({
    id,
    testId,
    value,
    onValueChange,
    options,
    groups,
    disabled,
    placeholder,
    className,
    ...aria
}: SettingSelectProps) {
    const all = groups ? groups.flatMap((g) => g.options) : (options ?? []);
    const itemFor = (option: Option) => (
        <S.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="relative flex min-h-10 cursor-default select-none items-center rounded-md py-1 pl-8 pr-2 text-sm text-foreground outline-none sm:min-h-8 data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
        >
            <span className="absolute left-2 flex size-4 items-center justify-center">
                <S.ItemIndicator>
                    <Check className="size-4" aria-hidden="true" />
                </S.ItemIndicator>
            </span>
            {option.description ? (
                <span className="flex min-w-0 flex-col">
                    <S.ItemText>{option.label}</S.ItemText>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
            ) : (
                <S.ItemText>{option.label}</S.ItemText>
            )}
        </S.Item>
    );
    return (
        <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <S.Trigger
                id={id}
                data-testid={testId}
                aria-label={aria["aria-label"]}
                className={cn(
                    "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm whitespace-nowrap text-foreground shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
                    // Radix drops `className` on Select.Value, so the selected text is clamped here:
                    // it shrinks inside the trigger and ends in an ellipsis instead of running over
                    // the chevron or outside the box.
                    "[&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:truncate [&>span:first-child]:text-left [&>svg]:shrink-0",
                    className,
                )}
            >
                <S.Value placeholder={placeholder}>
                    {all.find((o) => o.value === value)?.label ?? null}
                </S.Value>
                <S.Icon asChild>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </S.Icon>
            </S.Trigger>
            <S.Portal>
                <S.Content
                    position="popper"
                    sideOffset={6}
                    className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground shadow-card"
                >
                    <S.Viewport>
                        {groups
                            ? groups.map((group) => (
                                  <S.Group key={group.label}>
                                      <S.Label className="px-2 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                                          {group.label}
                                      </S.Label>
                                      {group.options.map(itemFor)}
                                  </S.Group>
                              ))
                            : (options ?? []).map(itemFor)}
                    </S.Viewport>
                </S.Content>
            </S.Portal>
        </S.Root>
    );
}

// ---------- debounced number input ----------

export interface NumberFieldProps {
    id: string;
    testId?: string;
    value: number | null;
    min: number;
    max: number;
    /** Empty text commits null when true. Otherwise empty text is ignored. */
    allowEmpty?: boolean;
    placeholder?: string;
    disabled?: boolean;
    onCommit: (value: number | null) => void;
    delayMs?: number;
}

/**
 * Whole-number input. Invalid text is ignored. A valid value is committed after a short pause or on blur,
 * and only when it differs from the stored value.
 */
export function NumberField({
    id,
    testId,
    value,
    min,
    max,
    allowEmpty = false,
    placeholder,
    disabled,
    onCommit,
    delayMs = 500,
}: NumberFieldProps) {
    const [draft, setDraft] = useState(value === null ? "" : String(value));
    const timer = useRef<number | undefined>(undefined);
    const stored = useRef(value);
    stored.current = value;
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    // Keep the text in step with the stored value (after a save, or after a revert).
    useEffect(() => {
        setDraft(value === null ? "" : String(value));
    }, [value]);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    const parse = (text: string): number | null | undefined => {
        if (text.trim() === "") return allowEmpty ? null : undefined;
        if (!/^\d+$/.test(text.trim())) return undefined;
        const n = Number(text);
        return n >= min && n <= max ? n : undefined;
    };

    const commit = (text: string) => {
        const parsed = parse(text);
        if (parsed === undefined) return;
        if (parsed === stored.current) return;
        commitRef.current(parsed);
    };

    return (
        <input
            id={id}
            data-testid={testId}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            disabled={disabled}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => {
                const text = e.target.value;
                setDraft(text);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => commit(text), delayMs);
            }}
            onBlur={(e) => {
                window.clearTimeout(timer.current);
                commit(e.target.value);
            }}
            className={cn(
                "h-9 w-32 min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 tabular-nums",
            )}
        />
    );
}

// ---------- helpers ----------

/** A value the option list uses for "not set" (Radix needs non-empty values). */
export const AUTO = "auto";

export function toOptionValue(value: string | null | undefined): string {
    return value ? value : AUTO;
}

export function fromOptionValue(value: string): string | null {
    return value === AUTO ? null : value;
}

/** Text shown while a page-level request runs. */
export function Loading({ label }: { label: string }) {
    return (
        <div className="flex justify-center py-10">
            <Spinner label={label} />
        </div>
    );
}

export function ErrorText({ error, fallback }: { error: unknown; fallback: string }) {
    return (
        <p role="alert" className="text-sm text-destructive">
            {errorMessage(error, fallback)}
        </p>
    );
}

/** A failed load: the message and a Retry button that runs `onRetry` again. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
            <p className="text-sm text-destructive">{message}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
            </Button>
        </div>
    );
}
