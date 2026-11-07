import { useCallback, useEffect, useId, useState } from "react";
import { Bot, Check, Pencil, PlugZap, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Loading, SettingSelect, StackedField, useSettings, type Option, type SummaryPromptConfig, type CustomPrompt } from "./shared";
import { DeletePromptDialog, PromptEditDialog, PromptViewDialog, promptDeleteFailed, promptSaveFailed } from "./ai-sections";
import { TITLE_PRESETS, TITLE_PROMPT_PLACEHOLDER } from "./prompt-texts";
import { t, useI18n } from "@/lib/i18n";

export type ProviderRole = "transcription" | "enhancement";

export interface ProviderRow {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    transcriptionModel?: string | null;
    enhancementModel?: string | null;
    transcriptionModels?: string[];
    enhancementModels?: string[];
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: string;
}

interface Preset {
    name: string;
    baseUrl: string;
    /** Default transcription model. */
    model: string;
    /** Official transcription models offered in the dropdown. */
    models?: string[];
    /** Default enhancement model. */
    enhancementModel?: string;
    /** Official enhancement models offered in the dropdown. */
    enhancementModels?: string[];
    /** Whether live models can also be fetched from the provider API with the user's API key. */
    dynamicModels?: boolean;
    /** Placeholder of the model text field when typing a custom model. */
    modelPlaceholder?: string;
    keyPlaceholder: string;
    canTranscribe: boolean;
    canEnhance: boolean;
    note?: string;
}

const DEFAULT_TRANSCRIBE_PLACEHOLDER = "gpt-4o-transcribe, gemini-2.5-flash, whisper-1, etc.";
const DEFAULT_ENHANCE_PLACEHOLDER = "gpt-4o-mini, gemini-2.5-flash, deepseek-v3, etc.";

/** Official presets pre-configured with each vendor's official endpoint and current model catalog. */
export const PRESETS: Preset[] = [
    {
        name: "Google Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-3.5-transcribe",
        models: [
            "gemini-3.5-transcribe",
            "gemini-3.8-flash",
            "gemini-3.8-pro",
            "gemini-4-argon",
            "gemini-3.5-flash-lite",
            "gemini-3.6-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash",
        ],
        enhancementModel: "gemini-3.8-flash",
        enhancementModels: [
            "gemini-3.8-flash",
            "gemini-3.8-pro",
            "gemini-4-argon",
            "gemini-3.5-flash-lite",
            "gemini-3.6-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash",
        ],
        dynamicModels: true,
        keyPlaceholder: "AIza...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-transcribe",
        models: [
            "gpt-4o-transcribe",
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe-diarize",
            "whisper-1",
        ],
        enhancementModel: "gpt-4o-mini",
        enhancementModels: [
            "gpt-4o-mini",
            "gpt-4o",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "o4-mini",
            "o3",
        ],
        dynamicModels: true,
        keyPlaceholder: "sk-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "ElevenLabs",
        baseUrl: "https://api.elevenlabs.io/v1",
        model: "scribe_v2",
        models: ["scribe_v2", "scribe_v2_realtime", "scribe_v2_medical", "scribe_v1"],
        dynamicModels: true,
        keyPlaceholder: "sk_...",
        canTranscribe: true,
        canEnhance: false,
        note: "ElevenLabs transcribes only.",
    },
    {
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3-turbo",
        models: [
            "whisper-large-v3-turbo",
            "whisper-large-v3",
            "distil-whisper-large-v3-en",
        ],
        enhancementModel: "llama-3.3-70b-versatile",
        enhancementModels: [
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "meta-llama/llama-4-scout-17b-16e-instruct",
            "meta-llama/llama-4-maverick-17b-128e-instruct",
            "deepseek-r1-distill-llama-70b",
            "qwen-qwq-32b",
        ],
        dynamicModels: true,
        keyPlaceholder: "gsk_...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "SiliconFlow (China)",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "FunAudioLLM/SenseVoiceSmall",
        models: [
            "FunAudioLLM/SenseVoiceSmall",
            "TeleAI/TeleSpeechASR",
            "XingChenAGI/XingChenASR-V3.2-Ultra",
        ],
        enhancementModel: "deepseek-ai/DeepSeek-V3",
        enhancementModels: [
            "deepseek-ai/DeepSeek-V3",
            "Pro/deepseek-ai/DeepSeek-V3",
            "deepseek-ai/DeepSeek-R1",
            "Qwen/Qwen3-32B",
            "Qwen/Qwen2.5-72B-Instruct",
            "Qwen/Qwen2.5-7B-Instruct",
        ],
        dynamicModels: true,
        keyPlaceholder: "sk-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        model: "openai/whisper-large-v3",
        models: [
            "openai/whisper-large-v3",
            "nvidia/parakeet-tdt-0.6b-v3",
        ],
        enhancementModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        enhancementModels: [
            "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            "deepseek-ai/DeepSeek-V3",
            "deepseek-ai/DeepSeek-R1",
            "Qwen/Qwen2.5-72B-Instruct-Turbo",
        ],
        dynamicModels: true,
        keyPlaceholder: "...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "google/gemini-2.5-flash",
        models: [
            "google/gemini-2.5-flash",
            "google/gemini-2.5-flash-lite",
            "google/gemini-2.5-pro",
            "openai/gpt-4o-mini-transcribe",
            "openai/whisper-large-v3-turbo",
            "openai/gpt-4o-audio-preview",
        ],
        enhancementModel: "google/gemini-2.5-flash",
        enhancementModels: [
            "google/gemini-2.5-flash",
            "google/gemini-2.5-pro",
            "openai/gpt-4.1-mini",
            "openai/gpt-4o-mini",
            "anthropic/claude-sonnet-4",
            "deepseek/deepseek-chat-v3-0324",
        ],
        dynamicModels: true,
        modelPlaceholder: DEFAULT_TRANSCRIBE_PLACEHOLDER,
        keyPlaceholder: "sk-or-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4.1-flash",
        enhancementModel: "deepseek-v4.1-flash",
        enhancementModels: ["deepseek-v4.1-flash"],
        dynamicModels: true,
        modelPlaceholder: "deepseek-v4.1-flash, gpt-4o-mini, etc.",
        keyPlaceholder: "sk-...",
        canTranscribe: false,
        canEnhance: true,
        note: "OpenCode Go is chat only. It cannot transcribe audio.",
    },
    {
        name: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
        model: "",
        modelPlaceholder: DEFAULT_TRANSCRIBE_PLACEHOLDER,
        keyPlaceholder: "lm-studio",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "",
        modelPlaceholder: DEFAULT_TRANSCRIBE_PLACEHOLDER,
        keyPlaceholder: "ollama",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Custom",
        baseUrl: "",
        model: "",
        modelPlaceholder: DEFAULT_TRANSCRIBE_PLACEHOLDER,
        keyPlaceholder: "Your API key",
        canTranscribe: true,
        canEnhance: true,
    },
];

