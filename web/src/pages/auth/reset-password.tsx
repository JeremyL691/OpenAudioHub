import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthField, AuthInput, AuthLayout, AuthLink, AuthNotice } from "./auth-layout";
import { useI18n } from "@/lib/i18n";

const MIN_PASSWORD = 8;

export default function Page() {
    const { t } = useI18n();
    const session = useSession();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const token = params.get("token");
    const error = params.get("error");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [pending, setPending] = useState(false);

    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;

    if (!token || error) {
        const expired = error === "INVALID_TOKEN";
        return (
            <AuthLayout documentTitle={t("auth.reset.invalidDocumentTitle")} title={t("auth.reset.invalidTitle")} subtitle={t("auth.reset.invalidSubtitle")}>
                <div className="space-y-6">
                    <AuthNotice className="text-muted-foreground">
                        <p>
                            {expired
                                ? t("auth.reset.expired")
                                : t("auth.reset.missing")}
                        </p>
                    </AuthNotice>
                    <AuthLink to="/forgot-password">{t("auth.reset.requestNew")}</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password !== confirmPassword) {
            toast.error(t("auth.reset.mismatch"));
            return;
        }
        if (password.length < MIN_PASSWORD) {
            toast.error(t("auth.reset.tooShort"));
            return;
        }
        setPending(true);
        try {
            await api("/api/auth/reset-password", { method: "POST", json: { newPassword: password, token } });
            toast.success(t("auth.reset.success"));
            navigate("/login", { replace: true });
        } catch (err) {
            toast.error(errorMessage(err, t("auth.reset.failed")));
            setPending(false);
        }
    }

    return (
        <AuthLayout documentTitle={t("auth.reset.documentTitle")} title={t("auth.reset.title")} subtitle={t("auth.reset.subtitle")}>
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="password" label={t("auth.reset.newPassword")}>
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
                    <AuthField id="confirmPassword" label={t("auth.reset.confirmPassword")}>
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
                        {pending ? t("auth.reset.pending") : t("auth.reset.submit")}
                    </Button>
                </form>
                <AuthLink to="/login">{t("auth.reset.backToSignIn")}</AuthLink>
            </div>
        </AuthLayout>
    );
}
