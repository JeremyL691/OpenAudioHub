import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router";
import { ACCOUNT_SUSPENDED_EVENT, api } from "./api";

export interface SessionUser {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface SessionData {
    session: {
        id: string;
        token: string;
        userId: string;
        expiresAt: string;
        createdAt: string;
        updatedAt: string;
        ipAddress?: string | null;
        userAgent?: string | null;
    };
    user: SessionUser;
}

export type SessionStatus = "loading" | "authenticated" | "anonymous";

export interface SessionState {
    status: SessionStatus;
    data: SessionData | null;
}

// One shared store, so every component sees the same answer and only one request runs at a time.
let current: SessionState = { status: "loading", data: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
    current = next;
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Asks the server who is signed in. A failed request counts as signed out. */
export function refreshSession(): Promise<void> {
    if (!inflight) {
        inflight = api<SessionData | null>("/api/auth/get-session")
            .then(
                (data) => setState(data ? { status: "authenticated", data } : { status: "anonymous", data: null }),
                () => setState({ status: "anonymous", data: null }),
            )
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

/** The current session. Loads it on first use. `refresh` asks the server again. */
export function useSession(): SessionState & { refresh: () => Promise<void> } {
    const state = useSyncExternalStore(
        subscribe,
        () => current,
        () => current,
    );
    useEffect(() => {
        if (current.status === "loading") void refreshSession();
    }, []);
    return { ...state, refresh: refreshSession };
}

/** Ends the session on the server and forgets it here. Callers navigate afterwards. */
/** Ends the session, then loads /login from scratch so no state of the old session stays in memory. */
export async function signOut(): Promise<void> {
    try {
        await api("/api/auth/sign-out", { method: "POST", json: {} });
    } finally {
        window.location.assign("/login");
    }
}

/**
 * Guards a route. Waits for the session, sends signed-out visitors to /login, and sends
 * anyone whose API call answered ACCOUNT_SUSPENDED to /suspended.
 */
export function RequireSession({ children }: { children: ReactNode }) {
    const { status } = useSession();
    const navigate = useNavigate();

    useEffect(() => {
        const onSuspended = () => navigate("/suspended", { replace: true });
        window.addEventListener(ACCOUNT_SUSPENDED_EVENT, onSuspended);
        return () => window.removeEventListener(ACCOUNT_SUSPENDED_EVENT, onSuspended);
    }, [navigate]);

    // The server already sends signed-out page loads to /login, so the page renders while the
    // session loads; waiting would delay keyboard shortcuts and first paint for no gain.
    if (status === "anonymous") return <Navigate to="/login" replace />;
    return <>{children}</>;
}
