import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { Loading } from "./shared";

export interface PlaudConnection {
    connected: boolean;
    server?: "global" | "eu" | "apse1" | "cn" | "custom";
    apiBase?: string;
    plaudEmail?: string | null;
    needsReconnect?: boolean;
    tokenExpiresAt?: string | null;
    createdAt?: string;
}

const REGION_LABELS: Record<string, string> = {
    global: "Global",
    eu: "EU, Frankfurt",
    apse1: "Asia Pacific, Singapore",
    cn: "China mainland",
    custom: "Custom",
};

interface SendCodeAnswer {
    otpToken: string;
    apiBase: string;
}

interface HandoffAnswer {
    code: string;
    expiresAt: number;
}

interface HandoffStatus {
    status: "pending" | "connected" | "expired";
    error?: string;
}

/** Loads the connection state and offers the sign-in and disconnect actions. */
export function PlaudAccountSection() {
    const [conn, setConn] = useState<PlaudConnection | null>(null);
    const [loadError, setLoadError] = useState<unknown>(null);
    const [signIn, setSignIn] = useState(false);
    const [confirm, setConfirm] = useState<"switch" | "disconnect" | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            setConn(await api<PlaudConnection>("/api/plaud/connection"));
            setLoadError(null);
        } catch (err) {
            setLoadError(err);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const disconnect = async (thenSignIn: boolean) => {
        setBusy(true);
        try {
            await api("/api/plaud/connection", { method: "DELETE" });
            if (!thenSignIn) toast.success("Plaud account disconnected");
            await load();
            if (thenSignIn) setSignIn(true);
        } catch (err) {
            toast.error(errorMessage(err, "Failed to disconnect the Plaud account"));
        } finally {
            setBusy(false);
        }
    };

    const connectedNow = async () => {
        setSignIn(false);
        toast.success("Plaud account connected");
        await load();
    };

    const connected = conn?.connected === true;

    return (
        <div className="grid gap-4">
            <p className="text-xs text-muted-foreground">
                The Plaud account OpenAudioHub pulls recordings from. Your library stays as it is when you switch accounts. Only later syncs
                follow the new account.
            </p>
            {conn === null && !loadError ? <Loading label="Loading Plaud account" /> : null}
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(loadError, "The Plaud connection could not be loaded.")}
                </p>
            ) : null}

            {conn && !connected ? (
                <div className="grid gap-3 rounded-xl bg-muted px-4 py-3">
                    <p className="text-xs text-muted-foreground">No Plaud account connected. Sign in below to start syncing recordings.</p>
                    <PlaudSignInPanel onConnected={connectedNow} />
                </div>
            ) : null}

            {conn && connected ? (
                <div className="divide-y divide-border rounded-xl bg-muted px-4">
                    <div className="flex flex-wrap items-start justify-between gap-3 py-3">
                        <div className="min-w-0 space-y-0.5">
                            <p className="text-xs text-muted-foreground">Connected account</p>
                            <p className="truncate text-[13px] font-medium">{conn.plaudEmail ?? "Email not available"}</p>
                            <p className="text-xs text-muted-foreground">
                                Region: {REGION_LABELS[conn.server ?? "global"] ?? "Global"}
                                {conn.tokenExpiresAt ? ` · Token valid until ${formatDate(conn.tokenExpiresAt)}` : ""}
                            </p>
                        </div>
                        {conn.needsReconnect ? <StatusBadge tone="warning">Sign-in expired</StatusBadge> : <StatusBadge tone="success">Connected</StatusBadge>}
                    </div>

                    {conn.needsReconnect ? (
                        <div className="grid gap-2 py-3">
                            <p className="text-sm">Reconnect Plaud to keep recordings syncing.</p>
                            <div>
                                <Button variant="primary" onClick={() => setSignIn(true)}>
                                    Reconnect
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2 py-3">
                        <Button variant="secondary" disabled={busy} onClick={() => setConfirm("switch")}>
                            Switch account
                        </Button>
                        <Button variant="destructive" disabled={busy} onClick={() => setConfirm("disconnect")}>
                            Disconnect
                        </Button>
                    </div>
                </div>
            ) : null}

            <PlaudSignInDialog open={signIn} onClose={() => setSignIn(false)} onConnected={connectedNow} />

            <AlertDialog open={confirm === "switch"} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogTitle>Switch Plaud account?</AlertDialogTitle>
                    <AlertDialogDescription>
                        The current connection is removed first. Recordings already synced stay in your library.
                    </AlertDialogDescription>
                    <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                            <Button variant="secondary">Cancel</Button>
                        </AlertDialogCancel>
                        <AlertDialogAction
                            asChild
                            onClick={() => {
                                setConfirm(null);
                                void disconnect(true);
                            }}
                        >
                            <Button variant="primary">Switch account</Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={confirm === "disconnect"} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogTitle>Disconnect Plaud?</AlertDialogTitle>
                    <AlertDialogDescription>
                        Recordings stop syncing until you connect again. Recordings already synced stay in your library.
                    </AlertDialogDescription>
                    <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                            <Button variant="secondary">Cancel</Button>
                        </AlertDialogCancel>
                        <AlertDialogAction
                            asChild
                            onClick={() => {
                                setConfirm(null);
                                void disconnect(false);
                            }}
                        >
                            <Button variant="destructive">Disconnect</Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/** The Plaud sign-in tabs, shown inline when no account is connected and in the dialog on reconnect. */
export function PlaudSignInPanel({ onConnected }: { onConnected: () => void | Promise<void> }) {
    const [tab, setTab] = useState("browser");
    const [handoffCode, setHandoffCode] = useState<string | null>(null);
    const connectedRef = useRef(onConnected);
    connectedRef.current = onConnected;
    const codeRef = useRef<string | null>(null);
    codeRef.current = handoffCode;

    // Leaving the panel cancels a sign-in that is still waiting.
    useEffect(() => {
        return () => {
            const code = codeRef.current;
            if (code) {
                void api(`/api/plaud/auth/handoff?code=${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => undefined);
            }
        };
    }, []);

    const done = () => connectedRef.current();

    return (
        <Tabs value={tab} onValueChange={setTab} className="grid gap-3">
            <TabsList className="grid w-full grid-cols-3 gap-0.5 rounded-lg bg-secondary p-0.5">
                <TabsTrigger value="browser" className="h-8 min-w-0 px-2 text-[13px]">
                    Sign in with Plaud
                </TabsTrigger>
                <TabsTrigger value="email" className="h-8 min-w-0 px-2 text-[13px]">
                    Email code
                </TabsTrigger>
                <TabsTrigger value="paste" className="h-8 min-w-0 px-2 text-[13px]">
                    Paste token
                </TabsTrigger>
            </TabsList>
            <TabsContent value="browser">
                <BrowserTab code={handoffCode} setCode={setHandoffCode} onConnected={done} onSwitch={setTab} />
            </TabsContent>
            <TabsContent value="email">
                <EmailCodeTab onConnected={done} />
            </TabsContent>
            <TabsContent value="paste">
                <PasteTokenTab onConnected={done} />
            </TabsContent>
        </Tabs>
    );
}

/** The sign-in panel in a dialog. Used to reconnect an expired sign-in and to switch accounts. */
export function PlaudSignInDialog({
    open,
    onClose,
    onConnected,
}: {
    open: boolean;
    onClose: () => void;
    onConnected: () => void | Promise<void>;
}) {
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>Connect Plaud account</DialogTitle>
                <DialogDescription>Choose how to sign in to Plaud.</DialogDescription>
                {open ? <PlaudSignInPanel onConnected={onConnected} /> : null}
                <DialogFooter>
                    <Button variant="secondary" onClick={onClose}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function EmailCodeTab({ onConnected }: { onConnected: () => void | Promise<void> }) {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState<(SendCodeAnswer & { email: string }) | null>(null);
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const sendCode = async () => {
        setBusy(true);
        setError(null);
        try {
            const answer = await api<SendCodeAnswer>("/api/plaud/auth/send-code", {
                method: "POST",
                json: { email: email.trim() },
            });
            setSent({ ...answer, email: email.trim() });
        } catch (err) {
            setError(errorMessage(err, "The code could not be sent."));
        } finally {
            setBusy(false);
        }
    };

    const verify = async () => {
        if (!sent) return;
        setBusy(true);
        setError(null);
        try {
            await api("/api/plaud/auth/verify", {
                method: "POST",
                json: { code: code.trim(), otpToken: sent.otpToken, apiBase: sent.apiBase, email: sent.email },
            });
            await onConnected();
        } catch (err) {
            setError(errorMessage(err, "The code could not be verified."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-4">
            <Field label="Plaud email">
                <Input
                    type="email"
                    autoComplete="email"
                    value={email}
                    disabled={sent !== null}
                    onChange={(e) => setEmail(e.target.value)}
                />
            </Field>
            {sent ? (
                <Field label="Verification code" hint="Enter the code Plaud emailed to you.">
                    <Input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                    />
                </Field>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                {sent ? (
                    <Button variant="secondary" disabled={busy} onClick={() => setSent(null)}>
                        Use another email
                    </Button>
                ) : null}
                {sent ? (
                    <Button variant="primary" disabled={busy || code.trim() === ""} onClick={() => void verify()}>
                        {busy ? <Spinner label="Connecting" /> : null}
                        Verify and connect
                    </Button>
                ) : (
                    <Button variant="primary" disabled={busy || email.trim() === ""} onClick={() => void sendCode()}>
                        {busy ? <Spinner label="Sending code" /> : null}
                        Send code
                    </Button>
                )}
            </div>
        </div>
    );
}

type DesktopOpenBrowser = (code: string) => Promise<void>;

function desktopOpenBrowser(): DesktopOpenBrowser | null {
    const bridge = (window as unknown as { __openaudiohubDesktop?: { openPlaudBrowser?: DesktopOpenBrowser } }).__openaudiohubDesktop;
    return bridge?.openPlaudBrowser ?? null;
}

function PasteTokenTab({ onConnected }: { onConnected: () => void | Promise<void> }) {
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const connect = async () => {
        setBusy(true);
        setError(null);
        try {
            await api("/api/plaud/auth/connect-token", {
                method: "POST",
                json: { accessToken: token.trim(), source: "paste" },
            });
            await onConnected();
        } catch (err) {
            setError(errorMessage(err, "The token could not be connected."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">
                Copy your account token from the Plaud web app and paste it here. Workspace tokens are refused.
            </p>
            <Field label="Account token">
                <Textarea
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="font-mono text-xs"
                />
            </Field>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
            <div className="flex justify-end">
                <Button variant="primary" disabled={busy || token.trim() === ""} onClick={() => void connect()}>
                    {busy ? <Spinner label="Connecting" /> : null}
                    Connect
                </Button>
            </div>
        </div>
    );
}

const HANDOFF_POLL_MS = 2000;

function BrowserTab({
    code,
    setCode,
    onConnected,
    onSwitch,
}: {
    code: string | null;
    setCode: (code: string | null) => void;
    onConnected: () => void | Promise<void>;
    onSwitch: (tab: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const connectedRef = useRef(onConnected);
    connectedRef.current = onConnected;

    // While a sign-in is waiting, check its status until it connects, expires or is cancelled.
    useEffect(() => {
        if (!code) return;
        let alive = true;
        const tick = async () => {
            try {
                const status = await api<HandoffStatus>(`/api/plaud/auth/handoff?code=${encodeURIComponent(code)}`);
                if (!alive) return;
                if (status.status === "connected") {
                    alive = false;
                    setCode(null);
                    await connectedRef.current();
                } else if (status.status === "expired") {
                    alive = false;
                    setCode(null);
                    setMessage(status.error ?? "This sign-in link has expired. Start again.");
                } else if (status.error) {
                    setMessage(status.error);
                }
            } catch {
                // A failed check is retried on the next tick.
            }
        };
        const timer = window.setInterval(() => void tick(), HANDOFF_POLL_MS);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [code, setCode]);

    const start = async () => {
        setBusy(true);
        setMessage(null);
        const openInSystemBrowser = desktopOpenBrowser();
        // Reserve a tab while the click still has browser user activation. The
        // handoff request below is asynchronous and otherwise popup blockers can
        // suppress the browser tab on ordinary web installs.
        const popup = openInSystemBrowser ? null : window.open("about:blank", "_blank");
        if (!openInSystemBrowser && !popup) {
            setMessage("Allow pop-ups to open Plaud sign-in in a new browser tab.");
            setBusy(false);
            return;
        }
        if (popup) popup.opener = null;
        let code: string | null = null;
        try {
            const handoff = await api<HandoffAnswer>("/api/plaud/auth/handoff", { method: "POST", json: {} });
            code = handoff.code;
            if (openInSystemBrowser) {
                await openInSystemBrowser(handoff.code);
            } else if (popup) {
                popup.location.href = `/connect/plaud?code=${encodeURIComponent(handoff.code)}`;
            }
            setCode(handoff.code);
        } catch (err) {
            popup?.close();
            if (code) {
                await api(`/api/plaud/auth/handoff?code=${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => undefined);
            }
            setMessage(errorMessage(err, "The sign-in window could not be started."));
        } finally {
            setBusy(false);
        }
    };

    const cancel = async () => {
        if (code) {
            await api(`/api/plaud/auth/handoff?code=${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => undefined);
        }
        setCode(null);
        setMessage(null);
    };

    return (
        <div className="grid gap-4">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
                Easiest path: install the <span className="font-medium">Browser extension</span> browser extension. Sign in to Plaud as usual
                (Google, Apple, or email) and the connector brings the session back here. Nothing to copy or paste.
            </p>
            {code ? (
                <p role="status" className="flex items-center gap-2 text-sm">
                    <Spinner label="Waiting for Plaud sign-in" />
                    Waiting for Plaud sign-in…
                </p>
            ) : null}
            {message ? (
                <p role="alert" className="text-sm text-destructive">
                    {message}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                {code ? (
                    <Button variant="secondary" onClick={() => void cancel()}>
                        Cancel
                    </Button>
                ) : null}
                <Button variant="primary" className="w-full" disabled={busy || code !== null} onClick={() => void start()}>
                    {busy ? <Spinner label="Opening Plaud sign-in" /> : null}
                    Open Plaud sign-in
                </Button>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
                Already installed? Reload this page so OpenAudioHub can detect it. Or use the{" "}
                <button type="button" className="text-link underline decoration-dotted underline-offset-2 hover:opacity-80" onClick={() => onSwitch("email")}>
                    email code
                </button>{" "}
                /{" "}
                <button type="button" className="text-link underline decoration-dotted underline-offset-2 hover:opacity-80" onClick={() => onSwitch("paste")}>
                    paste token
                </button>{" "}
                methods instead.
            </p>
        </div>
    );
}
