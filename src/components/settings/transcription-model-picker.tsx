"use client";

/**
 * Model picker shared by the Add/Edit provider dialogs.
 *
 * For a provider that transcribes, it offers the transcription model list:
 *   - Preset has `fetchAudioModels: true` (OpenRouter): live-fetch the
 *     audio-input model list from the provider's /v1/models endpoint via
 *     `POST /api/settings/ai/providers/models`. Debounced on apiKey change.
 *   - Preset has `knownTranscriptionModels`: render a dropdown from the
 *     hand-curated list shipped in `provider-presets.ts`.
 *
 * For a chat-only provider (`supportsTranscription: false`, e.g. OpenCode Go),
 * it live-fetches the chat model list when the preset has `fetchChatModels`.
 *
 * Otherwise it is a plain freeform text input (LM Studio / Ollama / Custom).
 *
 * Both list modes include a final "Custom (type model name)…" option as
 * an escape hatch so users on a stale OpenAudioHub release can still type a
 * model id we haven't seeded yet.
 */

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { ProviderPreset } from "@/lib/ai/provider-presets";

interface ModelOption {
    id: string;
    name: string;
}

const CUSTOM_SENTINEL = "__custom__";

interface Props {
    preset: ProviderPreset | undefined;
    apiKey: string;
    baseUrl: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}

export function TranscriptionModelPicker({
    preset,
    apiKey,
    baseUrl,
    value,
    onChange,
    disabled,
}: Props) {
    const chatOnly = preset?.supportsTranscription === false;
    // Live fetch: audio models for transcribing presets, chat models for
    // chat-only presets.
    const [remoteModels, setRemoteModels] = useState<ModelOption[]>([]);
    const [remoteLoading, setRemoteLoading] = useState(false);
    const [remoteError, setRemoteError] = useState<string | null>(null);
    // Used to discard out-of-order fetches when the user toggles providers /
    // edits the key faster than the network responds.
    const requestId = useRef(0);

    const liveFetch = chatOnly
        ? preset?.fetchChatModels === true
        : preset?.fetchAudioModels === true;
    const shouldFetch = liveFetch && apiKey.trim().length > 0;
    const providerName = preset?.name ?? "";

    useEffect(() => {
        if (!shouldFetch) {
            setRemoteModels([]);
            setRemoteError(null);
            setRemoteLoading(false);
            return;
        }
        // Debounce so we don't fire a request on every keystroke of the
        // API key paste. 400ms feels responsive without being chatty.
        const reqId = ++requestId.current;
        setRemoteLoading(true);
        setRemoteError(null);
        const timer = setTimeout(async () => {
            try {
                const res = await fetch("/api/settings/ai/providers/models", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        provider: providerName,
                        apiKey,
                        baseUrl: baseUrl || null,
                        kind: chatOnly ? "chat" : "audio",
                    }),
                });
                const data = (await res.json().catch(() => null)) as {
                    models?: ModelOption[];
                    error?: string;
                } | null;
                if (reqId !== requestId.current) return;
                if (!res.ok) {
                    setRemoteModels([]);
                    setRemoteError(
                        data?.error ||
                            (chatOnly
                                ? "Couldn't load chat models."
                                : "Couldn't load audio models."),
                    );
                    return;
                }
                setRemoteModels(data?.models ?? []);
            } catch {
                if (reqId !== requestId.current) return;
                setRemoteError(
                    chatOnly
                        ? "Couldn't load chat models."
                        : "Couldn't load audio models.",
                );
            } finally {
                if (reqId === requestId.current) {
                    setRemoteLoading(false);
                }
            }
        }, 400);
        return () => clearTimeout(timer);
    }, [shouldFetch, providerName, apiKey, baseUrl, chatOnly]);

    // Resolve which option list (if any) we should render.
    const options: ModelOption[] = liveFetch
        ? remoteModels
        : (preset?.knownTranscriptionModels ?? []).map((id) => ({
              id,
              name: id,
          }));

    const hasOptions = options.length > 0;

    // Custom-mode toggle: true when the user explicitly picked "Custom…"
    // OR when the stored `value` isn't one of the curated options (legacy
    // values or hand-typed ids from a stale release).
    const [useCustom, setUseCustom] = useState(false);

    // Reset whenever the selected preset changes. Without this, clicking
    // "Custom…" on one provider and then switching providers leaves the
    // picker stuck in freeform mode for the new provider (where the
    // current value is a perfectly valid item in its curated list).
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset on preset change only.
    useEffect(() => {
        setUseCustom(false);
    }, [providerName]);

    useEffect(() => {
        if (!hasOptions) {
            setUseCustom(false);
            return;
        }
        if (value && !options.some((o) => o.id === value)) {
            setUseCustom(true);
        }
        // We deliberately don't flip useCustom back to false when value
        // matches an option — the user might be in the middle of typing.
    }, [hasOptions, options, value]);

    const handleSelectChange = (selected: string) => {
        if (selected === CUSTOM_SENTINEL) {
            setUseCustom(true);
            onChange("");
            return;
        }
        setUseCustom(false);
        onChange(selected);
    };

    // Helper text below the picker.
    let helper: string | null = null;
    if (liveFetch) {
        if (remoteLoading) {
            helper = chatOnly
                ? "Loading chat models…"
                : "Loading audio-capable models…";
        } else if (remoteError) {
            helper = remoteError;
        } else if (hasOptions) {
            helper = chatOnly
                ? "Chat models from the provider. Used for summaries and titles."
                : "Only audio-input models are shown. Transcription uses chat-completions; mp3/wav recordings only.";
        } else {
            helper = "Enter your API key to load the model list.";
        }
    } else if (preset?.knownTranscriptionModels?.length) {
        helper =
            "Pick a transcription model. Choose Custom… to type a model id we haven't shipped yet.";
    }

    return (
        <div className="space-y-2">
            <Label htmlFor="defaultModel">
                {chatOnly ? "Default chat model" : "Default Model"}
            </Label>
            {hasOptions && !useCustom ? (
                <Select
                    value={value || undefined}
                    onValueChange={handleSelectChange}
                    disabled={disabled}
                >
                    <SelectTrigger>
                        <SelectValue
                            placeholder={
                                chatOnly
                                    ? "Pick a chat model"
                                    : "Pick a transcription model"
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {options.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                                {m.name}
                            </SelectItem>
                        ))}
                        <SelectItem value={CUSTOM_SENTINEL}>
                            Custom (type model name)…
                        </SelectItem>
                    </SelectContent>
                </Select>
            ) : (
                <Input
                    id="defaultModel"
                    type="text"
                    placeholder={
                        chatOnly
                            ? "deepseek-v4.1-flash, gpt-4o-mini, etc."
                            : "whisper-1, gpt-4o, etc."
                    }
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    disabled={disabled}
                    className="font-mono text-sm"
                />
            )}
            {hasOptions && useCustom && (
                <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => {
                        setUseCustom(false);
                        onChange(options[0]?.id ?? "");
                    }}
                >
                    Back to suggested models
                </button>
            )}
            {helper && (
                <p className="text-xs text-muted-foreground">{helper}</p>
            )}
        </div>
    );
}
