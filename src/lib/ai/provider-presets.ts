import { OPENCODE_GO_SESSION_ID } from "@/lib/brand/legacy";

export type TranscriptionStyle = "whisper" | "chat" | "gemini" | "elevenlabs";

/** Model ids that transcribe audio. Matched when no preset list names the model. */
const TRANSCRIPTION_MODEL_PATTERN =
    /whisper|asr|sensevoice|telespeech|transcribe|scribe|parakeet|speech/i;

export interface ProviderPreset {
    name: string;
    baseUrl: string;
    placeholder: string;
    defaultModel: string;
    transcriptionStyle: TranscriptionStyle;
    fetchAudioModels?: boolean;
    knownTranscriptionModels?: readonly string[];
    /**
     * Whether this provider can be used for AI enhancements (summaries,
     * titles) via `chat.completions`. Defaults to `true` when omitted --
     * only transcription-only providers (e.g. ElevenLabs Scribe) set this
     * to `false`.
     */
    supportsEnhancement?: boolean;
    /**
     * Whether this provider can transcribe audio. Defaults to `true`. Chat-only
     * providers such as OpenCode Go set this to `false`.
     */
    supportsTranscription?: boolean;
    /**
     * Chat model for summaries and titles. Used when the stored model is a
     * transcription model, as on a provider that both transcribes and chats.
     */
    defaultChatModel?: string;
    /** List chat models from `GET {baseUrl}/models` in the model picker. */
    fetchChatModels?: boolean;
    /** Model ids matching this pattern are left out of the chat model list. */
    chatModelExclude?: RegExp;
    /** Headers sent with every request to this provider. */
    defaultHeaders?: Readonly<Record<string, string>>;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
    {
        name: "OpenAI",
        baseUrl: "",
        placeholder: "sk-...",
        defaultModel: "whisper-1",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "whisper-1",
            "gpt-4o-transcribe",
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe-diarize",
        ],
    },
    {
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        placeholder: "gsk_...",
        defaultModel: "whisper-large-v3-turbo",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "whisper-large-v3-turbo",
            "whisper-large-v3",
        ],
    },
    {
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        placeholder: "...",
        defaultModel: "openai/whisper-large-v3",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "openai/whisper-large-v3",
            "nvidia/parakeet-tdt-0.6b-v3",
        ],
    },
    {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        placeholder: "sk-or-...",
        defaultModel: "google/gemini-2.5-flash-lite",
        transcriptionStyle: "chat",
        fetchAudioModels: true,
    },
    {
        name: "SiliconFlow (China)",
        baseUrl: "https://api.siliconflow.cn/v1",
        placeholder: "sk-...",
        defaultModel: "FunAudioLLM/SenseVoiceSmall",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "FunAudioLLM/SenseVoiceSmall",
            "TeleAI/TeleSpeechASR",
            "XingChenAGI/XingChenASR-V3.2-Ultra",
        ],
        defaultChatModel: "Qwen/Qwen2.5-7B-Instruct",
        fetchChatModels: true,
        chatModelExclude:
            /asr|sensevoice|telespeech|speech|audio|tts|embed|rerank|bge|image|flux/i,
    },
    {
        name: "OpenCode Go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        placeholder: "sk-...",
        defaultModel: "deepseek-v4.1-flash",
        transcriptionStyle: "chat",
        supportsTranscription: false,
        fetchChatModels: true,
        // MiniMax and Qwen models use the Anthropic Messages format, which the
        // OpenAI-compatible path here cannot call.
        chatModelExclude: /minimax|qwen/i,
        defaultHeaders: { "x-opencode-session": OPENCODE_GO_SESSION_ID },
    },
    {
        name: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
        placeholder: "lm-studio",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        placeholder: "ollama",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Google Gemini",
        baseUrl: "",
        placeholder: "AIza...",
        defaultModel: "gemini-2.0-flash",
        transcriptionStyle: "gemini",
        knownTranscriptionModels: [
            "gemini-2.0-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ],
    },
    {
        name: "ElevenLabs",
        baseUrl: "https://api.elevenlabs.io/v1",
        placeholder: "sk_...",
        defaultModel: "scribe_v2",
        transcriptionStyle: "elevenlabs",
        knownTranscriptionModels: ["scribe_v2", "scribe_v1"],
        supportsEnhancement: false,
    },
    {
        name: "Custom",
        baseUrl: "",
        placeholder: "Your API key",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
] as const;

export function findPreset(name: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find((p) => p.name === name);
}

export function getTranscriptionStyle(
    providerName: string,
): TranscriptionStyle {
    return findPreset(providerName)?.transcriptionStyle ?? "whisper";
}

/**
 * Whether a provider can run AI enhancements (summaries, titles) via
 * `chat.completions`. Unknown/custom provider names default to `true`.
 */
export function supportsEnhancement(providerName: string): boolean {
    return findPreset(providerName)?.supportsEnhancement ?? true;
}

/**
 * Whether a provider can transcribe audio. Unknown/custom provider names
 * default to `true`.
 */
export function supportsTranscription(providerName: string): boolean {
    return findPreset(providerName)?.supportsTranscription ?? true;
}

/** True when the model id names a transcription model rather than a chat model. */
export function isTranscriptionModel(
    model: string,
    providerName: string,
): boolean {
    const known =
        findPreset(providerName)?.knownTranscriptionModels?.includes(model) ??
        false;
    return known || TRANSCRIPTION_MODEL_PATTERN.test(model);
}
