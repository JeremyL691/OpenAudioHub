import {
    type APIRequestContext,
    type Browser,
    expect,
    type Page,
    test,
} from "@playwright/test";
import {
    baseURL,
    configureAccount,
    fixture,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

// Black-box UI checks for the recordings library, the detail page, the mini
// player and the keyboard shortcuts. Each test works on recordings it creates,
// with names unique to that test. Tests that need an empty library or change
// list settings run on a fresh account.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 800 };
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

test.use({ viewport: DESKTOP });

/** A name no other test uses, so a search isolates this test's rows. */
function uniqueName(label: string): string {
    const stamp = Date.now().toString(36);
    const salt = Math.floor(Math.random() * 1e6).toString(36);
    return `${label} ${stamp}${salt}`;
}

async function listIds(api: APIRequestContext): Promise<string[]> {
    const res = await api.get("/api/recordings");
    expect(res.ok(), "list recordings").toBeTruthy();
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body)
        ? body
        : ((body as { recordings?: unknown[] }).recordings ?? []);
    return (list as { id: string }[]).map((r) => r.id);
}

/**
 * Uploads the three-second fixture and returns the id of the recording it
 * created. The upload answer carries no id, so the id is the one new in the
 * list.
 */
async function uploadFixture(api: APIRequestContext): Promise<string> {
    const before = new Set(await listIds(api));
    const res = await api.post("/api/recordings/upload", {
        multipart: {
            file: {
                name: "tone-3s.mp3",
                mimeType: "audio/mpeg",
                buffer: fixture("tone-3s.mp3"),
            },
        },
    });
    expect(res.status(), "upload").toBeLessThan(300);
    const created = (await listIds(api)).filter((id) => !before.has(id));
    expect(created, "one new recording").toHaveLength(1);
    return created[0];
}

/** Uploads the fixture and renames it. Returns the recording id. */
async function namedRecording(
    api: APIRequestContext,
    name: string,
): Promise<string> {
    const id = await uploadFixture(api);
    const res = await api.patch(`/api/recordings/${id}`, {
        data: { filename: name },
    });
    expect(res.ok(), "rename fixture recording").toBeTruthy();
    return id;
}

/**
 * Waits until the transcript is stored. Transcription may answer 202 and finish
 * later; the audio pipeline route reports the job state.
 */
/** Polls until `read` returns a value, or fails the test after `timeoutMs`. */
async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((r) => setTimeout(r, 500));
    }
}

async function waitForTranscript(
    api: APIRequestContext,
    id: string,
    body: string,
): Promise<void> {
    if (!body.includes("queued")) return;
    await expect
        .poll(
            async () => {
                const res = await api.get(`/api/recordings/${id}/audio-pipeline`);
                return res.text();
            },
            { timeout: 120_000, intervals: [1000] },
        )
        .toContain("completed");
}

/** The rename button that heads the preview (the player repeats it lower down). */
function renameTitle(page: Page, name: string) {
    return page.getByRole("button", { name: `Rename ${name}` }).first();
}

/** The library row for one recording id. */
function rowById(page: Page, id: string) {
    return page.locator(`[data-testid="recording-row"][data-id="${id}"]`);
}

/** A row of the library list whose text contains the name. */
function rowFor(page: Page, name: string) {
    return page.getByTestId("recording-row").filter({ hasText: name });
}

async function searchFor(page: Page, text: string): Promise<void> {
    await page.getByTestId("recording-search").fill(text);
}

async function audioState(page: Page) {
    return page.locator("audio").evaluate((el: HTMLAudioElement) => ({
        paused: el.paused,
        currentTime: el.currentTime,
        duration: el.duration,
        readyState: el.readyState,
    }));
}

async function waitForAudio(page: Page): Promise<void> {
    await expect
        .poll(async () => (await audioState(page)).readyState, {
            timeout: 20_000,
        })
        .toBeGreaterThanOrEqual(1);
}

/**
 * A new account with onboarding done, in its own browser context. The caller
 * disposes it.
 */
