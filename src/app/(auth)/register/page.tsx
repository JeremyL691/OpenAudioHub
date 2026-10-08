import { redirect } from "next/navigation";
import { SelfHostAuthChrome } from "@/components/auth/auth-chrome";
import { RegisterForm } from "@/components/auth/register-form";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { env } from "@/lib/env";

export default async function RegisterPage() {
    await redirectIfAuthenticated();

    // Per product decision: when registration is disabled, redirect to
    // /login rather than rendering a "registration disabled" panel. The
    // dangling deep-link is the only meaningful entry point, and a
    // redirect is a less confusing landing than a dead-end card.
    if (env.DISABLE_REGISTRATION) {
        redirect("/login");
    }

    return (
        <SelfHostAuthChrome
            title="Create your account"
            subtitle="The first account on a new OpenAudioHub instance becomes the admin."
        >
            <RegisterForm />
        </SelfHostAuthChrome>
    );
}
