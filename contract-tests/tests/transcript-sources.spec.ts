import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { newUserContext, uploadRecording } from "../helpers/api";
import { fakeControl } from "../helpers/plaud-extra";

test("detail exposes empty and single-source arrays and preserves missing-recording errors", async () => {
    const api = await newUserContext("transcript-empty");
    try {
        const id = await uploadRecording(api);
        const detail = () => api.get(`/api/recordings/${id}`);
        expect(await (await detail()).json()).toMatchObject({ transcription: null, transcriptions: [] });
        expect((await api.post(`/api/recordings/${id}/transcription/from-browser`, {
            data: { text: "Only source", model: "whisper-base" },
        })).status()).toBe(200);
        const single = await (await detail()).json();
        expect(single.transcriptions).toHaveLength(1);
        expect(single.transcriptions[0]).toEqual(single.transcription);
        expect(single.transcription).toMatchObject({ text: "Only source", source: "openaudiohub" });
        const other = await newUserContext("transcript-other");
        try { expect((await other.get(`/api/recordings/${id}`)).status()).toBe(404); } finally { await other.dispose(); }
        expect((await api.delete(`/api/recordings/${id}`)).status()).toBe(200);
        expect((await detail()).status()).toBe(404);
        expect((await api.get("/api/recordings/missing-transcript-recording")).status()).toBe(404);
    } finally {
        await api.dispose();
    }
});

test("detail orders all sources by preference and search matches older sources", async () => {
    const api = await newUserContext("transcript-sources");
    try {
        const email = `sources-${randomUUID()}@example.test`;
        const plaudId = `sources-${randomUUID()}`;
        expect((await api.put("/api/settings/user", { data: { importPlaudContent: true } })).status()).toBe(200);
        await fakeControl("/account", { email, recordings: [{ id: plaudId, is_trans: true }] });
        const sent = await api.post("/api/plaud/auth/send-code", { data: { email } });
        expect(sent.status()).toBe(200);
        const { otpToken, apiBase } = await sent.json();
        expect((await api.post("/api/plaud/auth/verify", { data: { email, otpToken, apiBase, code: "123456" } })).status()).toBe(200);
        const sync = await api.post("/api/plaud/sync");
        expect(sync.status()).toBe(200);
        expect((await sync.json()).errors).toEqual([]);
        const { recordings } = await (await api.get("/api/recordings")).json();
        const id = recordings.find((row: { plaudFileId: string }) => row.plaudFileId === plaudId)?.id;
        expect(id).toBeTruthy();
        const detail = async () => {
            const response = await api.get(`/api/recordings/${id}`);
            expect(response.status()).toBe(200);
            return response.json();
        };
        const imported = await detail();
        expect(imported.transcriptions).toHaveLength(1);
        expect(imported.transcription.source).toBe("plaud");
        expect((await api.post(`/api/recordings/${id}/transcription/from-browser`, {
            data: { text: "Unique browser words", model: "whisper-base" },
        })).status()).toBe(200);
        for (const preferred of ["plaud", "openaudiohub"] as const) {
            expect((await api.put("/api/settings/user", { data: { preferredTranscriptSource: preferred } })).status()).toBe(200);
            const body = await detail();
            expect(body.transcriptions.map((row: { source: string }) => row.source)).toEqual(
                preferred === "plaud" ? ["plaud", "openaudiohub"] : ["openaudiohub", "plaud"],
            );
            expect(body.transcription).toEqual(body.transcriptions[0]);
        }
        for (const query of [`Fake transcript line for ${plaudId}`, "Unique browser words"]) {
            const search = await api.get("/api/recordings/search", { params: { q: query } });
            expect(search.status()).toBe(200);
            expect(await search.json()).toEqual({ recordingIds: [id] });
        }
    } finally {
        await api.dispose();
    }
});
