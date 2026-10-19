import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { RECORDINGS_CHANGED } from "@/lib/recordings";
import { Group, Row, StackedField, ToggleRow, SettingSelect, AUTO, fromOptionValue, toOptionValue, useSettings, type CustomPrompt, type Option, type OptionGroup, type SummaryPromptConfig, type UserSettings } from "./shared";
import { SUMMARY_PROMPT_PLACEHOLDER } from "./prompt-texts";
import { t as translate, useI18n, type MessageKey } from "@/lib/i18n";

// ---------- transcription ----------

const LANGUAGE_CODES = ["en", "es", "fr", "de", "it", "pt", "nl", "sv", "da", "no", "fi", "pl", "cs", "uk", "ru", "ro", "hu", "el", "tr", "ar", "he", "hi", "id", "vi", "th", "zh", "ja", "ko"] as const;

/** The transcription languages, each named in the interface language. */
function languageOptions(): Option[] {
    return LANGUAGE_CODES.map((code) => ({ value: code, label: translate(`settings.ai.languageNames.${code}` as MessageKey) }));
}

function speakerCounts(autoLabel: string): Option[] {
    return [
        { value: AUTO, label: autoLabel },
        ...Array.from({ length: 32 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    ];
}

const QUALITY_KEYS: { value: "fast" | "balanced" | "accurate"; labelKey: MessageKey; descriptionKey: MessageKey }[] = [
    { value: "fast", labelKey: "settings.ai.qualityFast", descriptionKey: "settings.ai.qualityFastHint" },
    { value: "balanced", labelKey: "settings.ai.qualityBalanced", descriptionKey: "settings.ai.qualityBalancedHint" },
    { value: "accurate", labelKey: "settings.ai.qualityAccurate", descriptionKey: "settings.ai.qualityAccurateHint" },
];

export function TranscriptionSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const id = (name: string) => `${ids}-${name}`;
    const languages = languageOptions();
    const quality: Option[] = QUALITY_KEYS.map((q) => ({ value: q.value, label: t(q.labelKey), description: t(q.descriptionKey) }));

    return (
        <div className="grid gap-4">
            <Group>
                <ToggleRow
                    id="auto-transcribe"
                    field="autoTranscribe"
                    label={t("settings.ai.autoTranscribe")}
                    hint={t("settings.ai.autoTranscribeHint")}
                />
                <ToggleRow
                    id="import-plaud-content"
                    field="importPlaudContent"
                    label={t("settings.ai.importPlaud")}
                    hint={t("settings.ai.importPlaudHint")}
                />
                <Row htmlFor={id("transcript-mode")} label={t("settings.ai.whenPlaud")}>
                    <SettingSelect
                        id={id("transcript-mode")}
                        testId="transcript-mode"
                        value={settings.transcriptMode}
                        disabled={isSaving("transcriptMode")}
                        onValueChange={(v) => void save({ transcriptMode: v as UserSettings["transcriptMode"] })}
                        options={[
                            { value: "plaud_only", label: t("settings.ai.plaudOnly") },
                            { value: "keep_both", label: t("settings.ai.keepBoth") },
                        ]}
                        className="w-72 max-w-[55%] shrink-0"
                    />
                </Row>
                <Row htmlFor={id("preferred-source")} label={t("settings.ai.primaryTranscript")}>
                    <SettingSelect
                        id={id("preferred-source")}
                        testId="preferred-transcript-source"
                        value={settings.preferredTranscriptSource}
                        disabled={isSaving("preferredTranscriptSource")}
                        onValueChange={(v) => void save({ preferredTranscriptSource: v as UserSettings["preferredTranscriptSource"] })}
                        options={[
                            { value: "plaud", label: "Plaud" },
                            { value: "openaudiohub", label: t("settings.ai.myProvider") },
                        ]}
                        className="w-48 max-w-[55%] shrink-0"
                    />
                </Row>
            </Group>

            <Group>
                <Row
                    htmlFor={id("language")}
                    label={t("settings.ai.defaultLanguage")}
                    hint={t("settings.ai.defaultLanguageHint")}
                >
                    <SettingSelect
                        id={id("language")}
                        testId="transcription-language"
                        value={toOptionValue(settings.defaultTranscriptionLanguage)}
                        disabled={isSaving("defaultTranscriptionLanguage")}
                        onValueChange={(v) => void save({ defaultTranscriptionLanguage: fromOptionValue(v) })}
                        options={[{ value: AUTO, label: t("settings.ai.autoDetect") }, ...languages]}
                        className="w-64 max-w-[55%] shrink-0"
                    />
                </Row>
                <ToggleRow
                    id="speaker-diarization"
                    field="speakerDiarization"
                    label={t("settings.ai.speakerLabels")}
                    hint={t("settings.ai.speakerLabelsHint")}
                />
                {settings.speakerDiarization ? (
                    <Row
                        htmlFor={id("speaker-count")}
                        label={t("settings.ai.expectedSpeakers")}
                        hint={t("settings.ai.expectedSpeakersHint")}
                        className="border-l-2 border-primary/20 py-3 pl-4"
                    >
                        <SettingSelect
                            id={id("speaker-count")}
                            testId="diarization-speaker-count"
                            value={settings.diarizationSpeakerCount === null ? AUTO : String(settings.diarizationSpeakerCount)}
                            disabled={isSaving("diarizationSpeakerCount")}
                            onValueChange={(v) => void save({ diarizationSpeakerCount: v === AUTO ? null : Number(v) })}
                            options={speakerCounts(t("settings.ai.auto"))}
                            className="w-64 max-w-[55%] shrink-0"
                        />
                    </Row>
                ) : null}
                <Row htmlFor={id("quality")} label={t("settings.ai.quality")} hint={t("settings.ai.qualityHint")}>
                    <SettingSelect
                        id={id("quality")}
                        testId="transcription-quality"
                        value={settings.transcriptionQuality}
                        disabled={isSaving("transcriptionQuality")}
                        onValueChange={(v) => void save({ transcriptionQuality: v as UserSettings["transcriptionQuality"] })}
                        options={quality}
                        className="w-64 max-w-[55%] shrink-0"
                    />
                </Row>
            </Group>
        </div>
    );
}

// ---------- summary ----------

const SUMMARY_PRESET_KEYS: { value: string; labelKey: MessageKey; descriptionKey: MessageKey }[] = [
    { value: "general", labelKey: "settings.ai.presets.general", descriptionKey: "settings.ai.presets.generalHint" },
    { value: "meeting-notes", labelKey: "settings.ai.presets.meeting", descriptionKey: "settings.ai.presets.meetingHint" },
    { value: "interview", labelKey: "settings.ai.presets.interview", descriptionKey: "settings.ai.presets.interviewHint" },
    { value: "call", labelKey: "settings.ai.presets.call", descriptionKey: "settings.ai.presets.callHint" },
    { value: "lecture", labelKey: "settings.ai.presets.lecture", descriptionKey: "settings.ai.presets.lectureHint" },
    { value: "brainstorm", labelKey: "settings.ai.presets.brainstorm", descriptionKey: "settings.ai.presets.brainstormHint" },
    { value: "voice-memo", labelKey: "settings.ai.presets.voiceMemo", descriptionKey: "settings.ai.presets.voiceMemoHint" },
    { value: "key-points", labelKey: "settings.ai.presets.keyPoints", descriptionKey: "settings.ai.presets.keyPointsHint" },
    { value: "action-items", labelKey: "settings.ai.presets.actionItems", descriptionKey: "settings.ai.presets.actionItemsHint" },
];

/** The built-in presets in the current language. */
function summaryPresets(): Option[] {
    return SUMMARY_PRESET_KEYS.map((p) => ({ value: p.value, label: translate(p.labelKey), description: translate(p.descriptionKey) }));
}

const OUTPUT_LANGUAGE_CODES = [AUTO, "zh", "en", "ja", "ko"] as const;

/** Output languages: Auto plus the four languages summaries are offered in. */
function outputLanguages(): Option[] {
    return OUTPUT_LANGUAGE_CODES.map((code) => ({
        value: code,
        label: code === AUTO ? translate("settings.ai.autoMatch") : translate(`settings.ai.languageNames.${code}` as MessageKey),
    }));
}

export const DEFAULT_PROMPT_CONFIG: SummaryPromptConfig = { selectedPrompt: "general", customPrompts: [] };

export function presetGroups(customPrompts: CustomPrompt[], builtIn: Option[] = summaryPresets()): OptionGroup[] {
    const groups: OptionGroup[] = [{ label: translate("settings.ai.builtIn"), options: builtIn }];
    if (customPrompts.length > 0) {
        groups.push({ label: translate("settings.ai.custom"), options: customPrompts.map((p) => ({ value: p.id, label: p.name })) });
    }
    return groups;
}

/** The toast when a prompt save fails: resolved in the current language at call time. */
export function promptSaveFailed(): string {
    return translate("settings.ai.promptSaveFailed");
}
/** The toast when a prompt delete fails: resolved in the current language at call time. */
export function promptDeleteFailed(): string {
    return translate("settings.ai.promptDeleteFailed");
}

export function SummarySection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const id = (name: string) => `${ids}-${name}`;
    const config: SummaryPromptConfig = settings.summaryPrompt ?? DEFAULT_PROMPT_CONFIG;
    const [editor, setEditor] = useState<{ prompt: CustomPrompt | null } | null>(null);
    const [viewing, setViewing] = useState<CustomPrompt | null>(null);
    const [deleting, setDeleting] = useState<CustomPrompt | null>(null);

    const groups = presetGroups(config.customPrompts, summaryPresets());

    const saveList = async (customPrompts: CustomPrompt[]): Promise<boolean> => save({ summaryPrompt: { ...config, customPrompts } }, promptSaveFailed());

    const removePrompt = async (target: CustomPrompt) => {
        const next: SummaryPromptConfig = {
            selectedPrompt: config.selectedPrompt === target.id ? "general" : config.selectedPrompt,
            customPrompts: config.customPrompts.filter((p) => p.id !== target.id),
        };
        const ok = await save({ summaryPrompt: next }, promptDeleteFailed());
        if (ok) toast.success(t("settings.ai.promptDeleted"));
    };

    return (
        <div className="grid gap-6">
            <div className="grid gap-4">
                <StackedField
                    htmlFor={id("preset")}
                    label={t("settings.ai.defaultPrompt")}
                    hint={t("settings.ai.defaultPromptHint")}
                >
                    <SettingSelect
                        id={id("preset")}
                        testId="summary-preset"
                        value={config.selectedPrompt}
                        groups={groups}
                        disabled={isSaving("summaryPrompt")}
                        onValueChange={(v) => void save({ summaryPrompt: { ...config, selectedPrompt: v } })}
                        className="w-full"
                    />
                </StackedField>
                <StackedField
                    htmlFor={id("output-language")}
                    label={t("settings.ai.outputLanguage")}
                    hint={t("settings.ai.outputLanguageHint")}
                >
                    <SettingSelect
                        id={id("output-language")}
                        testId="ai-output-language"
                        value={toOptionValue(settings.aiOutputLanguage)}
                        disabled={isSaving("aiOutputLanguage")}
                        onValueChange={(v) => void save({ aiOutputLanguage: fromOptionValue(v) })}
                        options={outputLanguages()}
                        className="w-full"
                    />
                </StackedField>
                <ToggleRow
                    id="auto-summarize"
                    field="autoSummarize"
                    label={t("settings.ai.autoSummarize")}
                    hint={t("settings.ai.autoSummarizeHint")}
                    className="border-t border-border py-3"
                />
                <StackedField htmlFor={id("auto-preset")} label={t("settings.ai.autoPreset")}>
                    <SettingSelect
                        id={id("auto-preset")}
                        testId="auto-summarize-preset"
                        value={settings.autoSummarizePreset ?? "general"}
                        groups={groups}
                        disabled={isSaving("autoSummarizePreset")}
                        onValueChange={(v) => void save({ autoSummarizePreset: v })}
                        className="w-full"
                    />
                </StackedField>
            </div>

            <section className="grid gap-4 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[13px] font-semibold text-foreground">{t("settings.ai.customPrompts")}</h2>
                    <Button variant="primary" className="px-3" onClick={() => setEditor({ prompt: null })}>
                        <Plus />
                        {t("settings.ai.addPrompt")}
                    </Button>
                </div>
                {config.customPrompts.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">{t("settings.ai.noPrompts")}</p>
                ) : (
                    <div className="divide-y divide-border">
                        {config.customPrompts.map((p) => (
                            <div key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                                <p className="min-w-0 truncate text-[13px] font-medium">{p.name}</p>
                                <div className="flex shrink-0 items-center gap-2">
                                    <Button variant="secondary" className="px-3" onClick={() => setViewing(p)}>
                                        {t("settings.ai.view")}
                                    </Button>
                                    <Button variant="secondary" size="icon" className="sm:size-9" aria-label={t("settings.ai.editPrompt", { name: p.name })} onClick={() => setEditor({ prompt: p })}>
                                        <Pencil />
                                    </Button>
                                    <Button variant="secondary" size="icon" className="sm:size-9" aria-label={t("settings.ai.deletePrompt", { name: p.name })} onClick={() => setDeleting(p)}>
                                        <Trash2 className="text-destructive" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {viewing ? <PromptViewDialog title={viewing.name} text={viewing.prompt} onClose={() => setViewing(null)} /> : null}

            {editor ? (
                <PromptEditDialog
                    key={editor.prompt?.id ?? "new"}
                    existing={editor.prompt}
                    kind="summary"
                    onClose={() => setEditor(null)}
                    onSave={async (item) => {
                        const customPrompts = editor.prompt
                            ? config.customPrompts.map((p) => (p.id === item.id ? item : p))
                            : [...config.customPrompts, item];
                        const ok = await saveList(customPrompts);
                        if (ok) toast.success(t("settings.ai.promptSaved"));
                        return ok;
                    }}
                />
            ) : null}

            {deleting ? (
                <DeletePromptDialog
                    onCancel={() => setDeleting(null)}
                    onConfirm={() => {
                        const target = deleting;
                        setDeleting(null);
                        void removePrompt(target);
                    }}
                />
            ) : null}
        </div>
    );
}

// ---------- shared prompt dialogs ----------

const PROMPT_COPY = {
    summary: {
        createKey: "settings.ai.createSummaryPrompt",
        placeholder: SUMMARY_PROMPT_PLACEHOLDER,
        testId: "custom-summary-prompt",
    },
    title: {
        createKey: "settings.ai.createTitlePrompt",
        placeholder: "",
        testId: "custom-title-prompt",
    },
} as const;

/** Create or edit one custom prompt. The save button stays disabled until the name and the prompt are filled. */
/** A prompt dialog intro with the inline `{transcription}` placeholder shown as a code chip. */
function promptIntro(key: MessageKey): ReactNode {
    const pieces = translate(key).split("{placeholder}");
    return (
        <>
            {pieces[0]}
            {pieces.length > 1 ? <code className="rounded bg-muted px-1 py-0.5">{"{transcription}"}</code> : null}
            {pieces.slice(1).join("{placeholder}")}
        </>
    );
}

export function PromptEditDialog({
    existing,
    kind,
    onClose,
    onSave,
    placeholder,
}: {
    existing: CustomPrompt | null;
    kind: keyof typeof PROMPT_COPY;
    onClose: () => void;
    /** Resolves true when the prompt was saved. The dialog closes then. */
    onSave: (item: CustomPrompt) => Promise<boolean>;
    placeholder?: string;
}) {
    const { t } = useI18n();
    const copy = PROMPT_COPY[kind];
    const ids = useId();
    const [name, setName] = useState(existing?.name ?? "");
    const [prompt, setPrompt] = useState(existing?.prompt ?? "");
    const [saving, setSaving] = useState(false);
    const ready = name.trim() !== "" && prompt.trim() !== "";

    const submit = async () => {
        if (!ready) {
            toast.error(t("settings.ai.nameAndPromptRequired"));
            return;
        }
        setSaving(true);
        const item: CustomPrompt = existing
            ? { ...existing, name: name.trim(), prompt: prompt.trim() }
            : { id: `prompt-${Date.now().toString(36)}`, name: name.trim(), prompt: prompt.trim(), createdAt: new Date().toISOString() };
        const ok = await onSave(item);
        setSaving(false);
        if (ok) onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>{existing ? t("settings.ai.editCustomPrompt") : t("settings.ai.createCustomPrompt")}</DialogTitle>
                <DialogDescription>{promptIntro(copy.createKey)}</DialogDescription>
                <div className="grid gap-4">
                    <StackedField htmlFor={`${ids}-name`} label={t("settings.ai.nameLabel")}>
                        <Input
                            id={`${ids}-name`}
                            data-testid={`${copy.testId}-name`}
                            placeholder={t("settings.ai.namePlaceholder")}
                            value={name}
                            className="h-9 sm:h-9"
                            onChange={(e) => setName(e.target.value)}
                        />
                    </StackedField>
                    <StackedField htmlFor={`${ids}-text`} label={t("settings.ai.promptLabel")}>
                        <Textarea
                            id={`${ids}-text`}
                            data-testid={`${copy.testId}-text`}
                            rows={8}
                            placeholder={placeholder ?? copy.placeholder}
                            value={prompt}
                            className="min-h-[300px] resize-y py-2 font-mono text-sm leading-normal"
                            onChange={(e) => setPrompt(e.target.value)}
                        />
                    </StackedField>
                </div>
                <div className="flex justify-end gap-2">
                    <Button variant="secondary" className="px-4" onClick={onClose}>
                        {t("settings.ai.cancel")}
                    </Button>
                    <Button variant="primary" className="px-4" disabled={!ready || saving} onClick={() => void submit()}>
                        {saving ? <Spinner label={t("settings.ai.savingPrompt")} /> : null}
                        {existing ? t("settings.ai.save") : t("settings.ai.create")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Read-only view of a built-in or custom prompt. */
export function PromptViewDialog({ title, description, text, onClose }: { title: string; description?: string; text: string; onClose: () => void }) {
    const { t } = useI18n();
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[80vh] overflow-y-auto">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className={description ? undefined : "sr-only"}>{description ?? t("settings.ai.customPromptFallback")}</DialogDescription>
                <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm whitespace-pre-wrap">{text}</pre>
            </DialogContent>
        </Dialog>
    );
}

/** Confirms removal of a custom prompt. */
export function DeletePromptDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    const { t } = useI18n();
    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent>
                <DialogTitle>{t("settings.ai.deletePromptTitle")}</DialogTitle>
                <DialogDescription>{t("settings.ai.deletePromptBody")}</DialogDescription>
                <DialogFooter>
                    <Button variant="secondary" onClick={onCancel}>
                        {t("settings.ai.cancel")}
                    </Button>
                    <Button variant="destructive" onClick={onConfirm}>
                        {t("settings.ai.delete")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------- recording names ----------

const TITLE_MODES: { value: UserSettings["recordingTitleMode"]; labelKey: MessageKey; hintKey: MessageKey; testId: string }[] = [
    { value: "original", labelKey: "settings.ai.nameOriginal", hintKey: "settings.ai.nameOriginalHint", testId: "recording-title-mode-original" },
    { value: "date", labelKey: "settings.ai.nameDate", hintKey: "settings.ai.nameDateHint", testId: "recording-title-mode-date" },
    { value: "ai", labelKey: "settings.ai.nameAi", hintKey: "settings.ai.nameAiHint", testId: "recording-title-mode-ai" },
];

interface TitleCandidate {
    id: string;
    filename: string;
    suggestedFilename: string;
    startTime: string;
}

export function NamingSection() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();

    return (
        <div className="grid gap-4">
            <div role="radiogroup" aria-label={t("settings.ai.recordingName")} className="divide-y divide-border rounded-xl bg-muted px-4">
                {TITLE_MODES.map((mode) => {
                    const itemId = `${ids}-${mode.value}`;
                    return (
                        <label
                            key={mode.value}
                            htmlFor={itemId}
                            className="flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-[13px] font-normal select-none"
                        >
                            <input
                                id={itemId}
                                type="radio"
                                name={`${ids}-title-mode`}
                                value={mode.value}
                                data-testid={mode.testId}
                                checked={settings.recordingTitleMode === mode.value}
                                disabled={isSaving("recordingTitleMode")}
                                onChange={() => void save({ recordingTitleMode: mode.value })}
                                className="mt-0.5 size-4 shrink-0 accent-primary"
                            />
                            <span className="min-w-0 flex-1 space-y-0.5">
                                <span className="block text-[13px] font-medium">{t(mode.labelKey)}</span>
                                <span className="block text-xs text-muted-foreground">{t(mode.hintKey)}</span>
                            </span>
                        </label>
                    );
                })}
            </div>
            <div className="rounded-xl bg-muted px-4">
                <ToggleRow
                    id="sync-title-plaud"
                    field="syncTitleToPlaud"
                    label={t("settings.ai.syncTitle")}
                    hint={t("settings.ai.syncTitleHint")}
                />
            </div>
            <DateTitleRepair />
        </div>
    );
}

/**
 * Fixes titles written before the date mode used plain dates.
 *
 * Candidates are listed, never applied on their own: a date-time title cannot prove it was
 * generated rather than typed, so the user picks.
 */
function DateTitleRepair() {
    const { t } = useI18n();
    const ids = useId();
    const [candidates, setCandidates] = useState<TitleCandidate[] | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<unknown>(null);

    const check = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api<{ candidates: TitleCandidate[] }>("/api/recordings/title-repair");
            setCandidates(data.candidates);
            setPicked(new Set());
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void check();
    }, [check]);

    const toggle = (id: string) => {
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const apply = async () => {
        if (!candidates) return;
        setApplying(true);
        try {
            const picks = candidates
                .filter((c) => picked.has(c.id))
                .map((c) => ({ id: c.id, expectedFilename: c.filename }));
            const result = await api<{ renamed: { id: string; filename: string }[]; skipped: { id: string; reason: string }[] }>(
                "/api/recordings/title-repair",
                { method: "POST", json: { picks } },
            );
            if (result.renamed.length > 0) {
                toast.success(result.renamed.length === 1 ? t("settings.ai.titleUpdated") : t("settings.ai.titlesUpdated", { count: result.renamed.length }));
            }
            if (result.skipped.length > 0) {
                toast.message(result.skipped.length === 1 ? t("settings.ai.titleSkipped") : t("settings.ai.titlesSkipped", { count: result.skipped.length }));
            }
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
            await check();
        } catch (err) {
            toast.error(errorMessage(err, t("settings.ai.couldNotUpdateTitles")));
        } finally {
            setApplying(false);
        }
    };

    const open = (candidates?.length ?? 0) > 0;

    return (
        <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                    <h2 className="text-[13px] font-semibold text-foreground">{t("settings.ai.dateTitles")}</h2>
                    <p className="text-xs text-muted-foreground">{t("settings.ai.dateTitlesHint")}</p>
                </div>
                <Button variant="secondary" className="px-3" disabled={loading || applying} onClick={() => void check()}>
                    {loading ? <Spinner /> : null}
                    {t("settings.ai.checkTitles")}
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(error, t("settings.ai.couldNotReadTitles"))}
                </p>
            ) : null}
            {candidates === null ? null : !open ? (
                <p className="text-sm text-muted-foreground">{t("settings.ai.noTitlesToFix")}</p>
            ) : (
                <>
                    <ul data-testid="title-repair-list" className="divide-y divide-border rounded-xl bg-muted px-4">
                        {candidates.map((candidate) => (
                            <li key={candidate.id} className="flex items-start gap-3 py-2.5">
                                <input
                                    type="checkbox"
                                    id={`${ids}-repair-${candidate.id}`}
                                    data-testid="title-repair-item"
                                    checked={picked.has(candidate.id)}
                                    onChange={() => toggle(candidate.id)}
                                    className="mt-0.5 size-4 shrink-0 accent-primary"
                                />
                                <label htmlFor={`${ids}-repair-${candidate.id}`} className="min-w-0 flex-1 text-[13px] font-normal">
                                    <span className="block truncate">{candidate.filename}</span>
                                    <span className="block text-xs text-muted-foreground">{t("settings.ai.becomes", { name: candidate.suggestedFilename })}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="flex justify-end">
                        <Button variant="primary" className="px-3" disabled={picked.size === 0 || applying} onClick={() => void apply()}>
                            {applying ? <Spinner /> : null}
                            {t("settings.ai.updateSelected")}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}

