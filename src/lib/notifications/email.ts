import nodemailer from "nodemailer";
import React from "react";
import { claimEmailSend, releaseEmailSend } from "@/db/queries/email-log";
import { env } from "@/lib/env";
import { isSmtpConfigured } from "@/lib/smtp";
import { EmailChangeConfirmEmail } from "./email-templates/email-change-confirm";
import { ExportReadyEmail } from "./email-templates/export-ready";
import { NewRecordingEmail } from "./email-templates/new-recording-email";
import { PasswordResetEmail } from "./email-templates/password-reset-email";
import { TestEmail } from "./email-templates/test-email";
import { VerifyEmailEmail } from "./email-templates/verify-email";
import { renderEmailHtml } from "./render-email";

interface EmailOptions {
    to: string;
    subject: string;
    html: string;
    text?: string;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
    // Return null if SMTP is not configured
    if (!isSmtpConfigured()) {
        return null;
    }

    // Create transporter if it doesn't exist
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587),
            secure: env.SMTP_SECURE ?? false,
            auth: {
                user: env.SMTP_USER,
                pass: env.SMTP_PASSWORD,
            },
        });
    }

    return transporter;
}

/**
 * Send an email notification using SMTP
 * @returns true if successful, false otherwise
 */
/** Sender used when SMTP_FROM and SMTP_USER are both unset: noreply on this instance's host. */
function defaultFromAddress(): string {
    const host = env.APP_URL ? new URL(env.APP_URL).hostname : "localhost";
    return `OpenAudioHub <noreply@${host}>`;
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
    try {
        const mailer = getTransporter();

        if (!mailer) {
            console.warn(
                "Email notification skipped: SMTP not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD environment variables.",
            );
            return false;
        }

        const fromEmail =
            env.SMTP_FROM || env.SMTP_USER || defaultFromAddress();

        await mailer.sendMail({
            from: fromEmail,
            to: options.to,
            replyTo: env.SMTP_REPLY_TO,
            subject: options.subject,
            html: options.html,
            text: options.text || options.html.replace(/<[^>]*>/g, ""), // Strip HTML if no text provided
        });

        return true;
    } catch (error) {
        console.error("Failed to send email:", error);
        return false;
    }
}

/**
 * Send an email notification using SMTP and throw errors with details
 * @throws Error with detailed message if sending fails
 */
export async function sendEmailWithError(options: EmailOptions): Promise<void> {
    const mailer = getTransporter();

    if (!mailer) {
        throw new Error(
            "SMTP not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD environment variables.",
        );
    }

    const fromEmail = env.SMTP_FROM || env.SMTP_USER || defaultFromAddress();

    try {
        await mailer.sendMail({
            from: fromEmail,
            to: options.to,
            replyTo: env.SMTP_REPLY_TO,
            subject: options.subject,
            html: options.html,
            text: options.text || options.html.replace(/<[^>]*>/g, ""),
        });
    } catch (error) {
        const err = error as Error & { code?: string; command?: string };
        let errorMessage = "Failed to send email";

        if (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
            if (err.command === "CONN") {
                errorMessage = `Cannot connect to SMTP server at ${env.SMTP_HOST}:${env.SMTP_PORT ?? (env.SMTP_SECURE ? 465 : 587)}. Please check your SMTP_HOST and SMTP_PORT settings.`;
            } else {
                errorMessage = `Connection timeout to SMTP server. Please verify your SMTP_HOST and SMTP_PORT are correct.`;
            }
        } else if (err.code === "EAUTH") {
            errorMessage =
                "SMTP authentication failed. Please check your SMTP_USER and SMTP_PASSWORD.";
        } else if (err.message) {
            errorMessage = `SMTP error: ${err.message}`;
        }

        throw new Error(errorMessage);
    }
}

/**
 * Claim a once-only `(userId, kind)` email slot, build + send it, and
 * release the claim if the send fails (transient SMTP error) or `build`
 * throws (e.g. a render exception). Without the release, a single
 * transient failure permanently drops that email -- the claim row
 * already exists, so every future retry sees `claimed: false` and
 * skips sending forever.
 */
async function sendClaimedEmail(
    claim: { userId: string; kind: string },
    build: () => Promise<EmailOptions>,
): Promise<boolean> {
    const claimed = await claimEmailSend(claim);
    if (!claimed) return false;
    try {
        const options = await build();
        const sent = await sendEmail(options);
        if (!sent) await releaseEmailSend(claim);
        return sent;
    } catch (error) {
        await releaseEmailSend(claim);
        throw error;
    }
}

