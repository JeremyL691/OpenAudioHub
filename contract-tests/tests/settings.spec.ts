import { expect, test } from "@playwright/test";
import {
    anonymousContext,
    clientHeaders,
    newUserContext,
    uploadRecording,
} from "../helpers/api";

// ---------- helpers local to this file ----------

const B62 =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function crc32(text: string): number {
    let c = ~0 >>> 0;
    for (let i = 0; i < text.length; i++) {
        c ^= text.charCodeAt(i);
        for (let k = 0; k < 8; k++) {
            const mask = -(c & 1);
            c = (c >>> 1) ^ (0xedb88320 & mask);
        }
    }
    return ~c >>> 0;
}

/** Checksum rule from the spec: leading 4 base62 digits, left-padded with 0. */
function expectedChecksum(prefixAndPayload: string): string {
    let n = crc32(prefixAndPayload);
    if (n === 0) return "0000";
    let out = "";
    while (n > 0) {
        out = B62[n % 62] + out;
        n = Math.floor(n / 62);
    }
    return out.padStart(4, "0").slice(0, 4);
}

const FIXTURE_BYTES = 12608; // tone-3s.mp3 size, checked against the server in the audio test

async function uploadAndGetId(api: Awaited<ReturnType<typeof newUserContext>>) {
    return uploadRecording(api);
}

async function createKey(
    api: Awaited<ReturnType<typeof newUserContext>>,
    body: Record<string, unknown> = { name: "contract key" },
) {
    const res = await api.post("/api/settings/api-keys", { data: body });
    expect(res.status(), "create key").toBe(201);
    return (await res.json()) as {
        key: string;
        apiKey: Record<string, unknown> & { id: string };
    };
}

/** A bearer-authenticated context for a fresh account's key. */
async function apiKeyContext(label: string) {
    const owner = await newUserContext(label);
    const { key } = await createKey(owner);
    return { owner, key };
}

const DEFAULTS: Record<string, unknown> = {
    autoTranscribe: false,
    autoSummarize: false,
    autoSummarizePreset: null,
    syncInterval: 300000,
    autoSyncEnabled: true,
    syncOnMount: true,
    syncOnVisibilityChange: true,
    syncNotifications: true,
    defaultPlaybackSpeed: 1,
    defaultVolume: 75,
    autoPlayNext: false,
    playerScrubber: "waveform",
    defaultTranscriptionLanguage: null,
    transcriptionQuality: "balanced",
    speakerDiarization: true,
    diarizationSpeakerCount: null,
    dateTimeFormat: "relative",
    recordingListSortOrder: "newest",
    itemsPerPage: 50,
    listDensity: "comfortable",
    theme: "system",
    autoDeleteRecordings: false,
    retentionDays: null,
    browserNotifications: true,
    notificationSound: true,
    defaultExportFormat: "json",
    autoExport: false,
    autoExportFolder: null,
    autoExportFormat: "mp3",
    autoExportTitleMode: "original",
    defaultProviders: null,
    onboardingCompleted: false,
    autoGenerateTitle: true,
    recordingTitleMode: "ai",
    syncTitleToPlaud: false,
    aiOutputLanguage: null,
    importPlaudContent: false,
    transcriptMode: "plaud_only",
    preferredTranscriptSource: "plaud",
};

// ---------- user settings ----------

test("user settings: a new account reads every default", async () => {
    const api = await newUserContext("settings-defaults");
    const res = await api.get("/api/settings/user");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const [field, value] of Object.entries(DEFAULTS)) {
        expect(body[field], field).toStrictEqual(value);
    }
    expect(typeof body.userEmail).toBe("string");
    expect(String(body.userEmail)).toContain("@");
    expect(body).not.toHaveProperty("summaryPrompt");
    expect(body.titleGenerationPrompt).toBeNull();
    await api.dispose();
});

test("user settings: PUT changes only the fields it sends", async () => {
    const api = await newUserContext("settings-partial");
    const put = await api.put("/api/settings/user", {
        data: { theme: "dark", itemsPerPage: 25 },
    });
    expect(put.status()).toBe(200);
    expect(await put.json()).toStrictEqual({ success: true });

    const body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.theme).toBe("dark");
    expect(body.itemsPerPage).toBe(25);
    expect(body.speakerDiarization).toBe(true);
    expect(body.listDensity).toBe("comfortable");
    await api.dispose();
});

