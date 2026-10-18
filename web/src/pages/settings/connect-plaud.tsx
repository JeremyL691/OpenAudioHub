import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, errorMessage } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";

/** The browser connector bridge. It returns the account token captured in the browser. */
interface ConnectorBridge {
    connect: () => Promise<{ accessToken: string; apiBase?: string }>;
}

const CONNECTOR_POLL_MS = 250;

function connectorBridge(): ConnectorBridge | null {
    const scope = window as unknown as Record<string, ConnectorBridge | undefined>;
    return scope.__openaudiohubConnector ?? null;
}

type Outcome =
    | { kind: "detecting" }
    | { kind: "ready"; bridge: ConnectorBridge }
    | { kind: "connecting" }
    | { kind: "done" }
    | { kind: "missing" }
    | { kind: "error"; message: string };

/** Hands the browser's Plaud account token to the server, for the one-time code the desktop app opened this page with. */
export default function ConnectPlaudPage() {
    const [params] = useSearchParams();
    const code = (params.get("code") ?? "").trim();
    const [outcome, setOutcome] = useState<Outcome>({ kind: "detecting" });

    useEffect(() => {
        document.title = "Connect Plaud · OpenAudioHub";
    }, []);

    useEffect(() => {
        if (!code) {
            setOutcome({ kind: "error", message: "This sign-in link is incomplete. Start again from the OpenAudioHub app." });
            return;
        }

        let checks = 0;
        const interval = window.setInterval(() => {
            const bridge = connectorBridge();
            if (bridge) {
                window.clearInterval(interval);
                setOutcome({ kind: "ready", bridge });
                return;
            }
            checks++;
            if (checks >= 16) {
                window.clearInterval(interval);
                setOutcome({ kind: "missing" });
            }
        }, CONNECTOR_POLL_MS);

        return () => window.clearInterval(interval);
    }, [code]);

    const handleConnect = async (bridge: ConnectorBridge) => {
        setOutcome({ kind: "connecting" });
        try {
            const captured = await bridge.connect();
            await api("/api/plaud/auth/handoff/complete", {
                method: "POST",
                json: { code, accessToken: captured.accessToken, apiBase: captured.apiBase },
            });
            setOutcome({ kind: "done" });
        } catch (err) {
            setOutcome({ kind: "error", message: errorMessage(err, "Plaud sign-in failed.") });
        }
    };

    return (
        <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
            <section className="grid w-full max-w-md gap-4 rounded-2xl bg-card p-6 text-card-foreground shadow-card">
                <h1 className="text-[22px] font-bold tracking-tight text-foreground">Connect Plaud</h1>
                {outcome.kind === "detecting" ? (
                    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner label="Checking for connector" />
                        Waiting for the Plaud browser connector…
                    </p>
                ) : null}
                {outcome.kind === "ready" ? (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Sign in to Plaud in this browser. When you click below, the connector will capture your sign-in and return it to OpenAudioHub.
                        </p>
                        <button
                            type="button"
                            className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90"
                            onClick={() => void handleConnect(outcome.bridge)}
                        >
                            Continue with Plaud
                        </button>
                    </div>
                ) : null}
                {outcome.kind === "connecting" ? (
                    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner label="Connecting Plaud" />
                        Waiting for Plaud sign-in in browser…
                    </p>
                ) : null}
                {outcome.kind === "missing" ? (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            The OpenAudioHub browser connector extension was not detected. Please install it, then reload this page.
                        </p>
                        <a
                            href="https://github.com/JeremyL691/openaudiohub-connector#installation"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90"
                        >
                            Install Connector Extension
                        </a>
                        <button
                            type="button"
                            className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-border px-4 font-medium text-foreground hover:bg-muted"
                            onClick={() => window.location.reload()}
                        >
                            Reload
                        </button>
                    </div>
                ) : null}
                {outcome.kind === "done" ? (
                    <p role="status" className="text-sm font-medium text-foreground">
                        ✓ Plaud is connected. You can close this window and return to OpenAudioHub.
                    </p>
                ) : null}
                {outcome.kind === "error" ? (
                    <div className="space-y-3">
                        <p role="alert" className="text-sm text-destructive">
                            {outcome.message}
                        </p>
                        <button
                            type="button"
                            className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
                            onClick={() => window.location.reload()}
                        >
                            Try Again
                        </button>
                    </div>
                ) : null}
            </section>
        </div>
    );
}
