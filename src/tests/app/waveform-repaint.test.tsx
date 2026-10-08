// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Waveform } from "@/components/dashboard/waveform";

// Canvas stand-in that accepts every call the waveform makes. The tests count
// draws, so the recorded pixels are not needed.
function fakeContext() {
    return {
        setTransform: () => {},
        clearRect: () => {},
        beginPath: () => {},
        fill: () => {},
        fillRect: () => {},
        save: () => {},
        restore: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
        fillStyle: "",
        globalAlpha: 1,
    };
}

function spyOnCanvas() {
    return vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockImplementation(
            () => fakeContext() as unknown as CanvasRenderingContext2D,
        );
}

const props = {
    peaks: [0.2, 0.8, 0.5],
    progress: 0.5,
    durationSeconds: 10,
    onSeek: () => {},
};

describe("Waveform theme repaint", () => {
    afterEach(() => {
        cleanup();
        document.documentElement.className = "";
        vi.restoreAllMocks();
    });

    it("repaints when the theme class on <html> changes", async () => {
        const getContext = spyOnCanvas();
        render(<Waveform {...props} />);
        const drawsBeforeToggle = getContext.mock.calls.length;

        document.documentElement.classList.add("dark");

        await waitFor(() => {
            expect(getContext.mock.calls.length).toBeGreaterThan(
                drawsBeforeToggle,
            );
        });
    });

    it("stops watching the theme once unmounted", async () => {
        const getContext = spyOnCanvas();
        const { unmount } = render(<Waveform {...props} />);
        unmount();
        const drawsAfterUnmount = getContext.mock.calls.length;

        document.documentElement.classList.add("dark");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(getContext.mock.calls.length).toBe(drawsAfterUnmount);
    });
});
