// Seeds the E2E account and six recordings (PLAN T0.7).
// The account, AI provider, API key, and webhook go through the running app's own
// routes. Recordings, transcripts, summaries, and pipeline jobs are written with the
// app's Drizzle schema and field encryption, so the app reads them as it reads user
// data. Requires the app on APP_URL and the fake AI server on FAKE_AI_BASE_URL.
// Idempotent: exits without changes when the account already has recordings.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
    aiEnhancements,
    audioPipelineJobs,
    recordings,
    transcriptions,
} from "@/db/schema";
import { encryptJsonField, encryptText } from "@/lib/encryption/fields";
import {
    type FixtureSegment,
    joinSegmentText,
    LONG_SEGMENTS,
    SHORT_SEGMENTS,
    SUMMARY,
    toTimeline,
} from "./e2e-fixtures";

const ROOT = resolve(import.meta.dir, "../..");

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `${name} must be set; run scripts/dev/e2e-prepare.ts first`,
        );
    }
    return value;
}

const APP_URL = requiredEnv("APP_URL");
const EMAIL = requiredEnv("E2E_EMAIL");
const PASSWORD = requiredEnv("E2E_PASSWORD");
const FAKE_AI_BASE_URL = requiredEnv("FAKE_AI_BASE_URL");
const STORAGE_ROOT = resolve(ROOT, requiredEnv("LOCAL_STORAGE_PATH"));
const FIXTURE_DIR = resolve(ROOT, ".dev-artifacts/e2e/fixtures");
const SAMPLE_AUDIO = resolve(ROOT, "src/tests/fixtures/sample.mp3");
const LONG_AUDIO_SECONDS = 600;

type JobSpec = {
    status: string;
    phase: string;
    progress: number;
    timestampSource: string | null;
};

type TranscriptSpec = {
    source: "openaudiohub" | "plaud";
    segments: FixtureSegment[];
    withTimeline: boolean;
};

type RecordingSpec = {
    key: string;
    filename: string;
    audio: "sample" | "long";
    daysAgo: number;
    transcript?: TranscriptSpec;
    extraTranscript?: TranscriptSpec;
    summary: boolean;
    job?: JobSpec;
};

const RECORDING_SPECS: RecordingSpec[] = [
    {
        key: "e2e-weekly-sync",
        filename: "Weekly team sync",
        extraTranscript: {
            source: "plaud",
            segments: SHORT_SEGMENTS,
            withTimeline: false,
        },
        audio: "sample",
        daysAgo: 1,
        transcript: {
            source: "openaudiohub",
            segments: SHORT_SEGMENTS,
            withTimeline: true,
        },
        summary: true,
        job: {
            status: "completed",
            phase: "completed",
            progress: 1,
            timestampSource: "native",
        },
    },
    {
        key: "e2e-long-lecture",
        filename: "Long lecture (10 min)",
        audio: "long",
        daysAgo: 2,
        transcript: {
            source: "openaudiohub",
            segments: LONG_SEGMENTS,
            withTimeline: true,
        },
        summary: true,
        job: {
            status: "completed",
            phase: "completed",
            progress: 1,
            timestampSource: "native",
        },
    },
    {
        key: "e2e-plaud-import",
        filename: "Plaud import draft",
        audio: "sample",
        daysAgo: 3,
        transcript: {
            source: "plaud",
            segments: SHORT_SEGMENTS,
            withTimeline: false,
        },
        summary: false,
    },
    {
        key: "e2e-needs-alignment",
        filename: "Needs alignment",
        audio: "sample",
        daysAgo: 4,
        transcript: {
            source: "openaudiohub",
            segments: SHORT_SEGMENTS,
            withTimeline: false,
        },
        summary: false,
        job: {
            status: "needs_alignment",
            phase: "needs_alignment",
            progress: 1,
            timestampSource: null,
        },
    },
    {
        key: "e2e-processing",
        filename: "Processing now",
        audio: "sample",
        daysAgo: 0,
        summary: false,
        job: {
            status: "running",
            phase: "transcribing",
            progress: 0.4,
            timestampSource: null,
        },
    },
    {
        key: "e2e-untranscribed",
        filename: "Untranscribed memo",
        audio: "sample",
        daysAgo: 5,
        summary: false,
    },
];

