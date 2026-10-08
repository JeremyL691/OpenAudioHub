import { describe, expect, it } from "vitest";
import { recordingSource } from "@/lib/recordings/transcript-status";

describe("recordingSource", () => {
    it("labels a recording that carries a Plaud serial as Plaud", () => {
        expect(recordingSource("PLAUD-SN-0001")).toBe("Plaud");
    });

    it("labels an uploaded file as Upload, including the upload sentinel", () => {
        // The upload route stores "local" in the NOT NULL device column.
        expect(recordingSource("local")).toBe("Upload");
        expect(recordingSource("")).toBe("Upload");
        expect(recordingSource(null)).toBe("Upload");
        expect(recordingSource(undefined)).toBe("Upload");
    });
});
