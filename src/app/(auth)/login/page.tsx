import { SelfHostAuthChrome } from "@/components/auth/auth-chrome";
import { LoginForm } from "@/components/auth/login-form";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";

export default async function LoginPage() {
    await redirectIfAuthenticated();

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
