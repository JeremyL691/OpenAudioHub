// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
    STATUS_BADGE_STATUSES,
    StatusBadge,
    type StatusBadgeStatus,
    statusLabel,
} from "@/components/app/status-badge";

// The phase text the dashboard shows while a transcription runs. The badge
// uses the same words, so the two cannot disagree.
const DASHBOARD_PHASE_LABELS: Record<string, string> = {
    queued: "Waiting to process audio",
    download: "Reading original audio",
    decode: "Preparing audio",
    vad: "Detecting speech",
    chunking: "Preparing speech segments",
    transcribing: "Transcribing speech",
    completed: "Transcription complete",
    needs_alignment: "Transcript saved without timestamps",
    paused_disk: "Paused for disk space",
    failed: "Transcription failed",
    cancelled: "Transcription cancelled",
};

// Job statuses the pipeline and Core report besides the phases above.
const JOB_STATUSES = ["submitted", "running", "paused"] as const;

afterEach(() => {
    cleanup();
});

describe("StatusBadge", () => {
    it("covers every phase the dashboard labels", () => {
        for (const status of Object.keys(DASHBOARD_PHASE_LABELS)) {
            expect(STATUS_BADGE_STATUSES).toContain(status);
        }
    });

    it("covers every job status the pipeline and Core report", () => {
        for (const status of JOB_STATUSES) {
            expect(STATUS_BADGE_STATUSES).toContain(status);
        }
    });

    it.each(
        Object.entries(DASHBOARD_PHASE_LABELS),
    )("shows the dashboard wording for %s", (status, label) => {
        render(<StatusBadge status={status as StatusBadgeStatus} />);
        expect(screen.getByText(label)).toBeTruthy();
    });

    it.each(STATUS_BADGE_STATUSES)("labels %s with text", (status) => {
        const { container } = render(<StatusBadge status={status} />);
        const chip = container.querySelector(`[data-status="${status}"]`);
        expect(chip?.textContent?.trim()).toBe(statusLabel(status));
    });

    it("hides its icon from assistive technology", () => {
        const { container } = render(<StatusBadge status="failed" />);
        expect(
            container.querySelector("svg")?.getAttribute("aria-hidden"),
        ).toBe("true");
    });

    it("animates the icon only while work is in progress", () => {
        const { container: running } = render(<StatusBadge status="running" />);
        expect(running.querySelector("svg")?.getAttribute("class")).toContain(
            "motion-safe:animate-spin",
        );
        cleanup();

        const { container: failed } = render(<StatusBadge status="failed" />);
        expect(
            failed.querySelector("svg")?.getAttribute("class"),
        ).not.toContain("animate-spin");
    });
});
