import { expect, test, type APIRequestContext, type Download } from "@playwright/test";
import { fixture } from "../helpers/api";
import { FAKE_CHAT, FAKE_DIARIZED, fakeProvider, addProvider, transcribeAndWait } from "../helpers/transcription-extra";

interface ProviderSnapshot {
    id: string;
    provider: string;
    baseUrl: string | null;
    defaultModel: string | null;
    isDefaultTranscription: boolean;
    isDefaultEnhancement: boolean;
}

/** The account settings and providers this test changes, read before it changes them. */
async function snapshotAccount(request: APIRequestContext) {
    const user = await request.get("/api/settings/user");
    expect(user.ok()).toBeTruthy();
    const autoGenerateTitle = ((await user.json()) as { autoGenerateTitle: boolean }).autoGenerateTitle;
    const list = await request.get("/api/settings/ai/providers");
    expect(list.ok()).toBeTruthy();
    const providers = ((await list.json()) as { providers: ProviderSnapshot[] }).providers;
    return { autoGenerateTitle, providers };
}

/** Puts back the settings and providers from the snapshot, and deletes the provider the test added. */
async function restoreAccount(
    request: APIRequestContext,
    before: Awaited<ReturnType<typeof snapshotAccount>>,
    addedProviderId: string | undefined,
) {
    if (addedProviderId) {
        const removed = await request.delete(`/api/settings/ai/providers/${addedProviderId}`);
        expect(removed.ok(), "delete the provider the test added").toBeTruthy();
    }
    const restored = await request.put("/api/settings/user", { data: { autoGenerateTitle: before.autoGenerateTitle } });
    expect(restored.ok(), "restore autoGenerateTitle").toBeTruthy();
    const now = (await (await request.get("/api/settings/ai/providers")).json()) as { providers: ProviderSnapshot[] };
    for (const original of before.providers) {
        const current = now.providers.find((p) => p.id === original.id);
        if (!current) continue;
        if (
            current.isDefaultTranscription === original.isDefaultTranscription &&
            current.isDefaultEnhancement === original.isDefaultEnhancement
        ) {
            continue;
        }
        const update = await request.put(`/api/settings/ai/providers/${original.id}`, {
            data: {
                provider: original.provider,
                baseUrl: original.baseUrl,
                defaultModel: original.defaultModel,
                isDefaultTranscription: original.isDefaultTranscription,
                isDefaultEnhancement: original.isDefaultEnhancement,
            },
        });
        expect(update.ok(), `restore default flags on provider ${original.id}`).toBeTruthy();
    }
}

async function downloadedText(download: Download): Promise<string> {
    const stream = await download.createReadStream();
    if (!stream) throw new Error("download stream was not available");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}

test("transcript and summary exports download complete content", async ({ page, request }) => {
    const snapshot = await snapshotAccount(request);
    let addedProviderId: string | undefined;
    try {
        addedProviderId = await addProvider(request, fakeProvider({ defaultModel: `gpt-4o-transcribe-diarize-${Date.now()}` }));
        const before = await request.get("/api/recordings");
        expect(before.ok()).toBeTruthy();
        const existing = new Set(((await before.json()) as { recordings: { id: string }[] }).recordings.map((r) => r.id));
        const upload = await request.post("/api/recordings/upload", {
            multipart: { file: { name: "tone-3s.mp3", mimeType: "audio/mpeg", buffer: fixture("tone-3s.mp3") } },
        });
        expect(upload.ok()).toBeTruthy();
        const list = await request.get("/api/recordings");
        const recordings = ((await list.json()) as { recordings: { id: string; filename: string }[] }).recordings;
        const recording = recordings.find((r) => !existing.has(r.id));
        expect(recording).toBeTruthy();
        const id = recording!.id;
        const title = "Export names 東京 / notes";
        const rename = await request.patch(`/api/recordings/${id}`, { data: { filename: title } });
        expect(rename.ok()).toBeTruthy();
        const settings = await request.put("/api/settings/user", { data: { autoGenerateTitle: false } });
        expect(settings.ok()).toBeTruthy();
        expect(await transcribeAndWait(request, id)).toBeLessThan(300);

        await page.goto(`/recordings/${id}`);
        const transcriptToolbar = page.getByTestId("transcript-toolbar");
        const txtPromise = page.waitForEvent("download");
        await transcriptToolbar.getByRole("button", { name: "Download transcript as TXT" }).click();
        const txtDownload = await txtPromise;
        expect(txtDownload.suggestedFilename(), `download URL: ${txtDownload.url()}`).toBe(`${title.replace("/", "-")}.txt`);
        expect(await downloadedText(txtDownload)).toBe(FAKE_DIARIZED);

        const jsonPromise = page.waitForEvent("download");
        await transcriptToolbar.getByRole("button", { name: "Download transcript as JSON" }).click();
        const jsonDownload = await jsonPromise;
        expect(jsonDownload.suggestedFilename(), `download URL: ${jsonDownload.url()}`).toBe(`${title.replace("/", "-")}.json`);
        expect(JSON.parse(await downloadedText(jsonDownload))).toMatchObject({ text: FAKE_DIARIZED });

        await page.getByRole("button", { name: "Recording actions" }).click();
        await expect(page.getByRole("menuitem", { name: "Export SRT" })).toBeDisabled();
        await expect(page.getByRole("menuitem", { name: "Export VTT" })).toBeDisabled();
        for (const [format, extension, expectedType] of [
            ["TXT", "txt", "Hello from the contract suite."],
            ["JSON", "json", '"segments"'],
        ]) {
            const downloadPromise = page.waitForEvent("download");
            await page.getByRole("menuitem", { name: `Export ${format}` }).click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toBe(`${title.replace("/", "-")}.${extension}`);
            const content = await downloadedText(download);
            expect(content).toContain(expectedType);
            if (format === "JSON") expect(JSON.parse(content)).toMatchObject({ text: expect.any(String) });
            if (format !== "JSON") await page.getByRole("button", { name: "Recording actions" }).click();
        }

        await page.getByRole("tab", { name: "Summary" }).click();
        await page.getByTestId("summary-generate").click();
        await expect(page.getByTestId("summary-content")).toContainText(FAKE_CHAT, { timeout: 30_000 });

        const mdPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download summary as Markdown" }).click();
        const mdDownload = await mdPromise;
        expect(mdDownload.suggestedFilename()).toBe(`${title.replace("/", "-")} summary.md`);
        const markdown = await downloadedText(mdDownload);
        expect(markdown).toContain(`# ${title} summary`);
        expect(markdown).toContain(FAKE_CHAT);
        expect(markdown.endsWith("\n")).toBe(true);

        const summaryTxtPromise = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download summary as TXT" }).click();
        const summaryTxtDownload = await summaryTxtPromise;
        expect(summaryTxtDownload.suggestedFilename()).toBe(`${title.replace("/", "-")} summary.txt`);
        const summaryText = await downloadedText(summaryTxtDownload);
        expect(summaryText).toContain(title + " summary");
        expect(summaryText).toContain(FAKE_CHAT);
        expect(summaryText.endsWith("\n")).toBe(true);
    } finally {
        await restoreAccount(request, snapshot, addedProviderId);
    }
});
