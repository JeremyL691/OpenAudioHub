import { describe, expect, it } from "vitest";
import { brandColors } from "@/lib/notifications/email-templates/brand-colors";

// WCAG 2.x relative luminance and contrast ratio for #rrggbb colors.
function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
        return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [lighter, darker] = [luminance(a), luminance(b)].sort(
        (x, y) => y - x,
    );
    return (lighter + 0.05) / (darker + 0.05);
}

// Every text color in the email sits on one of these surfaces. The brand
// blue is left out on purpose: it is only a decorative rule (see brand-colors.ts).
describe("email brand colors", () => {
    it.each([
        [
            "body text on the container",
            brandColors.foreground,
            brandColors.card,
        ],
        [
            "body text on the page",
            brandColors.foreground,
            brandColors.background,
        ],
        [
            "muted text on the container",
            brandColors.mutedForeground,
            brandColors.card,
        ],
        [
            "muted text on the footer",
            brandColors.mutedForeground,
            brandColors.background,
        ],
        ["links on the footer", brandColors.primary, brandColors.background],
        [
            "button label on the button",
            brandColors.primaryForeground,
            brandColors.primary,
        ],
    ])("%s meets WCAG AA for text (4.5:1)", (_name, text, surface) => {
        expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
    });
});
