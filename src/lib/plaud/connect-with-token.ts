import { AppError, ErrorCode } from "@/lib/errors";
import {
    decodeAccessTokenExpiry,
    fetchPlaudUserMeEmail,
    isPlaudWorkspaceToken,
} from "./auth";
import { DEFAULT_PLAUD_API_BASE } from "./client";
import {
    type PersistPlaudConnectionResult,
    persistPlaudConnection,
} from "./persist-connection";
import { isValidPlaudApiUrl } from "./servers";

export interface ConnectPlaudWithTokenInput {
    userId: string;
    accessToken: string;
    apiBase?: unknown;
    source?: unknown;
}

export type ConnectPlaudWithTokenResult = Pick<
    PersistPlaudConnectionResult,
    "devices"
>;

/**
 * Validate a Plaud user access token and persist it as the user's connection.
 *
 * Throws AppError on any validation failure: missing token, malformed JWT,
 * workspace token pasted, expired token, invalid apiBase, or a Plaud
 * rejection during device validation.
 */
export async function connectPlaudWithToken({
    userId,
    accessToken: rawAccessToken,
    apiBase,
    source,
}: ConnectPlaudWithTokenInput): Promise<ConnectPlaudWithTokenResult> {
    const accessToken = rawAccessToken.trim().replace(/^Bearer\s+/i, "");
    if (!accessToken) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "accessToken is required",
            400,
            { field: "accessToken" },
        );
    }

    if (accessToken.split(".").length !== 3) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "That doesn't look like a Plaud access token. Copy the value of the Authorization header on a request to api*.plaud.ai (without the leading 'Bearer ').",
            400,
            { field: "accessToken" },
        );
    }

    if (isPlaudWorkspaceToken(accessToken)) {
        throw new AppError(
            ErrorCode.PLAUD_WORKSPACE_TOKEN_PASTED,
            "That's a workspace token, which expires in about 24 hours. OpenAudioHub needs your long-lived account token. Easiest fix: use the OpenAudioHub Connector. To paste manually, copy the value of the pld_ut cookie on web.plaud.ai (DevTools, Application, Cookies), not the Authorization header from a /device/list request.",
            400,
            { field: "accessToken" },
        );
    }

    const exp = decodeAccessTokenExpiry(accessToken);
    if (exp && exp.getTime() < Date.now()) {
        throw new AppError(
            ErrorCode.PLAUD_INVALID_TOKEN,
            "This Plaud access token has already expired. Sign in to web.plaud.ai again and copy a fresh one.",
            400,
        );
    }

    const apiBaseRaw =
        typeof apiBase === "string" && apiBase.trim().length > 0
            ? apiBase.trim().replace(/\/+$/, "")
            : DEFAULT_PLAUD_API_BASE;

    if (!isValidPlaudApiUrl(apiBaseRaw)) {
        throw new AppError(
            ErrorCode.PLAUD_INVALID_API_BASE,
            "Invalid API base",
            400,
        );
    }

    const plaudEmail = await fetchPlaudUserMeEmail(accessToken, apiBaseRaw);

    const rawSource = typeof source === "string" ? source : "unknown";
    const method =
        rawSource === "connector" || rawSource === "paste"
            ? rawSource
            : "unknown";
    console.log(
        `[plaud/connect-token] persisting connection (source=${rawSource}, apiBase=${apiBaseRaw})`,
    );

    const { devices } = await persistPlaudConnection({
        userId,
        accessToken,
        apiBase: apiBaseRaw,
        plaudEmail,
        method,
    });

    return { devices };
}
