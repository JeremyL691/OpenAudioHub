import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { refreshSession, useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { usePublicConfig } from "@/lib/public-config";
import { AuthField, AuthInput, AuthLayout } from "./auth-layout";

const MIN_PASSWORD = 8;

export default function Page() {
    const session = useSession();
    const navigate = useNavigate();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [pending, setPending] = useState(false);
    const config = usePublicConfig();

    if (session.status === "authenticated") return <Navigate to="/dashboard" replace />;
    if (config && !config.registrationEnabled) return <Navigate to="/login" replace />;

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
            await api("/api/auth/sign-up/email", {
                method: "POST",
                json: { name, email, password, callbackURL: "/dashboard" },
            });
            await refreshSession();
            toast.success("Account created successfully");
            navigate("/dashboard", { replace: true });
        } catch (err) {
            if (err instanceof ApiError && err.code === "REGISTRATION_DISABLED") {
                toast.error("Registration is disabled on this instance");
                navigate("/login", { replace: true });
                return;
            }
            toast.error(errorMessage(err, "Failed to create account"));
            setPending(false);
        }
    }

    return (
        <AuthLayout documentTitle="Create account | OpenAudioHub" title="Create your account" subtitle="Create the account you will use to sign in to this instance.">
            <div className="space-y-6">
                <form className="space-y-4" onSubmit={onSubmit}>
                    <AuthField id="name" label="Name">
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
                    <AuthField id="password" label="Password">
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
                    <AuthField id="confirmPassword" label="Confirm Password">
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
                        {pending ? "Creating account..." : "Create Account"}
                    </Button>
                </form>
                <div className="text-center text-[13px]">
                    <span className="text-muted-foreground">Already have an account? </span>
                    <Link to="/login" className="text-link hover:underline">
                        Sign in
                    </Link>
                </div>
            </div>
        </AuthLayout>
    );
}
