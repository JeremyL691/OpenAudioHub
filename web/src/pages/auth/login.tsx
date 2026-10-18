import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { refreshSession, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthField, AuthInput, AuthLayout } from "./auth-layout";
import { desktopApp } from "@/lib/desktop-app";
import { usePublicConfig } from "@/lib/public-config";
import { usePasswordResetByEmail } from "./reset-availability";

export default function Page() {
    // The desktop app never shows the form: it signs the window in again (spec/auth.md "Desktop mode").
    if (desktopApp()) return <DesktopReconnect />;
    return <SignInForm />;
}

function DesktopReconnect() {
    const navigate = useNavigate();
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        void (async () => {
            const ok = await desktopApp()
                ?.reconnect?.()
                .catch(() => false);
            if (!alive) return;
            if (ok) {
                await refreshSession();
                navigate("/dashboard", { replace: true });
            } else {
                setFailed(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [navigate]);
    return (
        <AuthLayout
            documentTitle="Reconnecting | OpenAudioHub"
            title="Reconnecting…"
            subtitle={failed ? "OpenAudioHub could not sign this window in. Quit and reopen the app." : "Signing in to your local account."}
        >
            {null}
        </AuthLayout>
    );
}

function SignInForm() {
    const resetByEmail = usePasswordResetByEmail();
    const config = usePublicConfig();
    const session = useSession();
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [pending, setPending] = useState(false);

    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        try {
            await api("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
            await refreshSession();
            toast.success("Logged in successfully");
            navigate("/dashboard", { replace: true });
        } catch (err) {
            toast.error(errorMessage(err, "Invalid email or password"));
            setPending(false);
        }
    }

    return (
        <AuthLayout documentTitle="Sign in | OpenAudioHub" title="Sign in" subtitle="Sign in to your OpenAudioHub instance.">
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="email" label="Email">
                        <AuthInput
                            id="email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            placeholder="you@example.com"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </AuthField>
                    <AuthField
                        id="password"
                        label="Password"
                        action={
                            resetByEmail ? (
                                <Link to="/forgot-password" className="text-[13px] text-link hover:underline">
                                    Forgot password?
                                </Link>
                            ) : null
                        }
                    >
                        <AuthInput
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            placeholder="••••••••"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </AuthField>
                    <Button type="submit" variant="primary" className="w-full sm:h-9" disabled={pending}>
                        {pending ? "Signing in..." : "Sign In"}
                    </Button>
                </form>
                {config?.registrationEnabled !== false && (
                    <div className="text-center text-[13px]">
                        <span className="text-muted-foreground">Don&apos;t have an account? </span>
                        <Link to="/register" className="text-link hover:underline">
                            Register
                        </Link>
                    </div>
                )}
            </div>
        </AuthLayout>
    );
}
