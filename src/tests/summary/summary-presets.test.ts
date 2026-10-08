import { describe, expect, it } from "vitest";
import {
    AI_OUTPUT_LANGUAGES,
    getAiOutputLanguageDirective,
    normalizeAiOutputLanguage,
    SUMMARY_PRESETS,
} from "@/lib/ai/summary-presets";

describe("summary templates", () => {
    const presets = Object.values(SUMMARY_PRESETS);

    it("ships nine templates, each with a unique name and the transcription placeholder", () => {
        expect(presets).toHaveLength(9);
        expect(new Set(presets.map((p) => p.name)).size).toBe(9);
        for (const preset of presets) {
            expect(preset.prompt.match(/\{transcription\}/g)).toHaveLength(1);
        }
    });

    it("keeps the four original ids so saved choices still resolve", () => {
        for (const id of [
            "general",
            "meeting-notes",
            "key-points",
            "action-items",
        ]) {
            expect(SUMMARY_PRESETS).toHaveProperty(id);
        }
    });
});

describe("output language", () => {
    it("offers Auto, Chinese, English, Japanese, and Korean", () => {
        expect(AI_OUTPUT_LANGUAGES.map((l) => l.code)).toEqual([
            "auto",
            "zh",
            "en",
            "ja",
            "ko",
        ]);
    });

    it("reads codes outside the list as unset", () => {
        expect(normalizeAiOutputLanguage("fr")).toBeNull();
        expect(normalizeAiOutputLanguage("ja")).toBe("ja");
        expect(getAiOutputLanguageDirective("fr")).toBe(
            getAiOutputLanguageDirective(null),
        );
    });

    it("names the target language in the directive", () => {
        expect(getAiOutputLanguageDirective("zh")).toContain(
            "Simplified Chinese",
        );
        expect(getAiOutputLanguageDirective("ko")).toContain("in Korean");
        expect(getAiOutputLanguageDirective("auto")).toContain(
            "same language as the transcription",
        );
    });
});
