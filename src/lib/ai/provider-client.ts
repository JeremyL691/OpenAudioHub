import { OpenAI } from "openai";
import { findPreset, isTranscriptionModel } from "@/lib/ai/provider-presets";

/** The stored fields that decide how to reach a provider and which model to use. */
export interface ProviderConnection {
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
}

/**
 * OpenAI SDK client for a stored provider. Applies the preset's default
 * headers, so providers that need extra headers work for transcription and
 * for chat alike.
 */
export function createProviderClient(
    connection: Pick<ProviderConnection, "provider" | "baseUrl">,
    apiKey: string,
    timeout?: number,
): OpenAI {
    const headers = providerHeaders(connection.provider);
    return new OpenAI({
        apiKey,
        baseURL: connection.baseUrl || undefined,
        ...(timeout === undefined ? {} : { timeout }),
        ...(headers ? { defaultHeaders: headers } : {}),
    });
}

/**
 * Headers a preset sends with every request. `OPENCODE_GO_SESSION_ID`, when
 * set, replaces the default OpenCode Go session header. Server-side only.
 */
export function providerHeaders(
    providerName: string,
): Record<string, string> | undefined {
    const headers = findPreset(providerName)?.defaultHeaders;
    if (!headers) return undefined;
    const session = process.env.OPENCODE_GO_SESSION_ID?.trim();
    return session && "x-opencode-session" in headers
        ? { ...headers, "x-opencode-session": session }
        : { ...headers };
}

/**
 * Chat model for summaries and titles. A stored transcription model is
 * replaced by the preset's chat model, or by a common default for the
 * provider's base URL.
 */
export function resolveChatModel(connection: ProviderConnection): string {
    const stored = connection.defaultModel?.trim() ?? "";
    if (stored && !isTranscriptionModel(stored, connection.provider)) {
        return stored;
    }
    const preset = findPreset(connection.provider);
    if (preset?.defaultChatModel) return preset.defaultChatModel;

    const baseUrl = connection.baseUrl || "";
    if (baseUrl.includes("groq")) return "llama-3.1-8b-instant";
    if (baseUrl.includes("together")) {
        return "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
    }
    if (baseUrl.includes("openrouter")) return "openai/gpt-4o-mini";
    return "gpt-4o-mini";
}
