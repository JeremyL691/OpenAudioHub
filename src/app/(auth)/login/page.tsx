import { SelfHostAuthChrome } from "@/components/auth/auth-chrome";
import { LoginForm } from "@/components/auth/login-form";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { isDesktopMode } from "@/lib/desktop/mode";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";

export default async function LoginPage() {
    await redirectIfAuthenticated();

    if (isDesktopMode()) {
        return (
            <SelfHostAuthChrome
                title="Reconnecting…"
                subtitle="Signing in to your local OpenAudioHub account."
            >
                <p className="text-sm text-muted-foreground">Reconnecting…</p>
            </SelfHostAuthChrome>
        );
    }

    const formProps = {
        registrationEnabled: !env.DISABLE_REGISTRATION,
        smtpConfigured: isSmtpConfigured(),
    };

    return (
        <SelfHostAuthChrome
            title="Sign in"
            subtitle="Sign in to your OpenAudioHub instance."
        >
            <LoginForm {...formProps} />
        </SelfHostAuthChrome>
    );
}
