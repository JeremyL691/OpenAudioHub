import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { APP_URL: "https://oah.test" } }));

import { EmailChangeConfirmEmail } from "@/lib/notifications/email-templates/email-change-confirm";
import { ExportReadyEmail } from "@/lib/notifications/email-templates/export-ready";
import { NewRecordingEmail } from "@/lib/notifications/email-templates/new-recording-email";
import { PasswordResetEmail } from "@/lib/notifications/email-templates/password-reset-email";
import { TestEmail } from "@/lib/notifications/email-templates/test-email";
import { VerifyEmailEmail } from "@/lib/notifications/email-templates/verify-email";
import { renderEmailHtml } from "@/lib/notifications/render-email";

// Each template renders with fixed props, so a change to copy, links, colors,
// or the shared layout shows up as a snapshot diff.
describe("email templates", () => {
    it("password reset", async () => {
        const html = await renderEmailHtml(
            <PasswordResetEmail resetUrl="https://oah.test/reset-password?token=abc123" />,
        );
        expect(html).toMatchSnapshot();
    });

    it("verify email", async () => {
        const html = await renderEmailHtml(
            <VerifyEmailEmail
                verificationUrl="https://oah.test/verify-email?token=abc123"
                expiresInHours={24}
            />,
        );
        expect(html).toMatchSnapshot();
    });

    it("email change confirmation", async () => {
        const html = await renderEmailHtml(
            <EmailChangeConfirmEmail
                confirmUrl="https://oah.test/confirm-email?token=abc123"
                newEmail="new@example.com"
                expiresInHours={24}
            />,
        );
        expect(html).toMatchSnapshot();
    });

    it("new recordings with names", async () => {
        const html = await renderEmailHtml(
            <NewRecordingEmail
                count={2}
                recordingNames={["Team sync", "Voice memo"]}
                recordingsUrl="https://oah.test/recordings"
                settingsUrl="https://oah.test/settings/notifications"
            />,
        );
        expect(html).toMatchSnapshot();
    });

    it("one new recording without names", async () => {
        const html = await renderEmailHtml(
            <NewRecordingEmail
                count={1}
                recordingsUrl="https://oah.test/recordings"
                settingsUrl="https://oah.test/settings/notifications"
            />,
        );
        expect(html).toMatchSnapshot();
    });

    it("export ready", async () => {
        const html = await renderEmailHtml(
            <ExportReadyEmail downloadUrl="https://oah.test/settings/export" />,
        );
        expect(html).toMatchSnapshot();
    });

    it("test email", async () => {
        const html = await renderEmailHtml(
            <TestEmail
                dashboardUrl="https://oah.test/dashboard"
                settingsUrl="https://oah.test/settings/notifications"
            />,
        );
        expect(html).toMatchSnapshot();
    });
});
