import { useCallback, useEffect, useId, useState } from "react";
import { Bot, Pencil, PlugZap, Plus, Sparkles, Trash2 } from "lucide-react";
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

export interface ProviderRow {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: string;
}

interface Preset {
    name: string;
    baseUrl: string;
    /** Default model. Empty when the provider has none. */
    model: string;
    /** Transcription models offered in a list. */
    models?: string[];
    /** The list is loaded from the provider with the API key. */
    dynamicModels?: boolean;
    /** Placeholder of the model text field when there is no list. */
    modelPlaceholder?: string;
    keyPlaceholder: string;
    canTranscribe: boolean;
    canEnhance: boolean;
    /** Shown under the checkboxes. */
    note?: string;
}

const DEFAULT_MODEL_PLACEHOLDER = "whisper-1, gpt-4o, etc.";

/** Presets offered in the add dialog, in the order the dialog lists them. */
export const PRESETS: Preset[] = [
    {
        name: "OpenAI",
        baseUrl: "",
        model: "whisper-1",
        models: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize"],
        keyPlaceholder: "sk-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3-turbo",
        models: ["whisper-large-v3-turbo", "whisper-large-v3"],
        keyPlaceholder: "gsk_...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        model: "",
        models: ["openai/whisper-large-v3", "nvidia/parakeet-tdt-0.6b-v3"],
        keyPlaceholder: "...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "google/gemini-2.5-flash-lite",
        dynamicModels: true,
        modelPlaceholder: DEFAULT_MODEL_PLACEHOLDER,
        keyPlaceholder: "sk-or-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "SiliconFlow (China)",
        baseUrl: "https://api.siliconflow.cn/v1",
        model: "FunAudioLLM/SenseVoiceSmall",
        models: ["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR", "XingChenAGI/XingChenASR-V3.2-Ultra"],
        keyPlaceholder: "sk-...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "deepseek-v4.1-flash",
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
        modelPlaceholder: DEFAULT_MODEL_PLACEHOLDER,
        keyPlaceholder: "lm-studio",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "",
        modelPlaceholder: DEFAULT_MODEL_PLACEHOLDER,
        keyPlaceholder: "ollama",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "Google Gemini",
        baseUrl: "",
        model: "gemini-2.0-flash",
        models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash", "gemini-1.5-pro"],
        keyPlaceholder: "AIza...",
        canTranscribe: true,
        canEnhance: true,
    },
    {
        name: "ElevenLabs",
        baseUrl: "https://api.elevenlabs.io/v1",
        model: "",
        models: ["scribe_v2", "scribe_v1"],
        keyPlaceholder: "sk_...",
        canTranscribe: true,
        canEnhance: false,
        note: "ElevenLabs transcribes only.",
    },
    {
        name: "Custom",
        baseUrl: "",
        model: "",
        modelPlaceholder: DEFAULT_MODEL_PLACEHOLDER,
        keyPlaceholder: "Your API key",
        canTranscribe: true,
        canEnhance: true,
    },
];

const CUSTOM_MODEL = "__custom__";

