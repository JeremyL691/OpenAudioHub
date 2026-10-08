import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderMock, smtpMock, nodemailerMock } = vi.hoisted(() => ({
    renderMock: { renderEmailHtml: vi.fn() },
    smtpMock: { isSmtpConfigured: vi.fn().mockReturnValue(true) },
    nodemailerMock: {
        sendMail: vi.fn().mockResolvedValue({ messageId: "m1" }),
    },
}));

vi.mock("@/lib/notifications/render-email", () => renderMock);
vi.mock("@/lib/smtp", () => smtpMock);
vi.mock("@/db/queries/email-log", () => ({
    claimEmailSend: vi.fn(),
    releaseEmailSend: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
    env: {
        APP_URL: "https://oah.test",
        SMTP_FROM: null,
        SMTP_USER: null,
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_PASSWORD: "secret",
    },
}));
vi.mock("nodemailer", () => ({
    default: {
        createTransport: vi.fn().mockReturnValue(nodemailerMock),
    },
}));

import {
    sendNewRecordingEmail,
    sendTestEmail,
} from "@/lib/notifications/email";

// The links in each email, in both the HTML props and the plain-text part.
// Notification links point at the canonical /settings/notifications route.
describe("email links", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        renderMock.renderEmailHtml.mockResolvedValue("<html></html>");
    });

    function renderedProps(): Record<string, unknown> {
        const element = renderMock.renderEmailHtml.mock
            .calls[0][0] as ReactElement<Record<string, unknown>>;
        return element.props;
    }

    it("new recording email links the library and the notification settings", async () => {
        await sendNewRecordingEmail("user@example.com", 2, [
            "Team sync",
            "Voice memo",
        ]);

        expect(renderedProps()).toMatchObject({
            recordingsUrl: "https://oah.test/recordings",
            settingsUrl: "https://oah.test/settings/notifications",
        });
        const { text } = nodemailerMock.sendMail.mock.calls[0][0];
        expect(text).toContain("View recordings: https://oah.test/recordings");
        expect(text).toContain(
            "Manage notifications: https://oah.test/settings/notifications",
        );
    });

    it("test email opens the overview and the notification settings", async () => {
        await sendTestEmail("user@example.com");

        expect(renderedProps()).toMatchObject({
            dashboardUrl: "https://oah.test/dashboard",
            settingsUrl: "https://oah.test/settings/notifications",
        });
        const { text } = nodemailerMock.sendMail.mock.calls[0][0];
        expect(text).toContain("Open overview: https://oah.test/dashboard");
        expect(text).toContain(
            "Manage notifications: https://oah.test/settings/notifications",
        );
    });
});
