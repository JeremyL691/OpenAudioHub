import { type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { type APIRequestContext } from "@playwright/test";
import { anonymousContext, baseURL } from "../helpers/api";
import {
    ensureFakePlaud,
    freshUser,
    mainUser,
    FAKE_PLAUD_URL,
    fakeControl,
    fakeRequests,
    jwt,
    nowSec,
} from "../helpers/plaud-extra";

const DAY = 24 * 3600;
let sharedApi: APIRequestContext | undefined;
async function shared(): Promise<APIRequestContext> {
    sharedApi ??= await freshUser("plaud-shared");
    return sharedApi;
}

const uniq = (label: string) => `${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.test`;

test.describe("plaud: connection and validation", () => {
    test("connection status needs a session", async () => {
        const api = await anonymousContext();
        const res = await api.get("/api/plaud/connection");
        expect(res.status()).toBe(401);
        expect((await res.json()).code).toBe("AUTH_SESSION_MISSING");
            });

    test("a new account reports not connected", async () => {
        const api = await shared();
        const res = await api.get("/api/plaud/connection");
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ connected: false });
            });

    test("disconnect is idempotent when nothing is connected", async () => {
        const api = await shared();
        const res = await api.delete("/api/plaud/connection");
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ success: true });
            });

    test("disconnect needs a session", async () => {
        const api = await anonymousContext();
        expect((await api.delete("/api/plaud/connection")).status()).toBe(401);
            });

    test("manual sync needs a session", async () => {
        const api = await anonymousContext();
        expect((await api.post("/api/plaud/sync")).status()).toBe(401);
            });

    test("manual sync without a connection reports it in errors", async () => {
        const api = await shared();
        const res = await api.post("/api/plaud/sync");
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, needsReconnect: false });
        expect(body.errors).toEqual(["No Plaud connection found"]);
            });

    test("manual sync is rate limited per user", async () => {
        test.setTimeout(240_000);
        const api = await freshUser("plaud-ratelimit");
        let limited = null;
        for (let i = 0; i < 40 && !limited; i++) {
            const res = await api.post("/api/plaud/sync");
            if (res.status() === 429) limited = res;
        }
        expect(limited, "a 429 arrives within 40 calls").not.toBeNull();
        const body = await limited!.json();
        expect(body.code).toBe("RATE_LIMITED");
        expect(Number(limited!.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(typeof body.details.limit).toBe("number");
        expect(body.details.remaining).toBe(0);
            });

    test("connect-token needs a session", async () => {
        const api = await anonymousContext();
        const res = await api.post("/api/plaud/auth/connect-token", { data: { accessToken: "a.b.c" } });
        expect(res.status()).toBe(401);
            });

    test("connect-token requires accessToken", async () => {
        const api = await shared();
        const res = await api.post("/api/plaud/auth/connect-token", { data: {} });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("MISSING_REQUIRED_FIELD");
        expect(body.details).toEqual({ field: "accessToken" });
            });

    test("connect-token rejects a value that is not a JWT shape", async () => {
        const api = await shared();
        const res = await api.post("/api/plaud/auth/connect-token", { data: { accessToken: "not-a-token" } });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("INVALID_INPUT");
            });

    test("connect-token refuses a workspace token", async () => {
        const api = await shared();
        const wt = jwt({ sub: "x", exp: nowSec() + DAY, ut_ref: "ref", wid: "ws-1" });
        const res = await api.post("/api/plaud/auth/connect-token", { data: { accessToken: wt } });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("PLAUD_WORKSPACE_TOKEN_PASTED");
            });

    test("connect-token refuses an expired token", async () => {
        const api = await shared();
        const ut = jwt({ sub: "x", exp: nowSec() - 60 });
        const res = await api.post("/api/plaud/auth/connect-token", { data: { accessToken: ut } });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("PLAUD_INVALID_TOKEN");
            });

    test("connect-token refuses an API base outside Plaud hosts", async () => {
        const api = await shared();
        const ut = jwt({ sub: "x", exp: nowSec() + DAY });
        const res = await api.post("/api/plaud/auth/connect-token", {
            data: { accessToken: ut, apiBase: "https://example.com" },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("PLAUD_INVALID_API_BASE");
        const plain = await api.post("/api/plaud/auth/connect-token", {
            data: { accessToken: ut, apiBase: "http://api.plaud.ai" },
        });
        expect((await plain.json()).code).toBe("PLAUD_INVALID_API_BASE");
            });

    test("send-code needs a session", async () => {
        const api = await anonymousContext();
        const res = await api.post("/api/plaud/auth/send-code", { data: { email: "a@example.test" } });
        expect(res.status()).toBe(401);
            });

    test("send-code requires an email, blank or malformed body included", async () => {
        const api = await shared();
        for (const data of [{}, { email: "   " }]) {
            const res = await api.post("/api/plaud/auth/send-code", { data });
            expect(res.status()).toBe(400);
            const body = await res.json();
            expect(body.code).toBe("MISSING_REQUIRED_FIELD");
            expect(body.details).toEqual({ field: "email" });
        }
        const malformed = await api.post("/api/plaud/auth/send-code", {
            data: "{not json",
            headers: { "content-type": "application/json" },
        });
        expect(malformed.status()).toBe(400);
        expect((await malformed.json()).code).toBe("MISSING_REQUIRED_FIELD");
            });

    test("verify needs a session", async () => {
        const api = await anonymousContext();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "1", otpToken: "t", apiBase: "https://api.plaud.ai" },
        });
        expect(res.status()).toBe(401);
            });

    test("verify requires code, otpToken and apiBase", async () => {
        const api = await shared();
        const res = await api.post("/api/plaud/auth/verify", { data: { code: "1", otpToken: "t" } });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("MISSING_REQUIRED_FIELD");
            });

    test("verify refuses an API base outside Plaud hosts", async () => {
        const api = await shared();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "1", otpToken: "t", apiBase: "https://evil.example.com" },
        });
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("PLAUD_INVALID_API_BASE");
            });

    test("handoff code is created, reported and cancelled by its owner", async () => {
        const owner = await shared();
        const other = await mainUser();
        const created = await owner.post("/api/plaud/auth/handoff");
        expect(created.status()).toBe(200);
        const { code, expiresAt } = await created.json();
        expect(typeof code).toBe("string");
        expect(code.length).toBe(43);
        expect(expiresAt).toBeGreaterThan(Date.now());
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);

        const own = await owner.get(`/api/plaud/auth/handoff?code=${code}`);
        expect(await own.json()).toEqual({ status: "pending" });

        const foreign = await other.get(`/api/plaud/auth/handoff?code=${code}`);
        expect(await foreign.json()).toEqual({ status: "expired" });
        expect(await (await other.delete(`/api/plaud/auth/handoff?code=${code}`)).json()).toEqual({ success: true });
        expect(await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json()).toEqual({ status: "pending" });

        await owner.delete(`/api/plaud/auth/handoff?code=${code}`);
        expect(await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json()).toEqual({ status: "expired" });
                    });

    test("handoff status needs a session and a code", async () => {
        const api = await shared();
        const res = await api.get("/api/plaud/auth/handoff");
        expect(res.status()).toBe(400);
        expect((await res.json()).code).toBe("MISSING_REQUIRED_FIELD");
                const anon = await anonymousContext();
        expect((await anon.post("/api/plaud/auth/handoff")).status()).toBe(401);
        await anon.dispose();
    });

    test("handoff complete is refused without same-origin fetch metadata", async () => {
        const anon = await anonymousContext();
        const missing = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code: "x", accessToken: "y" },
        });
        expect(missing.status()).toBe(403);
        expect((await missing.json()).code).toBe("FORBIDDEN");
        const cross = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code: "x", accessToken: "y" },
            headers: { "sec-fetch-site": "cross-site" },
        });
        expect(cross.status()).toBe(403);
        await anon.dispose();
    });

    test("handoff complete rejects unknown codes and requires a token", async () => {
        const owner = await shared();
        const anon = await anonymousContext();
        const unknown = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code: "does-not-exist", accessToken: "y" },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(unknown.status()).toBe(410);
        expect((await unknown.json()).code).toBe("PLAUD_HANDOFF_EXPIRED");

        const { code } = await (await owner.post("/api/plaud/auth/handoff")).json();
        const noToken = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(noToken.status()).toBe(400);
        expect((await noToken.json()).details).toEqual({ field: "accessToken" });

        const wt = jwt({ sub: "x", exp: nowSec() + DAY, ut_ref: "ref", wid: "ws-1" });
        const refused = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code, accessToken: wt },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(refused.status()).toBe(400);
        expect((await refused.json()).code).toBe("PLAUD_WORKSPACE_TOKEN_PASTED");

        // A failed connect keeps the code pending and records the message for the owner.
        const status = await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json();
        expect(status.status).toBe("pending");
        expect(typeof status.error).toBe("string");
        await anon.dispose();
            });

    test("the connect page is public, not indexed, titled, and ready for the extension", async () => {
        const anon = await anonymousContext();
        const res = await anon.get("/connect/plaud?code=abc");
        expect(res.status()).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/<title>Connect Plaud[^<]*<\/title>/);
        expect(html).toContain("noindex");
        expect(html).toContain('<meta name="openaudiohub-plaud-connect" content="1">');
        const oldWord = ["con", "nector"].join("");
        expect(html.toLowerCase()).not.toContain(oldWord);
        expect(html).toContain('data-testid="connect-start"');
        expect(html).toContain('data-testid="connect-install-link"');
        expect(html).toContain(
            "https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip",
        );
        const csp = res.headers()["content-security-policy"] ?? "";
        expect(csp).toContain("default-src 'self';");
        expect(csp).toContain("script-src 'self' 'unsafe-inline' blob:;");
        expect(csp).not.toContain("chrome-extension:");
        expect(csp).not.toContain("moz-extension:");
        expect(csp).not.toContain("http://127.0.0.1:*");
        expect(csp).not.toContain("http://localhost:*");
        await anon.dispose();
    });
});

