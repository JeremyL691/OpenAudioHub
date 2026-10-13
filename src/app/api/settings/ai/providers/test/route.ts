/**
 * POST /api/settings/ai/providers/test
 *
 * "Test connection" for the AI provider dialogs and the provider list.
 *
 * Request body: `{ provider, model?, apiKey?, baseUrl?, id? }`. An empty
 * `apiKey` with an `id` tests the stored credential of that row (the edit
 * flow and the list both rely on this). Nothing is persisted here.
 *
 * Makes one tiny upstream call: a chat completion for chat models, or a
 * one-second silent MP3 transcription for transcription models. Upstream
 * failures return 200 with `{ ok: false, error }` so the UI can show them
 * inline; the API key is redacted from the message.
 */

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { buildChatCompletionParams } from "@/lib/ai/chat-completion-params";
import {
    createProviderClient,
    type ProviderConnection,
} from "@/lib/ai/provider-client";
import {
    findPreset,
    getTranscriptionStyle,
    isTranscriptionModel,
    supportsEnhancement,
} from "@/lib/ai/provider-presets";
import { requireApiSession } from "@/lib/auth-server";
import { decrypt } from "@/lib/encryption";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { chatTranscribe } from "@/lib/transcription/chat-transcribe";
import { elevenLabsTranscribe } from "@/lib/transcription/elevenlabs-transcribe";
import { runFfmpeg } from "@/lib/transcription/ffmpeg";
import { geminiTranscribe } from "@/lib/transcription/gemini-transcribe";

const TEST_TIMEOUT_MS = 20_000;
const MAX_ERROR_CHARS = 300;

export const POST = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const body = (await request.json().catch(() => null)) as {
        provider?: unknown;
        model?: unknown;
        apiKey?: unknown;
        baseUrl?: unknown;
        id?: unknown;
    } | null;

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    let provider = str(body?.provider);
    let model = str(body?.model);
    let apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
    let baseUrl = str(body?.baseUrl);
    const id = str(body?.id);

    if (!apiKey && !id) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "apiKey or id is required",
            400,
        );
    }

    if (!apiKey) {
        const [row] = await db
            .select()
            .from(apiCredentials)
            .where(
                and(
                    eq(apiCredentials.id, id),
                    eq(apiCredentials.userId, session.user.id),
                ),
            )
            .limit(1);
        if (!row) {
            throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
        }
        apiKey = decrypt(row.apiKey);
        provider = provider || row.provider;
        model = model || row.defaultModel || "";
        baseUrl = baseUrl || row.baseUrl || "";
    }

    if (!provider) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "provider is required",
            400,
        );
    }

    model = model || findPreset(provider)?.defaultModel || "";
    const isTranscription =
        isTranscriptionModel(model, provider) || !supportsEnhancement(provider);
    const kind = isTranscription ? "transcription" : "chat";

    const conn: ProviderConnection = {
        provider,
        baseUrl: baseUrl || null,
        defaultModel: model,
    };
    const started = performance.now();

    try {
        const client = createProviderClient(conn, apiKey, TEST_TIMEOUT_MS);

        if (isTranscription) {
            const buf = await runFfmpeg(Buffer.alloc(0), [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=16000:cl=mono",
                "-t",
                "1",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "32k",
                "-f",
                "mp3",
                "pipe:1",
            ]);

            switch (getTranscriptionStyle(provider)) {
                case "whisper":
                    await client.audio.transcriptions.create({
                        model,
                        file: new File([new Uint8Array(buf)], "test.mp3", {
                            type: "audio/mpeg",
                        }),
                    });
                    break;
                case "chat":
                    await chatTranscribe({
                        client,
                        model,
                        audioBuffer: buf,
                        contentType: "audio/mpeg",
                    });
                    break;
                case "gemini":
                    await geminiTranscribe({
                        apiKey,
                        model,
                        audioBuffer: buf,
                        contentType: "audio/mpeg",
                    });
                    break;
                case "elevenlabs":
                    await elevenLabsTranscribe({
                        apiKey,
                        model,
                        file: new File([new Uint8Array(buf)], "test.mp3", {
                            type: "audio/mpeg",
                        }),
                        baseUrl: conn.baseUrl,
                        diarize: false,
                        timeoutMs: TEST_TIMEOUT_MS,
                    });
                    break;
            }
        } else {
            await client.chat.completions.create(
                buildChatCompletionParams({
                    model,
                    messages: [{ role: "user", content: "Reply with OK." }],
                    temperature: 0,
                    maxTokens: 16,
                }),
            );
        }

        return NextResponse.json({
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            kind,
        });
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const redacted = apiKey ? raw.split(apiKey).join("***") : raw;
        return NextResponse.json({
            ok: false,
            kind,
            error: redacted.slice(0, MAX_ERROR_CHARS),
        });
    }
});
