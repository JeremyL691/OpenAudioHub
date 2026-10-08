// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressBar } from "@/components/app/progress-bar";

describe("ProgressBar", () => {
    afterEach(() => {
        cleanup();
    });

    it("reports the fraction as a percentage and fills to match", () => {
        render(<ProgressBar value={0.4} label="Lecture progress" />);

        const bar = screen.getByRole("progressbar", {
            name: "Lecture progress",
        });
        expect(bar.getAttribute("aria-valuenow")).toBe("40");
        expect(bar.firstElementChild?.getAttribute("style")).toContain(
            "width: 40%",
        );
    });

    it("clamps out-of-range values and treats NaN as empty", () => {
        const { rerender } = render(
            <ProgressBar value={1.7} label="Upload progress" />,
        );
        const current = () =>
            screen.getByRole("progressbar", { name: "Upload progress" });
        expect(current().getAttribute("aria-valuenow")).toBe("100");

        rerender(<ProgressBar value={-0.2} label="Upload progress" />);
        expect(current().getAttribute("aria-valuenow")).toBe("0");

        rerender(<ProgressBar value={Number.NaN} label="Upload progress" />);
        expect(current().getAttribute("aria-valuenow")).toBe("0");
    });
});
