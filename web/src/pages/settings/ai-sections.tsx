import { useCallback, useEffect, useId, useState } from "react";
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

// ---------- transcription ----------

const LANGUAGES: Option[] = [
    ["en", "English"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["pt", "Portuguese"],
    ["nl", "Dutch"],
    ["sv", "Swedish"],
    ["da", "Danish"],
    ["no", "Norwegian"],
    ["fi", "Finnish"],
    ["pl", "Polish"],
    ["cs", "Czech"],
    ["uk", "Ukrainian"],
    ["ru", "Russian"],
    ["ro", "Romanian"],
    ["hu", "Hungarian"],
    ["el", "Greek"],
    ["tr", "Turkish"],
    ["ar", "Arabic"],
    ["he", "Hebrew"],
    ["hi", "Hindi"],
    ["id", "Indonesian"],
    ["vi", "Vietnamese"],
    ["th", "Thai"],
    ["zh", "Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
].map(([value, label]) => ({ value, label }));

const SPEAKER_COUNTS: Option[] = [
    { value: AUTO, label: "Auto" },
    ...Array.from({ length: 32 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
];

const QUALITY: Option[] = [
    { value: "fast", label: "Fast", description: "Faster transcription, lower accuracy" },
    { value: "balanced", label: "Balanced", description: "Good balance of speed and accuracy" },
    { value: "accurate", label: "Accurate", description: "Highest accuracy, slower transcription" },
];

export function TranscriptionSection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const id = (name: string) => `${ids}-${name}`;

    return (
        <div className="grid gap-4">
            <Group>
                <ToggleRow
                    id="auto-transcribe"
                    field="autoTranscribe"
                    label="Auto-transcribe new recordings"
                    hint="Transcribe new recordings on their own as soon as they arrive from your Plaud device"
                />
                <ToggleRow
                    id="import-plaud-content"
                    field="importPlaudContent"
                    label="Import Plaud transcripts and summaries"
                    hint="If Plaud already transcribed a recording, bring its transcript and summary over on the next sync instead of spending a provider call on it again."
                />
                <Row htmlFor={id("transcript-mode")} label="When Plaud has a transcript">
                    <SettingSelect
                        id={id("transcript-mode")}
                        testId="transcript-mode"
                        value={settings.transcriptMode}
                        disabled={isSaving("transcriptMode")}
                        onValueChange={(v) => void save({ transcriptMode: v as UserSettings["transcriptMode"] })}
                        options={[
                            { value: "plaud_only", label: "Use Plaud only (saves AI credits)" },
                            { value: "keep_both", label: "Keep both — also run my provider" },
                        ]}
                        className="w-72 max-w-[55%] shrink-0"
                    />
                </Row>
                <Row htmlFor={id("preferred-source")} label="Primary transcript">
                    <SettingSelect
                        id={id("preferred-source")}
                        testId="preferred-transcript-source"
                        value={settings.preferredTranscriptSource}
                        disabled={isSaving("preferredTranscriptSource")}
                        onValueChange={(v) => void save({ preferredTranscriptSource: v as UserSettings["preferredTranscriptSource"] })}
                        options={[
                            { value: "plaud", label: "Plaud" },
                            { value: "openaudiohub", label: "My provider" },
                        ]}
                        className="w-48 max-w-[55%] shrink-0"
                    />
                </Row>
            </Group>

            <Group>
                <Row
                    htmlFor={id("language")}
                    label="Default transcription language"
                    hint="Language to use for transcription. Auto-detect will identify the language automatically."
                >
                    <SettingSelect
                        id={id("language")}
                        testId="transcription-language"
                        value={toOptionValue(settings.defaultTranscriptionLanguage)}
                        disabled={isSaving("defaultTranscriptionLanguage")}
                        onValueChange={(v) => void save({ defaultTranscriptionLanguage: fromOptionValue(v) })}
                        options={[{ value: AUTO, label: "Auto-detect" }, ...LANGUAGES]}
                        className="w-64 max-w-[55%] shrink-0"
                    />
                </Row>
                <ToggleRow
                    id="speaker-diarization"
                    field="speakerDiarization"
                    label="Speaker labels"
                    hint="Breaks the transcript down by speaker (Speaker 1:, Speaker 2:). Only ElevenLabs Scribe handles this; other providers ignore it."
                />
                {settings.speakerDiarization ? (
                    <Row
                        htmlFor={id("speaker-count")}
                        label="Expected speakers"
                        hint="A hint, not a hard limit. Auto works well for most recordings."
                        className="border-l-2 border-primary/20 py-3 pl-4"
                    >
                        <SettingSelect
                            id={id("speaker-count")}
                            testId="diarization-speaker-count"
                            value={settings.diarizationSpeakerCount === null ? AUTO : String(settings.diarizationSpeakerCount)}
                            disabled={isSaving("diarizationSpeakerCount")}
                            onValueChange={(v) => void save({ diarizationSpeakerCount: v === AUTO ? null : Number(v) })}
                            options={SPEAKER_COUNTS}
                            className="w-64 max-w-[55%] shrink-0"
                        />
                    </Row>
                ) : null}
                <Row htmlFor={id("quality")} label="Transcription quality" hint="Balance between transcription speed and accuracy">
                    <SettingSelect
                        id={id("quality")}
                        testId="transcription-quality"
                        value={settings.transcriptionQuality}
                        disabled={isSaving("transcriptionQuality")}
                        onValueChange={(v) => void save({ transcriptionQuality: v as UserSettings["transcriptionQuality"] })}
                        options={QUALITY}
                        className="w-64 max-w-[55%] shrink-0"
                    />
                </Row>
            </Group>
        </div>
    );
}

// ---------- summary ----------

const SUMMARY_PRESETS: Option[] = [
    { value: "general", label: "General Summary", description: "Overview, key points, topics, and follow-ups for any recording" },
    {
        value: "meeting-notes",
        label: "Meeting Minutes",
        description: "Attendees, discussion, decisions, and an owner, task, and due date for each action item",
    },
    {
        value: "interview",
        label: "Interview and Research",
        description: "Background, questions and answers, pain points, quotes with timestamps, and insights",
    },
    { value: "call", label: "Phone and Client Call", description: "Purpose, requests, commitments, agreed next steps, and open issues" },
    { value: "lecture", label: "Lecture and Study Notes", description: "Outline, core concepts, examples, pitfalls, and review questions" },
    { value: "brainstorm", label: "Brainstorm", description: "Ideas grouped by theme, trade-offs, ideas set aside, and next experiments" },
    { value: "voice-memo", label: "Voice Memo and Podcast", description: "Main points, ideas, quotes, resources mentioned, and to-dos" },
    { value: "key-points", label: "Key Points", description: "A one-sentence overview and five to fifteen key points" },
    { value: "action-items", label: "Action Items", description: "Owner, task, due date, and status for every action item" },
];

const OUTPUT_LANGUAGES: Option[] = [
    { value: AUTO, label: "Auto (match transcript)" },
    { value: "zh", label: "Chinese (Simplified)" },
    { value: "en", label: "English" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
];

export const DEFAULT_PROMPT_CONFIG: SummaryPromptConfig = { selectedPrompt: "general", customPrompts: [] };

export function presetGroups(customPrompts: CustomPrompt[], builtIn: Option[] = SUMMARY_PRESETS): OptionGroup[] {
    const groups: OptionGroup[] = [{ label: "Built-in", options: builtIn }];
    if (customPrompts.length > 0) {
        groups.push({ label: "Custom", options: customPrompts.map((p) => ({ value: p.id, label: p.name })) });
    }
    return groups;
}

export const PROMPT_SAVE_FAILED = "Failed to save prompt. Changes reverted.";
export const PROMPT_DELETE_FAILED = "Failed to delete prompt. Changes reverted.";

export function SummarySection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const id = (name: string) => `${ids}-${name}`;
    const config: SummaryPromptConfig = settings.summaryPrompt ?? DEFAULT_PROMPT_CONFIG;
    const [editor, setEditor] = useState<{ prompt: CustomPrompt | null } | null>(null);
    const [viewing, setViewing] = useState<CustomPrompt | null>(null);
    const [deleting, setDeleting] = useState<CustomPrompt | null>(null);

    const groups = presetGroups(config.customPrompts, SUMMARY_PRESETS);

    const saveList = async (customPrompts: CustomPrompt[]): Promise<boolean> => save({ summaryPrompt: { ...config, customPrompts } }, PROMPT_SAVE_FAILED);

    const removePrompt = async (target: CustomPrompt) => {
        const next: SummaryPromptConfig = {
            selectedPrompt: config.selectedPrompt === target.id ? "general" : config.selectedPrompt,
            customPrompts: config.customPrompts.filter((p) => p.id !== target.id),
        };
        const ok = await save({ summaryPrompt: next }, PROMPT_DELETE_FAILED);
        if (ok) toast.success("Prompt deleted");
    };

    return (
        <div className="grid gap-6">
            <div className="grid gap-4">
                <StackedField
                    htmlFor={id("preset")}
                    label="Default summary prompt"
                    hint="The prompt that new summaries start from. You can override this per-recording."
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
                    label="AI output language"
                    hint="Applies to AI-generated summaries and titles. Auto follows whatever language the transcript is in."
                >
                    <SettingSelect
                        id={id("output-language")}
                        testId="ai-output-language"
                        value={toOptionValue(settings.aiOutputLanguage)}
                        disabled={isSaving("aiOutputLanguage")}
                        onValueChange={(v) => void save({ aiOutputLanguage: fromOptionValue(v) })}
                        options={OUTPUT_LANGUAGES}
                        className="w-full"
                    />
                </StackedField>
                <ToggleRow
                    id="auto-summarize"
                    field="autoSummarize"
                    label="Auto-generate summary after transcription"
                    hint="Runs after every successful transcription — manual, auto-sync, or re-transcribe. Switch on Auto-transcribe to cover recordings that arrive through sync as well. Uses one extra AI provider call per summary."
                    className="border-t border-border py-3"
                />
                <StackedField htmlFor={id("auto-preset")} label="Preset for auto-summary">
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
                    <h2 className="text-[13px] font-semibold text-foreground">Custom Summary Prompts</h2>
                    <Button variant="primary" className="px-3" onClick={() => setEditor({ prompt: null })}>
                        <Plus />
                        Add Custom Prompt
                    </Button>
                </div>
                {config.customPrompts.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">No custom prompts yet. Create one to get started.</p>
                ) : (
                    <div className="divide-y divide-border">
                        {config.customPrompts.map((p) => (
                            <div key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                                <p className="min-w-0 truncate text-[13px] font-medium">{p.name}</p>
                                <div className="flex shrink-0 items-center gap-2">
                                    <Button variant="secondary" className="px-3" onClick={() => setViewing(p)}>
                                        View
                                    </Button>
                                    <Button variant="secondary" size="icon" className="sm:size-9" aria-label={`Edit prompt ${p.name}`} onClick={() => setEditor({ prompt: p })}>
                                        <Pencil />
                                    </Button>
                                    <Button variant="secondary" size="icon" className="sm:size-9" aria-label={`Delete prompt ${p.name}`} onClick={() => setDeleting(p)}>
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
                        if (ok) toast.success("Prompt saved");
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

const PLACEHOLDER_CODE = <code className="rounded bg-muted px-1 py-0.5">{"{transcription}"}</code>;

const PROMPT_COPY = {
    summary: {
        create: (
            <>
                Write your own prompt for generating summaries. Use {PLACEHOLDER_CODE} as a placeholder for the transcription text. Ask for a JSON
                object with <code className="rounded bg-muted px-1 py-0.5">summary</code>,{" "}
                <code className="rounded bg-muted px-1 py-0.5">keyPoints</code>, and <code className="rounded bg-muted px-1 py-0.5">actionItems</code> fields.
            </>
        ),
        placeholder: SUMMARY_PROMPT_PLACEHOLDER,
        testId: "custom-summary-prompt",
    },
    title: {
        create: (
            <>Create a custom prompt for title generation. Use {PLACEHOLDER_CODE} as a placeholder for the transcription text.</>
        ),
        placeholder: "",
        testId: "custom-title-prompt",
    },
} as const;

/** Create or edit one custom prompt. The save button stays disabled until the name and the prompt are filled. */
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
    const copy = PROMPT_COPY[kind];
    const ids = useId();
    const [name, setName] = useState(existing?.name ?? "");
    const [prompt, setPrompt] = useState(existing?.prompt ?? "");
    const [saving, setSaving] = useState(false);
    const ready = name.trim() !== "" && prompt.trim() !== "";

    const submit = async () => {
        if (!ready) {
            toast.error("Name and prompt are required");
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
                <DialogTitle>{existing ? "Edit Custom Prompt" : "Create Custom Prompt"}</DialogTitle>
                <DialogDescription>{copy.create}</DialogDescription>
                <div className="grid gap-4">
                    <StackedField htmlFor={`${ids}-name`} label="Name">
                        <Input
                            id={`${ids}-name`}
                            data-testid={`${copy.testId}-name`}
                            placeholder="My Custom Prompt"
                            value={name}
                            className="h-9 sm:h-9"
                            onChange={(e) => setName(e.target.value)}
                        />
                    </StackedField>
                    <StackedField htmlFor={`${ids}-text`} label="Prompt">
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
                        Cancel
                    </Button>
                    <Button variant="primary" className="px-4" disabled={!ready || saving} onClick={() => void submit()}>
                        {saving ? <Spinner label="Saving prompt" /> : null}
                        {existing ? "Save" : "Create"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Read-only view of a built-in or custom prompt. */
export function PromptViewDialog({ title, description, text, onClose }: { title: string; description?: string; text: string; onClose: () => void }) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[80vh] overflow-y-auto">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className={description ? undefined : "sr-only"}>{description ?? "Custom prompt"}</DialogDescription>
                <pre className="overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm whitespace-pre-wrap">{text}</pre>
            </DialogContent>
        </Dialog>
    );
}

/** Confirms removal of a custom prompt. */
export function DeletePromptDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent>
                <DialogTitle>Delete this custom prompt?</DialogTitle>
                <DialogDescription>
                    Recordings you already summarized with this prompt keep their summaries, but you won't be able to run it again.
                </DialogDescription>
                <DialogFooter>
                    <Button variant="secondary" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={onConfirm}>
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------- recording names ----------

const TITLE_MODES: { value: UserSettings["recordingTitleMode"]; label: string; hint: string; testId: string }[] = [
    { value: "original", label: "Original name", hint: "Keep the name from Plaud or the uploaded file.", testId: "recording-title-mode-original" },
    { value: "date", label: "Date", hint: "Name by recording date, e.g. 2026-10-12.", testId: "recording-title-mode-date" },
    {
        value: "ai",
        label: "AI title",
        hint: "Generate a title from the transcript after transcription finishes.",
        testId: "recording-title-mode-ai",
    },
];

interface TitleCandidate {
    id: string;
    filename: string;
    suggestedFilename: string;
    startTime: string;
}

export function NamingSection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();

    return (
        <div className="grid gap-4">
            <div role="radiogroup" aria-label="Recording name" className="divide-y divide-border rounded-xl bg-muted px-4">
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
                                <span className="block text-[13px] font-medium">{mode.label}</span>
                                <span className="block text-xs text-muted-foreground">{mode.hint}</span>
                            </span>
                        </label>
                    );
                })}
            </div>
            <div className="rounded-xl bg-muted px-4">
                <ToggleRow
                    id="sync-title-plaud"
                    field="syncTitleToPlaud"
                    label="Sync titles to Plaud"
                    hint="Send generated titles back to the Plaud device and rename the file there"
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
                toast.success(result.renamed.length === 1 ? "1 title updated" : `${result.renamed.length} titles updated`);
            }
            if (result.skipped.length > 0) {
                toast.message(result.skipped.length === 1 ? "1 title was skipped" : `${result.skipped.length} titles were skipped`);
            }
            window.dispatchEvent(new Event(RECORDINGS_CHANGED));
            await check();
        } catch (err) {
            toast.error(errorMessage(err, "Could not update the titles"));
        } finally {
            setApplying(false);
        }
    };

    const open = (candidates?.length ?? 0) > 0;

    return (
        <section className="grid gap-3 border-t border-border pt-4">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                    <h2 className="text-[13px] font-semibold text-foreground">Existing date titles</h2>
                    <p className="text-xs text-muted-foreground">
                        Earlier versions named date titles with the time added. Check the list, then choose which to shorten to the date.
                    </p>
                </div>
                <Button variant="secondary" className="px-3" disabled={loading || applying} onClick={() => void check()}>
                    {loading ? <Spinner /> : null}
                    Check titles
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(error, "Could not read the titles")}
                </p>
            ) : null}
            {candidates === null ? null : !open ? (
                <p className="text-sm text-muted-foreground">No titles need fixing.</p>
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
                                    <span className="block text-xs text-muted-foreground">Becomes {candidate.suggestedFilename}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="flex justify-end">
                        <Button variant="primary" className="px-3" disabled={picked.size === 0 || applying} onClick={() => void apply()}>
                            {applying ? <Spinner /> : null}
                            Update selected
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}