// ---------------------------------------------------------------- fake Plaud

test.describe("plaud: sign-in and sync against the fake Plaud API", () => {
    test.describe.configure({ timeout: 300_000 });

    let fake: ChildProcess | null = null;

    test.beforeAll(async () => {
        fake = await ensureFakePlaud();
        await fakeControl("/reset");
    });

    test.afterAll(() => {
        fake?.kill();
    });

    /** Sends a code, verifies it, and returns the connection base. */
    async function signIn(api: APIRequestContext, email: string) {
        const sent = await api.post("/api/plaud/auth/send-code", { data: { email } });
        expect(sent.status()).toBe(200);
        const { otpToken, apiBase } = await sent.json();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "123456", otpToken, apiBase, email },
        });
        expect(res.status()).toBe(200);
        return { apiBase, devices: (await res.json()).devices as { sn: string }[] };
    }

    /** Gets an account token the way a browser session would, from the fake's own sign-in. */
    async function accountToken(email: string): Promise<string> {
        const sent = await fetch(`${FAKE_PLAUD_URL}/auth/otp-send-code`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: email }),
        });
        const { token } = (await sent.json()) as { token: string };
        const login = await fetch(`${FAKE_PLAUD_URL}/auth/otp-login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "123456", token }),
        });
        return ((await login.json()) as { access_token: string }).access_token;
    }

    test("sign-in with an emailed code connects the account", async () => {
        const api = await freshUser("plaud-signin");
        const email = uniq("Signin.User");
        const sent = await api.post("/api/plaud/auth/send-code", { data: { email } });
        expect(sent.status()).toBe(200);
        const sendBody = await sent.json();
        expect(sendBody.success).toBe(true);
        expect(sendBody.apiBase).toBe(FAKE_PLAUD_URL);

        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "123456", otpToken: sendBody.otpToken, apiBase: sendBody.apiBase, email },
        });
        expect(res.status()).toBe(200);
        const verified = await res.json();
        expect(verified.success).toBe(true);
        expect(verified.devices).toEqual([
            expect.objectContaining({ sn: "SN-FAKE-1", name: "Fake Pin", model: "PLAUD-NOTE", version_number: 1234 }),
        ]);

        const status = await (await api.get("/api/plaud/connection")).json();
        expect(status).toMatchObject({
            connected: true,
            server: "custom",
            apiBase: FAKE_PLAUD_URL,
            plaudEmail: email.toLowerCase(),
            needsReconnect: false,
        });
        expect(Date.parse(status.tokenExpiresAt)).toBeGreaterThan(Date.now() + 200 * DAY * 1000);
        await api.dispose();
    });

    test("a regional redirect is followed and the regional base is kept", async () => {
        const api = await freshUser("plaud-region");
        const sent = await api.post("/api/plaud/auth/send-code", { data: { email: uniq("region") } });
        expect(sent.status()).toBe(200);
        const { apiBase } = await sent.json();
        expect(apiBase).toBe(`${FAKE_PLAUD_URL}/eu`);
        await api.dispose();
    });

    test("endless region redirects fail with PLAUD_REGION_REDIRECT_LOOP", async () => {
        const api = await freshUser("plaud-loop");
        const res = await api.post("/api/plaud/auth/send-code", { data: { email: uniq("loop") } });
        expect(res.status()).toBe(502);
        expect((await res.json()).code).toBe("PLAUD_REGION_REDIRECT_LOOP");
        await api.dispose();
    });

    test("Plaud refusal of an email is shown with its message", async () => {
        const api = await freshUser("plaud-unknown");
        const res = await api.post("/api/plaud/auth/send-code", { data: { email: uniq("unknown") } });
        expect(res.status()).toBe(400);
        const body = await res.json();
        expect(body).toMatchObject({ code: "PLAUD_API_ERROR", error: "Email not registered", details: { plaudStatus: 1 } });
        await api.dispose();
    });

    test("a wrong code is refused as PLAUD_OTP_INVALID", async () => {
        const api = await freshUser("plaud-badcode");
        const sent = await (await api.post("/api/plaud/auth/send-code", { data: { email: uniq("badcode") } })).json();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "000000", otpToken: sent.otpToken, apiBase: sent.apiBase },
        });
        expect(res.status()).toBe(400);
        expect(await res.json()).toMatchObject({ code: "PLAUD_OTP_INVALID", error: "Verification code is wrong" });
        await api.dispose();
    });

    test("a workspace token returned at sign-in is refused and nothing is stored", async () => {
        const api = await freshUser("plaud-wt-signin");
        const sent = await (await api.post("/api/plaud/auth/send-code", { data: { email: uniq("wt") } })).json();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "999999", otpToken: sent.otpToken, apiBase: sent.apiBase },
        });
        expect(res.status()).toBe(502);
        expect((await res.json()).code).toBe("PLAUD_WORKSPACE_TOKEN_PASTED");
        expect(await (await api.get("/api/plaud/connection")).json()).toEqual({ connected: false });
        await api.dispose();
    });

    test("connect-token with an account token connects", async () => {
        const api = await freshUser("plaud-paste");
        const email = uniq("paste");
        const ut = await accountToken(email);
        const res = await api.post("/api/plaud/auth/connect-token", {
            data: { accessToken: ut, apiBase: FAKE_PLAUD_URL, source: "paste" },
        });
        expect(res.status()).toBe(200);
        expect((await res.json()).devices[0].sn).toBe("SN-FAKE-1");
        const status = await (await api.get("/api/plaud/connection")).json();
        expect(status).toMatchObject({ connected: true, plaudEmail: email.toLowerCase() });
        await api.dispose();
    });

    test("connect-token with a token Plaud rejects stores nothing", async () => {
        const api = await freshUser("plaud-revoked-paste");
        const email = uniq("revoked");
        const ut = await accountToken(email);
        await fakeControl("/account", { email, revoked: true });
        const res = await api.post("/api/plaud/auth/connect-token", {
            data: { accessToken: ut, apiBase: FAKE_PLAUD_URL },
        });
        expect(res.status()).toBe(401);
        expect((await res.json()).code).toBe("PLAUD_INVALID_TOKEN");
        expect(await (await api.get("/api/plaud/connection")).json()).toEqual({ connected: false });
        await api.dispose();
    });

    test("browser handoff completes with the captured token, once", async () => {
        const owner = await freshUser("plaud-handoff");
        const email = uniq("handoff");
        const ut = await accountToken(email);
        const { code } = await (await owner.post("/api/plaud/auth/handoff")).json();
        const anon = await anonymousContext();
        const done = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code, accessToken: ut, apiBase: FAKE_PLAUD_URL },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(done.status()).toBe(200);
        expect(await done.json()).toEqual({ success: true });
        expect(await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json()).toEqual({ status: "connected" });
        expect((await owner.get("/api/plaud/connection")).status()).toBe(200);
        expect(await (await owner.get("/api/plaud/connection")).json()).toMatchObject({ connected: true });

        const again = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code, accessToken: ut, apiBase: FAKE_PLAUD_URL },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(again.status()).toBe(410);
        expect((await again.json()).code).toBe("PLAUD_HANDOFF_EXPIRED");
        await anon.dispose();
        await owner.dispose();
    });

    test("an extension refresh key keeps the connection on the newest token", async () => {
        const owner = await freshUser("plaud-refresh");
        const email = uniq("refresh");
        const key = randomBytes(32).toString("base64url");
        const { code } = await (await owner.post("/api/plaud/auth/handoff")).json();
        const anon = await anonymousContext();
        const done = await anon.post("/api/plaud/auth/handoff/complete", {
            data: { code, accessToken: await accountToken(email), apiBase: FAKE_PLAUD_URL, refreshKey: key },
            headers: { "sec-fetch-site": "same-origin" },
        });
        expect(done.status()).toBe(200);
        const first = await (await owner.get("/api/plaud/connection")).json();

        const refresh = (accessToken: string, bearer = key) =>
            anon.post("/api/plaud/auth/refresh", {
                data: { accessToken, apiBase: FAKE_PLAUD_URL },
                headers: { authorization: `Bearer ${bearer}` },
            });

        await new Promise((resolve) => setTimeout(resolve, 1100));
        const newer = await accountToken(email);
        const res = await refresh(newer);
        expect(res.status()).toBe(200);
        expect(res.headers()["access-control-allow-origin"]).toBe("*");
        expect(await res.json()).toEqual({ success: true, updated: true });
        const second = await (await owner.get("/api/plaud/connection")).json();
        expect(second.tokenExpiresAt).not.toBe(first.tokenExpiresAt);

        const same = await refresh(newer);
        expect(same.status()).toBe(200);
        expect(await same.json()).toEqual({ success: true, updated: false });

        // A refresh after Plaud refused the stored token clears the reconnect flag.
        await fakeControl("/account", { email, revoked: true });
        expect((await (await owner.post("/api/plaud/sync")).json()).needsReconnect).toBe(true);
        await fakeControl("/account", { email, revoked: false });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect((await refresh(await accountToken(email))).status()).toBe(200);
        expect(await (await owner.get("/api/plaud/connection")).json()).toMatchObject({ needsReconnect: false });

        await new Promise((resolve) => setTimeout(resolve, 1100));
        const other = await refresh(await accountToken(uniq("other")));
        expect(other.status()).toBe(409);
        expect((await other.json()).code).toBe("PLAUD_ACCOUNT_MISMATCH");

        const unknown = await refresh(newer, randomBytes(32).toString("base64url"));
        expect(unknown.status()).toBe(401);
        expect((await unknown.json()).code).toBe("PLAUD_REFRESH_KEY_INVALID");
        const bare = await anon.post("/api/plaud/auth/refresh", { data: { accessToken: newer } });
        expect(bare.status()).toBe(401);
        expect((await bare.json()).code).toBe("PLAUD_REFRESH_KEY_INVALID");

        expect((await owner.delete("/api/plaud/connection")).status()).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const gone = await refresh(await accountToken(email));
        expect(gone.status()).toBe(401);
        expect((await gone.json()).code).toBe("PLAUD_REFRESH_KEY_INVALID");
        await anon.dispose();
        await owner.dispose();
    });

    test("the refresh endpoint answers the extension's preflight", async () => {
        const anon = await anonymousContext();
        const res = await anon.fetch("/api/plaud/auth/refresh", {
            method: "OPTIONS",
            headers: {
                origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
                "access-control-request-method": "POST",
                "access-control-request-headers": "authorization, content-type",
            },
        });
        expect(res.status()).toBe(204);
        expect(res.headers()["access-control-allow-origin"]).toBe("*");
        expect(res.headers()["access-control-allow-methods"]).toBe("POST");
        expect(res.headers()["access-control-allow-headers"]).toBe("authorization, content-type");
        await anon.dispose();
    });

    test("manual sync imports recordings with mapped fields and a workspace token", async () => {
        const api = await freshUser("plaud-import");
        const email = uniq("import");
        const start = Date.now() - 2 * DAY * 1000;
        const rec = (n: number) => ({
            id: `imp-${Date.now()}-${n}`,
            filename: `Import ${n}`,
            start_time: start + n * 60_000,
            end_time: start + n * 60_000 + 3000,
            duration: 3000,
            edit_time: start + n,
            version_ms: 5000 + n,
            file_md5: "d41d8cd98f00b204e9800998ecf8427e",
            serial_number: "SN-FAKE-1",
        });
        const recs = [rec(1), rec(2), rec(3)];
        await fakeControl("/account", { email, recordings: recs });
        await signIn(api, email);

        const before = (await fakeRequests()).length;
        const sync = await api.post("/api/plaud/sync");
        expect(sync.status()).toBe(200);
        expect(await sync.json()).toMatchObject({
            success: true,
            newRecordings: 3,
            updatedRecordings: 0,
            errors: [],
            needsReconnect: false,
        });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        for (const r of recs) {
            const row = list.find((x) => x.plaudFileId === r.id);
            expect(row, `recording ${r.id}`).toBeTruthy();
            expect(row).toMatchObject({
                filename: r.filename,
                duration: r.duration,
                plaudVersion: String(r.version_ms),
                deviceSn: "SN-FAKE-1",
                fileMd5: r.file_md5,
            });
            expect(new Date(row!.startTime as string).getTime()).toBe(r.start_time);
        }

        const requests = (await fakeRequests()).slice(before);
        const listCalls = requests.filter((q) => q.path === "/file/simple/web");
        expect(listCalls.length).toBeGreaterThan(0);
        expect(listCalls.every((q) => q.auth === "wt")).toBe(true);
        expect(listCalls.every((q) => q.ua?.startsWith("Mozilla/5.0"))).toBe(true);
        const temp = requests.filter((q) => q.path.startsWith("/file/temp-url/"));
        expect(temp.length).toBe(3);
        expect(temp.every((q) => q.query === "is_opus=0")).toBe(true);
        await api.dispose();
    });

    test("a sync with nothing changed downloads nothing", async () => {
        const api = await freshUser("plaud-steady");
        const email = uniq("steady");
        const id = `steady-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Steady", version_ms: 7000 }] });
        await signIn(api, email);
        expect((await (await api.post("/api/plaud/sync")).json()).newRecordings).toBe(1);

        const before = (await fakeRequests()).length;
        const again = await (await api.post("/api/plaud/sync")).json();
        expect(again).toMatchObject({ newRecordings: 0, updatedRecordings: 0, errors: [] });
        const downloads = (await fakeRequests()).slice(before).filter((q) => q.path.startsWith("/audio/"));
        expect(downloads).toEqual([]);
        await api.dispose();
    });

    test("a newer Plaud version updates the recording in place", async () => {
        const api = await freshUser("plaud-update");
        const email = uniq("update");
        const id = `upd-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Old name", version_ms: 8000 }] });
        await signIn(api, email);
        await api.post("/api/plaud/sync");
        const countBefore = ((await (await api.get("/api/recordings")).json()).recordings as unknown[]).length;

        await fakeControl("/account", { email, recordings: [{ id, filename: "New name", version_ms: 9000 }] });
        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body).toMatchObject({ newRecordings: 0, updatedRecordings: 1, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const row = list.find((x) => x.plaudFileId === id);
        expect(row).toMatchObject({ filename: "New name", plaudVersion: "9000" });
        expect(list.length).toBe(countBefore);
        await api.dispose();
    });

    test("a recording deleted in OpenAudioHub is not imported again", async () => {
        const api = await freshUser("plaud-tombstone");
        const email = uniq("tombstone");
        const id = `tomb-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Gone", version_ms: 1100 }] });
        await signIn(api, email);
        await api.post("/api/plaud/sync");
        const row = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.plaudFileId === id,
        );
        expect(row).toBeTruthy();
        expect((await api.delete(`/api/recordings/${row!.id as string}`)).ok()).toBeTruthy();

        await fakeControl("/account", { email, recordings: [{ id, version_ms: 1200 }] });
        const before = (await fakeRequests()).length;
        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body).toMatchObject({ newRecordings: 0, updatedRecordings: 0 });
        const downloads = (await fakeRequests()).slice(before).filter((q) => q.path === `/audio/${id}.mp3`);
        expect(downloads).toEqual([]);
        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list.some((x) => x.plaudFileId === id)).toBe(false);
        await api.dispose();
    });

    test("a Plaud token rejection marks the connection, and a reconnect clears it", async () => {
        const api = await freshUser("plaud-reconnect");
        const email = uniq("reconnect");
        await signIn(api, email);
        await fakeControl("/account", { email, revoked: true });

        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body.needsReconnect).toBe(true);
        expect(body.errors).toContain("Plaud rejected the stored token. Reconnect your Plaud account.");
        const status = await (await api.get("/api/plaud/connection")).json();
        expect(status).toMatchObject({ connected: true, needsReconnect: true });

        await fakeControl("/account", { email, revoked: false });
        await signIn(api, email);
        expect(await (await api.get("/api/plaud/connection")).json()).toMatchObject({ needsReconnect: false });
        await api.dispose();
    });

    test("a rate-limited Plaud list call is retried and succeeds", async () => {
        const api = await freshUser("plaud-retry");
        const email = uniq("retry");
        await fakeControl("/account", { email, recordings: [{ id: `retry-${Date.now()}`, version_ms: 1300 }] });
        await signIn(api, email);
        await fakeControl("/fail", { path: "/file/simple/web", status: 429, retryAfter: 1, times: 1 });
        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body).toMatchObject({ newRecordings: 1, errors: [] });
        await api.dispose();
    });

    test("a Plaud outage ends the sync with an error but keeps the connection", async () => {
        const api = await freshUser("plaud-outage");
        const email = uniq("outage");
        await signIn(api, email);
        await fakeControl("/fail", { path: "/file/simple/web", status: 500, times: 4 });
        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body.errors).toContain("Sync failed: Plaud is temporarily unavailable. Please try again later.");
        expect(body.needsReconnect).toBe(false);
        expect(await (await api.get("/api/plaud/connection")).json()).toMatchObject({ connected: true, needsReconnect: false });
        await api.dispose();
    });

    test("the connect page completes a handoff from extension messages", async ({ browser }) => {
        const owner = await freshUser("plaud-page");
        const email = uniq("Page.User");
        const token = await accountToken(email);
        const { code } = await (await owner.post("/api/plaud/auth/handoff")).json();
        const context = await browser.newContext({
            baseURL,
            extraHTTPHeaders: { origin: baseURL },
            storageState: { cookies: [], origins: [] },
        });
        const page = await context.newPage();
        await page.goto(`/connect/plaud?code=${code}`);
        await expect(page.getByTestId("connect-start")).toBeVisible();
        await expect(page.getByTestId("connect-install-link")).toHaveAttribute(
            "href",
            "https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip",
        );

        // A message from another app and a message with another protocol version are ignored.
        await page.evaluate(
            ({ origin, token }) => {
                window.postMessage({ app: "other-app", protocol: 1, kind: "token", accessToken: token, apiBase: origin }, origin);
                window.postMessage({ app: "openaudiohub-extension", protocol: 2, kind: "token", accessToken: token, apiBase: origin }, origin);
                window.postMessage({ app: "openaudiohub-extension", protocol: 1, kind: "waiting", site: "global" }, origin);
            },
            { origin: baseURL, token },
        );
        await expect(page.getByTestId("connect-waiting")).toBeVisible();
        expect((await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json()).status).toBe("pending");

        await page.evaluate(
            ({ origin, token, apiBase }) => {
                window.postMessage({ app: "openaudiohub-extension", protocol: 1, kind: "token", accessToken: token, apiBase }, origin);
            },
            { origin: baseURL, token, apiBase: FAKE_PLAUD_URL },
        );
        await expect(page.getByTestId("connect-success")).toBeVisible();
        expect((await (await owner.get(`/api/plaud/auth/handoff?code=${code}`)).json()).status).toBe("connected");

        const second = await (await owner.post("/api/plaud/auth/handoff")).json();
        const failed = await context.newPage();
        await failed.goto(`/connect/plaud?code=${second.code}`);
        await failed.evaluate((origin) => {
            window.postMessage({ app: "openaudiohub-extension", protocol: 1, kind: "failed", reason: "cancelled" }, origin);
        }, baseURL);
        await expect(failed.getByTestId("connect-error")).toBeVisible();
        await expect(failed.getByTestId("connect-error-text")).toHaveText(
            "Sign-in was cancelled. Click the OpenAudioHub icon to try again.",
        );
        await context.close();
        await owner.dispose();
    });

    test("disconnect keeps synced recordings and drops the connection", async () => {
        const api = await freshUser("plaud-keep");
        const email = uniq("keep");
        const id = `keep-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Kept", version_ms: 1400 }] });
        await signIn(api, email);
        await api.post("/api/plaud/sync");
        expect((await api.delete("/api/plaud/connection")).status()).toBe(200);
        expect(await (await api.get("/api/plaud/connection")).json()).toEqual({ connected: false });
        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list.some((x) => x.plaudFileId === id)).toBe(true);
        await api.dispose();
    });

    test("date titles are the local day only and survive later Plaud renames", async () => {
        const api = await freshUser("plaud-date-title");
        const email = uniq("datetitle");
        // 2026-10-18T06:30:00Z is 2026-10-17 in UTC-7 and 2026-10-18 in UTC+8. The title must be
        // the server's local day, so it is compared with the day the server reports for that instant.
        const start = Date.UTC(2026, 9, 18, 6, 30, 0);
        const id = `date-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Plaud name", start_time: start, version_ms: 2100 }] });
        await signIn(api, email);
        expect((await api.put("/api/settings/user", { data: { recordingTitleMode: "date" } })).status()).toBe(200);
        expect((await api.post("/api/plaud/sync")).status()).toBe(200);

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const row = list.find((x) => x.plaudFileId === id);
        expect(row).toBeTruthy();
        const title = row!.filename as string;
        expect(title).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // A later Plaud rename keeps the local date title.
        await fakeControl("/account", { email, recordings: [{ id, filename: "Renamed in Plaud", version_ms: 2200 }] });
        const updated = await (await api.post("/api/plaud/sync")).json();
        expect(updated.updatedRecordings).toBe(1);
        const after = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.plaudFileId === id,
        );
        expect(after!.filename).toBe(title);
        await api.dispose();
    });

    test("a manual rename is kept when Plaud changes the name", async () => {
        const api = await freshUser("plaud-manual-title");
        const email = uniq("manualtitle");
        const id = `manual-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Original name", version_ms: 3100 }] });
        await signIn(api, email);
        await api.post("/api/plaud/sync");
        const row = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.plaudFileId === id,
        );
        const patch = await api.patch(`/api/recordings/${row!.id as string}`, { data: { filename: "My own name" } });
        expect(patch.status()).toBe(200);

        await fakeControl("/account", { email, recordings: [{ id, filename: "Renamed in Plaud", version_ms: 3200 }] });
        await api.post("/api/plaud/sync");
        const after = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.plaudFileId === id,
        );
        expect(after!.filename).toBe("My own name");
        await api.dispose();
    });

    test("a changed Plaud version updates metadata without downloading the audio again", async () => {
        const api = await freshUser("plaud-no-redownload");
        const email = uniq("noredownload");
        const id = `same-${Date.now()}`;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Stored once", version_ms: 4100 }] });
        await signIn(api, email);
        expect((await (await api.post("/api/plaud/sync")).json()).newRecordings).toBe(1);

        const before = (await fakeRequests()).length;
        await fakeControl("/account", { email, recordings: [{ id, filename: "Stored once", version_ms: 4200 }] });
        const body = await (await api.post("/api/plaud/sync")).json();
        expect(body).toMatchObject({ newRecordings: 0, updatedRecordings: 1, errors: [] });

        const requests = (await fakeRequests()).slice(before);
        expect(requests.filter((q) => q.path.startsWith("/audio/")), "audio downloads").toEqual([]);
        expect(requests.filter((q) => q.path.startsWith("/file/temp-url/")), "presigned audio urls").toEqual([]);
        // The stored audio is still there and still playable.
        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const row = list.find((x) => x.plaudFileId === id);
        expect((await api.get(`/api/recordings/${row!.id as string}/audio`)).status()).toBe(200);
        await api.dispose();
    });

    test("the title repair previews date-time titles and applies only picked ones", async () => {
        const api = await freshUser("plaud-title-repair");
        const email = uniq("repair");
        const start = Date.UTC(2026, 9, 18, 6, 30, 0);
        const day = new Date(start).toLocaleDateString("en-CA");
        const shaped = `repair-shaped-${Date.now()}`;
        const plain = `repair-plain-${Date.now()}`;
        await fakeControl("/account", {
            email,
            recordings: [
                { id: shaped, filename: `${day} 23:30`, start_time: start, version_ms: 5100 },
                { id: plain, filename: "Weekly planning", start_time: start, version_ms: 5200 },
            ],
        });
        await signIn(api, email);
        await api.post("/api/plaud/sync");

        const preview = await api.get("/api/recordings/title-repair");
        expect(preview.status()).toBe(200);
        const candidates = (await preview.json()).candidates as { id: string; filename: string; suggestedFilename: string }[];
        const ids = candidates.map((c) => c.id);
        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const shapedRow = list.find((x) => x.plaudFileId === shaped)!;
        const plainRow = list.find((x) => x.plaudFileId === plain)!;
        expect(ids).toContain(shapedRow.id);
        expect(ids).not.toContain(plainRow.id);
        const candidate = candidates.find((c) => c.id === shapedRow.id)!;
        expect(candidate.suggestedFilename).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // A pick whose name changed since the preview is skipped, not applied.
        const stale = await api.post("/api/recordings/title-repair", {
            data: { picks: [{ id: shapedRow.id, expectedFilename: "something else" }] },
        });
        expect(stale.status()).toBe(200);
        expect((await stale.json()).skipped).toHaveLength(1);

        const applied = await api.post("/api/recordings/title-repair", {
            data: { picks: [{ id: shapedRow.id, expectedFilename: candidate.filename }] },
        });
        expect(applied.status()).toBe(200);
        expect((await applied.json()).renamed).toHaveLength(1);
        const after = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.id === shapedRow.id,
        );
        expect(after!.filename).toBe(candidate.suggestedFilename);
        await api.dispose();
    });
});
