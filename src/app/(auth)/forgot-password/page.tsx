import { SelfHostAuthChrome } from "@/components/auth/auth-chrome";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { redirectIfAuthenticated } from "@/lib/auth-server";
import { isSmtpConfigured } from "@/lib/smtp";

export default async function ForgotPasswordPage() {
    await redirectIfAuthenticated();

    const smtp = isSmtpConfigured();

    // SMTP may not be configured -- the form body explains the operator help
    // in that case; the subtitle here stays neutral so it reads correctly
    // either way.
    const title = "Reset password";
    const subtitle = smtp
        ? "We'll email you a link to set a new password."
        : "Password reset requires SMTP to be configured.";

    return (
        <SelfHostAuthChrome title={title} subtitle={subtitle}>
            <ForgotPasswordForm smtpConfigured={smtp} />
        </SelfHostAuthChrome>
    );
}