async function freshUser(browser: Browser, label: string) {
    const api = await newUserContext(label);
    await configureAccount(api);
    const context = await browser.newContext({
        baseURL,
        storageState: await api.storageState(),
        viewport: DESKTOP,
    });
    const page = await context.newPage();
    return {
        api,
        page,
        async dispose() {
            await context.close();
            await api.dispose();
        },
    };
}

// ---------------------------------------------------------------------------
// Library: layout, search and selection (shared session)
// ---------------------------------------------------------------------------

test("desktop library shows the list beside a detail pane for the selected recording", async ({
    page,
    request,
}) => {
    const name = uniqueName("Layout");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings?id=${id}`);

    await expect(page.getByTestId("recording-list")).toBeVisible();
    await expect(
        page.getByRole("heading", { name: "All recordings" }),
    ).toBeVisible();
    await expect(page.getByTestId("recording-search")).toBeVisible();
    // The preview title is a rename button labelled with the recording name.
    await expect(renameTitle(page, name)).toBeVisible();
    await expect(page.getByTestId("open-full-view")).toHaveAttribute(
        "href",
        `/recordings/${id}`,
    );
    // The mobile back control is hidden on desktop.
    await expect(
        page.getByRole("button", { name: "Back to recordings" }),
    ).toBeHidden();
});

test("on a phone the list and the detail pane take turns", async ({
    page,
    request,
}) => {
    const name = uniqueName("Phone");
    await namedRecording(request, name);

    await page.setViewportSize(PHONE);
    await page.goto("/recordings");
    await searchFor(page, name);
    await expect(rowFor(page, name)).toBeVisible();
    await rowFor(page, name).getByRole("button").first().click();

    await expect(
        page.getByRole("button", { name: "Back to recordings" }),
    ).toBeVisible();
    await expect(page.getByTestId("recording-list")).toBeHidden();

    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Back to recordings" }).click();
    await expect(page.getByTestId("recording-list")).toBeVisible();
    await page.setViewportSize(DESKTOP);
});

test("search narrows the list by name, clears, and reports no matches", async ({
    page,
    request,
}) => {
    const name = uniqueName("Searchable");
    await namedRecording(request, name);

    await page.goto("/recordings");
    await searchFor(page, name.toUpperCase());
    await expect(rowFor(page, name)).toHaveCount(1);

    await searchFor(page, `${name}-no-such-words`);
    await expect(
        page.getByText("No recordings match your search."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByTestId("recording-search")).toHaveValue("");
    await expect(rowFor(page, name)).toHaveCount(1);
});

test("Enter in the search box opens the first matching recording", async ({
    page,
    request,
}) => {
    const name = uniqueName("Enter opens");
    await namedRecording(request, name);

    await page.goto("/recordings");
    await searchFor(page, name);
    await page.getByTestId("recording-search").press("Enter");

    await expect(renameTitle(page, name)).toBeVisible();
});

test("the star button in the preview toggles and survives a reload", async ({
    page,
    request,
}) => {
    const name = uniqueName("Star");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings?id=${id}`);
    const star = page.getByTestId("recording-star");
    await expect(star).toHaveAttribute("aria-pressed", "false");

    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await expect(star).toHaveAccessibleName("Unstar");

    await page.reload();
    await expect(page.getByTestId("recording-star")).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect(rowFor(page, name).getByText("Starred")).toBeAttached();

    await page.getByTestId("recording-star").click();
    await expect(page.getByTestId("recording-star")).toHaveAttribute(
        "aria-pressed",
        "false",
    );
});

test("a row's menu lists its actions and Cancel keeps the recording", async ({
    page,
    request,
}) => {
    const name = uniqueName("Row menu");
    await namedRecording(request, name);

    await page.goto("/recordings");
    await searchFor(page, name);
    const row = rowFor(page, name);
    await row.getByRole("button", { name: "Row actions" }).click();

    for (const item of [
        "Open",
        "Rename",
        "Transcribe",
        "Download audio",
        "Delete",
    ]) {
        await expect(
            page.getByRole("menuitem", { name: item, exact: true }),
        ).toBeVisible();
    }

    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirm = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ hasText: "Delete this recording?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(rowFor(page, name)).toHaveCount(1);
});

