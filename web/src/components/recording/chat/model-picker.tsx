/** The model chip under the question box, and the popover that picks provider, model and thinking level. */
import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n, type MessageKey } from "@/lib/i18n";

export interface ChatProviderOption {
    id: string;
    /** The provider type, such as "OpenRouter". */
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
}

export interface ModelPickerProps {
    providers: ChatProviderOption[];
    providerId: string;
    model: string;
    effort: string;
    /** Levels the chosen model takes, from `ChatData.capabilities.effort`, lowest first. */
    efforts: string[];
    /** False when the model's levels are not known (`ChatData.capabilities.known`). */
    effortKnown: boolean;
    disabled?: boolean;
    onChange(patch: { providerId?: string; model?: string; effort?: string }): void;
}

export const EFFORT_LABELS: Record<string, MessageKey> = {
    default: "recording.chat.effortDefault",
    minimal: "recording.chat.effortMinimal",
    low: "recording.chat.effortLow",
    medium: "recording.chat.effortMedium",
    high: "recording.chat.effortHigh",
    xhigh: "recording.chat.effortXhigh",
    max: "recording.chat.effortMax",
};

interface ModelRow {
    id: string;
    name: string;
}

type ModelList = { status: "loading" } | { status: "ready"; models: ModelRow[] } | { status: "failed" };

