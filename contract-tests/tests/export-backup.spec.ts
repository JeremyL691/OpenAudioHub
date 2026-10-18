import { type APIRequestContext, expect, test } from "@playwright/test";
import * as unzipper from "unzipper";
import {
    anonymousContext,
    fixture,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

const JOB_WAIT_MS = 180_000;
const POLL_MS = 3_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface Job {
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    expiresAt: string | null;
    recordingCount: number | null;
    fileSize: number | null;
    errorMessage: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startBackup(api: APIRequestContext) {
    const res = await api.post("/api/backup");
    const body = (await res.json()) as { job: Job };
    return { status: res.status(), job: body.job };
}

async function waitForJob(api: APIRequestContext, jobId: string): Promise<Job> {
    const deadline = Date.now() + JOB_WAIT_MS;
    for (;;) {
        const res = await api.get(`/api/backup/${jobId}`);
        expect(res.status()).toBe(200);
        const { job } = (await res.json()) as { job: Job };
        if (job.status === "completed" || job.status === "failed") return job;
        if (Date.now() > deadline) {
            throw new Error(`job ${jobId} still ${job.status} after wait`);
        }
        await sleep(POLL_MS);
    }
}

async function unpack(bytes: Buffer) {
    const dir = await unzipper.Open.buffer(bytes);
    const files = new Map<string, Buffer>();
    for (const f of dir.files) {
        if (f.type === "File") files.set(f.path, await f.buffer());
    }
    return files;
}

async function userIdOf(api: APIRequestContext): Promise<string> {
    const res = await api.get("/api/auth/get-session");
    const body = (await res.json()) as { user: { id: string } };
    return body.user.id;
}

function isoFolder(startTime: string, id: string): string {
    return `${startTime.replace(/[:.]/g, "-")}_${id}`;
}

test("json export is pretty-printed", async () => {
    const api = await newUserContext("export-pretty");
    try {
        await uploadRecording(api);
        const res = await api.get("/api/export?format=json");
        expect(res.status()).toBe(200);
        expect(await res.text()).toContain("\n  {\n");
    } finally {
        await api.dispose();
    }
});

test("json export lists the newest recording first", async () => {
    const api = await newUserContext("export-order");
    try {
        const older = await uploadRecording(api);
        await sleep(1100);
        const newer = await uploadRecording(api);
        const rows = (await (await api.get("/api/export?format=json")).json()) as { id: string }[];
        expect(rows.map((r) => r.id)).toEqual([newer, older]);
    } finally {
        await api.dispose();
    }
});

test.describe("GET /api/export formats", () => {
    let api: APIRequestContext;
    let recordingId: string;

    test.beforeAll(async () => {
        api = await newUserContext("export-formats");
        recordingId = await uploadRecording(api);
    });
    test.afterAll(async () => {
        await api.dispose();
    });

    test("without a session it is refused", async () => {
        const anon = await anonymousContext();
        const res = await anon.get("/api/export?format=json");
        expect(res.status()).toBe(401);
        const body = (await res.json()) as { code: string };
        expect(["AUTH_SESSION_MISSING", "UNAUTHORIZED"]).toContain(body.code);
        await anon.dispose();
    });

    test("json export lists each recording with the documented fields", async () => {
        const res = await api.get("/api/export?format=json");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/json");
        expect(res.headers()["content-disposition"]).toMatch(
            /^attachment; filename="recordings-\d{4}-\d{2}-\d{2}\.json"$/,
        );
        const rows = (await res.json()) as Record<string, unknown>[];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: recordingId,
            filename: expect.stringMatching(/^contract-/),
            transcription: null,
            summary: null,
        });
        for (const key of ["duration", "startTime", "filesize"]) {
            expect(rows[0]).toHaveProperty(key);
        }
    });

    test("txt export writes a block per recording", async () => {
        const res = await api.get("/api/export?format=txt");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/plain");
        expect(res.headers()["content-disposition"]).toMatch(
            /filename="recordings-\d{4}-\d{2}-\d{2}\.txt"$/,
        );
        expect(await res.text()).toMatch(
            /^contract-\d+-\d+\n\d{4}-\d{2}-\d{2}T[^\n]+Z\nNo transcription\n\n---\n\n$/,
        );
    });

    test("srt export has no cues when nothing is transcribed", async () => {
        const res = await api.get("/api/export?format=srt");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/plain");
        expect(res.headers()["content-disposition"]).toMatch(/\.srt"$/);
        expect(await res.text()).toBe("");
    });

    test("vtt export is only the header when nothing is transcribed", async () => {
        const res = await api.get("/api/export?format=vtt");
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/vtt");
        expect(res.headers()["content-disposition"]).toMatch(/\.vtt"$/);
        expect(await res.text()).toBe("WEBVTT\n\n");
    });

    test("an unknown format is refused", async () => {
        const res = await api.get("/api/export?format=pdf");
        expect(res.status()).toBe(400);
        const body = (await res.json()) as {
            code: string;
            details: { field: string };
        };
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details.field).toBe("format");
    });

    test("a backup folder that does not exist is refused", async () => {
        const res = await api.put("/api/settings/user", {
            data: { backupFolder: `/nonexistent-oah-${Date.now()}/backups` },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as {
            code: string;
            details: { field: string };
        };
        expect(body.code).toBe("INVALID_INPUT");
        expect(body.details.field).toBe("backupFolder");
    });
});

test("without a format the saved default applies, and an explicit format wins", async () => {
    const api = await newUserContext("export-default");
    try {
        await uploadRecording(api);
        const fresh = await api.get("/api/export");
        expect(fresh.headers()["content-type"]).toContain("application/json");

        const put = await api.put("/api/settings/user", {
            data: { defaultExportFormat: "txt" },
        });
        expect(put.ok()).toBeTruthy();

        const byDefault = await api.get("/api/export");
        expect(byDefault.headers()["content-type"]).toContain("text/plain");

        const empty = await api.get("/api/export?format=");
        expect(empty.headers()["content-type"]).toContain("text/plain");

        const explicit = await api.get("/api/export?format=json");
        expect(explicit.headers()["content-type"]).toContain("application/json");
    } finally {
        await api.dispose();
    }
});

test.describe.serial("deleted recordings and backups", () => {
    let api: APIRequestContext;
    let keepId: string;

    test.beforeAll(async () => {
        api = await newUserContext("export-deleted");
        keepId = await uploadRecording(api);
        const goneId = await uploadRecording(api);
        expect((await api.delete(`/api/recordings/${goneId}`)).ok()).toBeTruthy();
    });
    test.afterAll(async () => {
        await api.dispose();
    });

    test("deleted recordings are left out of the export", async () => {
        const rows = (await (await api.get("/api/export?format=json")).json()) as {
            id: string;
        }[];
        expect(rows.map((r) => r.id)).toEqual([keepId]);
    });

    test("deleted recordings are left out of the archive", async () => {
        test.setTimeout(JOB_WAIT_MS + 30_000);
        const { job } = await startBackup(api);
        const done = await waitForJob(api, job.id);
        expect(done.status).toBe("completed");
        expect(done.recordingCount).toBe(1);
        const res = await api.get(`/api/backup/${job.id}/download`);
        const manifest = JSON.parse(
            (await unpack(await res.body())).get("manifest.json")!.toString("utf-8"),
        ) as { recordings: { id: string }[] };
        expect(manifest.recordings.map((r) => r.id)).toEqual([keepId]);
    });
});

test.describe.serial("backup jobs and archive", () => {
    let api: APIRequestContext;
    let jobId: string;

    test.beforeAll(async () => {
        api = await newUserContext("backup-jobs");
        await uploadRecording(api);
    });
    test.afterAll(async () => {
        await api.dispose();
    });

    test("starting a backup queues a pending job", async () => {
        const { status, job } = await startBackup(api);
        expect(status).toBe(202);
        expect(job.id).toEqual(expect.any(String));
        expect(job.status).toBe("pending");
        expect(job.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(job.completedAt).toBeNull();
        expect(job.expiresAt).toBeNull();
        expect(job.errorMessage).toBeNull();
        jobId = job.id;
    });

    test("a second start while a job is active returns that same job", async () => {
        const second = await startBackup(api);
        expect(second.job.id).toBe(jobId);
        // 202 while still active; 200 if it finished in between (cooldown reply).
        expect([200, 202]).toContain(second.status);
    });

    test("download before the job finishes is refused", async () => {
        const res = await api.get(`/api/backup/${jobId}/download`);
        // Usually 409. The worker may finish first, in which case the zip is served.
        expect([200, 409]).toContain(res.status());
        if (res.status() === 409) {
            expect(((await res.json()) as { code: string }).code).toBe("CONFLICT");
        }
    });

    test("a job completes with its archive metadata", async () => {
        test.setTimeout(JOB_WAIT_MS + 30_000);
        const done = await waitForJob(api, jobId);
        expect(done.status).toBe("completed");
        expect(done.errorMessage).toBeNull();
        expect(done.recordingCount).toBe(1);
        expect(done.fileSize).toBeGreaterThan(0);
        expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(
            Date.parse(done.expiresAt as string) - Date.parse(done.completedAt as string),
        ).toBe(SEVEN_DAYS_MS);
    });

    test("the job list shows the job", async () => {
        const res = await api.get("/api/backup");
        expect(res.status()).toBe(200);
        const { jobs } = (await res.json()) as { jobs: Job[] };
        expect(jobs[0].id).toBe(jobId);
        expect(jobs[0].status).toBe("completed");
    });

    test("a start within the cooldown returns the finished job, not a new one", async () => {
        const again = await startBackup(api);
        expect(again.status).toBe(200);
        expect(again.job.id).toBe(jobId);
        expect(again.job.status).toBe("completed");
    });

    test("an unknown job id is not found", async () => {
        const res = await api.get("/api/backup/does-not-exist");
        expect(res.status()).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
    });

    test("another user cannot see or download the job", async () => {
        const other = await newUserContext("backup-other");
        try {
            const status = await other.get(`/api/backup/${jobId}`);
            expect(status.status()).toBe(404);
            expect(((await status.json()) as { code: string }).code).toBe("NOT_FOUND");
            expect((await other.get(`/api/backup/${jobId}/download`)).status()).toBe(404);
            const list = (await (await other.get("/api/backup")).json()) as { jobs: Job[] };
            expect(list.jobs.map((j) => j.id)).not.toContain(jobId);
        } finally {
            await other.dispose();
        }
    });

    test("download sends the zip with attachment headers", async () => {
        const res = await api.get(`/api/backup/${jobId}/download`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toContain("application/zip");
        expect(res.headers()["content-disposition"]).toBe(
            `attachment; filename="openaudiohub-export-${jobId}.zip"`,
        );
        const bytes = await res.body();
        const job = (await (await api.get(`/api/backup/${jobId}`)).json()) as { job: Job };
        expect(bytes.length).toBe(job.job.fileSize);
        expect(Number(res.headers()["content-length"])).toBe(job.job.fileSize);
    });

    test("archive holds a manifest and one folder per recording with the audio", async () => {
        const res = await api.get(`/api/backup/${jobId}/download`);
        const files = await unpack(await res.body());
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf-8")) as {
            version: string;
            userId: string;
            audio_complete: boolean;
            missing_audio_count: number;
            recordings: {
                id: string;
                filename: string;
                startTime: string;
                endTime: string;
                duration: number;
                filesize: number;
                deviceSn: string;
                audio: { included: boolean; path: string | null };
                transcript: { included: boolean; path: string | null };
                timeline: { included: boolean; path: string | null };
                summary: { included: boolean; path: string | null };
            }[];
        };
        expect(manifest.version).toBe("2.0");
        expect(manifest.userId).toBe(await userIdOf(api));
        expect(manifest.audio_complete).toBe(true);
        expect(manifest.missing_audio_count).toBe(0);
        expect(manifest.recordings).toHaveLength(1);

        const entry = manifest.recordings[0];
        expect(entry.filename).toMatch(/^contract-/);
        expect(typeof entry.duration).toBe("number");
        expect(typeof entry.filesize).toBe("number");
        expect(entry.endTime).toMatch(/Z$/);
        expect(entry.audio.included).toBe(true);
        expect(entry.transcript).toEqual({ included: false, path: null });
        expect(entry.timeline).toEqual({ included: false, path: null });
        expect(entry.summary).toEqual({ included: false, path: null });

        const folder = isoFolder(entry.startTime, entry.id);
        expect(entry.audio.path).toBe(`${folder}/audio.mp3`);
        expect(files.get(`${folder}/audio.mp3`)!.equals(fixture("tone-3s.mp3"))).toBe(true);
        expect(files.has(`${folder}/transcript.txt`)).toBe(false);
        expect(files.has(`${folder}/summary.json`)).toBe(false);
        expect(files.has(`${folder}/timeline.json`)).toBe(false);
    });
});

test("an account with no recordings still gets a valid archive", async () => {
    test.setTimeout(JOB_WAIT_MS + 30_000);
    const api = await newUserContext("archive-empty");
    try {
        const { job } = await startBackup(api);
        const done = await waitForJob(api, job.id);
        expect(done.status).toBe("completed");
        expect(done.recordingCount).toBe(0);
        const files = await unpack(
            await (await api.get(`/api/backup/${job.id}/download`)).body(),
        );
        expect([...files.keys()]).toEqual(["manifest.json"]);
        const manifest = JSON.parse(files.get("manifest.json")!.toString("utf-8")) as {
            recordings: unknown[];
            audio_complete: boolean;
        };
        expect(manifest.recordings).toEqual([]);
        expect(manifest.audio_complete).toBe(true);
    } finally {
        await api.dispose();
    }
});

test.describe("scheduled backups", () => {
    // Scheduled jobs are queued only by the desktop build, which the shared test server is not.
    test("a due daily schedule queues a backup without a request @desktop-only", async () => {
        test.skip(
            !process.env.OAH_DESKTOP_TARGET,
            "scheduled backups run only in the desktop build (set OAH_DESKTOP_TARGET for a desktop-mode server)",
        );
        test.setTimeout(JOB_WAIT_MS + 60_000);
        const api = await newUserContext("backup-schedule");
        try {
            await uploadRecording(api);
            const put = await api.put("/api/settings/user", {
                data: { backupFrequency: "daily" },
            });
            expect(put.ok()).toBeTruthy();
            const deadline = Date.now() + JOB_WAIT_MS;
            for (;;) {
                const { jobs } = (await (await api.get("/api/backup")).json()) as { jobs: Job[] };
                if (jobs.length > 0) {
                    expect(jobs.length).toBe(1);
                    return;
                }
                if (Date.now() > deadline) throw new Error("no scheduled job appeared");
                await sleep(POLL_MS);
            }
        } finally {
            await api.dispose();
        }
    });
});