const CUSTOM_MODEL = "__custom__";

function presetFor(name: string): Preset | undefined {
    return PRESETS.find((p) => p.name === name);
}

function looksLikeTranscriptionModel(model: string | null | undefined): boolean {
    if (!model) return false;
    const lower = model.toLowerCase();
    return ["whisper", "asr", "sensevoice", "telespeech", "transcribe", "scribe", "parakeet", "speech"].some((h) =>
        lower.includes(h),
    );
}

/** Whether a stored provider row belongs to the Transcription column. */
function belongsToTranscription(row: ProviderRow): boolean {
    const preset = presetFor(row.provider);
    if (preset && !preset.canTranscribe) return false;
    if (row.isDefaultTranscription) return true;
    if (row.transcriptionModel) return true;
    if (preset && !preset.canEnhance) return true;
    if (looksLikeTranscriptionModel(row.defaultModel)) return true;
    return !row.enhancementModel && !row.isDefaultEnhancement;
}

/** Whether a stored provider row belongs to the Enhancement column. */
function belongsToEnhancement(row: ProviderRow): boolean {
    const preset = presetFor(row.provider);
    if (preset && !preset.canEnhance) return false;
    if (row.isDefaultEnhancement) return true;
    if (row.enhancementModel) return true;
    if (preset && !preset.canTranscribe) return true;
    if (row.defaultModel && !looksLikeTranscriptionModel(row.defaultModel)) return true;
    return !row.transcriptionModel && !row.isDefaultTranscription;
}

interface TestResult {
    ok: boolean;
    text: string;
}

interface TestAnswer {
    ok: boolean;
    kind?: string;
    latencyMs?: number;
    error?: string;
}

function resultText(answer: TestAnswer): TestResult {
    if (answer.ok) return { ok: true, text: t("settings.providers.connected", { ms: answer.latencyMs ?? 0 }) };
    return {
        ok: false,
        text: answer.error ? t("settings.providers.connectionFailedReason", { reason: answer.error }) : t("settings.providers.connectionFailed"),
    };
}

interface EditTarget {
    mode: ProviderRole;
    row: ProviderRow | null;
}

