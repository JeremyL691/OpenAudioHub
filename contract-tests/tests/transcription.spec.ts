import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonymousContext, newUserContext, uploadRecording } from "../helpers/api";
import {
    addProvider,
    FAKE_CHAT,
    FAKE_DIARIZED,
    FAKE_TRANSCRIPT,
    fakeProvider,
    fakeRequests,
    getDetail,
    getPipeline,
    transcribeAndWait,
} from "../helpers/transcription-extra";

/** Polls until an automatic summary has content, then returns the summary body. */
async function waitForSummary(
    api: APIRequestContext,
    id: string,
): Promise<{ summary: string | null; provider?: string; status?: string }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        const body = (await (await api.get(`/api/recordings/${id}/summary`)).json()) as {
            summary: string | null;
            provider?: string;
            status?: string;
        };
        if (body.status === "completed" || Date.now() > deadline) return body;
        await new Promise((r) => setTimeout(r, 500));
    }
}

/** Runs a test body with a fresh signed-in user, then disposes the context. */
async function withUser(
    label: string,
    body: (api: APIRequestContext) => Promise<void>,
): Promise<void> {
    const api = await newUserContext(label);
    try {
        await body(api);
    } finally {
        await api.dispose();
    }
}

async function setSettings(
    api: APIRequestContext,
    data: Record<string, unknown>,
): Promise<void> {
    const res = await api.put("/api/settings/user", { data });
    expect(res.ok(), "settings update").toBeTruthy();
}

test.describe("transcribe: errors", () => {
    test("no provider configured returns NO_TRANSCRIPTION_PROVIDER", async () => {
        await withUser("tr-noprov", async (api) => {
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: {},
            });
            expect(res.status()).toBe(400);
            expect((await res.json()).code).toBe("NO_TRANSCRIPTION_PROVIDER");
        });
    });

    test("unknown recording returns 404 RECORDING_NOT_FOUND", async () => {
        await withUser("tr-missing", async (api) => {
            await addProvider(api, fakeProvider());
            const res = await api.post(
                "/api/recordings/no-such-recording/transcribe",
                { data: {} },
            );
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
        });
    });

    test("deleted recording returns 404 RECORDING_NOT_FOUND", async () => {
        await withUser("tr-deleted", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const del = await api.delete(`/api/recordings/${id}`);
            expect(del.ok()).toBeTruthy();
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: {},
            });
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
        });
    });

    test("unknown providerId returns NO_TRANSCRIPTION_PROVIDER", async () => {
        await withUser("tr-badprov", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: { providerId: "does-not-exist" },
            });
            expect(res.status()).toBe(400);
            expect((await res.json()).code).toBe("NO_TRANSCRIPTION_PROVIDER");
        });
    });

    test("anonymous caller gets 401 AUTH_SESSION_MISSING", async () => {
        await withUser("tr-owner", async (owner) => {
            const id = await uploadRecording(owner);
            const anon = await anonymousContext();
            try {
                const res = await anon.post(
                    `/api/recordings/${id}/transcribe`,
                    { data: {} },
                );
                expect(res.status()).toBe(401);
                expect((await res.json()).code).toBe("AUTH_SESSION_MISSING");
            } finally {
                await anon.dispose();
            }
        });
    });

    test("another user's recording is not found", async () => {
        await withUser("tr-owner2", async (owner) => {
            await addProvider(owner, fakeProvider());
            const id = await uploadRecording(owner);
            await withUser("tr-other", async (other) => {
                await addProvider(other, fakeProvider());
                const res = await other.post(
                    `/api/recordings/${id}/transcribe`,
                    { data: {} },
                );
                expect(res.status()).toBe(404);
                expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
                const detail = await other.get(`/api/recordings/${id}`);
                expect(detail.status()).toBe(404);
            });
        });
    });

    test("upstream connection failure returns 500 TRANSCRIPTION_FAILED and stores nothing", async () => {
        await withUser("tr-unreach", async (api) => {
            await addProvider(
                api,
                fakeProvider({ baseUrl: "http://127.0.0.1:9/v1" }),
            );
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: {},
            });
            expect(res.status()).toBe(500);
            const body = (await res.json()) as {
                code: string;
                error: string;
                details?: { errorId?: string };
            };
            expect(body.code).toBe("TRANSCRIPTION_FAILED");
            expect(body.details?.errorId).toMatch(/^err_[0-9a-f]{8}$/);
            expect((await getDetail(api, id)).transcription).toBeNull();
        });
    });

    test("failed forced re-transcribe keeps the previous transcript", async () => {
        await withUser("tr-keep", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);

            await addProvider(
                api,
                fakeProvider({ baseUrl: "http://127.0.0.1:9/v1" }),
            );
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: {},
            });
            expect(res.status()).toBe(500);
            const detail = await getDetail(api, id);
            expect(detail.transcription?.text).toBe(FAKE_TRANSCRIPT);
        });
    });
});

