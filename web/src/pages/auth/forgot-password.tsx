import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { AuthField, AuthInput, AuthLayout, AuthLink, AuthNotice } from "./auth-layout";
import { usePasswordResetAvailability } from "./reset-availability";

export default function Page() {
    const session = useSession();
    const [email, setEmail] = useState("");
    const [pending, setPending] = useState(false);
    const [sent, setSent] = useState(false);
    const availability = usePasswordResetAvailability();
    const resetByEmail = availability.byEmail;

    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;

    if (availability.error) {
        return (
            <AuthLayout documentTitle="Reset password | OpenAudioHub" title="Reset password" subtitle="We could not check whether password reset is available.">
                <div className="space-y-6">
                    <AuthNotice className="text-muted-foreground">
                        <p>The server did not answer. Try again in a moment.</p>
                    </AuthNotice>
                    <Button type="button" variant="primary" className="w-full sm:h-9" onClick={availability.retry}>
                        Retry
                    </Button>
                    <AuthLink to="/login">Back to sign in</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    if (resetByEmail === null) return null;
    if (!resetByEmail) {
        return (
            <AuthLayout documentTitle="Reset password | OpenAudioHub" title="Reset password" subtitle="Password reset needs a mail server to be set up.">
                <div className="space-y-6">
                    <AuthNotice>
                        <p className="font-medium">Reset emails are turned off on this server.</p>
                        <p className="text-muted-foreground">
                            The administrator hasn&apos;t configured SMTP, so reset emails can&apos;t be delivered. Set{" "}
                            <code className="font-mono text-xs">SMTP_HOST</code>,{" "}
                            <code className="font-mono text-xs">SMTP_USER</code>, and{" "}
                            <code className="font-mono text-xs">SMTP_PASSWORD</code> in the server environment to enable it.
                            Until then, an administrator can reset it for you directly in the database.
                        </p>
                    </AuthNotice>
                    <AuthLink to="/login">Back to sign in</AuthLink>
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
            toast.error(errorMessage(err, "Could not send the reset email. Try again."));
        } finally {
            setPending(false);
        }
    }

    if (sent) {
        return (
            <AuthLayout documentTitle="Check your email | OpenAudioHub" title="Check your email" subtitle="If an account exists for that email, a reset link is on its way.">
                <div className="space-y-6">
                    <AuthLink to="/login">Back to sign in</AuthLink>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout documentTitle="Reset password | OpenAudioHub" title="Reset password" subtitle="Enter your email and we'll send a link to choose a new password.">
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
                    <Button type="submit" variant="primary" className="w-full sm:h-9" disabled={pending}>
                        {pending ? "Sending..." : "Send reset link"}
                    </Button>
                </form>
                <AuthLink to="/login">Back to sign in</AuthLink>
            </div>
        </AuthLayout>
    );
}
