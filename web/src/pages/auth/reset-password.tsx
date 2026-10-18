import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthField, AuthInput, AuthLayout, AuthLink, AuthNotice } from "./auth-layout";

const MIN_PASSWORD = 8;

export default function Page() {
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
            <AuthLayout documentTitle="Invalid reset link | OpenAudioHub" title="Invalid reset link" subtitle="This link is missing or has expired.">
                <div className="space-y-6">
                    <AuthNotice className="text-muted-foreground">
                        <p>
                            {expired
                                ? "This reset link has expired or was used already. Request a new link to continue."
                                : "Use the link in your latest reset email, or ask for a fresh one."}
                        </p>
                    </AuthNotice>
                    <AuthLink to="/forgot-password">Request a new link</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password !== confirmPassword) {
            toast.error("Passwords do not match");
            return;
        }
        if (password.length < MIN_PASSWORD) {
            toast.error("Password must be at least 8 characters");
            return;
        }
        setPending(true);
        try {
            await api("/api/auth/reset-password", { method: "POST", json: { newPassword: password, token } });
            toast.success("Password reset. You can sign in now.");
            navigate("/login", { replace: true });
        } catch (err) {
            toast.error(errorMessage(err, "Could not reset password. The link may have expired."));
            setPending(false);
        }
    }

    return (
        <AuthLayout documentTitle="Set a new password | OpenAudioHub" title="Set a new password" subtitle="Pick a password that's unique to this account.">
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="password" label="New password">
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
                    <AuthField id="confirmPassword" label="Confirm password">
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
                        {pending ? "Resetting password..." : "Reset password"}
                    </Button>
                </form>
                <AuthLink to="/login">Back to sign in</AuthLink>
            </div>
        </AuthLayout>
    );
}
