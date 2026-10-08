import { beforeEach, describe, expect, it, vi } from "vitest";

const { emailLogMock, renderMock, smtpMock, nodemailerMock } = vi.hoisted(
    () => ({
        emailLogMock: {
            claimEmailSend: vi.fn(),
            releaseEmailSend: vi.fn(),
        },
        renderMock: {
            renderEmailHtml: vi.fn().mockResolvedValue("<html></html>"),
        },
        smtpMock: { isSmtpConfigured: vi.fn().mockReturnValue(false) },
        nodemailerMock: {
            sendMail: vi.fn().mockResolvedValue({ messageId: "m1" }),
        },
    }),
);

vi.mock("@/db/queries/email-log", () => emailLogMock);
vi.mock("@/lib/notifications/render-email", () => renderMock);
vi.mock("@/lib/smtp", () => smtpMock);
vi.mock("@/lib/env", () => ({
    env: {
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

import { sendExportReadyEmail } from "@/lib/notifications/email";

describe("sendClaimedEmail (via sendExportReadyEmail)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        renderMock.renderEmailHtml.mockResolvedValue("<html></html>");
    });

    const input = {
        userId: "u1",
        email: "u1@example.com",
        jobId: "job-1",
        downloadUrl: "https://app/exports/job-1",
    };
    const claim = { userId: "u1", kind: "export_ready:job-1" };

    it("does not send (and claims nothing further) when the kind is already claimed", async () => {
        emailLogMock.claimEmailSend.mockResolvedValue(false);
        const sent = await sendExportReadyEmail(input);
        expect(sent).toBe(false);
        expect(emailLogMock.releaseEmailSend).not.toHaveBeenCalled();
    });

    it("releases the claim when sendEmail fails (SMTP not configured) so a retry can claim again", async () => {
        emailLogMock.claimEmailSend.mockResolvedValue(true);
        smtpMock.isSmtpConfigured.mockReturnValue(false);

        const sent = await sendExportReadyEmail(input);

        expect(sent).toBe(false);
        expect(emailLogMock.releaseEmailSend).toHaveBeenCalledWith(claim);
    });

    it("releases the claim and rethrows when rendering the template throws", async () => {
        emailLogMock.claimEmailSend.mockResolvedValue(true);
        renderMock.renderEmailHtml.mockRejectedValue(
            new Error("render exploded"),
        );

        await expect(sendExportReadyEmail(input)).rejects.toThrow(
            "render exploded",
        );
        expect(emailLogMock.releaseEmailSend).toHaveBeenCalledWith(claim);
    });

    it("does not release the claim on a successful send", async () => {
        emailLogMock.claimEmailSend.mockResolvedValue(true);
        smtpMock.isSmtpConfigured.mockReturnValue(true);
        nodemailerMock.sendMail.mockResolvedValue({ messageId: "m1" });

        const sent = await sendExportReadyEmail(input);

        expect(sent).toBe(true);
        expect(emailLogMock.releaseEmailSend).not.toHaveBeenCalled();
    });
});