async function send(
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
    const headers: Record<string, string> = { origin: APP_URL };
    if (options.body !== undefined)
        headers["content-type"] = "application/json";
    if (options.cookie) headers.cookie = options.cookie;
    return fetch(`${APP_URL}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
            options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
    });
}

async function requireOk(response: Response, step: string): Promise<unknown> {
    if (!response.ok) {
        throw new Error(`${step} failed with HTTP ${response.status}`);
    }
    return response.json().catch(() => null);
}

async function signIn(): Promise<string> {
    // Sign-up may already have run in an earlier seed; sign-in decides whether
    // the account is usable.
    await send("/api/auth/sign-up/email", {
        method: "POST",
        body: { email: EMAIL, password: PASSWORD, name: "E2E User" },
    });
    const response = await send("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: EMAIL, password: PASSWORD },
    });
    await requireOk(response, "sign-in");
    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
}

async function currentUserId(cookie: string): Promise<string> {
    const response = await send("/api/auth/get-session", { cookie });
    const body = (await requireOk(response, "get-session")) as {
        user?: { id?: string };
    } | null;
    const id = body?.user?.id;
    if (!id) throw new Error("session did not return a user id");
    return id;
}

async function configureAccount(cookie: string): Promise<void> {
    await requireOk(
        await send("/api/settings/user", {
            method: "PUT",
            body: { onboardingCompleted: true },
            cookie,
        }),
        "complete onboarding",
    );
    await requireOk(
        await send("/api/settings/ai/providers", {
            method: "POST",
            body: {
                provider: "Custom",
                apiKey: "e2e-local-key",
                baseUrl: FAKE_AI_BASE_URL,
                defaultModel: "fake-whisper-1",
                isDefaultTranscription: true,
                isDefaultEnhancement: true,
            },
            cookie,
        }),
        "create AI provider",
    );
    await requireOk(
        await send("/api/settings/api-keys", {
            method: "POST",
            body: { name: "E2E key", expiresAt: null, scopes: ["read"] },
            cookie,
        }),
        "create API key",
    );
    const events = (
        (await requireOk(
            await send("/api/settings/webhooks", { cookie }),
            "list webhook events",
        )) as { events: string[] }
    ).events;
    await requireOk(
        await send("/api/settings/webhooks", {
            method: "POST",
            body: {
                url: "http://127.0.0.1:3299/webhook",
                events,
                description: "E2E webhook",
                enabled: true,
            },
            cookie,
        }),
        "create webhook",
    );
}

function ensureLongFixture(): string {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const target = join(FIXTURE_DIR, `long-${LONG_AUDIO_SECONDS}s.mp3`);
    if (!existsSync(target)) {
        execFileSync(
            "ffmpeg",
            [
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                `sine=frequency=220:duration=${LONG_AUDIO_SECONDS}`,
                "-ac",
                "1",
                "-b:a",
                "16k",
                target,
            ],
            { stdio: "inherit" },
        );
    }
    return target;
}

async function insertRecording(
    userId: string,
    spec: RecordingSpec,
): Promise<void> {
    const isLong = spec.audio === "long";
    const durationMs = isLong ? LONG_AUDIO_SECONDS * 1000 : 1000;
    const storagePath = `e2e/${spec.key}.mp3`;
    const destination = join(STORAGE_ROOT, storagePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(isLong ? ensureLongFixture() : SAMPLE_AUDIO, destination);

    const startTime = new Date(Date.now() - spec.daysAgo * 86_400_000);
    const [row] = await db
        .insert(recordings)
        .values({
            userId,
            deviceSn: "E2E-DEVICE",
            plaudFileId: spec.key,
            filename: encryptText(spec.filename),
            duration: durationMs,
            startTime,
            endTime: new Date(startTime.getTime() + durationMs),
            filesize: statSync(destination).size,
            fileMd5: createHash("md5")
                .update(readFileSync(destination))
                .digest("hex"),
            storageType: "local",
            storagePath,
            plaudVersion: "e2e",
        })
        .returning({ id: recordings.id });
    const recordingId = row.id;

    if (spec.transcript) {
        const { source, segments, withTimeline } = spec.transcript;
        await db.insert(transcriptions).values({
            recordingId,
            userId,
            text: encryptText(joinSegmentText(segments)),
            detectedLanguage: "en",
            transcriptionType: "server",
            provider: source === "plaud" ? "plaud" : "Custom",
            model: source === "plaud" ? "plaud-native" : "fake-whisper-1",
            timeline: withTimeline
                ? encryptJsonField(toTimeline(segments))
                : null,
            timelineSource: withTimeline ? "native" : null,
            source,
        });
    }

    if (spec.extraTranscript) {
        await db.insert(transcriptions).values({
            recordingId,
            userId,
            text: encryptText(joinSegmentText(spec.extraTranscript.segments)),
            detectedLanguage: "en",
            transcriptionType: "server",
            provider: "plaud",
            model: "plaud-native",
            timeline: null,
            timelineSource: null,
            source: spec.extraTranscript.source,
        });
    }

    if (spec.summary) {
        await db.insert(aiEnhancements).values({
            recordingId,
            userId,
            summary: encryptText(SUMMARY.summary),
            keyPoints: encryptJsonField(SUMMARY.keyPoints),
            actionItems: encryptJsonField(SUMMARY.actionItems),
            provider: "Custom",
            model: "fake-chat-1",
            source: "openaudiohub",
        });
    }

    if (spec.job) {
        await db.insert(audioPipelineJobs).values({
            userId,
            recordingId,
            generation: 1,
            providerId: null,
            provider: "Custom",
            model: "fake-whisper-1",
            language: "en",
            trigger: "manual",
            durationMs,
            status: spec.job.status,
            phase: spec.job.phase,
            progress: spec.job.progress,
            configSnapshot: {},
            timestampSource: spec.job.timestampSource,
            completedAt: spec.job.status === "completed" ? new Date() : null,
        });
    }
}

async function main(): Promise<void> {
    const cookie = await signIn();
    const userId = await currentUserId(cookie);

    const existing = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(eq(recordings.userId, userId))
        .limit(1);
    if (existing.length > 0) {
        console.log("e2e account already has recordings; nothing to seed");
        return;
    }

    await configureAccount(cookie);
    for (const spec of RECORDING_SPECS) {
        await insertRecording(userId, spec);
    }
    console.log(
        `seeded e2e account with ${RECORDING_SPECS.length} recordings, one AI provider, one API key, and one webhook`,
    );
}

main().then(
    () => process.exit(0),
    (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    },
);