export async function sendNewRecordingEmail(
    email: string,
    count: number,
    recordingNames?: string[],
): Promise<boolean> {
    const subject =
        count === 1 ? "New recording synced" : `${count} new recordings synced`;

    const baseUrl = env.APP_URL;
    const dashboardUrl = `${baseUrl}/dashboard`;
    const settingsUrl = `${baseUrl}/settings#notifications`;

    // Render React email component to HTML
    const html = await renderEmailHtml(
        React.createElement(NewRecordingEmail, {
            count,
            recordingNames: recordingNames || [],
            dashboardUrl,
            settingsUrl,
        }),
    );

    // Generate plain text version
    const text = `
${subject}

Your Plaud device has synced ${count === 1 ? "a new recording" : `${count} new recordings`}.
${
    recordingNames && recordingNames.length > 0
        ? `\nRecordings:\n${recordingNames.map((name) => `- ${name}`).join("\n")}`
        : ""
}

View recordings: ${dashboardUrl}

Manage notifications: ${settingsUrl}
    `.trim();

    return sendEmail({
        to: email,
        subject,
        html,
        text,
    });
}

export async function sendPasswordResetEmail(
    email: string,
    resetUrl: string,
): Promise<boolean> {
    const subject = "Reset your OpenAudioHub password";

    const html = await renderEmailHtml(
        React.createElement(PasswordResetEmail, {
            resetUrl,
        }),
    );

    const text = `
${subject}

We received a request to reset your OpenAudioHub password. Click the link below to choose a new password. This link expires in 1 hour.

${resetUrl}

If you didn't request a password reset, you can safely ignore this email -- your password will not change.
    `.trim();

    return sendEmail({
        to: email,
        subject,
        html,
        text,
    });
}

/**
 * Send a verification email. Called from the Better Auth
 * `emailVerification.sendVerificationEmail` callback on sign-up and
 * on explicit "resend verification" requests.
 */
export async function sendVerifyEmail(input: {
    email: string;
    verificationUrl: string;
    expiresInSeconds: number;
}): Promise<boolean> {
    const expiresInHours = Math.max(
        1,
        Math.round(input.expiresInSeconds / 3600),
    );
    const html = await renderEmailHtml(
        React.createElement(VerifyEmailEmail, {
            verificationUrl: input.verificationUrl,
            expiresInHours,
        }),
    );
    return sendEmail({
        to: input.email,
        subject: "Confirm your OpenAudioHub email",
        html,
    });
}

/**
 * Send the confirmation link for an email-address change. Called from
 * the Better Auth `user.changeEmail.sendChangeEmailVerification`
 * callback. Sent to the OLD address per Better Auth defaults so the
 * change can be canceled if the account was compromised.
 */
export async function sendEmailChangeConfirm(input: {
    /** Address the link is mailed to (the current address on file). */
    sendTo: string;
    newEmail: string;
    confirmUrl: string;
    expiresInSeconds: number;
}): Promise<boolean> {
    const expiresInHours = Math.max(
        1,
        Math.round(input.expiresInSeconds / 3600),
    );
    const html = await renderEmailHtml(
        React.createElement(EmailChangeConfirmEmail, {
            confirmUrl: input.confirmUrl,
            newEmail: input.newEmail,
            expiresInHours,
        }),
    );
    return sendEmail({
        to: input.sendTo,
        subject: "Confirm your new OpenAudioHub email",
        html,
    });
}

/** Sent once per completed export job (dedup keyed on jobId). */
export async function sendExportReadyEmail(input: {
    userId: string;
    email: string;
    jobId: string;
    downloadUrl: string;
}): Promise<boolean> {
    return sendClaimedEmail(
        { userId: input.userId, kind: `export_ready:${input.jobId}` },
        async () => {
            const html = await renderEmailHtml(
                React.createElement(ExportReadyEmail, {
                    downloadUrl: input.downloadUrl,
                }),
            );
            return {
                to: input.email,
                subject: "Your OpenAudioHub export is ready",
                html,
            };
        },
    );
}

export async function sendTestEmail(email: string): Promise<void> {
    const subject = "Test Email from OpenAudioHub";

    const baseUrl = env.APP_URL;
    const dashboardUrl = `${baseUrl}/dashboard`;
    const settingsUrl = `${baseUrl}/settings#notifications`;

    // Render React email component to HTML
    const html = await renderEmailHtml(
        React.createElement(TestEmail, {
            dashboardUrl,
            settingsUrl,
        }),
    );

    // Generate plain text version
    const text = `
${subject}

This is a test email from OpenAudioHub to verify your email notification settings.

If you received this email, your email notifications are configured correctly! You'll receive notifications when new recordings are synced from your Plaud device.

View dashboard: ${dashboardUrl}

Manage notifications: ${settingsUrl}
    `.trim();

    await sendEmailWithError({
        to: email,
        subject,
        html,
        text,
    });
}
