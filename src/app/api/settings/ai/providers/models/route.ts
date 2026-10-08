/**
 * POST /api/settings/ai/providers/models
 *
 * Lists models for the Add/Edit dialogs, so the user can pick one instead of
 * typing an id they may not have on hand.
 *
 * Request body: `{ provider, apiKey, baseUrl?, kind? }`. `kind` is `"audio"`
 * (default) for audio-input models, or `"chat"` for chat models on a provider
 * that cannot transcribe. The apiKey comes from the in-progress form (the
 * credential may not be saved yet). It is validated with one upstream call
 * and never persisted from this route.
 *
 * Audio lists come from OpenRouter, the only provider that exposes per-model
 * input modalities. Chat lists come from any preset with `fetchChatModels`,
 * minus the ids matching its `chatModelExclude`. Other presets return an
 * empty list, and the UI falls back to the freeform input.
 */

import { NextResponse } from "next/server";
import { findPreset, type ProviderPreset } from "@/lib/ai/provider-presets";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

interface ModelOption {
    id: string;
    name: string;
}

interface OpenRouterModel {
    id: string;
    name?: string;
    architecture?: {
        input_modalities?: string[];
    };
}

interface ModelListPayload {
    data?: { id: string; name?: string }[] | OpenRouterModel[];
}

const UPSTREAM_TIMEOUT_MS = 10_000;

export const POST = apiHandler(async (request: Request) => {
    // Auth-only: we never read or write user-scoped DB rows here, but the
    // route proxies an outbound HTTP call using a user-supplied key. Gate
    // it behind a session so anonymous traffic can't burn our egress.
    await requireApiSession(request);

    const body = (await request.json().catch(() => null)) as {
        provider?: unknown;
        apiKey?: unknown;
        baseUrl?: unknown;
        kind?: unknown;
    } | null;

    const provider = typeof body?.provider === "string" ? body.provider : "";
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
    const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl : "";
    const kind = body?.kind === "chat" ? "chat" : "audio";

    if (!provider || !apiKey) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "provider and apiKey are required",
            400,
        );
    }

    const preset = findPreset(provider);
    const effectiveBaseUrl =
        baseUrl || preset?.baseUrl || "https://api.openai.com/v1";

    if (kind === "audio" && provider === "OpenRouter") {
        const payload = await fetchModelList(
            provider,
            `${effectiveBaseUrl.replace(/\/$/, "")}/models`,
            { Authorization: `Bearer ${apiKey}` },
        );
        return NextResponse.json({ models: audioModelsFrom(payload) });
    }

    if (kind === "chat" && preset?.fetchChatModels) {
        const payload = await fetchModelList(
            provider,
            `${effectiveBaseUrl.replace(/\/$/, "")}/models`,
            {
                Authorization: `Bearer ${apiKey}`,
                ...preset.defaultHeaders,
            },
        );
        return NextResponse.json({ models: chatModelsFrom(payload, preset) });
    }

    return NextResponse.json({ models: [] satisfies ModelOption[] });
});

/** GET a provider's model catalog. Errors map to user-facing AppErrors. */
async function fetchModelList(
    providerName: string,
    url: string,
    headers: Record<string, string>,
): Promise<ModelListPayload> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            headers,
            signal: controller.signal,
            // Model catalog is fetched on demand; never cache between
            // requests. Provider catalogs change often, and Next.js's default
            // fetch cache would silently serve stale data.
            cache: "no-store",
        });
    } catch (err) {
        if ((err as Error).name === "AbortError") {
            throw new AppError(
                ErrorCode.AI_PROVIDER_API_ERROR,
                `Timed out fetching models from ${providerName}.`,
                504,
            );
        }
        throw new AppError(
            ErrorCode.AI_PROVIDER_API_ERROR,
            `Failed to reach ${providerName}.`,
            502,
        );
    } finally {
        clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_API_ERROR,
            `${providerName} rejected the API key.`,
            401,
        );
    }
    if (!response.ok) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_API_ERROR,
            `${providerName} returned ${response.status} while listing models.`,
            502,
        );
    }

    const payload = (await response
        .json()
        .catch(() => null)) as ModelListPayload | null;
    return payload ?? {};
}

function audioModelsFrom(payload: ModelListPayload): ModelOption[] {
    const list = Array.isArray(payload.data)
        ? (payload.data as OpenRouterModel[])
        : [];
    return (
        list
            .flatMap((m) =>
                (m.architecture?.input_modalities ?? []).includes("audio")
                    ? [{ id: m.id, name: m.name || m.id }]
                    : [],
            )
            // Stable alphabetical order so the dropdown doesn't reshuffle on
            // every refresh as the catalog re-orders.
            .sort((a, b) => a.name.localeCompare(b.name))
    );
}

function chatModelsFrom(
    payload: ModelListPayload,
    preset: ProviderPreset,
): ModelOption[] {
    const list = Array.isArray(payload.data) ? payload.data : [];
    return list
        .map((m) => m.id)
        .filter((id) => !preset.chatModelExclude?.test(id))
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ id, name: id }));
}