function presetFor(name: string): Preset | undefined {
    return PRESETS.find((p) => p.name === name);
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

export function ProvidersSection() {
    const { t } = useI18n();
    const [tab, setTab] = useState<"providers" | "prompts">("providers");
    const [rows, setRows] = useState<ProviderRow[] | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [results, setResults] = useState<Record<string, TestResult>>({});
    const [editing, setEditing] = useState<ProviderRow | "new" | null>(null);
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

    const testRow = async (row: ProviderRow) => {
        setBusy(row.id);
        try {
            const answer = await api<TestAnswer>("/api/settings/ai/providers/test", { method: "POST", json: { id: row.id } });
            setResults((r) => ({ ...r, [row.id]: resultText(answer) }));
        } catch (err) {
            setResults((r) => ({ ...r, [row.id]: { ok: false, text: errorMessage(err, t("settings.providers.connectionFailed")) } }));
        } finally {
            setBusy(null);
        }
    };

    const remove = async (row: ProviderRow) => {
        try {
            await api(`/api/settings/ai/providers/${encodeURIComponent(row.id)}`, { method: "DELETE" });
            toast.success(t("settings.providers.deleted"));
            setResults((r) => {
                const next = { ...r };
                delete next[row.id];
                return next;
            });
            await load();
        } catch (err) {
            toast.error(errorMessage(err, t("settings.providers.deleteFailed")));
        }
    };

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
                {tab === "providers" ? (
                    <Button variant="primary" className="px-3" onClick={() => setEditing("new")}>
                        <Plus />
                        {t("settings.providers.addProvider")}
                    </Button>
                ) : null}
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

                    {rows && rows.length === 0 ? (
                        <EmptyState
                            headingLevel={2}
                            title={t("settings.providers.emptyTitle")}
                            description={t("settings.providers.emptyBody")}
                            action={
                                <Button variant="primary" onClick={() => setEditing("new")}>
                                    {t("settings.providers.addProvider")}
                                </Button>
                            }
                            className="rounded-xl bg-muted"
                        />
                    ) : null}

                    {rows && rows.length > 0 ? (
                        <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                            {rows.map((row) => {
                                const result = results[row.id];
                                return (
                                    <div
                                        key={row.id}
                                        className="flex min-h-11 flex-col gap-3 px-4 py-2.5 transition-colors hover:bg-accent sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-1 flex flex-wrap items-center gap-2">
                                                <h3 className="text-[13px] font-medium text-foreground">{row.provider}</h3>
                                                {row.isDefaultTranscription ? (
                                                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-link">{t("settings.providers.transcriptionBadge")}</span>
                                                ) : null}
                                                {row.isDefaultEnhancement ? (
                                                    <span className="rounded-full bg-info px-2 py-0.5 text-xs text-info-foreground">{t("settings.providers.enhancementBadge")}</span>
                                                ) : null}
                                            </div>
                                            <p className="text-xs text-muted-foreground">{t("settings.providers.modelLine", { model: row.defaultModel || t("settings.providers.noDefaultModel") })}</p>
                                            <p className="truncate font-mono text-xs text-muted-foreground">{row.baseUrl || t("settings.providers.defaultAddress")}</p>
                                            {result ? (
                                                <output
                                                    data-testid="provider-row-test-result"
                                                    className={cn("mt-1 block text-xs break-words", result.ok ? "text-success" : "text-destructive")}
                                                >
                                                    {result.text}
                                                </output>
                                            ) : null}
                                        </div>
                                        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-4 sm:justify-end">
                                            <Button
                                                size="icon"
                                                variant="secondary"
                                                className="sm:size-9"
                                                aria-label={t("settings.providers.testConnection")}
                                                data-testid="provider-row-test"
                                                disabled={busy === row.id}
                                                onClick={() => void testRow(row)}
                                            >
                                                {busy === row.id ? <Spinner label={t("settings.providers.testingConnection")} /> : <PlugZap />}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="secondary"
                                                className="sm:size-9"
                                                aria-label={t("settings.providers.editProvider")}
                                                onClick={() => setEditing(row)}
                                            >
                                                <Pencil />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="secondary"
                                                className="sm:size-9"
                                                aria-label={t("settings.providers.deleteProvider")}
                                                onClick={() => setDeleting(row)}
                                            >
                                                <Trash2 className="text-destructive" />
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}

                    {editing ? (
                        <ProviderDialog
                            key={editing === "new" ? "new" : editing.id}
                            existing={editing === "new" ? null : editing}
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

interface ProviderDialogProps {
    existing: ProviderRow | null;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

function ProviderDialog({ existing, onClose, onSaved }: ProviderDialogProps) {
    const { t } = useI18n();
    const ids = useId();
    const [provider, setProvider] = useState(existing?.provider ?? "");
    const [apiKey, setApiKey] = useState("");
    const [baseUrl, setBaseUrl] = useState(existing ? (existing.baseUrl ?? "") : "");
    const [model, setModel] = useState(existing ? (existing.defaultModel ?? "") : "");
    const [customModel, setCustomModel] = useState(() => {
        const staticList = presetFor(existing?.provider ?? "")?.models;
        return Boolean(staticList && existing?.defaultModel && !staticList.includes(existing.defaultModel));
    });
    const [transcription, setTranscription] = useState(existing?.isDefaultTranscription ?? false);
    const [enhancement, setEnhancement] = useState(existing?.isDefaultEnhancement ?? false);
    const [fetched, setFetched] = useState<{ id: string; name: string }[]>([]);
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<TestResult | null>(null);
    const [saving, setSaving] = useState(false);

    const preset = presetFor(provider);
    const canTranscribe = preset?.canTranscribe ?? true;
    const canEnhance = preset?.canEnhance ?? true;
    const dynamic = Boolean(preset?.dynamicModels);
    const keyText = apiKey.trim();

    // Provider lists that come from the provider itself load once an API key is typed.
    useEffect(() => {
        if (!dynamic || !keyText) return;
        let alive = true;
        const timer = window.setTimeout(() => {
            api<{ models: { id: string; name: string }[] }>("/api/settings/ai/providers/models", {
                method: "POST",
                json: { provider, apiKey: keyText, baseUrl: baseUrl.trim() || undefined, kind: canTranscribe ? "audio" : "chat" },
            })
                .then((answer) => {
                    if (alive) setFetched(answer.models);
                })
                .catch(() => {
                    if (alive) setFetched([]);
                });
        }, 600);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [dynamic, provider, keyText, baseUrl, canTranscribe]);

    const pickProvider = (name: string) => {
        const next = presetFor(name);
        setProvider(name);
        setBaseUrl(next?.baseUrl ?? "");
        setModel(next?.model ?? "");
        setCustomModel(false);
        setFetched([]);
        if (next && !next.canTranscribe) setTranscription(false);
        if (next && !next.canEnhance) setEnhancement(false);
    };

    const test = async () => {
        setTesting(true);
        setResult(null);
        try {
            const body: Record<string, unknown> = {
                provider,
                baseUrl: baseUrl.trim(),
                model: model.trim(),
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
            const flags = {
                baseUrl: baseUrl.trim(),
                defaultModel: model.trim(),
                isDefaultTranscription: canTranscribe && transcription,
                isDefaultEnhancement: canEnhance && enhancement,
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

    // The model control: a list when the preset has one (or the provider's list has loaded), otherwise a text field.
    const dynamicLoaded = dynamic && keyText !== "" && fetched.length > 0;
    const listed = !customModel && preset?.models ? preset.models : null;
    const modelOptions: Option[] = (() => {
        if (!customModel && dynamicLoaded) {
            const options: Option[] = fetched.map((m) => ({ value: m.id, label: m.name }));
            if (model && !options.some((o) => o.value === model)) options.unshift({ value: model, label: model });
            return [...options, { value: CUSTOM_MODEL, label: t("settings.providers.customModelOption") }];
        }
        if (!customModel && listed) {
            return [...listed.map((m) => ({ value: m, label: m })), { value: CUSTOM_MODEL, label: t("settings.providers.customModelOption") }];
        }
        return [];
    })();
    const showList = modelOptions.length > 0;
    const modelHint = listed
        ? t("settings.providers.modelHintList")
        : dynamic && canTranscribe
          ? t("settings.providers.modelHintDynamic")
          : undefined;
    const pickModel = (value: string) => {
        if (value === CUSTOM_MODEL) {
            setCustomModel(true);
            setModel("");
            return;
        }
        setModel(value);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>{existing ? t("settings.providers.editAiProvider") : t("settings.providers.addAiProvider")}</DialogTitle>
                <DialogDescription className="sr-only">{t("settings.providers.providersIntro")}</DialogDescription>

                <div className="grid gap-4">
                    <StackedField htmlFor={`${ids}-provider`} label={t("settings.providers.providerLabel")}>
                        <SettingSelect
                            id={`${ids}-provider`}
                            value={provider}
                            placeholder={t("settings.providers.selectProvider")}
                            disabled={existing !== null}
                            onValueChange={pickProvider}
                            options={PRESETS.map((p) => ({ value: p.name, label: p.name }))}
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
                            placeholder={t("settings.providers.baseUrlPlaceholder")}
                            value={baseUrl}
                            className="h-9 font-mono text-sm sm:h-9"
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                    </StackedField>

                    <StackedField
                        htmlFor={`${ids}-model`}
                        label={t("settings.providers.defaultModel")}
                        hint={
                            showList ? modelHint : dynamic && !keyText ? t("settings.providers.modelHintNeedKey") : customModel ? modelHint : undefined
                        }
                    >
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
                                {customModel && (listed || dynamicLoaded) ? (
                                    <button
                                        type="button"
                                        className="w-fit text-xs text-link underline-offset-4 hover:underline"
                                        onClick={() => {
                                            setCustomModel(false);
                                            setModel(preset?.model ?? "");
                                        }}
                                    >
                                        {t("settings.providers.backToSuggested")}
                                    </button>
                                ) : null}
                                <Input
                                    id={`${ids}-model`}
                                    value={model}
                                    placeholder={preset?.modelPlaceholder ?? DEFAULT_MODEL_PLACEHOLDER}
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
                            <output className={cn("text-sm", result.ok ? "text-success" : "text-destructive")}>{result.text}</output>
                        ) : null}
                    </div>

                    <div className="grid gap-2 rounded-xl bg-muted p-4 text-[13px]">
                        {canTranscribe ? (
                            <label className="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    className="size-4 accent-primary"
                                    checked={transcription}
                                    onChange={(e) => setTranscription(e.target.checked)}
                                />
                                <span>{t("settings.providers.useForTranscription")}</span>
                            </label>
                        ) : null}
                        <label className={cn("flex items-center gap-2", canEnhance ? "cursor-pointer" : "cursor-not-allowed opacity-50")}>
                            <input
                                type="checkbox"
                                className="size-4 accent-primary"
                                checked={canEnhance && enhancement}
                                disabled={!canEnhance}
                                onChange={(e) => setEnhancement(e.target.checked)}
                            />
                            <span>{t("settings.providers.useForEnhancement")}</span>
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
