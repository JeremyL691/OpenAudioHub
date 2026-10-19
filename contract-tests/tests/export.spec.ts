import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonymousContext, newUserContext, uploadRecording } from "../helpers/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

test("backup routes are gone", async () => {
    const api = await newUserContext("no-backup");
    try {
        expect((await api.get("/api/backup")).status()).toBe(404);
        expect((await api.post("/api/backup")).status()).toBe(404);
        expect((await api.get("/api/backup/job_1")).status()).toBe(404);
        expect((await api.get("/api/backup/job_1/download")).status()).toBe(404);
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

test.describe.serial("deleted recordings", () => {
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
});
