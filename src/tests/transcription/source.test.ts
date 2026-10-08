import { describe, expect, it } from "vitest";
import {
    isOwnSource,
    normalizeSource,
    OWN_SOURCE,
    OWN_SOURCE_VALUES,
} from "@/lib/transcription/source";

describe("transcript source vocabulary", () => {
    it("writes the current value and reads the legacy one as the current value", () => {
        expect(OWN_SOURCE).toBe("openaudiohub");
        expect(normalizeSource("riffado")).toBe("openaudiohub");
        expect(normalizeSource("openaudiohub")).toBe("openaudiohub");
        expect(normalizeSource("plaud")).toBe("plaud");
    });

    it("queries both stored values so rows written before the rename are found", () => {
        expect(OWN_SOURCE_VALUES).toEqual(["openaudiohub", "riffado"]);
    });

    it("treats both stored values as the user's own transcript", () => {
        expect(isOwnSource("openaudiohub")).toBe(true);
        expect(isOwnSource("riffado")).toBe(true);
        expect(isOwnSource("plaud")).toBe(false);
        expect(isOwnSource(null)).toBe(false);
        expect(isOwnSource(undefined)).toBe(false);
    });
});