test("user settings: unknown fields are ignored", async () => {
    const api = await newUserContext("settings-unknown");
    const put = await api.put("/api/settings/user", {
        data: { notARealSetting: "x", theme: "light" },
    });
    expect(put.status()).toBe(200);
    const body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body).not.toHaveProperty("notARealSetting");
    expect(body.theme).toBe("light");
    await api.dispose();
});

test("user settings: enum fields reject unknown values with the field name", async () => {
    const api = await newUserContext("settings-enum");
    const bad: Array<[string, string]> = [
        ["theme", "neon"],
        ["playerScrubber", "knob"],
        ["transcriptionQuality", "best"],
        ["dateTimeFormat", "epoch"],
        ["recordingListSortOrder", "random"],
        ["listDensity", "tiny"],
        ["defaultExportFormat", "pdf"],
        ["autoExportFormat", "flac"],
        ["autoExportTitleMode", "never"],
        ["transcriptMode", "both"],
        ["recordingTitleMode", "never"],
        ["preferredTranscriptSource", "bogus"],
    ];
    for (const [field, value] of bad) {
        const res = await api.put("/api/settings/user", {
            data: { [field]: value },
        });
        expect(res.status(), field).toBe(400);
        const body = (await res.json()) as {
            code: string;
            details: { field: string };
        };
        expect(body.code, field).toBe("INVALID_INPUT");
        expect(body.details.field, field).toBe(field);
    }
    await api.dispose();
});

test("user settings: speakerDiarization must be a boolean", async () => {
    const api = await newUserContext("settings-diar-bool");
    const res = await api.put("/api/settings/user", {
        data: { speakerDiarization: "yes" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).details.field).toBe("speakerDiarization");
    await api.dispose();
});

test("user settings: diarizationSpeakerCount accepts 1 to 32 and null only", async () => {
    const api = await newUserContext("settings-diar-count");
    for (const ok of [1, 32, null]) {
        const res = await api.put("/api/settings/user", {
            data: { diarizationSpeakerCount: ok },
        });
        expect(res.status(), String(ok)).toBe(200);
    }
    for (const bad of [0, 33, 2.5, "3"]) {
        const res = await api.put("/api/settings/user", {
            data: { diarizationSpeakerCount: bad },
        });
        expect(res.status(), String(bad)).toBe(400);
        expect((await res.json()).details.field).toBe("diarizationSpeakerCount");
    }
    await api.dispose();
});

test("user settings: aiOutputLanguage rejects unknown codes and reads back accepted ones", async () => {
    const api = await newUserContext("settings-lang");
    const bad = await api.put("/api/settings/user", {
        data: { aiOutputLanguage: "zz-bogus" },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).details.field).toBe("aiOutputLanguage");

    const ok = await api.put("/api/settings/user", {
        data: { aiOutputLanguage: "en" },
    });
    expect(ok.status()).toBe(200);
    const body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.aiOutputLanguage).toBe("en");
    await api.dispose();
});

test("user settings: summaryPrompt rejects a plain string and accepts null", async () => {
    const api = await newUserContext("settings-summary-prompt");
    const bad = await api.put("/api/settings/user", {
        data: { summaryPrompt: "bad" },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).details.field).toBe("summaryPrompt");

    const cleared = await api.put("/api/settings/user", {
        data: { summaryPrompt: null },
    });
    expect(cleared.status()).toBe(200);
    await api.dispose();
});

test("user settings: titleGenerationPrompt round-trips", async () => {
    const api = await newUserContext("settings-title-prompt");
    const put = await api.put("/api/settings/user", {
        data: { titleGenerationPrompt: "Name it after the topic" },
    });
    expect(put.status()).toBe(200);
    const body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.titleGenerationPrompt).toBe("Name it after the topic");
    await api.dispose();
});

