import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { refreshSession, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/public-config";
import { desktopApp } from "@/lib/desktop-app";
import { AuthField, AuthInput, AuthLayout } from "./auth-layout";
import { useI18n } from "@/lib/i18n";

const MIN_PASSWORD = 8;

export default function Page() {
    const { t } = useI18n();
    const session = useSession();
    const navigate = useNavigate();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [pending, setPending] = useState(false);
    const config = usePublicConfig();
    const local = config?.singleAccount === true && desktopApp() === null;
    useEffect(() => {
        if (local) window.location.replace("/dashboard");
    }, [local]);

    if (local) return null;
    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;
    if (config && !config.registrationEnabled) return <Navigate to="/login" replace />;

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password !== confirmPassword) {
            toast.error(t("auth.register.mismatch"));
            return;
        }
        if (password.length < MIN_PASSWORD) {
            toast.error(t("auth.register.tooShort"));
            return;
        }
        setPending(true);
        try {
            await api("/api/auth/sign-up/email", {
                method: "POST",
                json: { name, email, password, callbackURL: "/dashboard" },
            });
            await refreshSession();
            toast.success(t("auth.register.success"));
            navigate("/dashboard", { replace: true });
        } catch (err) {
            if (err instanceof ApiError && err.code === "REGISTRATION_DISABLED") {
                toast.error(t("auth.register.disabled"));
                navigate("/login", { replace: true });
                return;
            }
            toast.error(errorMessage(err, t("auth.register.failed")));
            setPending(false);
        }
    }

    return (
        <AuthLayout documentTitle={t("auth.register.documentTitle")} title={t("auth.register.title")} subtitle={t("auth.register.subtitle")}>
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="name" label={t("auth.register.name")}>
                        <AuthInput
                            id="name"
                            name="name"
                            autoComplete="name"
                            placeholder="John Doe"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </AuthField>
                    <AuthField id="email" label={t("auth.register.email")}>
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
                    <AuthField id="password" label={t("auth.register.password")}>
                        <AuthInput
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="new-password"
                            placeholder="••••••••"
                            minLength={MIN_PASSWORD}
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </AuthField>
                    <AuthField id="confirmPassword" label={t("auth.register.confirmPassword")}>
                        <AuthInput
                            id="confirmPassword"
                            name="confirmPassword"
                            type="password"
                            autoComplete="new-password"
                            placeholder="••••••••"
                            required
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                        />
                    </AuthField>
                    <Button type="submit" variant="primary" className="w-full sm:h-9" disabled={pending}>
                        {pending ? t("auth.register.pending") : t("auth.register.submit")}
                    </Button>
                </form>
                <div className="text-center text-[13px]">
                    <span className="text-muted-foreground">{t("auth.register.haveAccount")} </span>
                    <Link to="/login" className="text-link hover:underline">
                        {t("auth.register.signIn")}
                    </Link>
                </div>
            </div>
        </AuthLayout>
    );
}