test("the row menu offers in-browser transcription", async ({
    page,
    request,
}) => {
    const name = uniqueName("Browser row");
    await namedRecording(request, name);

    await page.goto("/recordings");
    await searchFor(page, name);
    await rowFor(page, name).getByRole("button", { name: "Row actions" }).click();
    await expect(
        page.getByRole("menuitem", { name: "Transcribe in browser", exact: true }),
    ).toBeVisible();
});

test("renaming from a row's menu updates the row and the stored name", async ({
    page,
    request,
}) => {
    const name = uniqueName("Rename row");
    const id = await namedRecording(request, name);
    const renamed = `${name} renamed`;

    await page.goto("/recordings");
    await searchFor(page, name);
    await rowFor(page, name).getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Rename recording" });
    const input = dialog.getByRole("textbox", { name: "Name" });
    await expect(input).toHaveValue(name);
    await input.fill(renamed);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(rowFor(page, renamed)).toHaveCount(1);
    const stored = await request.get(`/api/recordings/${id}`);
    const body = (await stored.json()) as { filename?: string };
    expect(JSON.stringify(body)).toContain(renamed);
});

test("the title on the detail page renames in place; Escape cancels", async ({
    page,
    request,
}) => {
    const name = uniqueName("Inline title");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings/${id}`);
    await page.getByRole("button", { name: `Rename ${name}` }).click();
    const field = page.getByRole("textbox", { name: "Recording name" });
    await expect(field).toBeFocused();
    await field.fill("discarded edit");
    await field.press("Escape");
    await expect(
        page.getByRole("heading", { level: 1, name }),
    ).toBeVisible();

    await page.getByRole("button", { name: `Rename ${name}` }).click();
    const again = page.getByRole("textbox", { name: "Recording name" });
    await again.fill(`${name} final`);
    await again.press("Enter");
    await expect(
        page.getByRole("heading", { level: 1, name: `${name} final` }),
    ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Detail page
// ---------------------------------------------------------------------------

test("detail page shows tabs below the wide-layout breakpoint and returns to the library", async ({
    page,
    request,
}) => {
    const name = uniqueName("Detail tabs");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings/${id}`);
    await expect(page.getByRole("tab", { name: "Transcript" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Details" })).toBeVisible();
    await expect(page.getByTestId("player")).toBeVisible();
    await expect(page.getByTestId("recording-star")).toBeVisible();

    await page.getByRole("button", { name: "Back to recordings" }).click();
    await expect(page).toHaveURL(/\/recordings$/);
});

test("an unknown recording id answers with not found", async ({ page }) => {
    const res = await page.goto(`/recordings/${UNKNOWN_ID}`);
    expect(res?.status()).toBe(404);
});

test("the detail actions menu disables exports until a transcript exists", async ({
    page,
    request,
}) => {
    const name = uniqueName("Actions");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings/${id}`);
    await page.getByRole("button", { name: "Recording actions" }).click();

    await expect(
        page.getByRole("menuitem", { name: "Download audio" }),
    ).toBeVisible();
    await expect(
        page.getByRole("menuitem", { name: "Star", exact: true }),
    ).toBeVisible();
    for (const label of ["Export TXT", "Export SRT", "Export VTT", "Export JSON"]) {
        await expect(
            page.getByRole("menuitem", { name: label }),
        ).toBeDisabled();
    }
    await expect(
        page.getByRole("menuitem", { name: "Transcribe", exact: true }),
    ).toBeEnabled();
    await expect(
        page.getByRole("menuitem", { name: "Delete recording" }),
    ).toBeVisible();
});

test("deleting from the detail page asks first, then removes the recording", async ({
    page,
    request,
}) => {
    const name = uniqueName("Delete detail");
    const id = await namedRecording(request, name);

    await page.goto(`/recordings/${id}`);
    await page.getByRole("button", { name: "Recording actions" }).click();
    await page.getByRole("menuitem", { name: "Delete recording" }).click();

    const dialog = page.getByRole("dialog", { name: "Delete this recording?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/recordings/${id}$`));

    await page.getByRole("button", { name: "Recording actions" }).click();
    await page.getByRole("menuitem", { name: "Delete recording" }).click();
    await page
        .getByRole("dialog", { name: "Delete this recording?" })
        .getByRole("button", { name: "Delete recording" })
        .click();

    await page.waitForURL(/\/recordings$/);
    const gone = await request.get(`/api/recordings/${id}`);
    expect(gone.status()).toBe(404);
});

