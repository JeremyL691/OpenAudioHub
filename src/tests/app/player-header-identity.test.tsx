// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import type { Recording } from "@/types/recording";

vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));
vi.mock("@/components/recordings/download-audio-button", () => ({
    DownloadAudioButton: () => <button type="button">Download</button>,
}));

const recording: Recording = {
    id: "rec-1",
    filename: "Weekly team sync",
    duration: 61_000,
    startTime: "2026-10-07T07:09:20.000Z",
    filesize: 4506,
    deviceSn: "PLAUD-1",
};

afterEach(() => cleanup());

describe("RecordingPlayerHeader", () => {
    it("shows the title, download, and size in the library preview", () => {
        render(
            <RecordingPlayerHeader
                recording={recording}
                duration={0}
                scrubberStyle="waveform"
                waveformStatus="ready"
                onDecodeWaveform={() => {}}
            />,
        );
        expect(screen.getByText("Weekly team sync")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
        expect(screen.getByText("4.40 KB")).toBeTruthy();
    });

    it("renders nothing on the detail page when the waveform is ready", () => {
        const { container } = render(
            <RecordingPlayerHeader
                recording={recording}
                duration={0}
                scrubberStyle="waveform"
                waveformStatus="ready"
                onDecodeWaveform={() => {}}
                hideIdentity
            />,
        );
        expect(container.innerHTML).toBe("");
    });

    it("keeps the waveform action on the detail page", () => {
        render(
            <RecordingPlayerHeader
                recording={recording}
                duration={0}
                scrubberStyle="waveform"
                waveformStatus="skipped"
                onDecodeWaveform={() => {}}
                hideIdentity
            />,
        );
        expect(screen.queryByText("Weekly team sync")).toBeNull();
        expect(
            screen.getByRole("button", { name: /Generate waveform/ }),
        ).toBeTruthy();
    });
});
