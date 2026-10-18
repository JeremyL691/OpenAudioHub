import { type APIRequestContext, expect, test } from "@playwright/test";
import { anonymousContext, fixture } from "../helpers/api";
import {
    getRecording,
    listRecordings,
    md5,
    peaks,
    signUpWithRetry,
    uploadUnique,
} from "../helpers/recordings-extra";

// Private audio is cacheable by the browser only, never by shared caches.
const AUDIO_CACHE = "private, max-age=31536000, immutable";

/**
 * Two accounts shared by the whole file. Sign-up is limited per IP, so the file
 * creates no more than these two; every test uploads its own recordings.
 */
let shared: Promise<{ owner: APIRequestContext; other: APIRequestContext }> | undefined;
function people() {
    shared ??= Promise.all([signUpWithRetry("rec-owner"), signUpWithRetry("rec-other")]).then(
        ([owner, other]) => ({ owner, other }),
    );
    return shared;
}
test.afterAll(async () => {
    if (!shared) return;
    const { owner, other } = await shared;
    await Promise.all([owner.dispose(), other.dispose()]);
});

const MP3 = { file: "tone-3s.mp3", mime: "audio/mpeg" };
const WAV = { file: "tone-2s.wav", mime: "audio/wav" };

/** Entry names and bodies of a ZIP written with the "store" method, read from its central directory. */
function zipEntries(buf: Buffer): { name: string; body: Buffer }[] {
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    const out: { name: string; body: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
        const size = buf.readUInt32LE(at + 20);
        const nameLen = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const commentLen = buf.readUInt16LE(at + 32);
        const local = buf.readUInt32LE(at + 42);
        const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
        const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        out.push({ name, body: buf.subarray(dataStart, dataStart + size) });
        at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

test.describe("recordings: auth", () => {
    test("every recordings route refuses an anonymous caller with 401", async () => {
        const api = await anonymousContext();
        const id = "anonymousprobe0000001";
        const calls: [string, () => Promise<{ status(): number; json(): Promise<unknown> }>][] = [
            ["list", () => api.get("/api/recordings")],
            ["detail", () => api.get(`/api/recordings/${id}`)],
            ["patch", () => api.patch(`/api/recordings/${id}`, { data: { filename: "x" } })],
            ["delete", () => api.delete(`/api/recordings/${id}`)],
            ["star", () => api.put(`/api/recordings/${id}/star`, { data: { starred: true } })],
            ["audio", () => api.get(`/api/recordings/${id}/audio`)],
            ["peaks", () => api.post(`/api/recordings/${id}/peaks`, { data: { peaks: peaks(40) } })],
            ["merge", () => api.post("/api/recordings/merge", { data: { ids: [id, id + "b"] } })],
            ["download", () => api.get(`/api/recordings/download?ids=${id}`)],
            ["upload", () => api.post("/api/recordings/upload", { multipart: { file: { name: "a.mp3", mimeType: "audio/mpeg", buffer: fixture(MP3.file) } } })],
        ];
        for (const [name, call] of calls) {
            const res = await call();
            expect(res.status(), name).toBe(401);
            expect(await res.json(), name).toMatchObject({ code: "AUTH_SESSION_MISSING" });
        }
        await api.dispose();
    });
});

test.describe("recordings: list and detail", () => {
    let api: APIRequestContext;
    let first: { id: string; filename: string };
    let second: { id: string; filename: string };

    test.beforeAll(async () => {
        api = (await people()).owner;
        first = await uploadUnique(api, MP3.file, MP3.mime, "list-a");
        second = await uploadUnique(api, WAV.file, WAV.mime, "list-b");
    });

    test("list returns the caller's recordings with the full row fields", async () => {
        const rows = await listRecordings(api);
        const row = rows.find((r) => r.id === first.id);
        expect(row).toBeTruthy();
        expect(row).toMatchObject({
            filename: first.filename,
            storageType: "local",
            plaudVersion: "1",
            deletedAt: null,
            starredAt: null,
            waveformPeaks: null,
            isTrash: false,
        });
        for (const key of ["id", "userId", "duration", "startTime", "endTime", "filesize", "fileMd5", "storagePath", "createdAt", "updatedAt"]) {
            expect(row, key).toHaveProperty(key);
        }
    });

    test("list is ordered by start time, newest first", async () => {
        const rows = await listRecordings(api);
        const ids = rows.map((r) => r.id);
        expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
        const times = rows.map((r) => Date.parse(r.startTime));
        for (let i = 1; i < times.length; i++) {
            expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
        }
    });

    test("list ignores paging and filter query parameters", async () => {
        const res = await api.get("/api/recordings?limit=1&cursor=zzz&has_transcription=true");
        expect(res.status()).toBe(200);
        const ids = ((await res.json()) as { recordings: { id: string }[] }).recordings.map((r) => r.id);
        expect(ids).toContain(first.id);
        expect(ids).toContain(second.id);
    });

    test("detail returns the recording and a null transcription when none exists", async () => {
        const res = await api.get(`/api/recordings/${first.id}`);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { recording: { id: string; filename: string }; transcription: unknown };
        expect(body.recording.id).toBe(first.id);
        expect(body.recording.filename).toBe(first.filename);
        expect(body.transcription).toBeNull();
    });

    test("detail of an unknown id returns 404 RECORDING_NOT_FOUND", async () => {
        const res = await api.get("/api/recordings/does-not-exist-000001");
        expect(res.status()).toBe(404);
        expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND", error: "Recording not found" });
    });
});

test.describe("recordings: edit (PATCH)", () => {
    let api: APIRequestContext;
    let id: string;

    test.beforeAll(async () => {
        api = (await people()).owner;
        id = (await uploadUnique(api, MP3.file, MP3.mime, "edit")).id;
    });

    test("rename trims whitespace, removes control characters, and returns the new name", async () => {
        const res = await api.patch(`/api/recordings/${id}`, {
            data: { filename: "  Renamed \u0001 Title  " },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ filename: "Renamed  Title" });
        expect((await getRecording(api, id)).filename).toBe("Renamed  Title");
    });

    test("a name of exactly 200 characters is accepted", async () => {
        const name = "b".repeat(200);
        const res = await api.patch(`/api/recordings/${id}`, { data: { filename: name } });
        expect(res.status()).toBe(200);
        expect((await getRecording(api, id)).filename).toBe(name);
    });

    test("a name that is empty after cleanup is rejected", async () => {
        const res = await api.patch(`/api/recordings/${id}`, { data: { filename: "  \u0001 " } });
        expect(res.status()).toBe(400);
        expect(await res.json()).toEqual({
            error: "Name cannot be empty",
            code: "INVALID_INPUT",
            details: { field: "filename" },
        });
    });

    test("a name longer than 200 characters is rejected", async () => {
        const res = await api.patch(`/api/recordings/${id}`, { data: { filename: "c".repeat(201) } });
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({
            code: "INVALID_INPUT",
            details: { field: "filename", maxLength: 200 },
        });
    });

    test("a non-string filename is rejected", async () => {
        const res = await api.patch(`/api/recordings/${id}`, { data: { filename: 5 } });
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({
            error: "filename must be a string",
            code: "INVALID_INPUT",
            details: { field: "filename" },
        });
    });

    test("a rename of another user's recording returns 404 and changes nothing", async () => {
        const other = (await people()).other;
            const before = (await getRecording(api, id)).filename;
            const res = await other.patch(`/api/recordings/${id}`, { data: { filename: "hijack" } });
            expect(res.status()).toBe(404);
            expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
            expect((await getRecording(api, id)).filename).toBe(before);
    });
});

test.describe("recordings: star", () => {
    let api: APIRequestContext;
    let id: string;

    test.beforeAll(async () => {
        api = (await people()).owner;
        id = (await uploadUnique(api, MP3.file, MP3.mime, "star")).id;
    });

    test("starring sets starredAt and returns the new state", async () => {
        const res = await api.put(`/api/recordings/${id}/star`, { data: { starred: true } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ id, starred: true });
        expect((await getRecording(api, id)).starredAt).not.toBeNull();
    });

    test("starring again keeps the original star time", async () => {
        const before = (await getRecording(api, id)).starredAt;
        await new Promise((r) => setTimeout(r, 1100));
        const res = await api.put(`/api/recordings/${id}/star`, { data: { starred: true } });
        expect(res.status()).toBe(200);
        expect((await getRecording(api, id)).starredAt).toBe(before);
    });

    test("unstarring clears starredAt", async () => {
        const res = await api.put(`/api/recordings/${id}/star`, { data: { starred: false } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ id, starred: false });
        expect((await getRecording(api, id)).starredAt).toBeNull();
    });

    test("a non-boolean starred value is rejected", async () => {
        const res = await api.put(`/api/recordings/${id}/star`, { data: { starred: "yes" } });
        expect(res.status()).toBe(400);
        expect(await res.json()).toEqual({
            error: "starred must be a boolean",
            code: "INVALID_INPUT",
            details: { field: "starred" },
        });
    });

    test("starring another user's recording returns 404", async () => {
        const other = (await people()).other;
            const res = await other.put(`/api/recordings/${id}/star`, { data: { starred: true } });
            expect(res.status()).toBe(404);
            expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
            expect((await getRecording(api, id)).starredAt).toBeNull();
    });
});

test.describe("recordings: delete", () => {
    let api: APIRequestContext;

    test.beforeAll(async () => {
        api = (await people()).owner;
    });

    test("delete removes the recording from every read and write path", async () => {
        const { id } = await uploadUnique(api, MP3.file, MP3.mime, "gone");
        const res = await api.delete(`/api/recordings/${id}`);
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });

        expect((await api.get(`/api/recordings/${id}`)).status()).toBe(404);
        expect((await api.get(`/api/recordings/${id}/audio`)).status()).toBe(404);
        expect((await api.patch(`/api/recordings/${id}`, { data: { filename: "x" } })).status()).toBe(404);
        expect((await api.put(`/api/recordings/${id}/star`, { data: { starred: true } })).status()).toBe(404);
        expect((await api.post(`/api/recordings/${id}/peaks`, { data: { peaks: peaks(40) } })).status()).toBe(404);
        expect((await api.get(`/api/recordings/download?ids=${id}&format=original`)).status()).toBe(404);
        expect((await api.post("/api/recordings/merge", { data: { ids: [id, id + "x"] } })).status()).toBe(404);

        const rows = await listRecordings(api);
        expect(rows.map((r) => r.id)).not.toContain(id);
    });

    test("deleting twice returns 404 the second time", async () => {
        const { id } = await uploadUnique(api, MP3.file, MP3.mime, "twice");
        expect((await api.delete(`/api/recordings/${id}`)).status()).toBe(200);
        const again = await api.delete(`/api/recordings/${id}`);
        expect(again.status()).toBe(404);
        expect(await again.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
    });

    test("deleting another user's recording returns 404 and keeps the owner's copy", async () => {
        const owner = (await people()).other;
            const { id } = await uploadUnique(owner, MP3.file, MP3.mime, "keep");
            const res = await api.delete(`/api/recordings/${id}`);
            expect(res.status()).toBe(404);
            expect((await owner.get(`/api/recordings/${id}`)).status()).toBe(200);
    });
});

test.describe("recordings: upload", () => {
    let api: APIRequestContext;

    test.beforeAll(async () => {
        api = (await people()).owner;
    });

    test("an mp3 upload is stored with its checksum, size, and probed duration", async () => {
        const name = `upload-mp3-${Date.now()}`;
        const res = await api.post("/api/recordings/upload", {
            multipart: { file: { name: `${name}.mp3`, mimeType: "audio/mpeg", buffer: fixture(MP3.file) } },
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true, filename: name });

        const row = (await listRecordings(api)).find((r) => r.filename === name)!;
        expect(row).toBeTruthy();
        const detail = await getRecording(api, row.id);
        expect(detail.filesize).toBe(fixture(MP3.file).length);
        expect(detail.fileMd5).toBe(md5(fixture(MP3.file)));
        expect(detail.duration).toBeGreaterThanOrEqual(2900);
        expect(detail.duration).toBeLessThanOrEqual(3200);
        expect(detail.storagePath.endsWith(".mp3")).toBe(true);
        expect(Date.parse(detail.endTime) - Date.parse(detail.startTime)).toBe(detail.duration);
    });

    test("a wav upload is accepted and streams back as audio/wav", async () => {
        const { id } = await uploadUnique(api, WAV.file, WAV.mime, "wavup");
        const res = await api.get(`/api/recordings/${id}/audio`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("audio/wav");
    });

    test("the extension check ignores case", async () => {
        const name = `upper-${Date.now()}`;
        const res = await api.post("/api/recordings/upload", {
            multipart: { file: { name: `${name}.MP3`, mimeType: "audio/mpeg", buffer: fixture(MP3.file) } },
        });
        expect(res.status()).toBe(200);
    });

    test("an unsupported extension is rejected with the accepted list", async () => {
        const res = await api.post("/api/recordings/upload", {
            multipart: { file: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
        });
        expect(res.status()).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("INVALID_FILE_FORMAT");
        for (const ext of [".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".opus", ".webm", ".aac", ".flac"]) {
            expect(body.error).toContain(ext);
        }
    });

    test("a request without a file field is rejected", async () => {
        const res = await api.post("/api/recordings/upload", {
            multipart: { other: "1" },
        });
        expect(res.status()).toBe(400);
        expect(await res.json()).toEqual({
            error: "No file provided",
            code: "MISSING_REQUIRED_FIELD",
            details: { field: "file" },
        });
    });

    test("a file with an audio extension but no decodable audio is rejected with 422", async () => {
        const res = await api.post("/api/recordings/upload", {
            multipart: { file: { name: "fake.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("not audio at all, just text") } },
        });
        expect(res.status()).toBe(422);
        expect(await res.json()).toMatchObject({
            error: "File does not contain a valid audio stream",
            code: "INVALID_FILE_FORMAT",
        });
    });

    test("the uploaded recording is private to its owner", async () => {
        const other = (await people()).other;
            const { id } = await uploadUnique(api, MP3.file, MP3.mime, "private");
            expect((await other.get(`/api/recordings/${id}`)).status()).toBe(404);
            expect((await listRecordings(other)).map((r) => r.id)).not.toContain(id);
    });
});

test.describe("recordings: audio streaming", () => {
    let api: APIRequestContext;
    let mp3Id: string;
    let wavId: string;
    let mp3: Buffer;

    test.beforeAll(async () => {
        mp3 = fixture(MP3.file);
        api = (await people()).owner;
        mp3Id = (await uploadUnique(api, MP3.file, MP3.mime, "stream-mp3")).id;
        wavId = (await uploadUnique(api, WAV.file, WAV.mime, "stream-wav")).id;
    });

    test("a full request returns the bytes with type, length, range and cache headers", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`);
        expect(res.status()).toBe(200);
        const h = res.headers();
        expect(h["content-type"]).toBe("audio/mpeg");
        expect(h["content-length"]).toBe(String(mp3.length));
        expect(h["accept-ranges"]).toBe("bytes");
        expect(h["cache-control"]).toBe(AUDIO_CACHE);
        expect(Buffer.from(await res.body()).equals(mp3)).toBe(true);
    });

    test("a bounded range returns 206 with the matching slice", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: "bytes=0-99" } });
        expect(res.status()).toBe(206);
        const h = res.headers();
        expect(h["content-range"]).toBe(`bytes 0-99/${mp3.length}`);
        expect(h["content-length"]).toBe("100");
        expect(h["accept-ranges"]).toBe("bytes");
        expect(h["content-type"]).toBe("audio/mpeg");
        expect(h["cache-control"]).toBe(AUDIO_CACHE);
        expect(Buffer.from(await res.body()).equals(mp3.subarray(0, 100))).toBe(true);
    });

    test("an open-ended range runs to the last byte", async () => {
        const start = 100;
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: `bytes=${start}-` } });
        expect(res.status()).toBe(206);
        expect(res.headers()["content-range"]).toBe(`bytes ${start}-${mp3.length - 1}/${mp3.length}`);
        expect(Buffer.from(await res.body()).equals(mp3.subarray(start))).toBe(true);
    });

    test("a range starting past the end returns 416 with the total size", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: "bytes=999999-" } });
        expect(res.status()).toBe(416);
        expect(res.headers()["content-range"]).toBe(`bytes */${mp3.length}`);
    });

    test("a range whose start is after its end returns 416", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: "bytes=10-5" } });
        expect(res.status()).toBe(416);
        expect(res.headers()["content-range"]).toBe(`bytes */${mp3.length}`);
    });

    test("a range whose end is past the last byte returns 416, not a clamped 206", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: "bytes=0-999999" } });
        expect(res.status()).toBe(416);
        expect(res.headers()["content-range"]).toBe(`bytes */${mp3.length}`);
    });

    test("a suffix range (bytes=-N) is not honored and returns the full file", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio`, { headers: { range: "bytes=-100" } });
        expect(res.status()).toBe(200);
        expect(res.headers()["content-length"]).toBe(String(mp3.length));
    });

    test("download=1 on an mp3 sends the file as an attachment with a no-store cache policy", async () => {
        const res = await api.get(`/api/recordings/${mp3Id}/audio?download=1`);
        expect(res.status()).toBe(200);
        const h = res.headers();
        expect(h["content-type"]).toBe("audio/mpeg");
        expect(h["content-disposition"]).toMatch(/^attachment; filename="/);
        expect(h["content-disposition"]).toContain(".mp3");
        expect(h["cache-control"]).toBe("private, no-store");
        expect(Buffer.from(await res.body()).equals(mp3)).toBe(true);
    });

    test("download=1 on a wav sends an mp3 named after the recording", async () => {
        const detail = await getRecording(api, wavId);
        const res = await api.get(`/api/recordings/${wavId}/audio?download=1`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("audio/mpeg");
        expect(decodeURIComponent(res.headers()["content-disposition"].split("filename*=UTF-8''")[1])).toBe(
            `${detail.filename}.mp3`,
        );
        const body = Buffer.from(await res.body());
        const isMp3 = body.subarray(0, 3).toString("ascii") === "ID3" || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
        expect(isMp3).toBe(true);
    });

    test("another user cannot stream the recording", async () => {
        const other = (await people()).other;
            expect((await other.get(`/api/recordings/${mp3Id}/audio`)).status()).toBe(404);
            expect((await other.get(`/api/recordings/${mp3Id}/audio?download=1`)).status()).toBe(404);
    });
});

test.describe("recordings: waveform peaks", () => {
    let api: APIRequestContext;
    let id: string;

    test.beforeAll(async () => {
        api = (await people()).owner;
        id = (await uploadUnique(api, MP3.file, MP3.mime, "peaks")).id;
    });

    test("the first valid peaks are stored, rounded to three decimals", async () => {
        const values = peaks(39, 0.5);
        values.push(0.1234567);
        const res = await api.post(`/api/recordings/${id}/peaks`, { data: { peaks: values } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ stored: true });
        const stored = (await getRecording(api, id)).waveformPeaks!;
        expect(stored).toHaveLength(40);
        expect(stored[39]).toBe(0.123);
    });

    test("a second post is a no-op and the first peaks are kept", async () => {
        const res = await api.post(`/api/recordings/${id}/peaks`, { data: { peaks: peaks(40, 0.9) } });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ stored: false });
        expect((await getRecording(api, id)).waveformPeaks![0]).toBe(0.5);
    });

    test("peaks with fewer than 32 or more than 2048 values are rejected", async () => {
        const fresh = (await uploadUnique(api, MP3.file, MP3.mime, "peaks-len")).id;
        for (const count of [31, 2049]) {
            const res = await api.post(`/api/recordings/${fresh}/peaks`, { data: { peaks: peaks(count) } });
            expect(res.status(), `count ${count}`).toBe(400);
            expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
        }
        const edge = await api.post(`/api/recordings/${fresh}/peaks`, { data: { peaks: peaks(2048) } });
        expect(edge.status()).toBe(200);
    });

    test("values outside [0, 1] or not numbers are rejected", async () => {
        const fresh = (await uploadUnique(api, MP3.file, MP3.mime, "peaks-val")).id;
        const bad = [
            [...peaks(39), 1.5],
            [...peaks(39), -0.1],
            [...peaks(39), "0.5"],
            [...peaks(39), null],
        ];
        for (const values of bad) {
            const res = await api.post(`/api/recordings/${fresh}/peaks`, { data: { peaks: values } });
            expect(res.status()).toBe(400);
            expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
        }
    });

    test("a body without a peaks array, or invalid JSON, is rejected", async () => {
        const fresh = (await uploadUnique(api, MP3.file, MP3.mime, "peaks-body")).id;
        const noArray = await api.post(`/api/recordings/${fresh}/peaks`, { data: { peaks: "abc" } });
        expect(noArray.status()).toBe(400);
        expect(await noArray.json()).toMatchObject({ error: "Expected { peaks: number[] }" });
        const notJson = await api.post(`/api/recordings/${fresh}/peaks`, {
            headers: { "content-type": "application/json" },
            data: "{not json",
        });
        expect(notJson.status()).toBe(400);
        expect(await notJson.json()).toMatchObject({ code: "INVALID_INPUT" });
    });

    test("peaks for another user's recording return 404", async () => {
        const other = (await people()).other;
            const res = await other.post(`/api/recordings/${id}/peaks`, { data: { peaks: peaks(40) } });
            expect(res.status()).toBe(404);
            expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
    });
});

test.describe("recordings: batch download", () => {
    let api: APIRequestContext;
    let a: string;
    let b: string;
    let sameName1: string;
    let sameName2: string;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        api = (await people()).owner;
        a = (await uploadUnique(api, MP3.file, MP3.mime, "dl-a")).id;
        b = (await uploadUnique(api, WAV.file, WAV.mime, "dl-b")).id;
        const twin = `twin-${Date.now()}`;
        sameName1 = await uploadSameName(twin);
        sameName2 = await uploadSameName(twin);
        async function uploadSameName(name: string): Promise<string> {
            const before = new Set((await listRecordings(api)).map((r) => r.id));
            const res = await api.post("/api/recordings/upload", {
                multipart: { file: { name: `${name}.mp3`, mimeType: "audio/mpeg", buffer: fixture(MP3.file) } },
            });
            expect(res.status()).toBe(200);
            const added = (await listRecordings(api)).filter((r) => !before.has(r.id));
            expect(added).toHaveLength(1);
            return added[0].id;
        }
    });

    test("a single id with format=original returns the stored file untouched", async () => {
        const res = await api.get(`/api/recordings/download?ids=${a}&format=original`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("audio/mpeg");
        expect(res.headers()["content-disposition"]).toContain(".mp3");
        expect(res.headers()["cache-control"]).toBe("private, no-store");
        expect(Buffer.from(await res.body()).equals(fixture(MP3.file))).toBe(true);
    });

    test("several ids return one zip with an mp3 per recording by default", async () => {
        const res = await api.get(`/api/recordings/download?ids=${a},${b}`);
        expect(res.status()).toBe(200);
        expect(res.headers()["content-type"]).toBe("application/zip");
        expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="OpenAudioHub-\d{4}-\d{2}-\d{2}\.zip"/);
        expect(res.headers()["cache-control"]).toBe("private, no-store");
        const entries = zipEntries(Buffer.from(await res.body()));
        const names = entries.map((e) => e.name);
        expect(entries).toHaveLength(2);
        expect(names.some((n) => n.startsWith("dl-a-") && n.endsWith(".mp3"))).toBe(true);
        expect(names.some((n) => n.startsWith("dl-b-") && n.endsWith(".mp3"))).toBe(true);
    });

    test("format=original in a zip keeps each stored extension", async () => {
        const res = await api.get(`/api/recordings/download?ids=${a},${b}&format=original`);
        expect(res.status()).toBe(200);
        const entries = zipEntries(Buffer.from(await res.body()));
        expect(entries.map((e) => e.name).some((n) => n.endsWith(".wav"))).toBe(true);
        expect(entries.map((e) => e.name).some((n) => n.endsWith(".mp3"))).toBe(true);
    });

    test("two recordings with the same name get unique archive names", async () => {
        const res = await api.get(`/api/recordings/download?ids=${sameName1},${sameName2}`);
        expect(res.status()).toBe(200);
        const names = zipEntries(Buffer.from(await res.body())).map((e) => e.name);
        expect(new Set(names).size).toBe(2);
        expect(names.some((n) => n.endsWith(" (2).mp3"))).toBe(true);
    });

    test("ids that are not the caller's are left out of the zip", async () => {
        const other = (await people()).other;
            const foreign = (await uploadUnique(other, MP3.file, MP3.mime, "dl-foreign")).id;
            const res = await api.get(`/api/recordings/download?ids=${a},${foreign},unknownid00000000000001`);
            expect(res.status()).toBe(200);
            expect(zipEntries(Buffer.from(await res.body()))).toHaveLength(1);
    });

    test("when none of the ids is the caller's, the request returns 404", async () => {
        const res = await api.get("/api/recordings/download?ids=unknownid00000000000001");
        expect(res.status()).toBe(404);
        expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
    });

    test("a missing, empty, or malformed ids parameter is rejected", async () => {
        for (const q of ["", "?ids=", "?ids=bad%20id", "?ids=a,,b%20c"]) {
            const res = await api.get(`/api/recordings/download${q}`);
            expect(res.status(), q).toBe(400);
            expect(await res.json()).toMatchObject({ code: "INVALID_INPUT" });
        }
    });

    test("more than 100 ids is rejected", async () => {
        const ids = Array.from({ length: 101 }, (_, i) => `id${String(i).padStart(18, "0")}`).join(",");
        const res = await api.get(`/api/recordings/download?ids=${ids}`);
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({ error: "ids must be 1 to 100 recording ids", code: "INVALID_INPUT" });
    });

    test("an unknown format value is rejected", async () => {
        const res = await api.get(`/api/recordings/download?ids=${a}&format=ogg`);
        expect(res.status()).toBe(400);
        expect(await res.json()).toEqual({
            error: "format must be mp3 or original",
            code: "INVALID_INPUT",
        });
    });
});

test.describe("recordings: merge", () => {
    let api: APIRequestContext;
    let mp3Id: string;
    let wavId: string;
    let mp3Duration: number;
    let wavDuration: number;

    test.beforeAll(async () => {
        api = (await people()).owner;
        const mp3 = await uploadUnique(api, MP3.file, MP3.mime, "merge-mp3");
        const wav = await uploadUnique(api, WAV.file, WAV.mime, "merge-wav");
        mp3Id = mp3.id;
        wavId = wav.id;
        mp3Duration = (await getRecording(api, mp3Id)).duration;
        wavDuration = (await getRecording(api, wavId)).duration;
    });

    test("merging two recordings returns 201 with a new id and keeps the originals", async () => {
        const res = await api.post("/api/recordings/merge", { data: { ids: [mp3Id, wavId] } });
        expect(res.status()).toBe(201);
        const { id } = (await res.json()) as { id: string };
        expect(id).toBeTruthy();
        expect(id).not.toBe(mp3Id);
        expect(id).not.toBe(wavId);
        expect((await api.get(`/api/recordings/${mp3Id}`)).status()).toBe(200);
        expect((await api.get(`/api/recordings/${wavId}`)).status()).toBe(200);
    });

    test("the merged recording is named after the first input, joined in the given order", async () => {
        const ab = (await (await api.post("/api/recordings/merge", { data: { ids: [mp3Id, wavId] } })).json()) as { id: string };
        const ba = (await (await api.post("/api/recordings/merge", { data: { ids: [wavId, mp3Id] } })).json()) as { id: string };
        const mp3Name = (await getRecording(api, mp3Id)).filename;
        const wavName = (await getRecording(api, wavId)).filename;
        expect((await getRecording(api, ab.id)).filename).toBe(`${mp3Name} (merged)`);
        expect((await getRecording(api, ba.id)).filename).toBe(`${wavName} (merged)`);
    });

    test("the merged duration is about the sum of the inputs and its audio is ogg", async () => {
        const { id } = (await (await api.post("/api/recordings/merge", { data: { ids: [mp3Id, wavId] } })).json()) as { id: string };
        const merged = await getRecording(api, id);
        expect(Math.abs(merged.duration - (mp3Duration + wavDuration))).toBeLessThanOrEqual(200);
        expect(merged.plaudVersion).toBe("1");
        const audio = await api.get(`/api/recordings/${id}/audio`);
        expect(audio.status()).toBe(200);
        expect(audio.headers()["content-type"]).toBe("audio/ogg");
    });

    test("the merged start time is the earliest input start time", async () => {
        const first = await getRecording(api, mp3Id);
        const second = await getRecording(api, wavId);
        const earliest = Math.min(Date.parse(first.startTime), Date.parse(second.startTime));
        const { id } = (await (await api.post("/api/recordings/merge", { data: { ids: [wavId, mp3Id] } })).json()) as { id: string };
        expect(Date.parse((await getRecording(api, id)).startTime)).toBe(earliest);
    });

    test("a title option names the merged recording and is trimmed", async () => {
        const res = await api.post("/api/recordings/merge", { data: { ids: [mp3Id, wavId], title: "  Joined talk  " } });
        expect(res.status()).toBe(201);
        const { id } = (await res.json()) as { id: string };
        expect((await getRecording(api, id)).filename).toBe("Joined talk");
    });

    test("fewer than two ids, duplicate ids, or a bad title are rejected", async () => {
        const cases: [string, unknown][] = [
            ["one id", { ids: [mp3Id] }],
            ["duplicate ids", { ids: [mp3Id, mp3Id] }],
            ["no ids", {}],
            ["title too long", { ids: [mp3Id, wavId], title: "t".repeat(256) }],
            ["title not a string", { ids: [mp3Id, wavId], title: 7 }],
        ];
        for (const [label, data] of cases) {
            const res = await api.post("/api/recordings/merge", { data });
            expect(res.status(), label).toBe(400);
            expect(await res.json(), label).toMatchObject({ code: "INVALID_INPUT" });
        }
    });

    test("a request with an id that is not the caller's returns 404 and creates nothing", async () => {
        const before = (await listRecordings(api)).length;
        const res = await api.post("/api/recordings/merge", { data: { ids: [mp3Id, "unknownid00000000000001"] } });
        expect(res.status()).toBe(404);
        expect(await res.json()).toMatchObject({ code: "RECORDING_NOT_FOUND" });
        expect((await listRecordings(api)).length).toBe(before);
    });

    test("deleting the originals does not remove the merged recording", async () => {
        const x = (await uploadUnique(api, MP3.file, MP3.mime, "merge-x")).id;
        const y = (await uploadUnique(api, WAV.file, WAV.mime, "merge-y")).id;
        const { id } = (await (await api.post("/api/recordings/merge", { data: { ids: [x, y] } })).json()) as { id: string };
        expect((await api.delete(`/api/recordings/${x}`)).status()).toBe(200);
        expect((await api.delete(`/api/recordings/${y}`)).status()).toBe(200);
        expect((await api.get(`/api/recordings/${id}`)).status()).toBe(200);
        expect((await api.get(`/api/recordings/${id}/audio`)).status()).toBe(200);
    });
});

test.describe("recordings: per-user isolation", () => {
    test("one user cannot read, change, stream, or merge another user's recording", async () => {
        const owner = (await people()).owner;
        const intruder = (await people()).other;
        const { id } = await uploadUnique(owner, MP3.file, MP3.mime, "iso");
            expect((await intruder.get(`/api/recordings/${id}`)).status()).toBe(404);
            expect((await intruder.patch(`/api/recordings/${id}`, { data: { filename: "x" } })).status()).toBe(404);
            expect((await intruder.put(`/api/recordings/${id}/star`, { data: { starred: true } })).status()).toBe(404);
            expect((await intruder.post(`/api/recordings/${id}/peaks`, { data: { peaks: peaks(40) } })).status()).toBe(404);
            expect((await intruder.get(`/api/recordings/${id}/audio`)).status()).toBe(404);
            expect((await intruder.get(`/api/recordings/download?ids=${id}`)).status()).toBe(404);
            expect((await intruder.post("/api/recordings/merge", { data: { ids: [id, id + "z"] } })).status()).toBe(404);
            expect((await listRecordings(intruder)).map((r) => r.id)).not.toContain(id);
            // The owner's copy is untouched.
            expect((await getRecording(owner, id)).filename).toBeTruthy();
    });
});