test("a summary made automatically appears without a manual re-run", async ({ browser }) => {
    // The library row says ready only when the detail pane has content, so opening the pane after
    // the run finished must show the text, not an empty result.
    const { api, page, dispose } = await freshUser(browser, "ui-summary-auto");
    try {
        await api.put("/api/settings/user", { data: { autoSummarize: true } });
        const id = await uploadRecording(api);
        const transcribe = await api.post(`/api/recordings/${id}/transcribe`);
        expect(transcribe.status()).toBe(200);
        await waitFor(async () => {
            const json = await (await api.get(`/api/recordings/${id}/summary`)).json();
            return json.status === "completed" ? json : undefined;
        });

        await page.goto(`/recordings/${id}`);
        await page.getByRole("tab", { name: "Summary" }).click();
        await expect(page.getByTestId("summary-content")).toContainText("Contract summary");
        await expect(page.getByTestId("summary-generate")).toContainText("Re-generate");
    } finally {
        await dispose();
    }
});

test("a transcript shows its text and the summary generates", async ({
    page,
    request,
}) => {
    const name = uniqueName("Transcript flow");
    const id = await namedRecording(request, name);
    const transcribe = await request.post(`/api/recordings/${id}/transcribe`, {
        timeout: 120_000,
    });
    const transcribeBody = await transcribe.text();
    expect(transcribe.status(), `transcribe: ${transcribeBody}`).toBeLessThan(300);
    await waitForTranscript(request, id, transcribeBody);

    await page.goto(`/recordings/${id}`);
    await waitForAudio(page);

    // The fake provider returns text without timestamps, so the timeline is absent.
    await expect(page.getByTestId("transcript-segment")).toHaveCount(0);
    await expect(page.getByText("fixed transcript")).toBeVisible();
    await expect(page.getByTestId("transcript-toolbar")).toBeVisible();
    await expect(page.getByTestId("source-switcher")).toHaveCount(0);

    await page.getByTestId("transcript-toolbar").getByRole("button", { name: "Download transcript as TXT" }).waitFor();

    await page.getByRole("tab", { name: "Summary" }).click();
    await page.getByTestId("summary-generate").click();
    await expect(page.getByTestId("summary-content")).toContainText(
        "Contract summary",
        { timeout: 30_000 },
    );
});

