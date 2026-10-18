import { createHash } from "node:crypto";
import { type APIRequestContext, expect, request } from "@playwright/test";
import { fixture, freshCredentials } from "./api";

/**
 * The upload response carries only `{ success, filename }`, so the id is found
 * by listing the caller's recordings. Give each upload a unique basename.
 */
export async function uploadUnique(
    api: APIRequestContext,
    fixtureName: string,
    mimeType: string,
    label = "rec",
): Promise<{ id: string; filename: string; buffer: Buffer }> {
    const basename = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ext = fixtureName.slice(fixtureName.lastIndexOf("."));
    const buffer = fixture(fixtureName);
    const res = await api.post("/api/recordings/upload", {
        multipart: {
            file: { name: `${basename}${ext}`, mimeType, buffer },
        },
    });
    expect(res.status(), "upload").toBe(200);
    const body = (await res.json()) as { success: boolean; filename: string };
    expect(body.success).toBe(true);
    expect(body.filename).toBe(basename);
    const list = await listRecordings(api);
    const found = list.find((r) => r.filename === basename);
    expect(found, "uploaded recording is listed").toBeTruthy();
    return { id: found!.id, filename: basename, buffer };
}

export interface RecordingRow {
    id: string;
    filename: string;
    duration: number;
    startTime: string;
    starredAt: string | null;
    waveformPeaks: number[] | null;
    storagePath: string;
    endTime: string;
    [key: string]: unknown;
}

export async function listRecordings(
    api: APIRequestContext,
): Promise<RecordingRow[]> {
    const res = await api.get("/api/recordings");
    expect(res.status()).toBe(200);
    return ((await res.json()) as { recordings: RecordingRow[] }).recordings;
}

export async function getRecording(
    api: APIRequestContext,
    id: string,
): Promise<RecordingRow> {
    const res = await api.get(`/api/recordings/${id}`);
    expect(res.status(), `detail ${id}`).toBe(200);
    return ((await res.json()) as { recording: RecordingRow }).recording;
}

export function md5(buffer: Buffer): string {
    return createHash("md5").update(buffer).digest("hex");
}

/** A list of `count` peak values, all `value`. */
export function peaks(count: number, value = 0.5): number[] {
    return Array.from({ length: count }, () => value);
}

/**
 * A signed-up user context. Sign-up alone starts the session, so this avoids
 * the separate sign-in call that the shared auth rate limit throttles.
 * Retries while the per-IP sign-up limit is hit.
 */
export async function signUpWithRetry(
    label: string,
): Promise<APIRequestContext> {
    const baseURL = process.env.OAH_BASE_URL ?? "http://localhost:3210";
    const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: { origin: baseURL },
    });
    const who = freshCredentials(label);
    for (let attempt = 0; attempt < 12; attempt++) {
        const res = await api.post("/api/auth/sign-up/email", { data: who });
        if (res.status() !== 429) {
            expect(res.ok(), `sign-up ${label}`).toBeTruthy();
            return api;
        }
        await new Promise((resolve) => setTimeout(resolve, 7000));
    }
    throw new Error(`sign-up for ${label} stayed rate limited`);
}
