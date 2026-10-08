// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptBody } from "@/components/recording/transcript/transcript-body";

const segments = Array.from({ length: 12 }, (_, index) => ({
    start_ms: index * 1000,
    end_ms: index * 1000 + 900,
    text: `Segment ${index + 1}`,
}));

describe("TranscriptBody", () => {
    it("renders every timed segment in the library preview", () => {
        render(
            <TranscriptBody
                text="unused"
                timeline={segments}
                variant="preview"
            />,
        );
        expect(screen.getAllByTestId("transcript-segment")).toHaveLength(12);
        expect(screen.getByText("Segment 12")).toBeTruthy();
        expect(screen.queryByText(/Showing the first/)).toBeNull();
    });

    it("reports a hand scroll so follow-playback can stop", () => {
        const onUserScroll = vi.fn();
        const { container } = render(
            <TranscriptBody
                text="unused"
                timeline={segments}
                followPlayback
                onUserScroll={onUserScroll}
            />,
        );
        const scroller = container.firstElementChild as HTMLElement;
        fireEvent.wheel(scroller);
        fireEvent.touchMove(scroller);
        expect(onUserScroll).toHaveBeenCalledTimes(2);
    });
});
