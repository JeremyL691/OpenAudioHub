import { useEffect, useState } from "react";
import { api } from "./api";

/** Server facts the signed-out pages need (`GET /api/auth/config`). */
export type PublicConfig = { registrationEnabled: boolean; passwordResetEnabled: boolean };

export interface PublicConfigState {
    /** The server's public config, or null until it has loaded. */
    config: PublicConfig | null;
    /** The error from the last failed load, or null. */
    error: Error | null;
    /** Asks the server again. */
    retry: () => void;
}

let cached: Promise<PublicConfig> | null = null;

function load(): Promise<PublicConfig> {
    cached ??= api<PublicConfig>("/api/auth/config").catch((error) => {
        cached = null;
        throw error;
    });
    return cached;
}

/** The server's public config with its load state. A failed load sets `error` until `retry` succeeds. */
export function usePublicConfigState(): PublicConfigState {
    const [config, setConfig] = useState<PublicConfig | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let alive = true;
        load()
            .then((c) => {
                if (!alive) return;
                setConfig(c);
                setError(null);
            })
            .catch((err: unknown) => {
                if (alive) setError(err instanceof Error ? err : new Error(String(err)));
            });
        return () => {
            alive = false;
        };
    }, [attempt]);
    return { config, error, retry: () => setAttempt((n) => n + 1) };
}

/** The server's public config, or null until it has loaded (and while a load is failing). */
export function usePublicConfig(): PublicConfig | null {
    return usePublicConfigState().config;
}
