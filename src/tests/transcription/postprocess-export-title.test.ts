import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        update: vi.fn(),
    },
}));

vi.mock("@/lib/ai/generate-title", () => ({
    generateTitleFromTranscription: vi.fn().mockResolvedValue("AI Title"),
}));

vi.mock("@/lib/recordings/auto-export", () => ({
    autoExportRecording: vi.fn(),
    renameAutoExport: vi.fn(),
}));

vi.mock("@/lib/encryption/fields", () => ({
    encryptText: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

import { db } from "@/db";
import { renameAutoExport } from "@/lib/recordings/auto-export";
import { postProcessTranscription } from "@/lib/transcription/postprocess";

const baseInput = {
    userId: "user-1",
    recordingId: "rec-1",
    text: "hello world",
    syncTitleToPlaud: false,
};

describe("postProcessTranscription with auto-export AI title", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("renames only the export copy when exportAiTitle is set and autoGenerateTitle is off", async () => {
        await postProcessTranscription({
            ...baseInput,
            autoGenerateTitle: false,
            exportAiTitle: true,
        });

        expect(db.update).not.toHaveBeenCalled();
        expect(renameAutoExport).toHaveBeenCalledWith(
            "user-1",
            "rec-1",
            "AI Title",
        );
    });

    it("does nothing when neither flag is set", async () => {
        await postProcessTranscription({
            ...baseInput,
            autoGenerateTitle: false,
            exportAiTitle: false,
        });

        expect(db.update).not.toHaveBeenCalled();
        expect(renameAutoExport).not.toHaveBeenCalled();
    });
});
