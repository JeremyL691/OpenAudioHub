import { type Browser, type Page, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { configureAccount, fakeAiBaseUrl, fakeAiControl, newUserContext, uploadRecording } from "../helpers/api";

/** A fresh account with a transcribed recording, so the chat has something to answer from. */
async function preparedAccount(browser: Browser): Promise<{ page: Page; id: string; dispose(): Promise<void> }> {
    const api = await newUserContext(`chat-ui-${randomUUID().slice(0, 8)}`);
    // Onboarding must be finished, or every page redirects to the tour.
    await configureAccount(api);
    const created = await api.post("/api/settings/ai/providers", {
        data: {
            provider: "Custom",
            apiKey: "contract-chat-ui-key",
            baseUrl: fakeAiBaseUrl,
            defaultModel: "fake-chat-1",
            isDefaultTranscription: true,
            isDefaultEnhancement: true,
        },
    });
    expect(created.status(), "add provider").toBeTruthy();
    const id = await uploadRecording(api);
    const transcribed = await api.post(`/api/recordings/${id}/transcribe`);
    expect(transcribed.status(), "transcribe").toBe(200);
    const state = await api.storageState();
    const context = await browser.newContext({
        storageState: state,
        baseURL: state.baseURL ?? process.env.OAH_BASE_URL,
        viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    return {
        page,
        id,
        async dispose() {
            await context.close();
            await api.dispose();
        },
    };
}

test.afterEach(async () => {
    await fakeAiControl("/__reset");
});

test("the chat opens beside a wide recording and shows the answer", async ({ page: shared, browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings/${account.id}`);
        const button = account.page.getByTestId("recording-ask-ai");
        await expect(button).toBeVisible();
        await expect(button).toHaveAttribute("aria-pressed", "false");
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        // A wide recording view keeps the panel beside the recording rather than in a drawer.
        await expect(account.page.getByTestId("recording-chat-dock")).toBeVisible();
        await expect(account.page.getByTestId("chat-empty")).toBeVisible();
        const input = account.page.getByLabel("Your question");
        await input.fill("What did we decide?");
        await account.page.getByTestId("chat-send").click();
        await expect(account.page.getByTestId("chat-turn")).toHaveCount(1, { timeout: 30_000 });
        await expect(account.page.getByTestId("chat-turn")).toContainText("Contract summary", {
            timeout: 30_000,
        });
    } finally {
        await account.dispose();
    }
    void shared;
});

test("a narrow recording view opens the chat as an inline view in the same plane", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 600, height: 900 });
        await account.page.goto(`/recordings/${account.id}`);
        await account.page.getByTestId("recording-ask-ai").click();
        await expect(account.page.getByTestId("recording-chat")).toBeVisible();
        // No popup drawer or dialog overlay on the same plane
        await expect(account.page.getByRole("dialog")).toHaveCount(0);
        await expect(account.page.getByTestId("recording-chat-dock")).toHaveCount(0);
        // Toggling Ask AI returns to the transcript
        await account.page.getByTestId("recording-ask-ai").click();
        await expect(account.page.getByTestId("recording-chat")).toBeHidden();
        await expect(account.page.getByTestId("transcript-card")).toBeVisible();
    } finally {
        await account.dispose();
    }
});

test("a recording without a transcript explains what to do first", async ({ browser }) => {
    const api = await newUserContext(`chat-ui-empty-${randomUUID().slice(0, 8)}`);
    try {
        await configureAccount(api);
        const provider = await api.post("/api/settings/ai/providers", {
            data: { provider: "Custom", apiKey: "contract-ui-key", baseUrl: fakeAiBaseUrl, defaultModel: "fake-chat-1", isDefaultEnhancement: true },
        });
        expect(provider.status()).toBeTruthy();
        const id = await uploadRecording(api);
        const context = await browser.newContext({
            storageState: await api.storageState(),
            baseURL: process.env.OAH_BASE_URL,
        });
        const page = await context.newPage();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/recordings/${id}`);
        await page.getByTestId("recording-ask-ai").click();
        await expect(page.getByTestId("chat-empty")).toContainText("Transcribe this recording");
        await expect(page.getByTestId("chat-send")).toBeDisabled();
        await context.close();
    } finally {
        await api.dispose();
    }
});

test("the model menu offers the thinking levels a known model takes", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings/${account.id}`);
        await account.page.getByTestId("recording-ask-ai").click();
        const picker = account.page.getByTestId("chat-model-picker");
        await picker.click();
        // The fake model was never checked, so no level is offered or sent.
        await expect(account.page.getByText("This model's thinking levels are unknown, so none is sent.")).toBeVisible();
        await expect(account.page.getByRole("radiogroup", { name: "Thinking level" })).toHaveCount(0);

        // A typed model id is used as is. This family's levels are known.
        await account.page.getByRole("combobox", { name: "Model" }).fill("deepseek-chat");
        await account.page.getByRole("option", { name: "Use deepseek-chat" }).click();
        await expect(picker).toContainText("deepseek-chat");
        await picker.click();
        const levels = account.page.getByRole("radiogroup", { name: "Thinking level" });
        await expect(levels).toBeVisible();
        // Exact names: "High" is a prefix of "Extra high", so a loose match would be ambiguous.
        for (const name of ["Default", "Minimal", "Low", "Medium", "High"]) {
            await expect(levels.getByRole("radio", { name, exact: true })).toBeVisible();
        }
        await expect(levels.getByRole("radio", { name: "Maximum", exact: true })).toHaveCount(0);
        await levels.getByRole("radio", { name: "High", exact: true }).click();
        await expect(levels.getByRole("radio", { name: "High", exact: true })).toHaveAttribute("aria-checked", "true");
        await account.page.keyboard.press("Escape");

        // The choice is remembered for this recording.
        await account.page.reload();
        await account.page.getByTestId("recording-ask-ai").click();
        await expect(account.page.getByTestId("chat-model-picker")).toContainText("deepseek-chat");
        await expect(account.page.getByTestId("chat-model-picker")).toContainText("High");
    } finally {
        await account.dispose();
    }
});

test("clicking Ask AI in the library preview opens full view with chat active and back button returns", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings?id=${account.id}`);
        // Ensure library list is visible
        await expect(account.page.getByTestId("recording-list")).toBeVisible();
        // Ensure the tabs row in preview pane has NO "Ask AI" tab
        await expect(account.page.getByRole("tab", { name: "Ask AI" })).toHaveCount(0);
        await expect(account.page.getByRole("tab", { name: "Transcript" })).toBeVisible();
        await expect(account.page.getByRole("tab", { name: "Summary" })).toBeVisible();
        await expect(account.page.getByRole("tab", { name: "Details" })).toBeVisible();

        // Click Ask AI in the header
        await account.page.getByTestId("recording-ask-ai").click();

        // Should navigate to full view with chat=1
        await expect(account.page).toHaveURL(new RegExp(`/recordings/${account.id}\\?chat=1$`));
        // Recording list is gone in full view
        await expect(account.page.getByTestId("recording-list")).toHaveCount(0);
        // Both transcript on the left and chat dock on the right are visible
        await expect(account.page.getByTestId("transcript-card")).toBeVisible();
        await expect(account.page.getByTestId("recording-chat-dock")).toBeVisible();

        // Clicking Back returns to library
        await account.page.getByRole("button", { name: "Back to recordings" }).click();
        await expect(account.page).toHaveURL(/\/recordings/);
        await expect(account.page.getByTestId("recording-list")).toBeVisible();
    } finally {
        await account.dispose();
    }
});