test("user settings: autoExport cannot be turned on in the web app", async () => {
    const api = await newUserContext("settings-autoexport");
    const res = await api.put("/api/settings/user", {
        data: { autoExport: true },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as {
        code: string;
        details: { field: string };
    };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.details.field).toBe("autoExport");
    await api.dispose();
});

test("user settings: the export folder must exist, and retired backup keys are ignored", async () => {
    const api = await newUserContext("settings-folders");
    const missing = "/nonexistent-oah-contract-folder-zzz";
    const exp = await api.put("/api/settings/user", {
        data: { autoExportFolder: missing },
    });
    expect(exp.status()).toBe(400);
    expect((await exp.json()).details.field).toBe("autoExportFolder");

    const retired = await api.put("/api/settings/user", {
        data: { backupFrequency: "daily", backupFolder: missing },
    });
    expect(retired.status()).toBe(200);
    const settings = (await (await api.get("/api/settings/user")).json()) as Record<string, unknown>;
    expect(settings).not.toHaveProperty("backupFrequency");
    expect(settings).not.toHaveProperty("backupFolder");
    expect(settings).not.toHaveProperty("lastScheduledBackupAt");
    await api.dispose();
});

test("user settings: barkPushUrl is stored, reported as set, and cleared by an empty value", async () => {
    const api = await newUserContext("settings-bark");
    const url = "https://push.example.com/abc123";
    expect(
        (await api.put("/api/settings/user", { data: { barkPushUrl: url } }))
            .status(),
    ).toBe(200);
    let body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.barkPushUrl).toBe(url);
    expect(body.barkPushUrlSet).toBe(true);

    expect(
        (await api.put("/api/settings/user", { data: { barkPushUrl: "" } }))
            .status(),
    ).toBe(200);
    body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.barkPushUrl).toBeNull();
    expect(body.barkPushUrlSet).toBe(false);
    await api.dispose();
});

test("user settings: auto export format accepts ogg", async () => {
    const api = await newUserContext("settings-ogg");
    const res = await api.put("/api/settings/user", { data: { autoExportFormat: "ogg" } });
    expect(res.status()).toBe(200);
    const body = await (await api.get("/api/settings/user")).json();
    expect(body.autoExportFormat).toBe("ogg");
});

test("user settings: recordingTitleMode sets autoGenerateTitle", async () => {
    const api = await newUserContext("settings-title-mode");
    await api.put("/api/settings/user", { data: { recordingTitleMode: "date" } });
    let body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.recordingTitleMode).toBe("date");
    expect(body.autoGenerateTitle).toBe(false);

    await api.put("/api/settings/user", { data: { recordingTitleMode: "ai" } });
    body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.autoGenerateTitle).toBe(true);
    await api.dispose();
});

test("user settings: marketingEmailConsent is stored in settings and reads back", async () => {
    const api = await newUserContext("settings-consent");
    await api.put("/api/settings/user", {
        data: { marketingEmailConsent: true },
    });
    let body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.marketingEmailConsent).toBe(true);
    await api.put("/api/settings/user", {
        data: { marketingEmailConsent: false },
    });
    body = (await (await api.get("/api/settings/user")).json()) as Record<
        string,
        unknown
    >;
    expect(body.marketingEmailConsent).toBe(false);
    await api.dispose();
});

test("user settings: anonymous requests are refused", async () => {
    const api = await anonymousContext();
    const get = await api.get("/api/settings/user");
    expect(get.status()).toBe(401);
    expect((await get.json()).code).toBe("AUTH_SESSION_MISSING");
    const put = await api.put("/api/settings/user", { data: { theme: "dark" } });
    expect(put.status()).toBe(401);
    await api.dispose();
});

// ---------- storage ----------

test("storage: a new account has no usage", async () => {
    const api = await newUserContext("settings-storage-empty");
    const res = await api.get("/api/settings/storage");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.storageType).toBe("local");
    expect(body.usedBytes).toBe(0);
    expect(body.recordingCount).toBe(0);
    expect(body.totalDurationMs).toBe(0);
    expect(body.largest).toStrictEqual([]);
    expect(body.quotaBytes).toBeNull();
    const free = body.diskFreeBytes;
    expect(free === null || (typeof free === "number" && free > 0)).toBe(true);
    await api.dispose();
});

test("storage: usage follows uploads and lists the largest recording", async () => {
    const api = await newUserContext("settings-storage-usage");
    const id = await uploadAndGetId(api);
    const body = (await (await api.get("/api/settings/storage")).json()) as {
        usedBytes: number;
        recordingCount: number;
        totalDurationMs: number;
        largest: Array<{
            id: string;
            filename: string;
            filesize: number;
            duration: number;
            startTime: string;
        }>;
    };
    expect(body.recordingCount).toBe(1);
    expect(body.usedBytes).toBeGreaterThan(0);
    expect(body.totalDurationMs).toBeGreaterThan(0);
    expect(body.largest).toHaveLength(1);
    expect(body.largest[0].id).toBe(id);
    expect(body.largest[0].filesize).toBe(body.usedBytes);
    expect(body.largest[0].duration).toBe(body.totalDurationMs);
    expect(typeof body.largest[0].filename).toBe("string");
    expect(new Date(body.largest[0].startTime).toString()).not.toBe("Invalid Date");
    await api.dispose();
});

