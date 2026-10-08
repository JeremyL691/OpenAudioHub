// Detail-page check for the Docker smoke stack. Called by docker-smoke-flow.py.
// Opens the long recording as the smoke user, waits for audio metadata, checks the duration,
// clicks the transcript segment nearest 400 s, and checks that the audio seeks there and that
// exactly one segment is active. Reads its inputs from the environment and never prints the
// session cookie.
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const env = process.env;
const base = env.SMOKE_BASE_URL;
const recordingId = env.SMOKE_RECORDING_ID;
const outFile = env.SMOKE_OUT;
const shotFile = env.SMOKE_SHOT;
const TARGET_MS = 400_000;
const EXPECTED_SECONDS = 720;

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
});
await context.addCookies([
    { name: env.SMOKE_COOKIE_NAME, value: env.SMOKE_COOKIE_VALUE, url: base },
]);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
    if (message.type() === "error")
        consoleErrors.push(message.text().slice(0, 200));
});

let result = {};
let ok = false;
try {
    await page.goto(`${base}/recordings/${recordingId}`, {
        waitUntil: "domcontentloaded",
    });
    await page
        .getByTestId("player")
        .waitFor({ state: "visible", timeout: 60_000 });
    // A seek only takes effect once the audio element has its metadata.
    await page.waitForFunction(
        () => {
            const audio = document.querySelector("audio");
            return Boolean(audio && audio.readyState >= 1);
        },
        null,
        { timeout: 60_000 },
    );
    const duration = await page.locator("audio").evaluate((el) => el.duration);

    // The transcript loads after the page shell; read it only once it has rendered.
    const segments = page.getByTestId("transcript-segment");
    const segmentsStarted = Date.now();
    await segments
        .first()
        .waitFor({ state: "attached", timeout: 60_000 })
        .catch(() => {});
    const segmentWaitSeconds = (Date.now() - segmentsStarted) / 1000;
    const starts = await segments.evaluateAll((els) =>
        els.map((el) => Number(el.getAttribute("data-start-ms"))),
    );
    let index = 0;
    let best = Number.POSITIVE_INFINITY;
    starts.forEach((start, i) => {
        const distance = Math.abs(start - TARGET_MS);
        if (distance < best) {
            best = distance;
            index = i;
        }
    });
    const targetSeconds = (starts[index] ?? 0) / 1000;

    await segments.nth(index).click();
    await page
        .waitForFunction(
            (target) => {
                const audio = document.querySelector("audio");
                return Boolean(
                    audio && Math.abs(audio.currentTime - target) < 1,
                );
            },
            targetSeconds,
            { timeout: 15_000 },
        )
        .catch(() => {});
    await page
        .waitForFunction(
            () =>
                document.querySelectorAll(
                    '[data-testid="transcript-segment"][data-active="true"]',
                ).length === 1,
            null,
            { timeout: 5_000 },
        )
        .catch(() => {});

    const currentTime = await page
        .locator("audio")
        .evaluate((el) => el.currentTime);
    const activeCount = await page
        .locator('[data-testid="transcript-segment"][data-active="true"]')
        .count();
    // The waveform is decoded in the browser, and the label shows until that finishes.
    const analyzingStarted = Date.now();
    const analyzingCleared = await page
        .getByText("Analyzing audio")
        .waitFor({ state: "hidden", timeout: 90_000 })
        .then(
            () => true,
            () => false,
        );
    const analyzingSeconds = (Date.now() - analyzingStarted) / 1000;
    // The viewport is 1280 px wide, so any sideways scroll is overflow.
    const overflowPx = await page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
    );
    await page.screenshot({ path: shotFile });

    result = {
        duration,
        segmentCount: starts.length,
        firstStartMs: starts[0] ?? null,
        lastStartMs: starts[starts.length - 1] ?? null,
        seekTargetMs: starts[index] ?? null,
        currentTime,
        activeCount,
        segmentWaitSeconds: Math.round(segmentWaitSeconds * 10) / 10,
        overflowPx,
        analyzingCleared,
        analyzingSeconds: Math.round(analyzingSeconds * 10) / 10,
        consoleErrors,
    };
    ok =
        Math.abs(duration - EXPECTED_SECONDS) < 2 &&
        starts.length > 0 &&
        Math.abs(currentTime - targetSeconds) < 1 &&
        activeCount === 1 &&
        overflowPx <= 0;
} catch (error) {
    result = { error: String(error).slice(0, 400), consoleErrors };
} finally {
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    await browser.close();
}
process.exit(ok ? 0 : 1);
