import { LEGACY_CONNECTOR_GLOBAL } from "@/lib/brand/legacy";

/**
 * Bridge the browser extension (or the desktop preload) publishes on `window`.
 * Bump `version` on both sides when the contract changes.
 */
export interface ConnectorBridge {
    version: number;
    connect(): Promise<{
        accessToken: string;
        apiBase: string;
        region: "global" | "euc1" | "apse1" | "unknown";
        capturedAt: number;
    }>;
}

declare global {
    interface Window {
        __openaudiohubConnector?: ConnectorBridge;
    }
}

/** Install page for the OpenAudioHub Connector browser extension. */
export const CONNECTOR_INSTALL_URL =
    "https://github.com/JeremyL691/openaudiohub-connector#installation";

/**
 * Returns the connector bridge, under the current global name or the one the
 * extension used before the rename. Call only in the browser.
 */
export function readConnectorBridge(): ConnectorBridge | undefined {
    const scope = window as unknown as Record<
        string,
        ConnectorBridge | undefined
    >;
    return scope.__openaudiohubConnector ?? scope[LEGACY_CONNECTOR_GLOBAL];
}
