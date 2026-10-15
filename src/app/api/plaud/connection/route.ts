import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { plaudConnections, plaudDevices } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { decrypt } from "@/lib/encryption";
import { apiHandler } from "@/lib/errors";
import { decodeAccessTokenExpiry } from "@/lib/plaud/auth";
import { serverKeyFromApiBase } from "@/lib/plaud/servers";

/**
 * When the stored Plaud token expires, for the desktop app's background refresh. Never returns the token. A
 * token that cannot be decrypted (for example after a key change) reports null instead of failing the request.
 */
function tokenExpiresAtOf(bearerToken: string): string | null {
    try {
        return (
            decodeAccessTokenExpiry(decrypt(bearerToken))?.toISOString() ?? null
        );
    } catch {
        return null;
    }
}

export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    const [connection] = await db
        .select()
        .from(plaudConnections)
        .where(eq(plaudConnections.userId, session.user.id))
        .limit(1);

    if (!connection) {
        return NextResponse.json({ connected: false });
    }

    const server = serverKeyFromApiBase(connection.apiBase);

    return NextResponse.json({
        connected: true,
        server,
        plaudEmail: connection.plaudEmail ?? null,
        // True once Plaud has rejected the stored token during a sync; the UI
        // uses this to prompt a reconnect. Cleared on the next good sync or
        // on reconnect.
        needsReconnect: connection.invalidatedAt != null,
        tokenExpiresAt: tokenExpiresAtOf(connection.bearerToken),
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
        // Include the raw URL so the UI can populate the custom field
        ...(server === "custom" && { apiBase: connection.apiBase }),
    });
});

/**
 * DELETE /api/plaud/connection
 *
 * Disconnects the current Plaud account for this user by deleting the
 * stored connection and its associated device rows. Synced recordings are
 * preserved — they remain in the user's OpenAudioHub library.
 */
export const DELETE = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);

    await db
        .delete(plaudDevices)
        .where(eq(plaudDevices.userId, session.user.id));

    await db
        .delete(plaudConnections)
        .where(eq(plaudConnections.userId, session.user.id));

    return NextResponse.json({ success: true });
});
