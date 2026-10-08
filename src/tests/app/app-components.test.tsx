// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Clock } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/app/empty-state";
import { InlineError } from "@/components/app/inline-error";
import { KeyHint } from "@/components/app/key-hint";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatCard } from "@/components/app/stat-card";

afterEach(() => {
    cleanup();
});

describe("PageHeader", () => {
    it("renders the title as the page's h1, with description and actions", () => {
        render(
            <PageHeader
                title="Recordings"
                description="Everything you have synced."
                actions={<button type="button">Upload</button>}
            />,
        );
        expect(
            screen.getByRole("heading", { level: 1, name: "Recordings" }),
        ).toBeTruthy();
        expect(screen.getByText("Everything you have synced.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    });
});

describe("StatCard", () => {
    it("shows the label and the value", () => {
        render(<StatCard label="Recordings" value="42" hint="this week" />);
        expect(screen.getByText("Recordings")).toBeTruthy();
        expect(screen.getByText("42")).toBeTruthy();
        expect(screen.getByText("this week")).toBeTruthy();
    });
});

describe("EmptyState", () => {
    it("shows the title, description, and the action", () => {
        render(
            <EmptyState
                icon={Clock}
                title="No recordings yet"
                description="Sync your Plaud account to get started."
                action={<button type="button">Sync now</button>}
            />,
        );
        expect(
            screen.getByRole("heading", {
                level: 2,
                name: "No recordings yet",
            }),
        ).toBeTruthy();
        expect(
            screen.getByText("Sync your Plaud account to get started."),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
    });
});

describe("InlineError", () => {
    it("announces the message as an alert", () => {
        render(<InlineError message="Could not load the summary." />);
        expect(screen.getByRole("alert").textContent).toContain(
            "Could not load the summary.",
        );
    });

    it("offers a retry only when one is provided", () => {
        const { unmount } = render(
            <InlineError message="Could not load the summary." />,
        );
        expect(screen.queryByRole("button")).toBeNull();
        unmount();
    });

    it("calls onRetry when the retry button is pressed", () => {
        const onRetry = vi.fn();
        render(
            <InlineError
                message="Could not load the summary."
                onRetry={onRetry}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});

describe("KeyHint", () => {
    it("renders each key in order", () => {
        const { container } = render(
            <KeyHint keys={["⌘", "K"]} label="Search" />,
        );
        expect(screen.getByText("Search")).toBeTruthy();
        const keys = Array.from(
            container.querySelectorAll("kbd[data-slot='kbd']"),
        );
        expect(keys.map((key) => key.textContent)).toEqual(["⌘", "K"]);
    });
});

describe("SectionCard", () => {
    it("renders the title as a heading with its content", () => {
        render(
            <SectionCard title="Storage" description="Where audio is kept.">
                <p>Local disk</p>
            </SectionCard>,
        );
        expect(screen.getByText("Storage")).toBeTruthy();
        expect(screen.getByText("Where audio is kept.")).toBeTruthy();
        expect(screen.getByText("Local disk")).toBeTruthy();
    });
});
