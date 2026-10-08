import { beforeEach, describe, expect, it, vi } from "vitest";

// The internal bridge routes (/api/internal/audio-pipeline/*) accept only the
// pipeline's bearer token. These tests run the real check; the route tests mock it.
const TOKEN = "pipeline-token-for-tests-0123456789abcdef";

const envState = vi.hoisted(() => ({
    AUDIO_PIPELINE_ENABLED: true,
    AUDIO_PIPELINE_TOKEN: "pipeline-token-for-tests-0123456789abcdef",
}));

vi.mock("@/lib/env", () => ({ env: envState }));

import { isAudioPipelineServiceRequest } from "@/lib/transcription/audio-pipeline-auth";

function request(authorization?: string): Request {
    const headers = new Headers();
    if (authorization !== undefined) {
        headers.set("authorization", authorization);
    }
    return new Request("http://openaudiohub.test/api/internal", { headers });
}

describe("isAudioPipelineServiceRequest", () => {
    beforeEach(() => {
        envState.AUDIO_PIPELINE_ENABLED = true;
        envState.AUDIO_PIPELINE_TOKEN = TOKEN;
    });

    it("accepts the configured token as a bearer credential", () => {
        expect(isAudioPipelineServiceRequest(request(`Bearer ${TOKEN}`))).toBe(
            true,
        );
    });

    it("rejects a token of the same length with the wrong value", () => {
        const wrong = `${TOKEN.slice(0, -1)}X`;
        expect(isAudioPipelineServiceRequest(request(`Bearer ${wrong}`))).toBe(
            false,
        );
    });

    it("rejects a token of another length", () => {
        expect(isAudioPipelineServiceRequest(request(`Bearer ${TOKEN}0`))).toBe(
            false,
        );
        expect(isAudioPipelineServiceRequest(request("Bearer short"))).toBe(
            false,
        );
    });

    it("rejects a missing header, a non-bearer scheme, and a bare token", () => {
        expect(isAudioPipelineServiceRequest(request())).toBe(false);
        expect(isAudioPipelineServiceRequest(request(`Basic ${TOKEN}`))).toBe(
            false,
        );
        expect(isAudioPipelineServiceRequest(request(TOKEN))).toBe(false);
    });

    it("rejects every request while the pipeline is disabled", () => {
        envState.AUDIO_PIPELINE_ENABLED = false;
        expect(isAudioPipelineServiceRequest(request(`Bearer ${TOKEN}`))).toBe(
            false,
        );
    });

    it("rejects every request when no token is configured", () => {
        envState.AUDIO_PIPELINE_TOKEN = "";
        expect(isAudioPipelineServiceRequest(request("Bearer "))).toBe(false);
    });
});
