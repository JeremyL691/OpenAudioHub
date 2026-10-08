import { describe, expect, it } from "vitest";
import { buildSummaryExport, markdownToPlainText } from "@/lib/summary/export";

const summary = [
    "## Overview",
    "The team agreed on **the launch date** and read [the spec](https://example.com/spec).",
    "",
    "## Action Items",
    "| Owner | Task | Due date | Status |",
    "| --- | --- | --- | --- |",
    "| Alice | Send the deck | Oct 12 | Open |",
    "",
    "Use `npm test` before release.",
].join("\n");

describe("markdownToPlainText", () => {
    it("drops heading and emphasis markup and keeps the link target", () => {
        const text = markdownToPlainText(summary);
        expect(text).toContain("Overview");
        expect(text).toContain("the launch date");
        expect(text).toContain("the spec (https://example.com/spec)");
        expect(text).toContain("Use npm test before release.");
        expect(text).not.toContain("**");
        expect(text).not.toContain("#");
    });

    it("joins table cells and removes the separator row", () => {
        const text = markdownToPlainText(summary);
        expect(text).toContain("Owner | Task | Due date | Status");
        expect(text).toContain("Alice | Send the deck | Oct 12 | Open");
        expect(text).not.toContain("---");
    });
});

describe("buildSummaryExport", () => {
    const input = {
        title: "Team sync: Q4 plan",
        summary,
        keyPoints: ["Launch on Oct 20"],
        actionItems: ["Alice sends the deck"],
        templateName: "Meeting Minutes",
        languageName: "English",
        model: "gpt-4o-mini",
    };

    it("writes Markdown with the heading, header line, and lists", () => {
        const file = buildSummaryExport("md", input);
        expect(file.mimeType).toBe("text/markdown");
        expect(file.filename).toBe("Team sync- Q4 plan summary.md");
        expect(file.content.startsWith("# Team sync: Q4 plan\n")).toBe(true);
        expect(file.content).toContain(
            "*Meeting Minutes · English · gpt-4o-mini*",
        );
        expect(file.content).toContain("## Overview");
        expect(file.content).toContain("## Key Points\n\n- Launch on Oct 20");
        expect(file.content).toContain(
            "## Action Items\n\n- Alice sends the deck",
        );
        expect(file.content.endsWith("\n")).toBe(true);
    });

    it("writes plain text without Markdown markup", () => {
        const file = buildSummaryExport("txt", input);
        expect(file.mimeType).toBe("text/plain");
        expect(file.filename).toBe("Team sync- Q4 plan summary.txt");
        expect(file.content).toContain(
            "Meeting Minutes · English · gpt-4o-mini",
        );
        expect(file.content).toContain("Key Points\n- Launch on Oct 20");
        expect(file.content).not.toContain("**");
        expect(file.content).not.toContain("## ");
    });

    it("omits empty lists and an absent header", () => {
        const file = buildSummaryExport("md", {
            title: "",
            summary: "Short.",
            keyPoints: [],
            actionItems: null,
        });
        expect(file.content).toBe("# Summary\n\nShort.\n");
    });
});
