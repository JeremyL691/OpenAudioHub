import type { StoredResult } from "./flow";
import type { FailureReason } from "./protocol";

/** A stored result older than this is not shown. */
export const RESULT_TTL = 10 * 60_000;

export type PopupView =
    | { state: "waiting" }
    | { state: "confirm"; failure: FailureReason | null }
    | { state: "result"; result: StoredResult }
    | { state: "help" };

export interface PopupInput {
    hasFlow: boolean;
    result: StoredResult | null;
    isConnectPage: boolean;
    now: number;
}

function fresh(result: StoredResult | null, now: number): StoredResult | null {
    if (result === null || typeof result.at !== "number") return null;
    return now - result.at <= RESULT_TTL ? result : null;
}

/**
 * Picks what the popup shows. A connect page always offers Connect, so a result left from an
 * earlier sign-in never takes the first click. A recent failure is shown above the Connect button.
 */
export function choosePopupView(input: PopupInput): PopupView {
    if (input.hasFlow) return { state: "waiting" };
    const result = fresh(input.result, input.now);
    if (input.isConnectPage) {
        return { state: "confirm", failure: result !== null && !result.ok ? result.reason : null };
    }
    if (result !== null) return { state: "result", result };
    return { state: "help" };
}
