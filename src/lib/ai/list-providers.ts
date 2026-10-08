import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiCredentials, userSettings } from "@/db/schema";

export interface ProviderListItem {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
    createdAt: Date;
}

/**
 * List a user's transcription/enhancement providers for the Providers UI.
 *
 * The authoritative transcription default is
 * `userSettings.defaultTranscriptionProviderId` (a credential id or null).
 * The per-row `isDefaultTranscription` boolean is derived from it here so the
 * UI has a single source of truth.
 */
export async function listUserProviders(
    userId: string,
): Promise<ProviderListItem[]> {
    const [settings] = await db
        .select({ pointer: userSettings.defaultTranscriptionProviderId })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    const pointer = settings?.pointer ?? null;

    const rows = await db
        .select({
            id: apiCredentials.id,
            provider: apiCredentials.provider,
            baseUrl: apiCredentials.baseUrl,
            defaultModel: apiCredentials.defaultModel,
            isDefaultEnhancement: apiCredentials.isDefaultEnhancement,
            createdAt: apiCredentials.createdAt,
        })
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, userId));

    return rows.map((row) => ({
        ...row,
        isDefaultTranscription: row.id === pointer,
    }));
}
