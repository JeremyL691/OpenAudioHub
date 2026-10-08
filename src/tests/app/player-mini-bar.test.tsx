// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PlayerMiniBar,
    shouldShowMiniPlayer,
} from "@/components/dashboard/player-mini-bar";

describe("PlayerMiniBar", () => {
    afterEach(() => {
        cleanup();
    });

    it("shows the title, the time, and a play control that calls back", () => {
        const onToggle = vi.fn();
        render(
            <PlayerMiniBar
                title="Weekly team sync"
                isPlaying={false}
                currentTime={65}
                duration={600}
                onToggle={onToggle}
            />,
        );

        expect(screen.getByTestId("mini-player")).toBeTruthy();
        expect(screen.getByText("Weekly team sync")).toBeTruthy();
        expect(screen.getByText("1:05 / 10:00")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Play" }));
        expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it("labels the control Pause while playing", () => {
        render(
            <PlayerMiniBar
                title="Plaud import draft"
                isPlaying
                currentTime={0}
                duration={0}
                onToggle={() => {}}
            />,
        );
        expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    });
});

describe("shouldShowMiniPlayer", () => {
    it("shows only when the player is laid out, scrolled away, and a recording is loaded", () => {
        expect(
            shouldShowMiniPlayer({
                hasRecording: true,
                playerRendered: true,
                playerInView: false,
            }),
        ).toBe(true);
    });

    it("stays hidden while the player is in view", () => {
        expect(
            shouldShowMiniPlayer({
                hasRecording: true,
                playerRendered: true,
                playerInView: true,
            }),
        ).toBe(false);
    });

    it("stays hidden when the player is not laid out (the phone list view)", () => {
        expect(
            shouldShowMiniPlayer({
                hasRecording: true,
                playerRendered: false,
                playerInView: false,
            }),
        ).toBe(false);
    });

    it("stays hidden when no recording is loaded", () => {
        expect(
            shouldShowMiniPlayer({
                hasRecording: false,
                playerRendered: true,
                playerInView: false,
            }),
        ).toBe(false);
    });
});