/** The part of a model id after its vendor prefix, which is what a reader recognises. */
export function shortModel(model: string | null | undefined): string {
    if (!model) return "";
    const slash = model.lastIndexOf("/");
    return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Provider names, made distinct when two saved providers are of the same kind. */
function providerLabels(providers: ChatProviderOption[]): Map<string, string> {
    const counts = new Map<string, number>();
    for (const row of providers) counts.set(row.provider, (counts.get(row.provider) ?? 0) + 1);
    const labels = new Map<string, string>();
    for (const row of providers) {
        if ((counts.get(row.provider) ?? 0) < 2) {
            labels.set(row.id, row.provider);
            continue;
        }
        const detail = shortModel(row.defaultModel) || hostOf(row.baseUrl) || row.id.slice(-4);
        labels.set(row.id, `${row.provider} · ${detail}`);
    }
    return labels;
}

function hostOf(url: string | null): string {
    if (!url) return "";
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

const SECTION = "px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground";

/** Picks the provider, model and thinking level for the next question. */
export function ModelPicker({ providers, providerId, model, effort, efforts, effortKnown, disabled, onChange }: ModelPickerProps) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [lists, setLists] = useState<Record<string, ModelList>>({});
    const labels = useMemo(() => providerLabels(providers), [providers]);
    const list = providerId ? lists[providerId] : undefined;

    useEffect(() => {
        if (!open || !providerId || list) return;
        setLists((current) => ({ ...current, [providerId]: { status: "loading" } }));
        api<{ models: ModelRow[] }>(`/api/settings/ai/providers/${encodeURIComponent(providerId)}/chat-models`)
            .then((answer) => setLists((current) => ({ ...current, [providerId]: { status: "ready", models: answer.models } })))
            .catch(() => setLists((current) => ({ ...current, [providerId]: { status: "failed" } })));
    }, [open, providerId, list]);

    const typed = search.trim();
    const models = list?.status === "ready" ? list.models : [];
    const offerTyped = typed !== "" && !models.some((row) => row.id === typed);
    const effortLabel = effort !== "default" && EFFORT_LABELS[effort] ? t(EFFORT_LABELS[effort]) : null;
    const chipName = shortModel(model) || labels.get(providerId) || t("recording.chat.modelPick");

    const choose = (next: string) => {
        onChange({ model: next });
        setOpen(false);
        setSearch("");
    };

    return (
        <Popover open={open} onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSearch("");
        }}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-testid="chat-model-picker"
                    aria-label={t("recording.chat.modelChipAria")}
                    disabled={disabled}
                    className="flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-muted data-[state=open]:text-foreground"
                >
                    <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                    <span className="max-w-[200px] truncate">{chipName}</span>
                    {effortLabel ? (
                        <>
                            <span aria-hidden="true" className="text-muted-foreground/60">·</span>
                            <span className="shrink-0">{effortLabel}</span>
                        </>
                    ) : null}
                    <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-60" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-[min(340px,calc(100vw-2rem))] overflow-hidden p-0">
                {providers.length > 1 ? (
                    <div className="border-b border-border/60 pb-1.5">
                        <p className={SECTION}>{t("recording.chat.provider")}</p>
                        <div role="listbox" aria-label={t("recording.chat.provider")} className="grid px-1.5">
                            {providers.map((row) => {
                                const selected = row.id === providerId;
                                return (
                                    <button
                                        key={row.id}
                                        type="button"
                                        role="option"
                                        aria-selected={selected}
                                        onClick={() => onChange({ providerId: row.id })}
                                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
                                    >
                                        <span className="min-w-0 flex-1 truncate">{labels.get(row.id)}</span>
                                        {selected ? <Check aria-hidden="true" className="size-4 shrink-0 text-primary" /> : null}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ) : null}

                <Command label={t("recording.chat.model")} loop className="flex flex-col">
                    <p className={SECTION}>{t("recording.chat.model")}</p>
                    <div className="mx-3 mb-1 flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5">
                        <Search aria-hidden="true" className="size-3.5 shrink-0 opacity-50" />
                        <Command.Input
                            value={search}
                            onValueChange={setSearch}
                            placeholder={t("recording.chat.modelSearch")}
                            aria-label={t("recording.chat.model")}
                            className="flex w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
                        />
                    </div>
                    <Command.List className="max-h-60 overflow-y-auto px-1.5 pb-1.5">
                        {list?.status === "loading" ? (
                            <Command.Loading>
                                <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("recording.chat.modelLoading")}</p>
                            </Command.Loading>
                        ) : null}
                        {list?.status === "failed" ? (
                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("recording.chat.modelFetchFailed")}</p>
                        ) : null}
                        {offerTyped ? (
                            <Command.Item
                                value={`typed:${typed}`}
                                forceMount
                                onSelect={() => choose(typed)}
                                className="flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none data-[selected=true]:bg-accent"
                            >
                                <span className="min-w-0 flex-1 truncate">{t("recording.chat.modelUseTyped", { model: typed })}</span>
                            </Command.Item>
                        ) : null}
                        {list?.status === "ready" ? (
                            <Command.Empty className="px-2 py-3 text-center text-xs text-muted-foreground">{t("recording.chat.modelNone")}</Command.Empty>
                        ) : null}
                        {models.map((row) => {
                            const selected = row.id === model;
                            return (
                                <Command.Item
                                    key={row.id}
                                    value={row.id}
                                    keywords={[row.name]}
                                    onSelect={() => choose(row.id)}
                                    className="flex cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none data-[selected=true]:bg-accent"
                                >
                                    <span className="grid min-w-0 flex-1 leading-tight">
                                        <span className="truncate">{row.name}</span>
                                        {row.name !== row.id ? (
                                            <span className="truncate font-mono text-[11px] text-muted-foreground">{row.id}</span>
                                        ) : null}
                                    </span>
                                    {selected ? <Check aria-hidden="true" className="size-4 shrink-0 text-primary" /> : null}
                                </Command.Item>
                            );
                        })}
                    </Command.List>
                </Command>

                <div className="border-t border-border/60 pb-3">
                    <p className={SECTION}>{t("recording.chat.effort")}</p>
                    {effortKnown && efforts.length > 0 ? (
                        <div role="radiogroup" aria-label={t("recording.chat.effort")} className="flex flex-wrap gap-1 px-3 pt-0.5">
                            {["default", ...efforts.filter((level) => level !== "default")].map((level) => {
                                const selected = level === effort;
                                return (
                                    <button
                                        key={level}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        onClick={() => onChange({ effort: level })}
                                        className={cn(
                                            "h-7 rounded-full px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                                            selected
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-secondary text-muted-foreground hover:text-foreground",
                                        )}
                                    >
                                        {EFFORT_LABELS[level] ? t(EFFORT_LABELS[level]) : level}
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="px-3 text-xs text-muted-foreground">
                            {effortKnown ? t("recording.chat.effortNotSupported") : t("recording.chat.effortUnknown")}
                        </p>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