test("storage: anonymous requests are refused", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/settings/storage");
    expect(res.status()).toBe(401);
    await api.dispose();
});

// ---------- test email ----------

test("test email: a missing or blank address is refused", async () => {
    const api = await newUserContext("settings-mail-missing");
    for (const data of [{}, { email: "" }, { email: "   " }]) {
        const res = await api.post("/api/settings/test-email", { data });
        expect(res.status(), JSON.stringify(data)).toBe(400);
        const body = (await res.json()) as {
            code: string;
            details: { field: string };
        };
        expect(body.code).toBe("MISSING_REQUIRED_FIELD");
        expect(body.details.field).toBe("email");
    }
    await api.dispose();
});

test("test email: a malformed address is refused", async () => {
    const api = await newUserContext("settings-mail-invalid");
    const res = await api.post("/api/settings/test-email", {
        data: { email: "not-an-address" },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as {
        code: string;
        details: { field: string };
    };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.details.field).toBe("email");
    await api.dispose();
});

test("test email: a body that is not JSON counts as a missing address", async () => {
    const api = await newUserContext("settings-mail-badjson");
    const res = await api.post("/api/settings/test-email", {
        headers: { "content-type": "application/json" },
        data: "{not json",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_REQUIRED_FIELD");
    await api.dispose();
});

test("test email: without SMTP configured the send fails with SMTP_NOT_CONFIGURED", async () => {
    // Error path only: this test server has no SMTP, so a success is not expected.
    const api = await newUserContext("settings-mail-nosmtp");
    const res = await api.post("/api/settings/test-email", {
        data: { email: "recipient@example.com" },
    });
    expect(res.status()).toBe(500);
    const body = (await res.json()) as { code: string; details?: { errorId?: string } };
    expect(body.code).toBe("SMTP_NOT_CONFIGURED");
    expect(body.details?.errorId ?? "").toMatch(/^err_[0-9a-f]{8}$/);
    await api.dispose();
});

test("test email: anonymous requests are refused", async () => {
    const api = await anonymousContext();
    const res = await api.post("/api/settings/test-email", {
        data: { email: "recipient@example.com" },
    });
    expect(res.status()).toBe(401);
    await api.dispose();
});

// ---------- API keys ----------

test("api keys: creating a key shows the key once and returns the list record", async () => {
    const api = await newUserContext("settings-key-create");
    const { key, apiKey } = await createKey(api, { name: "  laptop  " });
    expect(apiKey.name).toBe("laptop");
    expect(apiKey.keyPrefix).toBe(key.slice(0, 12));
    expect(apiKey.source).toBe("manual");
    expect(apiKey.scopes).toStrictEqual(["read"]);
    expect(apiKey.lastUsedAt).toBeNull();
    expect(apiKey.expiresAt).toBeNull();
    expect(apiKey.revokedAt).toBeNull();
    expect(typeof apiKey.createdAt).toBe("string");
    expect(apiKey).not.toHaveProperty("key");
    expect(apiKey).not.toHaveProperty("keyHash");

    const list = (await (await api.get("/api/settings/api-keys")).json()) as {
        apiKeys: Array<Record<string, unknown>>;
    };
    expect(list.apiKeys).toHaveLength(1);
    expect(list.apiKeys[0]).not.toHaveProperty("key");
    expect(list.apiKeys[0]).not.toHaveProperty("keyHash");
    expect(JSON.stringify(list)).not.toContain(key);
    await api.dispose();
});

test("api keys: key format is oah_ plus 30 random and 4 checksum base62 characters", async () => {
    const api = await newUserContext("settings-key-format");
    const { key } = await createKey(api);
    expect(key).toHaveLength(38);
    expect(key.startsWith("oah_")).toBe(true);
    const body = key.slice(4);
    expect(body).toMatch(/^[0-9A-Za-z]{34}$/);
    expect(body.slice(-4)).toBe(expectedChecksum(`oah_${body.slice(0, -4)}`));
    await api.dispose();
});

test("api keys: name is required, at most 120 characters", async () => {
    const api = await newUserContext("settings-key-name");
    for (const data of [{}, { name: "" }, { name: "   " }]) {
        const res = await api.post("/api/settings/api-keys", { data });
        expect(res.status(), JSON.stringify(data)).toBe(400);
        const body = (await res.json()) as {
            code: string;
            details: { field: string };
        };
        expect(body.code).toBe("MISSING_REQUIRED_FIELD");
        expect(body.details.field).toBe("name");
    }
    const tooLong = await api.post("/api/settings/api-keys", {
        data: { name: "a".repeat(121) },
    });
    expect(tooLong.status()).toBe(400);
    expect((await tooLong.json()).code).toBe("INVALID_INPUT");

    const max = await api.post("/api/settings/api-keys", {
        data: { name: "a".repeat(120) },
    });
    expect(max.status()).toBe(201);
    await api.dispose();
});

test("api keys: expiresAt must be a future ISO timestamp", async () => {
    const api = await newUserContext("settings-key-expiry");
    const past = await api.post("/api/settings/api-keys", {
        data: { name: "k", expiresAt: "2020-01-01T00:00:00Z" },
    });
    expect(past.status()).toBe(400);
    expect((await past.json()).details.field).toBe("expiresAt");

    const junk = await api.post("/api/settings/api-keys", {
        data: { name: "k", expiresAt: "tomorrow-ish" },
    });
    expect(junk.status()).toBe(400);

    const notString = await api.post("/api/settings/api-keys", {
        data: { name: "k", expiresAt: 5 },
    });
    expect(notString.status()).toBe(400);

    const future = "2099-01-01T00:00:00.000Z";
    const ok = await api.post("/api/settings/api-keys", {
        data: { name: "k", expiresAt: future },
    });
    expect(ok.status()).toBe(201);
    expect(new Date((await ok.json()).apiKey.expiresAt).toISOString()).toBe(future);
    await api.dispose();
});

test("api keys: only the read scope is kept", async () => {
    const api = await newUserContext("settings-key-scopes");
    const write = await api.post("/api/settings/api-keys", {
        data: { name: "w", scopes: ["write"] },
    });
    expect((await write.json()).apiKey.scopes).toStrictEqual(["read"]);
    const both = await api.post("/api/settings/api-keys", {
        data: { name: "b", scopes: ["read", "write"] },
    });
    expect((await both.json()).apiKey.scopes).toStrictEqual(["read"]);
    await api.dispose();
});

test("api keys: the list is newest first", async () => {
    const api = await newUserContext("settings-key-order");
    const first = await createKey(api, { name: "first" });
    const second = await createKey(api, { name: "second" });
    const list = (await (await api.get("/api/settings/api-keys")).json()) as {
        apiKeys: Array<{ id: string }>;
    };
    expect(list.apiKeys.map((k) => k.id)).toStrictEqual([
        second.apiKey.id,
        first.apiKey.id,
    ]);
    await api.dispose();
});

test("api keys: revoking stops the key on /api/v1 and keeps it listed", async () => {
    const owner = await newUserContext("settings-key-revoke");
    const { key, apiKey } = await createKey(owner);

    const before = await owner.get("/api/v1/recordings", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(before.status()).toBe(200);

    const del = await owner.delete(`/api/settings/api-keys/${apiKey.id}`);
    expect(del.status()).toBe(200);
    expect(await del.json()).toStrictEqual({ success: true });

    const after = await owner.get("/api/v1/recordings", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(after.status()).toBe(401);
    expect((await after.json()).code).toBe("UNAUTHORIZED");

    const list = (await (await owner.get("/api/settings/api-keys")).json()) as {
        apiKeys: Array<{ id: string; revokedAt: string | null }>;
    };
    const row = list.apiKeys.find((k) => k.id === apiKey.id);
    expect(row).toBeDefined();
    expect(row?.revokedAt).not.toBeNull();
    await owner.dispose();
});

test("api keys: revoking an unknown id is a 404", async () => {
    const api = await newUserContext("settings-key-revoke-missing");
    const res = await api.delete("/api/settings/api-keys/no-such-key");
    expect(res.status()).toBe(404);
    const body = (await res.json()) as { code: string; details: { id: string } };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.details.id).toBe("no-such-key");
    await api.dispose();
});

test("api keys: another account's key cannot be revoked", async () => {
    const owner = await newUserContext("settings-key-owner");
    const other = await newUserContext("settings-key-other");
    const { apiKey } = await createKey(owner);
    const res = await other.delete(`/api/settings/api-keys/${apiKey.id}`);
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
    const list = (await (await owner.get("/api/settings/api-keys")).json()) as {
        apiKeys: Array<{ revokedAt: string | null }>;
    };
    expect(list.apiKeys[0].revokedAt).toBeNull();
    await other.dispose();
    await owner.dispose();
});

test("api keys: the key-management routes refuse API keys and anonymous callers", async () => {
    const owner = await newUserContext("settings-key-auth");
    const { key } = await createKey(owner);
    const bearerOnly = await anonymousContext();

    const list = await bearerOnly.get("/api/settings/api-keys", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(list.status()).toBe(401);
    expect((await list.json()).code).toBe("AUTH_SESSION_MISSING");

    const anon = await bearerOnly.post("/api/settings/api-keys", {
        data: { name: "x" },
    });
    expect(anon.status()).toBe(401);
    await bearerOnly.dispose();
    await owner.dispose();
});

test("api keys: lastUsedAt is set after the key authenticates", async () => {
    const owner = await newUserContext("settings-key-lastused");
    const { key, apiKey } = await createKey(owner);
    const res = await owner.get("/api/v1/recordings", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status()).toBe(200);

    let lastUsed: string | null = null;
    for (let i = 0; i < 20 && !lastUsed; i++) {
        const list = (await (await owner.get("/api/settings/api-keys")).json()) as {
            apiKeys: Array<{ id: string; lastUsedAt: string | null }>;
        };
        lastUsed = list.apiKeys.find((k) => k.id === apiKey.id)?.lastUsedAt ?? null;
        if (!lastUsed) await new Promise((r) => setTimeout(r, 250));
    }
    expect(lastUsed).not.toBeNull();
    await owner.dispose();
});

// ---------- public API ----------

test("public API: missing, unknown and malformed credentials get 401", async () => {
    const anon = await anonymousContext();
    const none = await anon.get("/api/v1/recordings");
    expect(none.status()).toBe(401);
    expect((await none.json()).code).toBe("UNAUTHORIZED");

    const unknown = await anon.get("/api/v1/recordings", {
        headers: { authorization: "Bearer oah_notARealKeyValueAtAll000000000000" },
    });
    expect(unknown.status()).toBe(401);
    expect((await unknown.json()).code).toBe("UNAUTHORIZED");

    const basic = await anon.get("/api/v1/recordings", {
        headers: { authorization: "Basic b2FoOnNlY3JldA==" },
    });
    expect(basic.status()).toBe(401);
    await anon.dispose();
});

test("public API: the bearer scheme is case-insensitive and a session cookie also works", async () => {
    const owner = await newUserContext("settings-api-scheme");
    const { key } = await createKey(owner);
    const lower = await owner.get("/api/v1/recordings", {
        headers: { authorization: `bearer ${key}` },
    });
    expect(lower.status()).toBe(200);

    const cookie = await owner.get("/api/v1/recordings");
    expect(cookie.status()).toBe(200);
    expect(await cookie.json()).toHaveProperty("data");
    await owner.dispose();
});

test("public API: only GET is offered", async () => {
    const owner = await newUserContext("settings-api-method");
    const res = await owner.post("/api/v1/recordings", { data: {} });
    expect(res.status()).toBe(405);
    await owner.dispose();
});

test("public API: recording list items have the documented fields", async () => {
    const { owner, key } = await apiKeyContext("settings-api-shape");
    const id = await uploadAndGetId(owner);
    const res = await owner.get("/api/v1/recordings?limit=10", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
        data: Array<Record<string, unknown>>;
        next_cursor: string | null;
        has_more: boolean;
    };
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
    const item = body.data.find((r) => r.id === id);
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toStrictEqual(
        [
            "created_at",
            "device",
            "duration_ms",
            "filesize_bytes",
            "has_summary",
            "has_transcription",
            "id",
            "links",
            "recorded_at",
            "title",
            "updated_at",
        ].sort(),
    );
    expect(typeof item?.title).toBe("string");
    expect(item?.device).toBeNull();
    expect(item?.has_transcription).toBe(false);
    expect(item?.has_summary).toBe(false);
    expect(item?.links).toStrictEqual({
        self: `/api/v1/recordings/${id}`,
        transcript: `/api/v1/recordings/${id}/transcript`,
        audio: `/api/v1/recordings/${id}/audio`,
    });
    await owner.dispose();
});

test("public API: the list pages with a cursor and returns each recording once", async () => {
    const { owner, key } = await apiKeyContext("settings-api-pages");
    const ids = [
        await uploadAndGetId(owner),
        await uploadAndGetId(owner),
        await uploadAndGetId(owner),
    ];
    const headers = { authorization: `Bearer ${key}` };

    const first = (await (
        await owner.get("/api/v1/recordings?limit=2", { headers })
    ).json()) as { data: Array<{ id: string }>; next_cursor: string; has_more: boolean };
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(typeof first.next_cursor).toBe("string");

    const second = (await (
        await owner.get(
            `/api/v1/recordings?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
            { headers },
        )
    ).json()) as { data: Array<{ id: string }>; next_cursor: string | null; has_more: boolean };
    expect(second.data).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();

    const seen = [...first.data, ...second.data].map((r) => r.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toStrictEqual([...ids].sort());
    await owner.dispose();
});

test("public API: list parameters are validated", async () => {
    const { owner, key } = await apiKeyContext("settings-api-params");
    const headers = { authorization: `Bearer ${key}` };
    const cases: Array<[string, string]> = [
        ["limit=0", "limit"],
        ["limit=101", "limit"],
        ["limit=abc", "limit"],
        ["has_transcription=yes", "has_transcription"],
        ["created_since=garbage", "created_since"],
        ["updated_since=garbage", "updated_since"],
        ["cursor=garbage", "cursor"],
    ];
    for (const [query, field] of cases) {
        const res = await owner.get(`/api/v1/recordings?${query}`, { headers });
        expect(res.status(), query).toBe(400);
        const body = (await res.json()) as { code: string; details: { field: string } };
        expect(body.code, query).toBe("INVALID_INPUT");
        expect(body.details.field, query).toBe(field);
    }
    await owner.dispose();
});

test("public API: list filters by time and transcription", async () => {
    const { owner, key } = await apiKeyContext("settings-api-filters");
    const id = await uploadAndGetId(owner);
    const headers = { authorization: `Bearer ${key}` };
    const ids = async (query: string) =>
        (
            (await (await owner.get(`/api/v1/recordings?${query}`, { headers })).json()) as {
                data: Array<{ id: string }>;
            }
        ).data.map((r) => r.id);

    expect(await ids("created_since=2099-01-01T00:00:00Z")).toStrictEqual([]);
    expect(await ids("updated_since=2099-01-01T00:00:00Z")).toStrictEqual([]);
    expect(await ids("created_since=2000-01-01T00:00:00Z")).toContain(id);
    expect(await ids("updated_since=2000-01-01T00:00:00Z")).toContain(id);
    expect(await ids("has_transcription=false")).toContain(id);
    expect(await ids("has_transcription=true")).not.toContain(id);
    await owner.dispose();
});

test("public API: recording detail has transcript and summary fields, and foreign ids are not found", async () => {
    const { owner, key } = await apiKeyContext("settings-api-detail");
    const other = await newUserContext("settings-api-detail-other");
    const id = await uploadAndGetId(owner);
    const headers = { authorization: `Bearer ${key}` };

    const res = await owner.get(`/api/v1/recordings/${id}`, { headers });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.transcript).toBeNull();
    expect(body.transcripts).toStrictEqual([]);
    expect(body.summary).toBeNull();
    expect(body.links).toStrictEqual({
        self: `/api/v1/recordings/${id}`,
        transcript: `/api/v1/recordings/${id}/transcript`,
        audio: `/api/v1/recordings/${id}/audio`,
    });

    const missing = await owner.get("/api/v1/recordings/no-such-recording", { headers });
    expect(missing.status()).toBe(404);
    const missingBody = (await missing.json()) as {
        code: string;
        details: { id: string };
    };
    expect(missingBody.code).toBe("RECORDING_NOT_FOUND");
    expect(missingBody.details.id).toBe("no-such-recording");

    // The other account's own key must not see this recording.
    const { key: otherKey } = await createKey(other);
    const foreign = await owner.get(`/api/v1/recordings/${id}`, {
        headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(foreign.status()).toBe(404);
    expect((await foreign.json()).code).toBe("RECORDING_NOT_FOUND");
    await other.dispose();
    await owner.dispose();
});

test("public API: transcript endpoint answers 404 until a transcript exists", async () => {
    const { owner, key } = await apiKeyContext("settings-api-transcript");
    const id = await uploadAndGetId(owner);
    const headers = { authorization: `Bearer ${key}` };

    const none = await owner.get(`/api/v1/recordings/${id}/transcript`, { headers });
    expect(none.status()).toBe(404);
    const noneBody = (await none.json()) as { code: string; error: string; details: { id: string } };
    expect(noneBody.code).toBe("NOT_FOUND");
    expect(noneBody.error).toBe("Transcript not found");
    expect(noneBody.details.id).toBe(id);

    const unknown = await owner.get("/api/v1/recordings/no-such-recording/transcript", {
        headers,
    });
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).code).toBe("RECORDING_NOT_FOUND");
    await owner.dispose();
});

test("public API: audio streams the whole file with cache and range headers", async () => {
    const { owner, key } = await apiKeyContext("settings-api-audio");
    const id = await uploadAndGetId(owner);
    const headers = { authorization: `Bearer ${key}` };

    const res = await owner.get(`/api/v1/recordings/${id}/audio`, { headers });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("audio/mpeg");
    expect(res.headers()["accept-ranges"]).toBe("bytes");
    expect(res.headers()["cache-control"]).toBe("private, max-age=300");
    const bytes = await res.body();
    expect(bytes.length).toBe(Number(res.headers()["content-length"]));
    expect(bytes.length).toBe(FIXTURE_BYTES);
    await owner.dispose();
});

test("public API: audio honours byte ranges and refuses unsatisfiable ones", async () => {
    const { owner, key } = await apiKeyContext("settings-api-range");
    const id = await uploadAndGetId(owner);
    const headers = { authorization: `Bearer ${key}` };
    const url = `/api/v1/recordings/${id}/audio`;

    const first = await owner.get(url, { headers: { ...headers, range: "bytes=0-9" } });
    expect(first.status()).toBe(206);
    expect(first.headers()["content-range"]).toBe(`bytes 0-9/${FIXTURE_BYTES}`);
    expect(first.headers()["content-length"]).toBe("10");
    expect((await first.body()).length).toBe(10);

    const open = await owner.get(url, { headers: { ...headers, range: "bytes=100-" } });
    expect(open.status()).toBe(206);
    expect(open.headers()["content-range"]).toBe(
        `bytes 100-${FIXTURE_BYTES - 1}/${FIXTURE_BYTES}`,
    );

    const outside = await owner.get(url, {
        headers: { ...headers, range: `bytes=${FIXTURE_BYTES + 10}-` },
    });
    expect(outside.status()).toBe(416);
    expect(outside.headers()["content-range"]).toBe(`bytes */${FIXTURE_BYTES}`);

    // A suffix range is not supported: the whole file comes back.
    const suffix = await owner.get(url, { headers: { ...headers, range: "bytes=-500" } });
    expect(suffix.status()).toBe(200);
    expect((await suffix.body()).length).toBe(FIXTURE_BYTES);
    await owner.dispose();
});

test("public API: audio of an unknown recording is a 404", async () => {
    const { owner, key } = await apiKeyContext("settings-api-audio-404");
    const res = await owner.get("/api/v1/recordings/no-such-recording/audio", {
        headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("RECORDING_NOT_FOUND");
    await owner.dispose();
});

test("public API: 600 requests a minute per key, then 429 with retry headers", async () => {
    test.setTimeout(180_000);
    const { owner, key } = await apiKeyContext("settings-api-ratelimit");
    // Own client address, so the per-address bucket is not shared with other suites.
    const headers = {
        authorization: `Bearer ${key}`,
        "x-forwarded-for": clientHeaders()["x-forwarded-for"],
    };
    const statuses: number[] = [];
    for (let batch = 0; batch < 12; batch++) {
        const wave = await Promise.all(
            Array.from({ length: 50 }, () =>
                owner.get("/api/v1/recordings?limit=1", { headers }),
            ),
        );
        for (const r of wave) statuses.push(r.status());
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(600);

    const limited = await owner.get("/api/v1/recordings?limit=1", { headers });
    expect(limited.status()).toBe(429);
    expect(limited.headers()["retry-after"]).toMatch(/^\d+$/);
    expect(limited.headers()["x-ratelimit-limit"]).toBe("600");
    expect(limited.headers()["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers()["x-ratelimit-reset"]).toMatch(/^\d+$/);
    const body = (await limited.json()) as {
        code: string;
        details: { retryAfter: number; limit: number; remaining: number; resetAt: number };
    };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.details.limit).toBe(600);
    expect(body.details.remaining).toBe(0);
    expect(body.details.retryAfter).toBeGreaterThan(0);
    await owner.dispose();
});