interface SavedCitation {
    sourceId: string;
    startMs: number | null;
    segmentStart: number | null;
    segmentEnd: number | null;
    line: number | null;
}

/** Checks that exactly the rows a citation names are marked, and that the player moved there. */
async function expectMarked(page: Page, citation: SavedCitation) {
    const cited = page.locator('[data-cited="true"]');
    if (citation.segmentStart !== null) {
        const first = citation.segmentStart;
        const last = citation.segmentEnd ?? first;
        await expect(cited).toHaveCount(last - first + 1);
        for (let index = first; index <= last; index++) {
            await expect(page.getByTestId("transcript-segment").nth(index)).toHaveAttribute("data-cited", "true");
        }
    } else {
        expect(citation.line, "a citation names a row or a line").not.toBeNull();
        await expect(cited).toHaveCount(1);
        await expect(page.getByTestId("transcript-line").nth(citation.line ?? 0)).toHaveAttribute("data-cited", "true");
    }
    if (citation.startMs !== null) {
        const seconds = Math.floor(citation.startMs / 1000);
        const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        await expect(page.getByTestId("player-time")).toContainText(time);
    }
}

test("a citation marks exactly the rows it names", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await fakeAiControl("/__reset");
        await fakeAiControl("/__answer", { content: "Hello from the contract suite [src_1]. It is fixed [src_2]." });

        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings/${account.id}`);
        await account.page.getByTestId("recording-ask-ai").click();
        await expect(account.page.getByTestId("recording-chat-dock")).toBeVisible();

        const input = account.page.getByLabel("Your question");
        await input.fill("Tell me about the contract suite");
        await account.page.getByTestId("chat-send").click();

        await expect(account.page.getByTestId("chat-turn")).toHaveCount(1, { timeout: 30_000 });
        await expect(account.page.getByTestId("chat-turn")).toContainText("Hello from the contract suite", { timeout: 30_000 });

        const state = await account.page.request.get(`/api/recordings/${account.id}/chat`);
        const saved = ((await state.json()) as { turns: { citations: SavedCitation[] }[] }).turns[0].citations;
        expect(saved.length, "the answer cites what it was given").toBeGreaterThan(0);

        // The answer shows a numbered badge, never the raw marker the model wrote.
        const answer = account.page.getByTestId("chat-turn").locator(".chat-markdown");
        await expect(answer).not.toContainText("src_");
        const citationLink = account.page.getByTestId("chat-citation-link").first();
        await expect(citationLink).toHaveText("1");
        await expect(citationLink).toHaveAttribute("data-source-id", "src_1");
        // The badge names its number and its words for a reader using a screen reader, so a badge
        // that shows only "1" is not read out as a bare digit.
        const label = await citationLink.getAttribute("aria-label");
        expect(label, "the badge says which source it is").toContain("1");
        expect(label, "the badge says what it points at").toContain("contract suite");
        await expect(citationLink).toHaveAttribute("title", /contract suite/);

        await citationLink.click();
        await expect(account.page.getByTestId("transcript-card")).toBeVisible();
        await expectMarked(account.page, saved[0]);
        await expect(account.page.locator('[data-cited="true"]').first()).toContainText("contract suite");

        // The sources under the answer are folded until asked for, and use the same numbers.
        await expect(account.page.getByTestId("chat-citations")).toHaveCount(0);
        await account.page.getByTestId("chat-sources-toggle").click();
        const rows = account.page.getByTestId("chat-citation");
        await expect(rows).toHaveCount(saved.length);
        await expect(rows.first()).toContainText("1");
        await rows.last().click();
        await expectMarked(account.page, saved[saved.length - 1]);

        // Playing the audio does not resolve the citation again and again.
        let citationRequests = 0;
        account.page.on("request", (req) => {
            if (req.url().includes("/citations/")) {
                citationRequests += 1;
            }
        });
        await account.page.getByTestId("player-play").click();
        await account.page.waitForTimeout(2000);
        await account.page.getByTestId("player-play").click();
        expect(citationRequests).toBeLessThanOrEqual(1);

        // The send button and the model chip share the row under the question.
        const sendBox = await account.page.getByTestId("chat-send").boundingBox();
        const chipBox = await account.page.getByTestId("chat-model-picker").boundingBox();
        expect(sendBox).toBeTruthy();
        expect(chipBox).toBeTruthy();
        if (sendBox && chipBox) {
            expect(Math.abs(sendBox.y + sendBox.height / 2 - (chipBox.y + chipBox.height / 2))).toBeLessThan(10);
        }

        // Verify zero horizontal overflow at 1024px and 390px (wait for responsive transitions to settle)
        for (const width of [1024, 390]) {
            await account.page.setViewportSize({ width, height: 800 });
            await account.page.waitForTimeout(300);
            const result = await account.page.evaluate(() => {
                const culprits: string[] = [];
                document.querySelectorAll("*").forEach((el) => {
                    const r = el.getBoundingClientRect();
                    if (r.right > window.innerWidth + 1) {
                        culprits.push(`${el.tagName}.${el.className} [right: ${Math.round(r.right)}]`);
                    }
                });
                return {
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    culprits,
                };
            });
            expect(result.overflow, `Width ${width}px culprits: ${result.culprits.join("; ")}`).toBe(0);
        }
    } finally {
        await account.dispose();
    }
});

test("starting a new chat asks first and then clears the answers", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings/${account.id}`);
        await account.page.getByTestId("recording-ask-ai").click();
        // A suggested question is sent as it is.
        await account.page.getByTestId("chat-suggestion").first().click();
        await expect(account.page.getByTestId("chat-turn")).toContainText("Contract summary", { timeout: 30_000 });

        await account.page.getByTestId("chat-clear").click();
        await expect(account.page.getByTestId("chat-clear-confirm")).toBeVisible();
        await account.page.keyboard.press("Escape");
        await expect(account.page.getByTestId("chat-turn")).toHaveCount(1);

        await account.page.getByTestId("chat-clear").click();
        await account.page.getByTestId("chat-clear-confirm").click();
        await expect(account.page.getByTestId("chat-turn")).toHaveCount(0);
        await expect(account.page.getByTestId("chat-empty")).toBeVisible();
    } finally {
        await account.dispose();
    }
});

test("the recording page remains interactive with chat open and audio playing", async ({ browser }) => {
    const account = await preparedAccount(browser);
    try {
        await account.page.setViewportSize({ width: 1440, height: 900 });
        await account.page.goto(`/recordings/${account.id}?chat=1`);
        await expect(account.page.getByTestId("recording-chat")).toBeVisible();
        await expect(account.page.getByTestId("transcript-card")).toBeVisible();
        await expect(account.page.getByTestId("player-play")).toBeVisible();

        // Start playback with chat open: no crash, no freeze
        await account.page.getByTestId("player-play").click();
        await account.page.waitForTimeout(1000);
        await account.page.getByTestId("player-play").click();

        // Both transcript and chat remain visible and functional
        await expect(account.page.getByTestId("transcript-card")).toBeVisible();
        await expect(account.page.getByTestId("recording-chat")).toBeVisible();
    } finally {
        await account.dispose();
    }
});
