import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { ApiError, api } from "@/lib/api";
import { signOut, useSession } from "@/lib/session";
import { usePublicConfig } from "@/lib/public-config";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AuthLayout, AuthNotice } from "./auth-layout";
import { useI18n } from "@/lib/i18n";

/** "checking" until the server answers; "suspended" when it refuses the session with ACCOUNT_SUSPENDED; "active" otherwise. */
type Check = "checking" | "suspended" | "active";

export default function Page() {
    const { t } = useI18n();
    const { status } = useSession();
    const [check, setCheck] = useState<Check>("checking");
    const [pending, setPending] = useState(false);
    const config = usePublicConfig();

    // The session payload does not say whether the account is suspended. A session-authenticated
    // route does: it answers 403 ACCOUNT_SUSPENDED for a suspended account and 200 otherwise.
    useEffect(() => {
        if (status !== "authenticated") return;
        let alive = true;
        api("/api/settings/user")
            .then(() => alive && setCheck("active"))
            .catch((err: unknown) => {
                if (alive) setCheck(err instanceof ApiError && err.code === "ACCOUNT_SUSPENDED" ? "suspended" : "active");
            });
        return () => {
            alive = false;
        };
    }, [status]);

    if (status === "loading" || (status === "authenticated" && check === "checking")) {
        return (
            <div className="flex min-h-svh items-center justify-center">
                <Spinner label={t("auth.suspended.checking")} />
            </div>
        );
    }
    if (status === "anonymous") return <Navigate to="/login" replace />;
    // Not suspended (or the check failed for another reason): /recordings decides what happens next.
    if (check !== "suspended") return <Navigate to="/recordings" replace />;

    function onSignOut() {
        setPending(true);
        void signOut();
    }

    return (
        <AuthLayout documentTitle={t("auth.suspended.documentTitle")} title={t("auth.suspended.title")} noindex>
            <div className="space-y-6">
                <AuthNotice className="text-muted-foreground">
                    <p>{t("auth.suspended.line1")}</p>
                    <p>{t("auth.suspended.line2")}</p>
                </AuthNotice>
                {config?.singleAccount === true ? null : (
                    <Button variant="primary" className="w-full sm:h-9" disabled={pending} onClick={onSignOut}>
                        {pending ? t("auth.suspended.signingOut") : t("auth.suspended.signOut")}
                    </Button>
                )}
            </div>
        </AuthLayout>
    );
}
