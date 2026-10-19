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
import { useI18n } from "@/lib/i18n";

export interface PlaudConnection {
    connected: boolean;
    server?: "global" | "eu" | "apse1" | "cn" | "custom";
    apiBase?: string;
    plaudEmail?: string | null;
    needsReconnect?: boolean;
    tokenExpiresAt?: string | null;
    createdAt?: string;
}

const REGION_KEYS: Record<string, "settings.plaud.regionGlobal" | "settings.plaud.regionEu" | "settings.plaud.regionApse1" | "settings.plaud.regionCn" | "settings.plaud.regionCustom"> = {
    global: "settings.plaud.regionGlobal",
    eu: "settings.plaud.regionEu",
    apse1: "settings.plaud.regionApse1",
    cn: "settings.plaud.regionCn",
    custom: "settings.plaud.regionCustom",
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
    const { t } = useI18n();
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
            if (!thenSignIn) toast.success(t("settings.plaud.disconnected"));
            await load();
            if (thenSignIn) setSignIn(true);
        } catch (err) {
            toast.error(errorMessage(err, t("settings.plaud.disconnectFailed")));
        } finally {
            setBusy(false);
        }
    };

    const connectedNow = async () => {
        setSignIn(false);
        toast.success(t("settings.plaud.connectedToast"));
        await load();
    };

    const connected = conn?.connected === true;

    return (
        <div className="grid gap-4">
            <p className="text-xs text-muted-foreground">{t("settings.plaud.intro")}</p>
            {conn === null && !loadError ? <Loading label={t("settings.plaud.loading")} /> : null}
            {loadError ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorMessage(loadError, t("settings.plaud.loadFailed"))}
                </p>
            ) : null}

            {conn && !connected ? (
                <div className="grid gap-3 rounded-xl bg-muted px-4 py-3">
                    <p className="text-xs text-muted-foreground">{t("settings.plaud.notConnected")}</p>
                    <PlaudSignInPanel onConnected={connectedNow} />
                </div>
            ) : null}

            {conn && connected ? (
                <div className="divide-y divide-border rounded-xl bg-muted px-4">
                    <div className="flex flex-wrap items-start justify-between gap-3 py-3">
                        <div className="min-w-0 space-y-0.5">
                            <p className="text-xs text-muted-foreground">{t("settings.plaud.connectedAccount")}</p>
                            <p className="truncate text-[13px] font-medium">{conn.plaudEmail ?? t("settings.plaud.emailUnavailable")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("settings.plaud.regionLine", { region: t(REGION_KEYS[conn.server ?? "global"] ?? "settings.plaud.regionGlobal") })}
                                {conn.tokenExpiresAt ? t("settings.plaud.tokenValidUntil", { date: formatDate(conn.tokenExpiresAt) }) : ""}
                            </p>
                        </div>
                        {conn.needsReconnect ? <StatusBadge tone="warning">{t("settings.plaud.signInExpired")}</StatusBadge> : <StatusBadge tone="success">{t("settings.plaud.connected")}</StatusBadge>}
                    </div>

                    {conn.needsReconnect ? (
                        <div className="grid gap-2 py-3">
                            <p className="text-sm">{t("settings.plaud.reconnectBody")}</p>
                            <div>
                                <Button variant="primary" onClick={() => setSignIn(true)}>
                                    {t("settings.plaud.reconnect")}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2 py-3">
                        <Button variant="secondary" disabled={busy} onClick={() => setConfirm("switch")}>
                            {t("settings.plaud.switchAccount")}
                        </Button>
                        <Button variant="destructive" disabled={busy} onClick={() => setConfirm("disconnect")}>
                            {t("settings.plaud.disconnect")}
                        </Button>
                    </div>
                </div>
            ) : null}

            <PlaudSignInDialog open={signIn} onClose={() => setSignIn(false)} onConnected={connectedNow} />

            <AlertDialog open={confirm === "switch"} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogTitle>{t("settings.plaud.switchTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>{t("settings.plaud.switchBody")}</AlertDialogDescription>
                    <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                            <Button variant="secondary">{t("settings.plaud.cancel")}</Button>
                        </AlertDialogCancel>
                        <AlertDialogAction
                            asChild
                            onClick={() => {
                                setConfirm(null);
                                void disconnect(true);
                            }}
                        >
                            <Button variant="primary">{t("settings.plaud.switchAccount")}</Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={confirm === "disconnect"} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogTitle>{t("settings.plaud.disconnectTitle")}</AlertDialogTitle>
                    <AlertDialogDescription>{t("settings.plaud.disconnectBody")}</AlertDialogDescription>
                    <AlertDialogFooter>
                        <AlertDialogCancel asChild>
                            <Button variant="secondary">{t("settings.plaud.cancel")}</Button>
                        </AlertDialogCancel>
                        <AlertDialogAction
                            asChild
                            onClick={() => {
                                setConfirm(null);
                                void disconnect(false);
                            }}
                        >
                            <Button variant="destructive">{t("settings.plaud.disconnect")}</Button>
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/** The Plaud sign-in tabs, shown inline when no account is connected and in the dialog on reconnect. */
export function PlaudSignInPanel({ onConnected }: { onConnected: () => void | Promise<void> }) {
    const { t } = useI18n();
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
                    {t("settings.plaud.tabBrowser")}
                </TabsTrigger>
                <TabsTrigger value="email" className="h-8 min-w-0 px-2 text-[13px]">
                    {t("settings.plaud.tabEmail")}
                </TabsTrigger>
                <TabsTrigger value="paste" className="h-8 min-w-0 px-2 text-[13px]">
                    {t("settings.plaud.tabPaste")}
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
    const { t } = useI18n();
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
                <DialogTitle>{t("settings.plaud.connectTitle")}</DialogTitle>
                <DialogDescription>{t("settings.plaud.connectBody")}</DialogDescription>
                {open ? <PlaudSignInPanel onConnected={onConnected} /> : null}
                <DialogFooter>
                    <Button variant="secondary" onClick={onClose}>
                        {t("settings.plaud.close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function EmailCodeTab({ onConnected }: { onConnected: () => void | Promise<void> }) {
    const { t } = useI18n();
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
            setError(errorMessage(err, t("settings.plaud.codeSendFailed")));
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
            setError(errorMessage(err, t("settings.plaud.codeVerifyFailed")));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-4">
            <Field label={t("settings.plaud.plaudEmail")}>
                <Input
                    type="email"
                    autoComplete="email"
                    value={email}
                    disabled={sent !== null}
                    onChange={(e) => setEmail(e.target.value)}
                />
            </Field>
            {sent ? (
                <Field label={t("settings.plaud.verificationCode")} hint={t("settings.plaud.verificationHint")}>
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
                        {t("settings.plaud.useAnotherEmail")}
                    </Button>
                ) : null}
                {sent ? (
                    <Button variant="primary" disabled={busy || code.trim() === ""} onClick={() => void verify()}>
                        {busy ? <Spinner label={t("settings.plaud.connecting")} /> : null}
                        {t("settings.plaud.verifyAndConnect")}
                    </Button>
                ) : (
                    <Button variant="primary" disabled={busy || email.trim() === ""} onClick={() => void sendCode()}>
                        {busy ? <Spinner label={t("settings.plaud.sendingCode")} /> : null}
                        {t("settings.plaud.sendCode")}
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
    const { t } = useI18n();
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
            setError(errorMessage(err, t("settings.plaud.tokenConnectFailed")));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">{t("settings.plaud.pasteIntro")}</p>
            <Field label={t("settings.plaud.accountToken")}>
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
                    {busy ? <Spinner label={t("settings.plaud.connecting")} /> : null}
                    {t("settings.plaud.connect")}
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
    const { t } = useI18n();
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
                    setMessage(status.error ?? t("settings.plaud.expiredLink"));
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
            setMessage(t("settings.plaud.allowPopups"));
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
            setMessage(errorMessage(err, t("settings.plaud.signInStartFailed")));
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
                {t("settings.plaud.browserIntro")}{" "}
                <a
                    className="text-link underline decoration-dotted underline-offset-2 hover:opacity-80"
                    href="/docs/guides/browser-extension"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t("settings.plaud.getExtension")}
                </a>
            </p>
            {code ? (
                <p role="status" className="flex items-center gap-2 text-sm">
                    <Spinner label={t("settings.plaud.waitingSignInLabel")} />
                    {t("settings.plaud.waitingSignIn")}
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
                        {t("settings.plaud.cancel")}
                    </Button>
                ) : null}
                <Button variant="primary" className="w-full" disabled={busy || code !== null} onClick={() => void start()}>
                    {busy ? <Spinner label={t("settings.plaud.openingSignIn")} /> : null}
                    {t("settings.plaud.openSignIn")}
                </Button>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
                {t("settings.plaud.browserFollowUp")}{" "}
                <button type="button" className="text-link underline decoration-dotted underline-offset-2 hover:opacity-80" onClick={() => onSwitch("email")}>
                    {t("settings.plaud.emailCode")}
                </button>{" "}
                {t("settings.plaud.or")}{" "}
                <button type="button" className="text-link underline decoration-dotted underline-offset-2 hover:opacity-80" onClick={() => onSwitch("paste")}>
                    {t("settings.plaud.pasteToken")}
                </button>{" "}
                {t("settings.plaud.methodsInstead")}
            </p>
        </div>
    );
}
