import { useEffect, useState } from "react";
import { Navigate } from "react-router";
import { ApiError, api } from "@/lib/api";
import { signOut, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AuthLayout, AuthNotice } from "./auth-layout";

/** "checking" until the server answers; "suspended" when it refuses the session with ACCOUNT_SUSPENDED; "active" otherwise. */
type Check = "checking" | "suspended" | "active";

export default function Page() {
    const { status } = useSession();
    const [check, setCheck] = useState<Check>("checking");
    const [pending, setPending] = useState(false);

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
                <Spinner label="Checking your session" />
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
        <AuthLayout documentTitle="Account suspended | OpenAudioHub" title="Your account is suspended" noindex>
            <div className="space-y-6">
                <AuthNotice className="text-muted-foreground">
                    <p>While we review your account, recordings, sync, and transcription are on hold.</p>
                    <p>Contact the administrator of this instance if you think this is a mistake.</p>
                </AuthNotice>
                <Button variant="primary" className="w-full sm:h-9" disabled={pending} onClick={onSignOut}>
                    {pending ? "Signing out..." : "Sign out"}
                </Button>
            </div>
        </AuthLayout>
    );
}
