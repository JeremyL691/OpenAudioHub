import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { desktopApp } from "@/lib/desktop-app";
import { usePublicConfig } from "@/lib/public-config";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthField, AuthInput, AuthLayout, AuthLink, AuthNotice } from "./auth-layout";
import { usePasswordResetAvailability } from "./reset-availability";
import { useI18n } from "@/lib/i18n";

export default function Page() {
    const { t } = useI18n();
    const session = useSession();
    const [email, setEmail] = useState("");
    const [pending, setPending] = useState(false);
    const [sent, setSent] = useState(false);
    const availability = usePasswordResetAvailability();
    const resetByEmail = availability.byEmail;
    const config = usePublicConfig();
    const local = config?.singleAccount === true && desktopApp() === null;
    useEffect(() => {
        if (local) window.location.replace("/dashboard");
    }, [local]);

    if (local) return null;
    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;

    if (availability.error) {
        return (
            <AuthLayout documentTitle={t("auth.forgot.documentTitle")} title={t("auth.forgot.title")} subtitle={t("auth.forgot.unavailableSubtitle")}>
                <div className="space-y-6">
                    <AuthNotice className="text-muted-foreground">
                        <p>{t("auth.forgot.noAnswer")}</p>
                    </AuthNotice>
                    <Button type="button" variant="primary" className="w-full sm:h-9" onClick={availability.retry}>
                        {t("auth.forgot.retry")}
                    </Button>
                    <AuthLink to="/login">{t("auth.forgot.backToSignIn")}</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    if (resetByEmail === null) return null;
    if (!resetByEmail) {
        return (
            <AuthLayout documentTitle={t("auth.forgot.documentTitle")} title={t("auth.forgot.title")} subtitle={t("auth.forgot.smtpSubtitle")}>
                <div className="space-y-6">
                    <AuthNotice>
                        <p className="font-medium">{t("auth.forgot.smtpTitle")}</p>
                        <p className="text-muted-foreground">{t("auth.forgot.smtpBody")}</p>
                    </AuthNotice>
                    <AuthLink to="/login">{t("auth.forgot.backToSignIn")}</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        try {
            await api("/api/auth/request-password-reset", {
                method: "POST",
                json: { email, redirectTo: "/reset-password" },
            });
            setSent(true);
        } catch (err) {
            toast.error(errorMessage(err, t("auth.forgot.failed")));
        } finally {
            setPending(false);
        }
    }

    if (sent) {
        return (
            <AuthLayout documentTitle={t("auth.forgot.checkDocumentTitle")} title={t("auth.forgot.checkTitle")} subtitle={t("auth.forgot.checkSubtitle")}>
                <div className="space-y-6">
                    <AuthLink to="/login">{t("auth.forgot.backToSignIn")}</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout documentTitle={t("auth.forgot.documentTitle")} title={t("auth.forgot.title")} subtitle={t("auth.forgot.subtitle")}>
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="email" label={t("auth.login.email")}>
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
                    <Button type="submit" variant="primary" className="w-full sm:h-9" disabled={pending}>
                        {pending ? t("auth.forgot.pending") : t("auth.forgot.submit")}
                    </Button>
                </form>
                <AuthLink to="/login">{t("auth.forgot.backToSignIn")}</AuthLink>
            </div>
        </AuthLayout>
    );
}