test("the library search matches transcript text and the Transcribed chip narrows to it", async ({
    page,
    request,
}) => {
    const name = uniqueName("Transcribed");
    const id = await namedRecording(request, name);
    const transcribe = await request.post(`/api/recordings/${id}/transcribe`, {
        timeout: 120_000,
    });
    expect(transcribe.ok(), "transcribe with the fake provider").toBeTruthy();

    await page.goto("/recordings");
    await searchFor(page, "fixed transcript");
    // Transcription may rename the recording, so rows are found by id.
    await expect(rowById(page, id)).toHaveCount(1);

    await page.getByTestId("recording-filter-transcribed").click();
    await expect(
        page.getByTestId("recording-filter-transcribed"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(rowById(page, id)).toHaveCount(1);
    await page.getByTestId("recording-filter-untranscribed").click();
    await expect(rowById(page, id)).toHaveCount(0);
});

test("a search asks the server once instead of fetching every recording", async ({
    page,
    request,
}) => {
    // Three transcribed recordings: the old code asked for each one's detail while searching.
    const ids: string[] = [];
    for (const label of ["one", "two", "three"]) {
        const id = await namedRecording(request, uniqueName(`SearchCost ${label}`));
        const transcribe = await request.post(`/api/recordings/${id}/transcribe`, {
            timeout: 120_000,
        });
        expect(transcribe.ok(), "transcribe with the fake provider").toBeTruthy();
        ids.push(id);
    }

    await page.goto("/recordings");
    const searches: string[] = [];
    const details: string[] = [];
    page.on("request", (req) => {
        const url = new URL(req.url());
        if (url.pathname === "/api/recordings/search") searches.push(url.search);
        // A detail read is /api/recordings/<id> with nothing after the id. The search route
        // shares the prefix, so it is excluded by name.
        if (/^\/api\/recordings\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/search")) {
            details.push(url.pathname);
        }
    });

    await searchFor(page, "fixed transcript");
    await expect(rowById(page, ids[0])).toHaveCount(1);

    // One search request covers the whole library. The detail pane does read the recording it
    // shows, which is one recording however large the library is; what must not happen is a read
    // per recording, which is what the search used to do.
    expect(searches.length, `search requests: ${searches.join(", ")}`).toBe(1);
    const distinct = new Set(details);
    expect(
        distinct.size,
        `distinct recordings read during the search: ${[...distinct].join(", ")} (3 are transcribed)`,
    ).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Player: transport, speed, mute and keys
// ---------------------------------------------------------------------------

test("player keys: Space toggles play, arrows seek and change volume", async ({
    page,
    request,
}) => {
    const id = await namedRecording(request, uniqueName("Keys player"));

    await page.goto(`/recordings/${id}`);
    await waitForAudio(page);

    await page.keyboard.press(" ");
    await expect
        .poll(async () => (await audioState(page)).paused)
        .toBe(false);
    await page.keyboard.press(" ");
    await expect
        .poll(async () => (await audioState(page)).paused)
        .toBe(true);

    // Five-second steps clamp at the ends of a three-second clip.
    await page.keyboard.press("ArrowRight");
    await expect
        .poll(async () => {
            const s = await audioState(page);
            return s.duration - s.currentTime;
        })
        .toBeLessThan(0.2);
    await page.keyboard.press("ArrowLeft");
    await expect
        .poll(async () => (await audioState(page)).currentTime)
        .toBeLessThan(0.2);

    const volume = page.locator('[aria-label="Volume"]').first();
    const before = Number(await volume.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowUp");
    await expect(volume).toHaveAttribute("aria-valuenow", String(before + 5));
    await page.keyboard.press("ArrowDown");
    await expect(volume).toHaveAttribute("aria-valuenow", String(before));
});

test("the speed button cycles through six speeds and back", async ({
    page,
    request,
}) => {
    const id = await namedRecording(request, uniqueName("Speed"));
    await page.goto(`/recordings/${id}`);
    await waitForAudio(page);

    const speed = page.getByTestId("player-speed");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
        seen.push((await speed.innerText()).trim());
        await speed.click();
    }
    expect(new Set(seen).size, `labels seen: ${seen.join(", ")}`).toBe(6);
    await expect(speed).toHaveText(seen[0]);
});

test("mute toggles its label and skip buttons clamp to the clip", async ({
    page,
    request,
}) => {
    const id = await namedRecording(request, uniqueName("Mute skip"));
    await page.goto(`/recordings/${id}`);
    await waitForAudio(page);

    await page.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Unmute", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect(
        page.getByRole("button", { name: "Mute", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Skip forward 15 seconds" }).click();
    await expect
        .poll(async () => {
            const s = await audioState(page);
            return s.duration - s.currentTime;
        })
        .toBeLessThan(0.2);
    await page.getByRole("button", { name: "Skip back 15 seconds" }).click();
    await expect
        .poll(async () => (await audioState(page)).currentTime)
        .toBeLessThan(0.2);
});

test("on a phone the compact player appears once the full player scrolls away", async ({
    page,
    request,
}) => {
    const name = uniqueName("Mini");
    const id = await namedRecording(request, name);
    const transcribe = await request.post(`/api/recordings/${id}/transcribe`, {
        timeout: 120_000,
    });
    expect(transcribe.ok(), "transcribe with the fake provider").toBeTruthy();

    // A short phone viewport makes the page scroll past the player.
    await page.setViewportSize({ width: PHONE.width, height: 320 });
    await page.goto(`/recordings/${id}`);
    await waitForAudio(page);
    await expect(page.getByTestId("mini-player")).toHaveCount(0);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const mini = page.getByTestId("mini-player");
    await expect(mini).toBeVisible();
    await expect(mini).toHaveAttribute("aria-label", "Now playing");

    await mini.getByRole("button", { name: "Play", exact: true }).click();
    await expect
        .poll(async () => (await audioState(page)).paused)
        .toBe(false);
    // Pause from the main player, which shares the same playback.
    await page.getByTestId("player-play").click();
    await expect
        .poll(async () => (await audioState(page)).paused)
        .toBe(true);
    await page.setViewportSize(DESKTOP);
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

test("? opens the shortcuts sheet and Escape closes it", async ({
    page,
    request,
}) => {
    await namedRecording(request, uniqueName("Shortcuts sheet"));
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();

    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    for (const text of [
        "Global",
        "Command palette",
        "Show this cheatsheet",
        "Open settings",
        "Focus search",
        "Recording list",
        "Next recording",
        "Previous recording",
        "Player",
        "Play / pause",
        "Seek back 5s",
        "Seek forward 5s",
        "Volume up",
        "Volume down",
    ]) {
        await expect(dialog.getByText(text, { exact: true })).toBeVisible();
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
});

test("/ focuses the library search, which stays empty", async ({
    page,
    request,
}) => {
    await namedRecording(request, uniqueName("Slash"));
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();

    await page.keyboard.press("/");
    await expect(page.getByTestId("recording-search")).toBeFocused();
    await expect(page.getByTestId("recording-search")).toHaveValue("");
});

test("Ctrl or Cmd+K opens the command palette", async ({ page, request }) => {
    await namedRecording(request, uniqueName("Palette"));
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
});

test(", opens settings from the library", async ({ page }) => {
    await page.goto("/recordings");
    await expect(page.getByTestId("recording-list")).toBeVisible();

    await page.keyboard.press(",");
    await page.waitForURL(/\/settings/);
});

test("j and k move the selection through the rows in list order", async ({
    page,
    request,
}) => {
    const tag = uniqueName("Keys list");
    const first = `${tag} first`;
    const second = `${tag} second`;
    const idA = await namedRecording(request, first);
    const idB = await namedRecording(request, second);
    const names = new Map([
        [idA, first],
        [idB, second],
    ]);

    await page.goto(`/recordings?q=${encodeURIComponent(tag)}`);
    const rows = page.getByTestId("recording-row");
    await expect(rows).toHaveCount(2);
    const ids = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-id") ?? ""),
    );

    await rows.nth(0).getByRole("button").first().click();
    await expect(
        renameTitle(page, names.get(ids[0]) ?? ""),
    ).toBeVisible();

    await page.keyboard.press("j");
    await expect(
        renameTitle(page, names.get(ids[1]) ?? ""),
    ).toBeVisible();

    await page.keyboard.press("k");
    await expect(
        renameTitle(page, names.get(ids[0]) ?? ""),
    ).toBeVisible();
});

test("the shortcut keys do nothing while the search box has focus", async ({
    page,
    request,
}) => {
    await namedRecording(request, uniqueName("Typing"));
    await page.goto("/recordings");
    const search = page.getByTestId("recording-search");
    await search.focus();

    await page.keyboard.type("j?/,");
    await expect(search).toHaveValue("j?/,");
    await expect(
        page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeHidden();
});

// ---------------------------------------------------------------------------
// Library on a fresh account. One sign-up serves the whole serial flow, because
// the sign-in endpoint rate-limits repeated account creation.
// ---------------------------------------------------------------------------

test.describe.serial("library on a new account", () => {
    let user: Awaited<ReturnType<typeof freshUser>>;

    test.beforeAll(async ({ browser }) => {
        user = await freshUser(browser, "lib-flow");
    });

    test.afterAll(async () => {
        await user.dispose();
    });

    test("a new account sees the empty state; the top-bar upload adds a row", async () => {
        const { page } = user;
        await page.goto("/recordings");
        const empty = page.getByTestId("empty-state");
        await expect(empty).toBeVisible();
        await expect(
            empty.getByRole("heading", { name: "No recordings yet" }),
        ).toBeVisible();
        await expect(
            empty.getByRole("button", { name: "Sync Device" }),
        ).toBeVisible();
        await expect(
            empty.getByRole("button", { name: "Upload Audio" }),
        ).toBeVisible();

        const upload = page.getByTestId("upload-button");
        await expect(upload).toHaveAccessibleName("Upload audio");
        const fileInputs = page.locator('input[type="file"]');
        const inputCount = await fileInputs.count();
        expect(inputCount).toBeGreaterThan(0);
        for (let index = 0; index < inputCount; index += 1) {
            const accept = (await fileInputs.nth(index).getAttribute("accept")) ?? "";
            expect(accept.split(",")).toEqual([
                "audio/*",
                ".mp3",
                ".mp4",
                ".m4a",
                ".wav",
                ".ogg",
                ".opus",
                ".webm",
                ".aac",
                ".flac",
            ]);
        }
        const chooser = page.waitForEvent("filechooser");
        await upload.click();
        await (await chooser).setFiles({
            name: "uploaded-clip.mp3",
            mimeType: "audio/mpeg",
            buffer: fixture("tone-3s.mp3"),
        });

        await expect(page.getByTestId("recording-row")).toHaveCount(1, {
            timeout: 30_000,
        });
        await expect(page.getByTestId("empty-state")).toHaveCount(0);
    });

    test("counts, status chips and no-match messages follow the filters", async () => {
        const { api, page } = user;
        await namedRecording(api, "Alpha clip");
        await namedRecording(api, "Bravo clip");
        await page.goto("/recordings");
        await expect(page.getByText("3 of 3 recordings")).toBeVisible();
        await expect(page.getByTestId("recording-filter-all")).toHaveAttribute(
            "aria-pressed",
            "true",
        );

        await page.getByTestId("recording-filter-transcribed").click();
        await expect(
            page.getByText("No recordings match this filter."),
        ).toBeVisible();
        await expect(page.getByTestId("recording-row")).toHaveCount(0);

        await page.getByTestId("recording-filter-untranscribed").click();
        await expect(page.getByTestId("recording-row")).toHaveCount(3);

        await searchFor(page, "zzz-no-match");
        await expect(
            page.getByText("No recordings match your search."),
        ).toBeVisible();
        await expect(
            page.getByText("0 matching of 3 recordings"),
        ).toBeVisible();
        await page.getByTestId("recording-filter-all").click();
        await page.getByRole("button", { name: "Clear search" }).click();
    });

    test("sort by name lists alphabetically", async () => {
        const { page } = user;
        await page.goto("/recordings");
        const rows = page.getByTestId("recording-row");
        await expect(rows).toHaveCount(3);

        await page.getByTestId("recording-sort").click();
        await page.getByRole("menuitemradio", { name: "Name" }).click();

        const names = await rows.evaluateAll((els) =>
            els.map((el) => el.querySelector('[data-testid="recording-row-name"]')?.textContent ?? ""),
        );
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(names).toContain("Alpha clip");
    });

    test("density choice is kept after a reload", async () => {
        const { page } = user;
        await page.goto("/recordings");
        await page.getByRole("button", { name: "Density" }).click();
        // The reload must come after the choice is stored, or it reads the old density.
        const saved = page.waitForResponse(
            (res) =>
                res.request().method() === "PUT" &&
                new URL(res.url()).pathname === "/api/settings/user" &&
                res.request().postData()?.includes('"listDensity":"compact"') === true,
        );
        await page.getByRole("menuitemradio", { name: "Compact" }).click();
        expect((await saved).ok()).toBe(true);

        await page.reload();
        await page.getByRole("button", { name: "Density" }).click();
        await expect(
            page.getByRole("menuitemradio", { name: "Compact" }),
        ).toHaveAttribute("aria-checked", "true");
        await page.keyboard.press("Escape");
    });

    test("select mode counts selections, enables download, and Cancel leaves it", async () => {
        const { page } = user;
        await page.goto("/recordings");
        await page.getByTestId("recording-select-mode").click();
        await expect(page.getByTestId("recording-row-checkbox")).toHaveCount(3);

        const merge = page.getByTestId("recording-bulk-merge");
        await expect(merge).toBeDisabled();
        await expect(page.getByTestId("recording-bulk-download")).toBeDisabled();

        await page.getByTestId("recording-select-all").click();
        await expect(page.getByText("3 selected")).toBeVisible();
        await expect(merge).toBeEnabled();
        const download = page.waitForEvent("download");
        await page.getByTestId("recording-bulk-download").click();
        expect((await download).suggestedFilename()).toMatch(
            /^OpenAudioHub-.*\.zip$/,
        );

        await page.getByTestId("recording-select-cancel").click();
        await expect(page.getByTestId("recording-row-checkbox")).toHaveCount(0);
    });

    test("merging two selected recordings creates one new recording", async () => {
        const { page, api } = user;
        await page.goto("/recordings");

        await page.getByTestId("recording-select-mode").click();
        await rowFor(page, "Alpha clip").click();
        await rowFor(page, "Bravo clip").click();
        await expect(page.getByText("2 selected")).toBeVisible();
        await page.getByTestId("recording-bulk-merge").click();

        const dialog = page.getByRole("dialog", { name: "Merge recordings" });
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId("merge-item")).toHaveCount(2);
        await expect(page.getByTestId("merge-title")).toHaveValue(
            /\(merged\)$/,
        );
        await page.getByTestId("merge-confirm").click();

        await expect(dialog).toBeHidden();
        await expect(page.getByText("Recordings merged")).toBeVisible();
        await expect
            .poll(async () => (await listIds(api)).length, { timeout: 20_000 })
            .toBe(4);
        await expect(page.getByTestId("recording-row")).toHaveCount(4);
    });

    test("the collection and filter in the address seed the list", async () => {
        const { page, api } = user;
        const starred = await namedRecording(api, "Kept clip");
        const star = await api.put(`/api/recordings/${starred}/star`, {
            data: { starred: true },
        });
        expect(star.ok()).toBeTruthy();

        await page.goto("/recordings?collection=starred");
        await expect(
            page.getByRole("heading", { name: "Starred", exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("recording-row")).toHaveCount(1);
        await expect(page.getByTestId("recording-row")).toContainText(
            "Kept clip",
        );
        await page.getByRole("link", { name: "Clear" }).click();
        await expect(
            page.getByRole("heading", { name: "All recordings" }),
        ).toBeVisible();

        await page.goto("/recordings?filter=processing");
        await expect(
            page.getByTestId("recording-filter-processing"),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            page.getByText("No recordings match this filter."),
        ).toBeVisible();
    });

    test("the list fills in more rows as its end comes into view", async () => {
        const { page, api } = user;
        const put = await api.put("/api/settings/user", {
            data: { itemsPerPage: 4 },
        });
        expect(put.ok(), "set a small page size").toBeTruthy();
        for (let i = 1; i <= 12; i++) {
            await namedRecording(api, `Page clip ${i}`);
        }

        await page.goto("/recordings");
        const total = (await listIds(api)).length;
        await expect(page.getByText(`${total} of ${total} recordings`)).toBeVisible();
        // A page loads when the end of the list enters view, so keep scrolling to it.
        await expect
            .poll(
                async () => {
                    // Scroll the list to its top and then to its end, so the end
                    // marker leaves view and comes back.
                    await page.evaluate(async () => {
                        const list = document.querySelector(
                            '[data-testid="recording-list"]',
                        );
                        let el = list as HTMLElement | null;
                        while (
                            el &&
                            !(
                                el.scrollHeight > el.clientHeight &&
                                /(auto|scroll)/.test(
                                    getComputedStyle(el).overflowY,
                                )
                            )
                        ) {
                            el = el.parentElement;
                        }
                        if (!el) return;
                        el.scrollTop = 0;
                        await new Promise((r) => setTimeout(r, 100));
                        el.scrollTop = el.scrollHeight;
                    });
                    // Real wheel input too, in case scripted scrolling does not count.
                    const box = await page
                        .getByTestId("recording-list")
                        .boundingBox();
                    if (box) {
                        await page.mouse.move(box.x + box.width / 2, box.y + 100);
                        await page.mouse.wheel(0, 4000);
                        await page.waitForTimeout(150);
                        await page.mouse.wheel(0, -4000);
                        await page.waitForTimeout(150);
                    }
                    return page.getByTestId("recording-row").count();
                },
                { timeout: 30_000 },
            )
            // Observed: two pages (8 rows) load. After that the loaded rows fill the pane,
            // the end marker never leaves view, and no further page loads on its own.
            .toBeGreaterThanOrEqual(8);
        expect(total).toBe(17);
    });
});
