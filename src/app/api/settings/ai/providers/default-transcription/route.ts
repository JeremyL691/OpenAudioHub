import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiCredentials } from "@/db/schema";
import { supportsTranscription } from "@/lib/ai/provider-presets";
import { setDefaultTranscriptionProvider } from "@/lib/ai/set-default-transcription";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";

const bodySchema = z.object({
    providerId: z.string().min(1),
});

export const PUT = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const raw = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Invalid request body",
            400,
            { issues: parsed.error.flatten() },
        );
    }

    const { providerId } = parsed.data;

    const [provider] = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
        })
        .from(apiCredentials)
        .where(
            and(
                eq(apiCredentials.id, providerId),
                eq(apiCredentials.userId, session.user.id),
            ),
        )
        .limit(1);

    if (!provider) {
        throw new AppError(ErrorCode.NOT_FOUND, "Provider not found", 404);
    }

    if (!supportsTranscription(provider.provider)) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `${provider.provider} does not support transcription (chat only)`,
            400,
        );
    }

    await setDefaultTranscriptionProvider(session.user.id, providerId);

    return NextResponse.json({ success: true });
});