export function ProvidersSection() {
    const { t } = useI18n();
    const [tab, setTab] = useState<"providers" | "prompts">("providers");
    const [rows, setRows] = useState<ProviderRow[] | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [results, setResults] = useState<Record<string, TestResult>>({});
    const [editing, setEditing] = useState<EditTarget | null>(null);
    const [deleting, setDeleting] = useState<ProviderRow | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await api<{ providers: ProviderRow[] }>("/api/settings/ai/providers");
            setRows(data.providers);
            setLoadError(null);
        } catch (err) {
            setLoadError(err);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const testRow = async (row: ProviderRow, role: ProviderRole) => {
        const key = `${role}:${row.id}`;
        setBusy(key);
        try {
            const model =
                role === "transcription"
                    ? row.transcriptionModel || row.defaultModel || undefined
                    : row.enhancementModel || row.defaultModel || undefined;
            const answer = await api<TestAnswer>("/api/settings/ai/providers/test", {
                method: "POST",
                json: { id: row.id, kind: role === "transcription" ? "transcription" : "chat", model },
            });
            setResults((r) => ({ ...r, [key]: resultText(answer) }));
        } catch (err) {
            setResults((r) => ({ ...r, [key]: { ok: false, text: errorMessage(err, t("settings.providers.connectionFailed")) } }));
        } finally {
            setBusy(null);
        }
    };

    const setDefaultForRole = async (row: ProviderRow, role: ProviderRole, modelOverride?: string) => {
        const key = `default:${role}:${row.id}`;
        setBusy(key);
        try {
            const endpoint =
                role === "transcription"
                    ? "/api/settings/ai/providers/default-transcription"
                    : "/api/settings/ai/providers/default-enhancement";
            await api(endpoint, {
                method: "PUT",
                json: modelOverride ? { providerId: row.id, model: modelOverride } : { providerId: row.id },
            });
            toast.success(t("settings.providers.updated"));
            await load();
        } catch (err) {
            toast.error(errorMessage(err, t("settings.providers.saveFailed")));
        } finally {
            setBusy(null);
        }
    };

    const remove = async (row: ProviderRow) => {
        try {
            await api(`/api/settings/ai/providers/${encodeURIComponent(row.id)}`, { method: "DELETE" });
            toast.success(t("settings.providers.deleted"));
            await load();
        } catch (err) {
            toast.error(errorMessage(err, t("settings.providers.deleteFailed")));
        }
    };

    const transcriptionRows = (rows ?? []).filter(belongsToTranscription);
    const enhancementRows = (rows ?? []).filter(belongsToEnhancement);

    return (
        <div className="grid gap-6">
            <header className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tile-indigo" aria-hidden="true">
                        <Bot className="size-5 text-primary-foreground" />
                    </span>
                    <div className="min-w-0">
                        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("settings.nav.providersTitle")}</h1>
                        <p className="mt-0.5 text-[13px] text-muted-foreground">{t("settings.providers.providersIntro")}</p>
                    </div>
                </div>
            </header>

            <div role="tablist" aria-label={t("settings.providers.tabsAria")} className="flex gap-2 border-b border-border">
                {(
                    [
                        ["providers", t("settings.providers.tabProviders")],
                        ["prompts", t("settings.providers.tabPrompts")],
                    ] as const
                ).map(([name, label]) => (
                    <button
                        key={name}
                        type="button"
                        role="tab"
                        aria-selected={tab === name}
                        onClick={() => setTab(name)}
                        className={cn(
                            "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                            tab === name ? "border-primary text-link" : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {name === "prompts" ? <Sparkles className="mr-2 inline size-4" aria-hidden="true" /> : null}
                        {label}
                    </button>
                ))}
            </div>

            {tab === "prompts" ? (
                <PromptsTab />
            ) : (
                <>
                    {rows === null && !loadError ? <Loading label={t("settings.providers.loading")} /> : null}
                    {loadError ? (
                        <p role="alert" className="text-sm text-destructive">
                            {errorMessage(loadError, t("settings.providers.providersLoadFailed"))}
                        </p>
                    ) : null}

                    {rows !== null ? (
                        <div className="grid items-start gap-6 lg:grid-cols-2">
                            <ProviderColumn
                                role="transcription"
                                title={t("settings.providers.transcriptionBadge")}
                                subtitle={t("settings.providers.transcriptionModelsHint")}
                                rows={transcriptionRows}
                                results={results}
                                busy={busy}
                                onAdd={() => setEditing({ mode: "transcription", row: null })}
                                onEdit={(row) => setEditing({ mode: "transcription", row })}
                                onDelete={setDeleting}
                                onTest={(row) => void testRow(row, "transcription")}
                                onSetDefault={(row, model) => void setDefaultForRole(row, "transcription", model)}
                            />

                            <ProviderColumn
                                role="enhancement"
                                title={t("settings.providers.enhancementBadge")}
                                subtitle={t("settings.providers.enhancementModelsHint")}
                                rows={enhancementRows}
                                results={results}
                                busy={busy}
                                onAdd={() => setEditing({ mode: "enhancement", row: null })}
                                onEdit={(row) => setEditing({ mode: "enhancement", row })}
                                onDelete={setDeleting}
                                onTest={(row) => void testRow(row, "enhancement")}
                                onSetDefault={(row, model) => void setDefaultForRole(row, "enhancement", model)}
                            />
                        </div>
                    ) : null}

                    {editing ? (
                        <ProviderDialog
                            key={`${editing.mode}:${editing.row ? editing.row.id : "new"}`}
                            mode={editing.mode}
                            existing={editing.row}
                            hasDefaultInColumn={
                                editing.mode === "transcription"
                                    ? transcriptionRows.some((r) => r.isDefaultTranscription)
                                    : enhancementRows.some((r) => r.isDefaultEnhancement)
                            }
                            onClose={() => setEditing(null)}
                            onSaved={async () => {
                                setEditing(null);
                                await load();
                            }}
                        />
                    ) : null}

                    <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
                        <AlertDialogContent>
                            <AlertDialogTitle>{t("settings.providers.deleteTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("settings.providers.deleteBody")}</AlertDialogDescription>
                            <AlertDialogFooter>
                                <AlertDialogCancel asChild>
                                    <Button variant="secondary">{t("common.action.cancel")}</Button>
                                </AlertDialogCancel>
                                <AlertDialogAction
                                    asChild
                                    onClick={() => {
                                        const target = deleting;
                                        setDeleting(null);
                                        if (target) void remove(target);
                                    }}
                                >
                                    <Button variant="destructive">{t("common.action.delete")}</Button>
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </>
            )}
        </div>
    );
}

interface ProviderColumnProps {
    role: ProviderRole;
    title: string;
    subtitle: string;
    rows: ProviderRow[];
    results: Record<string, TestResult>;
    busy: string | null;
    onAdd: () => void;
    onEdit: (row: ProviderRow) => void;
    onDelete: (row: ProviderRow) => void;
    onTest: (row: ProviderRow) => void;
    onSetDefault: (row: ProviderRow, model?: string) => void;
}

function ProviderColumn({
    role,
    title,
    subtitle,
    rows,
    results,
    busy,
    onAdd,
    onEdit,
    onDelete,
    onTest,
    onSetDefault,
}: ProviderColumnProps) {
    const { t } = useI18n();

    return (
        <section
            data-testid={`provider-column-${role}`}
            className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-card"
        >
            <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                            {rows.length}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
                </div>
                <Button
                    variant="primary"
                    size="sm"
                    data-testid={`add-provider-${role}`}
                    className="shrink-0 px-3"
                    onClick={onAdd}
                >
                    <Plus />
                    {t("settings.providers.addProvider")}
                </Button>
            </div>

            {rows.length === 0 ? (
                <EmptyState
                    headingLevel={3}
                    title={t("settings.providers.emptyTitle")}
                    description={subtitle}
                    action={
                        <Button variant="secondary" size="sm" onClick={onAdd}>
                            <Plus />
                            {t("settings.providers.addProvider")}
                        </Button>
                    }
                    className="rounded-xl bg-muted py-8"
                />
            ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                    {rows.map((row) => {
                        const isDefault = role === "transcription" ? row.isDefaultTranscription : row.isDefaultEnhancement;
                        const activeModel =
                            role === "transcription"
                                ? row.transcriptionModel || row.defaultModel
                                : row.enhancementModel || row.defaultModel;
                        const modelList =
                            role === "transcription" ? (row.transcriptionModels ?? []) : (row.enhancementModels ?? []);
                        const testKey = `${role}:${row.id}`;
                        const defaultKey = `default:${role}:${row.id}`;
                        const result = results[testKey];
                        const address = row.baseUrl || presetFor(row.provider)?.baseUrl || t("settings.providers.defaultAddress");

                        return (
                            <div
                                key={`${role}:${row.id}`}
                                className={cn(
                                    "flex flex-col gap-2.5 px-4 py-3 transition-colors hover:bg-accent/60",
                                    isDefault ? "bg-primary/[0.04]" : undefined,
                                )}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="text-[13px] font-semibold text-foreground">{row.provider}</h3>
                                            {isDefault ? (
                                                <span
                                                    className={cn(
                                                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                                                        role === "transcription"
                                                            ? "bg-primary/15 text-link"
                                                            : "bg-info text-info-foreground",
                                                    )}
                                                >
                                                    <Check className="size-3" />
                                                    {t("settings.providers.defaultBadge")}
                                                </span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled={busy === defaultKey}
                                                    onClick={() => onSetDefault(row)}
                                                    className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-link disabled:opacity-50"
                                                >
                                                    {t("settings.providers.setDefault")}
                                                </button>
                                            )}
                                        </div>

                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {t("settings.providers.modelLine", {
                                                model: activeModel || t("settings.providers.noDefaultModel"),
                                            })}
                                        </p>

                                        {modelList.length > 1 ? (
                                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                                {modelList.map((m) => {
                                                    const selected = isDefault && m === activeModel;
                                                    return (
                                                        <button
                                                            key={m}
                                                            type="button"
                                                            onClick={() => onSetDefault(row, m)}
                                                            className={cn(
                                                                "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                                                                selected
                                                                    ? "border-primary bg-primary/10 font-medium text-link"
                                                                    : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:text-foreground",
                                                            )}
                                                        >
                                                            {m}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ) : null}

                                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{address}</p>

                                        {result ? (
                                            <output
                                                data-testid="provider-row-test-result"
                                                className={cn(
                                                    "mt-1 block text-xs break-words",
                                                    result.ok ? "text-success" : "text-destructive",
                                                )}
                                            >
                                                {result.text}
                                            </output>
                                        ) : null}
                                    </div>

                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <Button
                                            size="icon"
                                            variant="secondary"
                                            className="size-8"
                                            aria-label={t("settings.providers.testConnection")}
                                            data-testid="provider-row-test"
                                            disabled={busy === testKey}
                                            onClick={() => onTest(row)}
                                        >
                                            {busy === testKey ? (
                                                <Spinner label={t("settings.providers.testingConnection")} />
                                            ) : (
                                                <PlugZap className="size-3.5" />
                                            )}
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="secondary"
                                            className="size-8"
                                            aria-label={t("settings.providers.editProvider")}
                                            onClick={() => onEdit(row)}
                                        >
                                            <Pencil className="size-3.5" />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="secondary"
                                            className="size-8"
                                            aria-label={t("settings.providers.deleteProvider")}
                                            onClick={() => onDelete(row)}
                                        >
                                            <Trash2 className="size-3.5 text-destructive" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

interface ProviderDialogProps {
    mode: ProviderRole;
    existing: ProviderRow | null;
    hasDefaultInColumn: boolean;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

function ProviderDialog({ mode, existing, hasDefaultInColumn, onClose, onSaved }: ProviderDialogProps) {
    const { t } = useI18n();
    const ids = useId();
    const initialPreset = presetFor(existing?.provider ?? "");
    const initialModel = existing
        ? mode === "transcription"
            ? (existing.transcriptionModel ?? existing.defaultModel ?? "")
            : (existing.enhancementModel ?? existing.defaultModel ?? "")
        : "";

    const [provider, setProvider] = useState(existing?.provider ?? "");
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState(existing ? (existing.baseUrl ?? initialPreset?.baseUrl ?? "") : "");
    const [model, setModel] = useState(initialModel);
    const [customModel, setCustomModel] = useState(() => {
        if (!existing || !initialModel) return false;
        const staticList = mode === "transcription" ? initialPreset?.models : initialPreset?.enhancementModels;
        return Boolean(staticList && staticList.length > 0 && !staticList.includes(initialModel));
    });
    const [isDefault, setIsDefault] = useState(() => {
        if (existing) {
            return mode === "transcription" ? existing.isDefaultTranscription : existing.isDefaultEnhancement;
        }
        return !hasDefaultInColumn;
    });
    const [fetched, setFetched] = useState<{ id: string; name: string }[]>([]);
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<TestResult | null>(null);
    const [saving, setSaving] = useState(false);

    const availablePresets = PRESETS.filter((p) => (mode === "transcription" ? p.canTranscribe : p.canEnhance));
    const preset = presetFor(provider);
    const dynamic = Boolean(preset?.dynamicModels);
    const keyText = apiKey.trim();

    const staticModels = mode === "transcription" ? preset?.models : preset?.enhancementModels;

    // Fetch live model list from the provider's official API once an API key is typed.
    useEffect(() => {
        if (!dynamic || !keyText || !provider) return;
        let alive = true;
        const timer = window.setTimeout(() => {
            api<{ models: { id: string; name: string }[] }>("/api/settings/ai/providers/models", {
                method: "POST",
                json: {
                    provider,
                    apiKey: keyText,
                    baseUrl: baseUrl.trim() || undefined,
                    kind: mode === "transcription" ? "audio" : "chat",
                },
            })
                .then((answer) => {
                    if (alive) setFetched(answer.models);
                })
                .catch(() => {
                    if (alive) setFetched([]);
                });
        }, 500);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [dynamic, provider, keyText, baseUrl, mode]);

    const pickProvider = (name: string) => {
        const next = presetFor(name);
        const defaultForRole =
            mode === "transcription" ? (next?.model ?? "") : (next?.enhancementModel ?? next?.model ?? "");
        setProvider(name);
        setBaseUrl(next?.baseUrl ?? "");
        setModel(defaultForRole);
        setCustomModel(false);
        setFetched([]);
        setResult(null);
    };

    const test = async () => {
        setTesting(true);
        setResult(null);
        try {
            const body: Record<string, unknown> = {
                provider,
                baseUrl: baseUrl.trim(),
                model: model.trim(),
                kind: mode === "transcription" ? "transcription" : "chat",
            };
            if (keyText) body.apiKey = keyText;
            if (existing) body.id = existing.id;
            const answer = await api<TestAnswer>("/api/settings/ai/providers/test", { method: "POST", json: body });
            setResult(resultText(answer));
        } catch (err) {
            setResult({ ok: false, text: errorMessage(err, t("settings.providers.connectionFailed")) });
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        if (!existing) {
            if (!provider || !keyText) {
                toast.error(t("settings.providers.providerRequired"));
                return;
            }
        }
        setSaving(true);
        try {
            const chosenModel = model.trim();
            const isTrans = mode === "transcription";
            const keepOtherTransModel = !isTrans && existing ? (existing.transcriptionModel ?? "") : "";
            const keepOtherEnhModel = isTrans && existing ? (existing.enhancementModel ?? "") : "";

            const nextTransModel = isTrans ? chosenModel : keepOtherTransModel;
            const nextEnhModel = !isTrans ? chosenModel : keepOtherEnhModel;

            const existingTransList = existing?.transcriptionModels ?? [];
            const existingEnhList = existing?.enhancementModels ?? [];

            const nextTransList = isTrans
                ? Array.from(new Set([chosenModel, ...existingTransList].filter(Boolean)))
                : existingTransList;
            const nextEnhList = !isTrans
                ? Array.from(new Set([chosenModel, ...existingEnhList].filter(Boolean)))
                : existingEnhList;

            const flags = {
                baseUrl: baseUrl.trim(),
                defaultModel: chosenModel || nextTransModel || nextEnhModel,
                transcriptionModel: nextTransModel,
                enhancementModel: nextEnhModel,
                transcriptionModels: nextTransList,
                enhancementModels: nextEnhList,
                isDefaultTranscription: isTrans ? isDefault : (existing?.isDefaultTranscription ?? false),
                isDefaultEnhancement: !isTrans ? isDefault : (existing?.isDefaultEnhancement ?? false),
            };
            if (existing) {
                await api(`/api/settings/ai/providers/${encodeURIComponent(existing.id)}`, {
                    method: "PUT",
                    json: keyText ? { ...flags, apiKey: keyText } : flags,
                });
                toast.success(t("settings.providers.updated"));
            } else {
                await api("/api/settings/ai/providers", {
                    method: "POST",
                    json: { provider, apiKey: keyText, ...flags },
                });
                toast.success(t("settings.providers.added"));
            }
            await onSaved();
        } catch (err) {
            toast.error(errorMessage(err, t("settings.providers.saveFailed")));
        } finally {
            setSaving(false);
        }
    };

    // Combine curated official preset models + live fetched models from the provider API.
    const mergedModelIds = (() => {
        const set = new Set<string>();
        for (const id of staticModels ?? []) {
            if (id) set.add(id);
        }
        for (const item of fetched) {
            if (item.id) set.add(item.id);
        }
        return Array.from(set);
    })();

    const modelOptions: Option[] = (() => {
        if (!customModel && mergedModelIds.length > 0) {
            const options: Option[] = mergedModelIds.map((id) => ({ value: id, label: id }));
            if (model && !options.some((o) => o.value === model)) {
                options.unshift({ value: model, label: model });
            }
            return [...options, { value: CUSTOM_MODEL, label: t("settings.providers.customModelOption") }];
        }
        return [];
    })();

    const showList = modelOptions.length > 0;
    const modelHint = showList
        ? t("settings.providers.modelHintList")
        : dynamic && !keyText
          ? t("settings.providers.modelHintNeedKey")
          : undefined;

    const pickModel = (value: string) => {
        if (value === CUSTOM_MODEL) {
            setCustomModel(true);
            setModel("");
            return;
        }
        setModel(value);
    };

    const defaultPlaceholder =
        mode === "transcription" ? DEFAULT_TRANSCRIBE_PLACEHOLDER : DEFAULT_ENHANCE_PLACEHOLDER;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>
                    {existing ? t("settings.providers.editAiProvider") : t("settings.providers.addAiProvider")}
                    {" · "}
                    {mode === "transcription"
                        ? t("settings.providers.transcriptionBadge")
                        : t("settings.providers.enhancementBadge")}
                </DialogTitle>
                <DialogDescription className="sr-only">{t("settings.providers.providersIntro")}</DialogDescription>

                <div className="grid gap-4">
                    <StackedField htmlFor={`${ids}-provider`} label={t("settings.providers.providerLabel")}>
                        <SettingSelect
                            id={`${ids}-provider`}
                            value={provider}
                            placeholder={t("settings.providers.selectProvider")}
                            disabled={existing !== null}
                            onValueChange={pickProvider}
                            options={availablePresets.map((p) => ({ value: p.name, label: p.name }))}
                            className="w-fit"
                        />
                    </StackedField>

                    <StackedField
                        htmlFor={`${ids}-api-key`}
                        label={t("settings.providers.apiKey")}
                        hint={existing ? t("settings.providers.apiKeyHintExisting") : undefined}
                    >
                        <Input
                            id={`${ids}-api-key`}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={preset?.keyPlaceholder ?? t("settings.providers.apiKeyPlaceholder")}
                            value={apiKey}
                            className="h-9 font-mono text-sm sm:h-9"
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </StackedField>

                    <StackedField htmlFor={`${ids}-base-url`} label={t("settings.providers.baseUrl")}>
                        <Input
                            id={`${ids}-base-url`}
                            type="text"
                            inputMode="url"
                            placeholder={preset?.baseUrl || t("settings.providers.baseUrlPlaceholder")}
                            value={baseUrl}
                            className="h-9 font-mono text-sm sm:h-9"
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                    </StackedField>

                    <StackedField htmlFor={`${ids}-model`} label={t("settings.providers.defaultModel")} hint={modelHint}>
                        {showList ? (
                            <SettingSelect
                                id={`${ids}-model`}
                                aria-label={t("settings.providers.defaultModel")}
                                value={model}
                                placeholder={t("settings.providers.pickModel")}
                                onValueChange={pickModel}
                                options={modelOptions}
                                className="w-fit"
                            />
                        ) : (
                            <>
                                {customModel && mergedModelIds.length > 0 ? (
                                    <button
                                        type="button"
                                        className="w-fit text-xs text-link underline-offset-4 hover:underline"
                                        onClick={() => {
                                            setCustomModel(false);
                                            const fallback =
                                                mode === "transcription"
                                                    ? (preset?.model ?? mergedModelIds[0] ?? "")
                                                    : (preset?.enhancementModel ?? preset?.model ?? mergedModelIds[0] ?? "");
                                            setModel(fallback);
                                        }}
                                    >
                                        {t("settings.providers.backToSuggested")}
                                    </button>
                                ) : null}
                                <Input
                                    id={`${ids}-model`}
                                    value={model}
                                    placeholder={preset?.modelPlaceholder ?? defaultPlaceholder}
                                    className="h-9 font-mono text-sm sm:h-9"
                                    onChange={(e) => setModel(e.target.value)}
                                />
                            </>
                        )}
                    </StackedField>

                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            variant="secondary"
                            className="px-3"
                            data-testid="provider-test-connection"
                            disabled={testing || !provider || (!existing && !keyText)}
                            onClick={() => void test()}
                        >
                            {testing ? <Spinner label={t("settings.providers.testingConnection")} /> : null}
                            {t("settings.providers.testConnection")}
                        </Button>
                        {result ? (
                            <output className={cn("text-sm", result.ok ? "text-success" : "text-destructive")}>
                                {result.text}
                            </output>
                        ) : null}
                    </div>

                    <div className="grid gap-2 rounded-xl bg-muted p-4 text-[13px]">
                        <label className="flex cursor-pointer items-center gap-2">
                            <input
                                type="checkbox"
                                className="size-4 accent-primary"
                                checked={isDefault}
                                onChange={(e) => setIsDefault(e.target.checked)}
                            />
                            <span>
                                {mode === "transcription"
                                    ? t("settings.providers.useForTranscription")
                                    : t("settings.providers.useForEnhancement")}
                            </span>
                        </label>
                        {preset?.note ? <p className="text-xs text-muted-foreground">{preset.note}</p> : null}
                    </div>
                </div>

                <div className="flex gap-2">
                    <Button variant="secondary" className="h-10 flex-1 sm:h-9" onClick={onClose}>
                        {t("common.action.cancel")}
                    </Button>
                    <Button variant="primary" className="h-10 flex-1 sm:h-9" disabled={saving} onClick={() => void save()}>
                        {saving ? <Spinner label={t("settings.providers.saving")} /> : null}
                        {existing ? t("settings.providers.updateProvider") : t("settings.providers.addProvider")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ---------- Prompts tab: title generation ----------

const DEFAULT_TITLE_CONFIG: SummaryPromptConfig = { selectedPrompt: "default", customPrompts: [] };

function PromptsTab() {
    const { t } = useI18n();
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const config: SummaryPromptConfig = settings.titleGenerationPrompt ?? DEFAULT_TITLE_CONFIG;
    const [viewing, setViewing] = useState<{ title: string; description?: string; text: string } | null>(null);
    const [editor, setEditor] = useState<{ prompt: CustomPrompt | null } | null>(null);
    const [deleting, setDeleting] = useState<CustomPrompt | null>(null);

    const options: Option[] = [
        ...TITLE_PRESETS.map((p) => ({ value: p.id, label: t("settings.providers.presetSuffix", { name: p.name }) })),
        ...config.customPrompts.map((p) => ({ value: p.id, label: t("settings.providers.customSuffix", { name: p.name }) })),
    ];

    const removePrompt = async (target: CustomPrompt) => {
        const next: SummaryPromptConfig = {
            selectedPrompt: config.selectedPrompt === target.id ? "default" : config.selectedPrompt,
            customPrompts: config.customPrompts.filter((p) => p.id !== target.id),
        };
        const ok = await save({ titleGenerationPrompt: next }, promptDeleteFailed());
        if (ok) toast.success(t("settings.providers.promptDeleted"));
    };

    return (
        <div className="grid gap-6">
            <StackedField
                htmlFor={`${ids}-selected`}
                label={t("settings.providers.activePrompt")}
                hint={t("settings.providers.activePromptHint")}
            >
                <SettingSelect
                    id={`${ids}-selected`}
                    testId="title-prompt-select"
                    value={config.selectedPrompt}
                    options={options}
                    disabled={isSaving("titleGenerationPrompt")}
                    onValueChange={(v) => void save({ titleGenerationPrompt: { ...config, selectedPrompt: v } }, promptSaveFailed())}
                    className="w-fit"
                />
            </StackedField>

            <section className="grid gap-4">
                <h2 className="text-[13px] font-semibold text-foreground">{t("settings.providers.presetPrompts")}</h2>
                <div className="divide-y divide-border">
                    {TITLE_PRESETS.map((p) => (
                        <div key={p.id} className="py-2.5">
                            <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="mb-1 flex items-center gap-2">
                                        <h3 className="text-[13px] font-medium">{p.name}</h3>
                                        {config.selectedPrompt === p.id ? (
                                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-link">{t("settings.providers.active")}</span>
                                        ) : null}
                                    </div>
                                    <p className="mb-2 text-xs text-muted-foreground">{p.description}</p>
                                </div>
                                <Button variant="secondary" className="px-3" onClick={() => setViewing({ title: p.name, description: p.description, text: p.text })}>
                                    {t("settings.providers.viewPrompt")}
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="grid gap-4 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-[13px] font-semibold text-foreground">{t("settings.providers.customPrompts")}</h2>
                    <Button variant="primary" className="px-3" onClick={() => setEditor({ prompt: null })}>
                        <Plus />
                        {t("settings.providers.addCustomPrompt")}
                    </Button>
                </div>
                {config.customPrompts.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">{t("settings.providers.noCustomPrompts")}</p>
                ) : (
                    <div className="divide-y divide-border">
                        {config.customPrompts.map((p) => (
                            <div key={p.id} className="py-2.5">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                        <div className="mb-1 flex items-center gap-2">
                                            <h3 className="truncate text-[13px] font-medium">{p.name}</h3>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <Button variant="secondary" className="px-3" onClick={() => setViewing({ title: p.name, text: p.prompt })}>
                                            {t("settings.providers.view")}
                                        </Button>
                                        <Button variant="secondary" size="icon" className="sm:size-9" aria-label={t("settings.providers.editPrompt", { name: p.name })} onClick={() => setEditor({ prompt: p })}>
                                            <Pencil />
                                        </Button>
                                        <Button variant="secondary" size="icon" className="sm:size-9" aria-label={t("settings.providers.deletePrompt", { name: p.name })} onClick={() => setDeleting(p)}>
                                            <Trash2 className="text-destructive" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {viewing ? (
                <PromptViewDialog title={viewing.title} description={viewing.description} text={viewing.text} onClose={() => setViewing(null)} />
            ) : null}

            {editor ? (
                <PromptEditDialog
                    key={editor.prompt?.id ?? "new"}
                    existing={editor.prompt}
                    kind="title"
                    placeholder={TITLE_PROMPT_PLACEHOLDER}
                    onClose={() => setEditor(null)}
                    onSave={async (item) => {
                        const target = editor.prompt;
                        const customPrompts = target
                            ? config.customPrompts.map((p) => (p.id === item.id ? item : p))
                            : [...config.customPrompts, item];
                        const ok = await save({ titleGenerationPrompt: { ...config, customPrompts } }, promptSaveFailed());
                        if (ok) toast.success(t("settings.providers.promptSaved"));
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
