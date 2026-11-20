import { type Browser, expect, test } from "@playwright/test";
import { configureAccount, newUserContext, uploadRecording } from "../helpers/api";

async function recordingPage(browser: Browser) {
    const api = await newUserContext("recovery-ui");
    await configureAccount(api);
    const id = await uploadRecording(api);
    const saved = await api.post(`/api/recordings/${id}/transcription/from-browser`, {
        data: { text: "Words for the recording", model: "whisper-base" },
    });
    expect(saved.status()).toBe(200);
    const initialChat = await (await api.get(`/api/recordings/${id}/chat`)).json();
    const context = await browser.newContext({
        storageState: await api.storageState(),
        baseURL: process.env.OAH_BASE_URL,
        viewport: { width: 1440, height: 900 },
    });
    return { id, initialChat, page: await context.newPage(), async dispose() { await context.close(); await api.dispose(); } };
}

test("active pipeline polling recovers from a failed poll and stops on completion", async ({ browser }) => {
    const account = await recordingPage(browser);
    try {
        let polls = 0;
        await account.page.route(`**/api/recordings/${account.id}/audio-pipeline`, async (route) => {
            polls++;
            if (polls === 2) return route.abort("failed");
            await route.fulfill({ json: {
                job: { id: "job", status: polls >= 4 ? "completed" : "running", phase: "transcribe", progress: polls >= 4 ? 100 : 25 },
                timeline: null, timestampSource: null, transcription: null,
            } });
        });
        await account.page.goto(`/recordings/${account.id}`);
        await expect(account.page.getByTestId("pipeline-status")).toBeVisible();
        await expect.poll(() => polls, { timeout: 20_000 }).toBe(4);
        await expect(account.page.getByTestId("pipeline-status")).toHaveCount(0);
        await account.page.clock.install();
        await account.page.clock.fastForward(60_000);
        expect(polls).toBe(4);
    } finally {
        await account.dispose();
    }
});

for (const interruption of ["clean EOF", "network error", "none", "exhausted"] as const) {
    test(`chat stream recovery: ${interruption}`, async ({ browser }) => {
        const account = await recordingPage(browser);
        try {
            let streams = 0;
            let submitted = false;
            let completed = false;
            const turn = {
                id: "recovery-turn", seq: 1, status: "running", question: "What happened?", answer: "", citations: [], partial: false,
                provider: "Custom", model: "fake-chat-1", effort: { requested: null, sent: null, known: false }, error: null,
                createdAt: new Date().toISOString(), finishedAt: null,
            };
            await account.page.route(`**/api/recordings/${account.id}/chat**`, async (route) => {
                const path = new URL(route.request().url()).pathname;
                if (path.endsWith("/events")) {
                    streams++;
                    if (interruption === "network error" && streams === 1) return route.abort("failed");
                    if (interruption === "exhausted") return route.fulfill({ contentType: "text/event-stream", body: "" });
                    if (interruption === "clean EOF" && streams === 1) {
                        return route.fulfill({ contentType: "text/event-stream", body: 'event: snapshot\ndata: {"status":"running","answer":"Hello"}\n\nevent: delta\ndata: {"text":" wor"}\n\n' });
                    }
                    completed = true;
                    return route.fulfill({ contentType: "text/event-stream", body: 'event: snapshot\ndata: {"status":"running","answer":"Hello"}\n\nevent: delta\ndata: {"text":" world"}\n\nevent: done\ndata: {}\n\n' });
                }
                if (path.endsWith("/turns") && route.request().method() === "POST") {
                    submitted = true;
                    return route.fulfill({ json: { turn } });
                }
                if (route.request().method() === "GET" && path.endsWith("/chat")) {
                    const current = { ...turn, status: completed ? "completed" : "running", answer: completed ? "Hello world" : "" };
                    return route.fulfill({ json: { ...account.initialChat, activeTurn: submitted && !completed ? current : null, turns: submitted ? [current] : [] } });
                }
                return route.continue();
            });
            await account.page.goto(`/recordings/${account.id}`);
            await account.page.getByTestId("recording-ask-ai").click();
            await account.page.getByLabel("Your question").fill(turn.question);
            await account.page.getByTestId("chat-send").click();
            if (interruption === "exhausted") {
                await expect(account.page.getByText("The connection to the answer was lost.")).toBeVisible({ timeout: 20_000 });
                expect(streams).toBe(5);
            } else {
                await expect(account.page.getByTestId("chat-turn")).toHaveAttribute("data-status", "completed");
                await expect(account.page.getByTestId("chat-turn").locator(".chat-markdown")).toHaveText("Hello world");
                expect(streams).toBe(interruption === "none" ? 1 : 2);
                await expect(account.page.getByTestId("chat-stop")).toHaveCount(0);
                await expect(account.page.getByTestId("chat-turn")).toHaveCount(1);
            }
        } finally {
            await account.dispose();
        }
    });
}