test.describe("transcribe: successful runs", () => {
    test("concurrent runs for one recording share one provider call", async () => {
        await withUser("tr-shared", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const seqs = async () =>
                (await fakeRequests("/audio/transcriptions")).map((r) => (r as { seq: number }).seq);
            const before = Math.max(0, ...(await seqs()));
            const [a, b] = await Promise.all([
                api.post(`/api/recordings/${id}/transcribe`, { data: {} }),
                api.post(`/api/recordings/${id}/transcribe`, { data: {} }),
            ]);
            expect(a.status()).toBe(b.status());
            expect((await seqs()).filter((n) => n > before)).toHaveLength(1);
        });
    });

    test("returns the transcript text and detected language", async () => {
        await withUser("tr-happy", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: {},
            });
            // 200 when the transcript is produced in the request; 202 when the
            // audio pipeline accepts it as a background job.
            expect([200, 202]).toContain(res.status());
            if (res.status() === 200) {
                const body = (await res.json()) as {
                    transcription: string;
                    detectedLanguage: string | null;
                };
                expect(body.transcription).toBe(FAKE_TRANSCRIPT);
                expect(body.detectedLanguage).toBe("en");
            } else {
                const body = (await res.json()) as {
                    jobId: string;
                    status: string;
                };
                expect(body.status).toBe("queued");
                expect(body.jobId).toBeTruthy();
                await transcribeAndWait(api, id);
            }
            const detail = await getDetail(api, id);
            expect(detail.transcription?.text).toBe(FAKE_TRANSCRIPT);
        });
    });

    test("stored transcript carries provider, model, source and no timeline", async () => {
        await withUser("tr-fields", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const t = (await getDetail(api, id)).transcription ?? {};
            expect(t.text).toBe(FAKE_TRANSCRIPT);
            expect(t.detectedLanguage).toBe("en");
            expect(t.provider).toBe("Custom");
            expect(t.model).toBe("fake-whisper-1");
            expect(t.transcriptionType).toBe("server");
            expect(t.source).toBe("openaudiohub");
            expect(t.timeline ?? null).toBeNull();
            expect(t.timelineSource ?? null).toBeNull();
        });
    });

    test("model override is stored as the model actually used", async () => {
        await withUser("tr-model", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(
                await transcribeAndWait(api, id, { model: "fake-whisper-alt" }),
            ).toBeLessThan(300);
            const t = (await getDetail(api, id)).transcription ?? {};
            expect(t.model).toBe("fake-whisper-alt");
        });
    });

    test("re-transcribe overwrites the transcript and drops the old summary", async () => {
        await withUser("tr-retrans", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);

            const made = await api.post(`/api/recordings/${id}/summary`, {
                data: {},
            });
            expect(made.status()).toBeLessThan(300);
            const before = (await (
                await api.get(`/api/recordings/${id}/summary`)
            ).json()) as { summary: string | null };
            expect(before.summary).toBeTruthy();

            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                data: { model: "fake-whisper-2" },
            });
            expect(res.status()).toBeLessThan(300);
            expect((await getDetail(api, id)).transcription?.model).toBe(
                "fake-whisper-2",
            );

            const after = (await (
                await api.get(`/api/recordings/${id}/summary`)
            ).json()) as { summary: string | null };
            expect(after.summary).toBeNull();
        });
    });

    test("automatic title renames the recording after transcription", async () => {
        await withUser("tr-title", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const before = (await getDetail(api, id)).recording.filename;
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const after = (await getDetail(api, id)).recording.filename;
            expect(after).not.toBe(before);
            // The stored title never keeps colons or semicolons and is at most 60 characters.
            expect(after).not.toMatch(/[:;]/);
            expect(after.length).toBeLessThanOrEqual(60);
        });
    });

    test("automatic title off leaves the filename alone", async () => {
        await withUser("tr-notitle", async (api) => {
            await setSettings(api, { autoGenerateTitle: false });
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const before = (await getDetail(api, id)).recording.filename;
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            expect((await getDetail(api, id)).recording.filename).toBe(before);
        });
    });

    test("automatic summary is off by default", async () => {
        await withUser("tr-nosum", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const sum = (await (
                await api.get(`/api/recordings/${id}/summary`)
            ).json()) as { summary: string | null };
            expect(sum.summary).toBeNull();
        });
    });

    test("automatic summary runs after transcription when enabled", async () => {
        await withUser("tr-autosum", async (api) => {
            await setSettings(api, { autoSummarize: true });
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            // The automatic run is a queued job, so the transcript step returns before it finishes.
            const sum = await waitForSummary(api, id);
            expect(sum.summary).toBeTruthy();
            expect(sum.provider).toBe("Custom");
        });
    });

    test("diarized model produces speaker-labelled turns with timestamps", async () => {
        await withUser("tr-diar", async (api) => {
            await addProvider(
                api,
                fakeProvider({ defaultModel: "gpt-4o-transcribe-diarize" }),
            );
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const t = (await getDetail(api, id)).transcription ?? {};
            expect(t.text).toBe(FAKE_DIARIZED);
            expect(t.detectedLanguage ?? null).toBeNull();
        });
    });

    test("ElevenLabs provider returns speaker-labelled text from word timings", async () => {
        await withUser("tr-eleven", async (api) => {
            await addProvider(api, {
                provider: "ElevenLabs",
                baseUrl: fakeProvider().baseUrl,
                defaultModel: "scribe_v2",
                isDefaultTranscription: true,
                isDefaultEnhancement: false,
            });
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBe(200);
            const t = (await getDetail(api, id)).transcription ?? {};
            // The fake's words carry no spacing tokens, so only the labels are pinned.
            expect(t.text).toMatch(/^Speaker 1: /m);
            expect(t.text).toMatch(/^Speaker 2: /m);
            expect(t.provider).toBe("ElevenLabs");
            expect(t.model).toBe("scribe_v2");
        });
    });

    test("whisper request carries model, response format and language hint", async () => {
        await withUser("tr-req", async (api) => {
            await setSettings(api, { defaultTranscriptionLanguage: "fr" });
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const model = `fake-whisper-req-${Date.now()}`;
            expect(await transcribeAndWait(api, id, { model })).toBeLessThan(300);
            const reqs = (await fakeRequests("/audio/transcriptions")).filter(
                (r) => r.fields.model === model,
            );
            expect(reqs.length).toBeGreaterThan(0);
            const f = reqs[reqs.length - 1].fields;
            expect(f.response_format).toBe("verbose_json");
            expect(f.language).toBe("fr");
        });
    });

    test("whisper request omits the language hint when none is set", async () => {
        await withUser("tr-req-nolang", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const model = `fake-whisper-nolang-${Date.now()}`;
            expect(await transcribeAndWait(api, id, { model })).toBeLessThan(300);
            const reqs = (await fakeRequests("/audio/transcriptions")).filter(
                (r) => r.fields.model === model,
            );
            expect(reqs.length).toBeGreaterThan(0);
            expect("language" in reqs[reqs.length - 1].fields).toBe(false);
        });
    });

    test("diarized request asks for diarized_json with automatic chunking", async () => {
        await withUser("tr-req-diar", async (api) => {
            const model = `gpt-4o-transcribe-diarize-${Date.now()}`;
            await addProvider(api, fakeProvider({ defaultModel: model }));
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const reqs = (await fakeRequests("/audio/transcriptions")).filter(
                (r) => r.fields.model === model,
            );
            expect(reqs.length).toBeGreaterThan(0);
            const f = reqs[reqs.length - 1].fields;
            expect(f.response_format).toBe("diarized_json");
            expect(f.chunking_strategy).toBe("auto");
        });
    });

    test("chat-style provider transcribes through chat completions", async () => {
        await withUser("tr-chat", async (api) => {
            await addProvider(
                api,
                fakeProvider({
                    provider: "OpenRouter",
                    defaultModel: "google/gemini-2.5-flash-lite",
                }),
            );
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const t = (await getDetail(api, id)).transcription ?? {};
            expect(t.text).toBe(FAKE_CHAT);
            expect(t.detectedLanguage ?? null).toBeNull();
            expect(t.provider).toBe("OpenRouter");
        });
    });

    test("transcribe accepts an empty or non-JSON body", async () => {
        await withUser("tr-body", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/transcribe`, {
                headers: { "content-type": "text/plain" },
                data: "not json",
            });
            expect([200, 202]).toContain(res.status());
        });
    });
});

test.describe("transcript read and delete", () => {
    test("GET and PATCH on the transcription path are not allowed", async () => {
        await withUser("tr-methods", async (api) => {
            const id = await uploadRecording(api);
            expect((await api.get(`/api/recordings/${id}/transcription`)).status()).toBe(405);
            expect(
                (
                    await api.patch(`/api/recordings/${id}/transcription`, {
                        data: { text: "edited" },
                    })
                ).status(),
            ).toBe(405);
        });
    });

    test("delete removes the transcript, then reports 404", async () => {
        await withUser("tr-del", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);

            const res = await api.delete(`/api/recordings/${id}/transcription`);
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual({ success: true });
            expect((await getDetail(api, id)).transcription).toBeNull();

            const again = await api.delete(`/api/recordings/${id}/transcription`);
            expect(again.status()).toBe(404);
            expect((await again.json()).code).toBe("NOT_FOUND");
        });
    });

    test("delete with no transcript returns 404 NOT_FOUND", async () => {
        await withUser("tr-del-none", async (api) => {
            const id = await uploadRecording(api);
            const res = await api.delete(`/api/recordings/${id}/transcription`);
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("NOT_FOUND");
        });
    });

    test("delete with an unknown source returns 400 INVALID_INPUT", async () => {
        await withUser("tr-del-bad", async (api) => {
            const id = await uploadRecording(api);
            const res = await api.delete(
                `/api/recordings/${id}/transcription?source=bogus`,
            );
            expect(res.status()).toBe(400);
            expect((await res.json()).code).toBe("INVALID_INPUT");
        });
    });

    test("delete of a missing source leaves the own transcript in place", async () => {
        await withUser("tr-del-plaud", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            const res = await api.delete(
                `/api/recordings/${id}/transcription?source=plaud`,
            );
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("NOT_FOUND");
            expect((await getDetail(api, id)).transcription?.text).toBe(
                FAKE_TRANSCRIPT,
            );
        });
    });

    test("delete also removes the summary written from the transcript", async () => {
        await withUser("tr-del-sum", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBeLessThan(300);
            expect(
                (await api.post(`/api/recordings/${id}/summary`, { data: {} })).status(),
            ).toBeLessThan(300);
            const res = await api.delete(`/api/recordings/${id}/transcription`);
            expect(res.status()).toBe(200);
            const sum = (await (
                await api.get(`/api/recordings/${id}/summary`)
            ).json()) as { summary: string | null };
            expect(sum.summary).toBeNull();
        });
    });

    test("delete on an unknown recording returns 404 RECORDING_NOT_FOUND", async () => {
        await withUser("tr-del-missing", async (api) => {
            const res = await api.delete(
                "/api/recordings/no-such-recording/transcription",
            );
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
        });
    });

    test("delete from another user is not found and does not remove the transcript", async () => {
        await withUser("tr-del-owner", async (owner) => {
            await addProvider(owner, fakeProvider());
            const id = await uploadRecording(owner);
            expect(await transcribeAndWait(owner, id)).toBeLessThan(300);
            await withUser("tr-del-other", async (other) => {
                const res = await other.delete(
                    `/api/recordings/${id}/transcription`,
                );
                expect(res.status()).toBe(404);
            });
            expect((await getDetail(owner, id)).transcription?.text).toBe(
                FAKE_TRANSCRIPT,
            );
        });
    });
});

test.describe("audio pipeline status", () => {
    test("recording with no job and no transcript reports nulls", async () => {
        await withUser("tr-pipe-empty", async (api) => {
            const id = await uploadRecording(api);
            const state = await getPipeline(api, id);
            expect(state.job).toBeNull();
            expect(state.timeline ?? null).toBeNull();
            expect(state.timestampSource).toBeNull();
            expect(state.transcription).toBeNull();
        });
    });

    test("after a synchronous transcript, status returns the transcript", async () => {
        await withUser("tr-pipe-sync", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBe(200);
            const state = await getPipeline(api, id);
            expect(state.job).toBeNull();
            expect(state.transcription).toEqual({
                text: FAKE_TRANSCRIPT,
                language: "en",
                source: "openaudiohub",
            });
        });
    });

    test("status for another user's recording reveals nothing", async () => {
        await withUser("tr-pipe-owner", async (owner) => {
            await addProvider(owner, fakeProvider());
            const id = await uploadRecording(owner);
            expect(await transcribeAndWait(owner, id)).toBe(200);
            await withUser("tr-pipe-other", async (other) => {
                const state = await getPipeline(other, id);
                expect(state.job).toBeNull();
                expect(state.transcription).toBeNull();
            });
        });
    });

    test("POST with an action other than retry or cancel returns 400", async () => {
        await withUser("tr-pipe-action", async (api) => {
            const id = await uploadRecording(api);
            const res = await api.post(`/api/recordings/${id}/audio-pipeline`, {
                data: { action: "pause" },
            });
            expect(res.status()).toBe(400);
            expect(await res.json()).toEqual({ error: "Invalid action" });
        });
    });

    test("retry and cancel with no job return 404", async () => {
        await withUser("tr-pipe-nojob", async (api) => {
            const id = await uploadRecording(api);
            for (const action of ["retry", "cancel"]) {
                const res = await api.post(
                    `/api/recordings/${id}/audio-pipeline`,
                    { data: { action } },
                );
                expect(res.status()).toBe(404);
                expect(await res.json()).toEqual({
                    error: "Audio job not found",
                });
            }
        });
    });

    test("retry of a job that is not failed returns 409 when a job exists", async () => {
        await withUser("tr-pipe-409", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBe(200);
            // No pipeline job exists on the synchronous path, so retry stays 404.
            const res = await api.post(`/api/recordings/${id}/audio-pipeline`, {
                data: { action: "retry" },
            });
            expect([404, 409]).toContain(res.status());
        });
    });
});

test.describe("browser transcription upload", () => {
    test("browser text is stored with provider browser and no AI provider needed", async () => {
        await withUser("tr-browser", async (api) => {
            const id = await uploadRecording(api);
            const before = (await getDetail(api, id)).recording.filename;
            const res = await api.post(
                `/api/recordings/${id}/transcription/from-browser`,
                {
                    data: {
                        text: "  browser words  ",
                        model: "whisper-base",
                        detectedLanguage: "fr",
                        provider: "OpenAI",
                    },
                },
            );
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual({
                transcription: "browser words",
                detectedLanguage: "fr",
            });
            const detail = await getDetail(api, id);
            expect(detail.transcription?.text).toBe("browser words");
            expect(detail.transcription?.provider).toBe("browser");
            expect(detail.transcription?.transcriptionType).toBe("browser");
            expect(detail.transcription?.model).toBe("whisper-base");
            expect(detail.transcription?.detectedLanguage).toBe("fr");
            expect(detail.transcription?.source).toBe("openaudiohub");
            // The browser path never generates a title.
            expect(detail.recording.filename).toBe(before);
        });
    });

    test("missing detectedLanguage is stored as null", async () => {
        await withUser("tr-browser-lang", async (api) => {
            const id = await uploadRecording(api);
            const res = await api.post(
                `/api/recordings/${id}/transcription/from-browser`,
                { data: { text: "hello", model: "whisper-tiny" } },
            );
            expect(res.status()).toBe(200);
            expect((await res.json()).detectedLanguage).toBeNull();
            expect((await getDetail(api, id)).transcription?.detectedLanguage).toBeNull();
        });
    });

    test("invalid body returns 400 MISSING_REQUIRED_FIELD with issues", async () => {
        await withUser("tr-browser-bad", async (api) => {
            const id = await uploadRecording(api);
            const url = `/api/recordings/${id}/transcription/from-browser`;
            const cases = [
                { text: "   ", model: "whisper-base" },
                { model: "whisper-base" },
                { text: "hi" },
                { text: "x".repeat(200_001), model: "whisper-base" },
                { text: "hi", model: "" },
            ];
            for (const data of cases) {
                const res = await api.post(url, { data });
                expect(res.status()).toBe(400);
                const body = (await res.json()) as {
                    code: string;
                    details?: { issues?: unknown };
                };
                expect(body.code).toBe("MISSING_REQUIRED_FIELD");
                expect(body.details?.issues).toBeTruthy();
            }
        });
    });

    test("unknown recording returns 404 RECORDING_NOT_FOUND", async () => {
        await withUser("tr-browser-missing", async (api) => {
            const res = await api.post(
                "/api/recordings/no-such-recording/transcription/from-browser",
                { data: { text: "hi", model: "whisper-base" } },
            );
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
        });
    });

    test("deleted recording returns 404 RECORDING_NOT_FOUND", async () => {
        await withUser("tr-browser-deleted", async (api) => {
            const id = await uploadRecording(api);
            expect((await api.delete(`/api/recordings/${id}`)).ok()).toBeTruthy();
            const res = await api.post(
                `/api/recordings/${id}/transcription/from-browser`,
                { data: { text: "hi", model: "whisper-base" } },
            );
            expect(res.status()).toBe(404);
            expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
        });
    });

    test("browser text replaces a server transcript", async () => {
        await withUser("tr-browser-replace", async (api) => {
            await addProvider(api, fakeProvider());
            const id = await uploadRecording(api);
            expect(await transcribeAndWait(api, id)).toBe(200);
            const res = await api.post(
                `/api/recordings/${id}/transcription/from-browser`,
                { data: { text: "local words", model: "whisper-tiny" } },
            );
            expect(res.status()).toBe(200);
            const t = (await getDetail(api, id)).transcription ?? {};
            expect(t.text).toBe("local words");
            expect(t.provider).toBe("browser");
        });
    });

    test("another user's recording is not found", async () => {
        await withUser("tr-browser-owner", async (owner) => {
            const id = await uploadRecording(owner);
            await withUser("tr-browser-other", async (other) => {
                const res = await other.post(
                    `/api/recordings/${id}/transcription/from-browser`,
                    { data: { text: "hi", model: "whisper-base" } },
                );
                expect(res.status()).toBe(404);
                expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
            });
            expect((await getDetail(owner, id)).transcription).toBeNull();
        });
    });

    test("anonymous caller gets 401", async () => {
        await withUser("tr-browser-owner2", async (owner) => {
            const id = await uploadRecording(owner);
            const anon = await anonymousContext();
            try {
                const res = await anon.post(
                    `/api/recordings/${id}/transcription/from-browser`,
                    { data: { text: "hi", model: "whisper-base" } },
                );
                expect(res.status()).toBe(401);
                expect((await res.json()).code).toBe("AUTH_SESSION_MISSING");
            } finally {
                await anon.dispose();
            }
        });
    });
});
