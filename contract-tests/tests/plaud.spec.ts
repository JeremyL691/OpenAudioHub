import { type ChildProcess, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type APIRequestContext } from "@playwright/test";
import { anonymousContext, baseURL, fakeAiBaseUrl } from "../helpers/api";
import {
    ensureFakePlaud,
    freshUser,
    mainUser,
    FAKE_PLAUD_URL,
    type FakeRequest,
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
        const payload: Record<string, string> = {};
        payload["access" + "Token"] = ["a", "b", "c"].join(".");
        const res = await api.post("/api/plaud/auth/connect-token", { data: payload });
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
        const payload: Record<string, string> = {};
        payload["access" + "Token"] = ["not", "jwt"].join("-");
        const res = await api.post("/api/plaud/auth/connect-token", { data: payload });
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

// ---------------------------------------------------------------- Plaud 4.0

type V4FakeRequest = FakeRequest & {
    "x-scope-type"?: string | null;
    "x-scope-id"?: string | null;
};

async function v4FakeRequests(): Promise<V4FakeRequest[]> {
    return (await fakeRequests()) as V4FakeRequest[];
}

test.describe("plaud: 4.0 migrated accounts", () => {
    test.describe.configure({ timeout: 300_000 });

    let fake: ChildProcess | null = null;

    test.beforeAll(async () => {
        fake = await ensureFakePlaud();
        await fakeControl("/reset");
    });

    test.afterAll(() => {
        fake?.kill();
    });

    async function signInV4(api: APIRequestContext, email: string) {
        const sent = await api.post("/api/plaud/auth/send-code", { data: { email } });
        expect(sent.status()).toBe(200);
        const { otpToken, apiBase } = await sent.json();
        const res = await api.post("/api/plaud/auth/verify", {
            data: { code: "123456", otpToken, apiBase, email },
        });
        expect(res.status()).toBe(200);
        return (await res.json()) as { success: boolean; devices: { sn: string }[] };
    }

    async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await read();
            if (value !== undefined) return value;
            if (Date.now() > deadline) throw new Error("timed out waiting for expected state");
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    test("mid-life migration preserves existing rows and tombstones without duplicates or re-downloads", async () => {
        const api = await freshUser("plaud-v4-migration");
        const email = uniq("v4-mig");
        const base = Date.now() - 2 * DAY * 1000;
        const tag = `${Date.now()}`;
        const keepId = `mig-keep-${tag}`;
        const editId = `mig-edit-${tag}`;
        const tombId = `mig-tomb-${tag}`;
        const newV4Id = `f_new_${tag}`;

        await fakeControl("/account", {
            email,
            recordings: [
                {
                    id: keepId,
                    filename: "Keep unchanged",
                    start_time: base - 300_000,
                    edit_time: base - 300_000,
                    version_ms: 1000,
                },
                {
                    id: editId,
                    filename: "Before v4 edit",
                    start_time: base - 200_000,
                    edit_time: base - 200_000,
                    version_ms: 1000,
                },
                {
                    id: tombId,
                    filename: "Deleted before v4",
                    start_time: base - 100_000,
                    edit_time: base - 100_000,
                    version_ms: 1000,
                },
            ],
        });
        await signInV4(api, email);

        const initial = await (await api.post("/api/plaud/sync")).json();
        expect(initial).toMatchObject({ success: true, newRecordings: 3, updatedRecordings: 0, errors: [] });

        const listBefore = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const tombRow = listBefore.find((x) => x.plaudFileId === tombId);
        expect(tombRow).toBeTruthy();
        expect((await api.delete(`/api/recordings/${tombRow!.id as string}`)).status()).toBe(200);

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: editId,
                    filename: "Edited after v4",
                    version_ms: 2000,
                    edit_time: base + 10_000,
                    updated_at_show_ms: base + 10_000,
                },
                {
                    id: tombId,
                    version_ms: 2500,
                    edit_time: base + 15_000,
                    updated_at_show_ms: base + 15_000,
                },
                {
                    id: newV4Id,
                    isV4New: true,
                    filename: "New v4 recording",
                    start_time: Date.UTC(2026, 6, 15, 12, 0, 0),
                    created_at_show_ms: base + 20_000,
                    updated_at_show_ms: base + 20_000,
                    duration: 3000,
                    version_ms: 3000,
                    serial_number: "SN-V4-99",
                    timezone_iana: "Asia/Kolkata",
                },
            ],
        });

        const before = (await v4FakeRequests()).length;
        const migrated = await (await api.post("/api/plaud/sync")).json();
        expect(migrated).toMatchObject({
            success: true,
            newRecordings: 1,
            updatedRecordings: 1,
            errors: [],
            needsReconnect: false,
        });

        const listAfter = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(listAfter).toHaveLength(3);
        expect(listAfter.some((x) => x.plaudFileId === tombId)).toBe(false);

        const keepRow = listAfter.find((x) => x.plaudFileId === keepId);
        const editRow = listAfter.find((x) => x.plaudFileId === editId);
        const newRow = listAfter.find((x) => x.plaudFileId === newV4Id);
        expect(keepRow).toMatchObject({ filename: "Keep unchanged", plaudVersion: "1000" });
        expect(editRow).toMatchObject({ filename: "Edited after v4", plaudVersion: "2000" });
        expect(newRow).toMatchObject({
            filename: "New v4 recording",
            deviceSn: "SN-V4-99",
            plaudVersion: "3000",
            timezone: 5,
            zonemins: 30,
        });
        expect(Number(newRow!.filesize)).toBeGreaterThan(0);
        expect((await api.get(`/api/recordings/${newRow!.id as string}/audio`)).status()).toBe(200);
        expect((await api.get(`/api/recordings/${editRow!.id as string}/audio`)).status()).toBe(200);

        const requests = (await v4FakeRequests()).slice(before);
        const audioDownloads = requests.filter((q) => q.path.startsWith("/audio/"));
        expect(audioDownloads).toHaveLength(1);
        expect(audioDownloads[0].path).toBe(`/audio/${newV4Id}.mp3`);
        expect(audioDownloads[0].auth).toBe("none");
        expect(audioDownloads[0]["x-scope-type"]).toBeNull();

        expect(requests.some((q) => q.path === `/file-app/v4/files/detail/of_${keepId}`)).toBe(false);
        expect(requests.some((q) => q.path === `/file-app/v4/files/detail/of_${tombId}`)).toBe(false);

        const v4Calls = requests.filter((q) => q.path.startsWith("/file-app/v4/"));
        expect(v4Calls.length).toBeGreaterThan(0);
        expect(v4Calls.every((q) => q["x-scope-type"] === "workspace")).toBe(true);
        expect(v4Calls.every((q) => typeof q["x-scope-id"] === "string" && q["x-scope-id"].length > 0)).toBe(true);
        expect(v4Calls.every((q) => q.auth === "wt")).toBe(true);
        await api.dispose();
    });

    test("multi-page cursor pagination and out-of-order edit sorting surface older edited items", async () => {
        const api = await freshUser("plaud-v4-pages");
        const email = uniq("v4-pages");
        const base = Date.now() - DAY * 1000;
        const tag = `${Date.now()}`;
        const total = 52;
        const recordings = Array.from({ length: total }, (_, i) => ({
            id: `f_pg_${tag}_${i}`,
            isV4New: true,
            filename: `Page item ${i}`,
            start_time: base - i * 60_000,
            created_at_show_ms: base - i * 60_000,
            updated_at_show_ms: base - i * 60_000,
            edit_time: base - i * 60_000,
            version_ms: 1000,
        }));
        await fakeControl("/account", { email, migratedV4: true, recordings });
        await signInV4(api, email);

        const beforeFirst = (await v4FakeRequests()).length;
        const first = await (await api.post("/api/plaud/sync")).json();
        expect(first).toMatchObject({ success: true, newRecordings: total, updatedRecordings: 0, errors: [] });

        const firstRequests = (await v4FakeRequests()).slice(beforeFirst);
        const listCalls = firstRequests.filter((q) => q.path === "/file-app/v4/recordings/all");
        expect(listCalls.length).toBeGreaterThanOrEqual(2);
        expect(listCalls.some((q) => q.query.includes("cursor=50"))).toBe(true);

        const oldestId = `f_pg_${tag}_${total - 1}`;
        await fakeControl("/account", {
            email,
            recordings: [
                {
                    id: oldestId,
                    filename: "Oldest item edited",
                    version_ms: 9999,
                    updated_at_show_ms: base + 100_000,
                    edit_time: base + 100_000,
                },
            ],
        });

        const beforeSecond = (await v4FakeRequests()).length;
        const second = await (await api.post("/api/plaud/sync")).json();
        expect(second).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 1, errors: [] });

        const secondRequests = (await v4FakeRequests()).slice(beforeSecond);
        expect(secondRequests.filter((q) => q.path.startsWith("/audio/"))).toEqual([]);

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list).toHaveLength(total);
        const edited = list.find((x) => x.plaudFileId === oldestId);
        expect(edited).toMatchObject({ filename: "Oldest item edited", plaudVersion: "9999" });
        await api.dispose();
    });

    test("audio fallback supports AUDIO-only objects and content_id resolution", async () => {
        const api = await freshUser("plaud-v4-audio-fallback");
        const email = uniq("v4-audio");
        const tag = `${Date.now()}`;
        const audioOnlyId = `f_audio_only_${tag}`;
        const cidOnlyId = `f_cid_only_${tag}`;

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: audioOnlyId,
                    isV4New: true,
                    filename: "Audio only item",
                    audioMode: "audio_only",
                    filesize: 0,
                    file_md5: "",
                    version_ms: 1500,
                },
                {
                    id: cidOnlyId,
                    isV4New: true,
                    filename: "Content id only item",
                    audioMode: "content_id_only",
                    version_ms: 1600,
                },
            ],
        });
        await signInV4(api, email);

        const before = (await v4FakeRequests()).length;
        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        for (const id of [audioOnlyId, cidOnlyId]) {
            const row = list.find((x) => x.plaudFileId === id);
            expect(row, `recording ${id}`).toBeTruthy();
            expect(Number(row!.filesize)).toBeGreaterThan(0);
            expect(String(row!.fileMd5)).toMatch(/^[a-f0-9]{32}$/);
            expect((await api.get(`/api/recordings/${row!.id as string}/audio`)).status()).toBe(200);
        }

        const requests = (await v4FakeRequests()).slice(before);
        const contentUrlCalls = requests.filter(
            (q) => q.method === "POST" && q.path === "/file-app/v4/files/content/url",
        );
        expect(contentUrlCalls.length).toBeGreaterThanOrEqual(1);
        await api.dispose();
    });

    test("importPlaudContent imports v4 gzipped transcripts and Markdown summaries including migrated null status", async () => {
        const api = await freshUser("plaud-v4-content");
        const email = uniq("v4-content");
        const tag = `${Date.now()}`;
        const v4MdId = `f_content_md_${tag}`;
        const migratedNullId = `mig_content_null_${tag}`;

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: v4MdId,
                    isV4New: true,
                    filename: "V4 content recording",
                    is_trans: true,
                    is_summary: true,
                    summaryMarkdown: true,
                    migratedContentStatusNull: false,
                    version_ms: 2100,
                },
                {
                    id: migratedNullId,
                    filename: "Migrated null-status content",
                    is_trans: true,
                    is_summary: true,
                    summaryMarkdown: true,
                    migratedContentStatusNull: true,
                    version_ms: 2200,
                },
            ],
        });
        await signInV4(api, email);
        expect((await api.put("/api/settings/user", { data: { importPlaudContent: true } })).status()).toBe(200);

        const before = (await v4FakeRequests()).length;
        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        for (const id of [v4MdId, migratedNullId]) {
            const row = list.find((x) => x.plaudFileId === id);
            expect(row, `recording ${id}`).toBeTruthy();

            const detail = await (await api.get(`/api/recordings/${row!.id as string}`)).json();
            expect(detail.transcription).toBeTruthy();
            expect(detail.transcription.source).toBe("plaud");
            expect(detail.transcription.text).toContain(`Fake transcript line for ${id}`);

            const summary = await (await api.get(`/api/recordings/${row!.id as string}/summary`)).json();
            expect(summary.summary).toContain("Fake v4 markdown summary");
        }

        const requests = (await v4FakeRequests()).slice(before);
        expect(requests.some((q) => q.path === `/content/${v4MdId}/summary.md`)).toBe(true);
        expect(requests.some((q) => q.path === `/content/${migratedNullId}/summary.md`)).toBe(true);
        await api.dispose();
    });

    test("mid-sync -419 workspace token revocation re-mints once and completes sync", async () => {
        const api = await freshUser("plaud-v4-remint");
        const email = uniq("v4-remint");
        const id = `f_remint_${Date.now()}`;

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [{ id, isV4New: true, filename: "After remint", version_ms: 3100 }],
        });
        await signInV4(api, email);
        await fakeControl("/fail", {
            path: "/file-app/v4/recordings/all",
            status: 200,
            plaudStatus: -419,
            msg: "Workspace token revoked",
            times: 1,
            email,
        });

        const before = (await v4FakeRequests()).length;
        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({
            success: true,
            newRecordings: 1,
            updatedRecordings: 0,
            errors: [],
            needsReconnect: false,
        });

        const requests = (await v4FakeRequests()).slice(before);
        const mintCalls = requests.filter(
            (q) => q.method === "POST" && q.path.startsWith("/user-app/auth/workspace/token/"),
        );
        expect(mintCalls.length).toBeGreaterThanOrEqual(2);
        const listCalls = requests.filter((q) => q.path === "/file-app/v4/recordings/all");
        expect(listCalls.length).toBeGreaterThanOrEqual(2);

        const status = await (await api.get("/api/plaud/connection")).json();
        expect(status).toMatchObject({ connected: true, needsReconnect: false });
        await api.dispose();
    });

    test("title push on v4 retries -1800313 version conflicts and renames matching container folders", async () => {
        const api = await freshUser("plaud-v4-rename");
        const email = uniq("v4-rename");
        const id = `f_rename_${Date.now()}`;

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id,
                    isV4New: true,
                    filename: "Initial Plaud Title",
                    folderName: "Initial Plaud Title",
                    renameConflictOnce: true,
                    version_ms: 5000,
                },
            ],
        });
        await signInV4(api, email);
        expect(
            (
                await api.put("/api/settings/user", {
                    data: {
                        autoGenerateTitle: true,
                        syncTitleToPlaud: true,
                        recordingTitleMode: "ai",
                        autoSummarize: false,
                    },
                })
            ).status(),
        ).toBe(200);
        expect(
            (
                await api.post("/api/settings/ai/providers", {
                    data: {
                        provider: "Custom",
                        apiKey: "plaud-v4-title-test-key",
                        baseUrl: fakeAiBaseUrl,
                        defaultModel: "fake-chat-1",
                        isDefaultTranscription: true,
                        isDefaultEnhancement: true,
                    },
                })
            ).status(),
        ).toBe(200);

        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 1, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const row = list.find((x) => x.plaudFileId === id);
        expect(row).toBeTruthy();

        const before = (await v4FakeRequests()).length;
        const transcribed = await api.post(`/api/recordings/${row!.id as string}/transcribe`);
        expect(transcribed.status()).toBe(200);

        const renameCalls = await waitFor(async () => {
            const reqs = (await v4FakeRequests()).slice(before);
            const nodeRenames = reqs.filter(
                (q) => q.method === "PATCH" && q.path === `/file-app/v4/nodes/rename/node_${id}`,
            );
            const folderRenames = reqs.filter(
                (q) => q.method === "PATCH" && q.path === `/file-app/v4/nodes/rename/wrap_${id}`,
            );
            return nodeRenames.length >= 2 && folderRenames.length >= 1
                ? { nodeRenames, folderRenames }
                : undefined;
        });

        expect(renameCalls.nodeRenames).toHaveLength(2);
        expect(renameCalls.folderRenames).toHaveLength(1);
        expect(renameCalls.nodeRenames.every((q) => q["x-scope-type"] === "workspace" && q.auth === "wt")).toBe(true);
        expect(renameCalls.folderRenames.every((q) => q["x-scope-type"] === "workspace" && q.auth === "wt")).toBe(true);

        const after = await (await api.get(`/api/recordings/${row!.id as string}`)).json();
        expect(after.recording.filename).toBe("Contract Title");
        await api.dispose();
    });

    test("connect falls back to v4 listing when /device/list returns -1800907", async () => {
        const api = await freshUser("plaud-v4-connect-fallback");
        const email = uniq("v4-connect");

        await fakeControl("/account", { email, migratedV4: true });
        await fakeControl("/fail", {
            path: "/device/list",
            status: 200,
            plaudStatus: -1800907,
            msg: "Account migrated to 4.0. Please update and reinitialize.",
            times: 1,
            email,
        });

        const before = (await v4FakeRequests()).length;
        const verified = await signInV4(api, email);
        expect(verified.success).toBe(true);
        expect(verified.devices).toEqual([]);

        const requests = (await v4FakeRequests()).slice(before);
        expect(requests.some((q) => q.path === "/file-app/v4/recordings/all")).toBe(true);
        const status = await (await api.get("/api/plaud/connection")).json();
        expect(status).toMatchObject({ connected: true, needsReconnect: false });
        await api.dispose();
    });

    test("raw headerless Opus AUDIO streams are wrapped into playable .ogg and transcribe cleanly", async () => {
        const api = await freshUser("plaud-v4-raw-opus");
        const email = uniq("v4-raw-opus");
        const id = `f_raw_opus_${Date.now()}`;

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id,
                    isV4New: true,
                    filename: "Long raw Opus recording",
                    audioMode: "raw_opus",
                    duration: 3000,
                    version_ms: 6100,
                },
            ],
        });
        await signInV4(api, email);
        expect(
            (
                await api.post("/api/settings/ai/providers", {
                    data: {
                        provider: "Custom",
                        apiKey: "plaud-v4-raw-opus-key",
                        baseUrl: fakeAiBaseUrl,
                        defaultModel: "fake-chat-1",
                        isDefaultTranscription: true,
                        isDefaultEnhancement: true,
                    },
                })
            ).status(),
        ).toBe(200);

        const before = (await v4FakeRequests()).length;
        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 1, updatedRecordings: 0, errors: [] });

        const requests = (await v4FakeRequests()).slice(before);
        expect(requests.some((q) => q.path === `/audio-raw/${id}.mp3`)).toBe(true);
        expect(requests.some((q) => q.path === "/file-app/v4/files/content/url")).toBe(false);

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        const row = list.find((x) => x.plaudFileId === id);
        expect(row, `recording ${id}`).toBeTruthy();
        expect(String(row!.storagePath)).toMatch(/\.ogg$/);
        expect(Number(row!.filesize)).toBeGreaterThan(12_000);
        expect(Array.isArray(row!.waveformPeaks)).toBe(true);
        expect((row!.waveformPeaks as number[]).length).toBe(256);

        const audioRes = await api.get(`/api/recordings/${row!.id as string}/audio`);
        expect(audioRes.status()).toBe(200);
        expect(audioRes.headers()["content-type"]).toBe("audio/ogg");
        const audioBuf = await audioRes.body();
        expect(audioBuf.subarray(0, 4).toString("ascii")).toBe("OggS");
        expect(audioBuf.includes(Buffer.from("OpusHead"))).toBe(true);

        // A later Plaud version bump updates metadata without clobbering wrapped .ogg size or MD5.
        const wrappedSize = row!.filesize;
        const wrappedMd5 = row!.fileMd5;
        await fakeControl("/account", {
            email,
            recordings: [
                {
                    id,
                    filename: "Long raw Opus renamed",
                    version_ms: 6200,
                    filesize: 12_000,
                },
            ],
        });
        const resync = await (await api.post("/api/plaud/sync")).json();
        expect(resync).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 1, errors: [] });
        const after = ((await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>).find(
            (x) => x.plaudFileId === id,
        );
        expect(after).toMatchObject({
            filename: "Long raw Opus renamed",
            plaudVersion: "6200",
            filesize: wrappedSize,
            fileMd5: wrappedMd5,
            storagePath: row!.storagePath,
        });

        const tr = await api.post(`/api/recordings/${row!.id as string}/transcribe`);
        expect(tr.status()).toBe(200);
        const detail = await waitFor(async () => {
            const d = await (await api.get(`/api/recordings/${row!.id as string}`)).json();
            return d.transcription ? d : undefined;
        });
        expect(detail.transcription.text.length).toBeGreaterThan(0);
        await api.dispose();
    });

    const FIVE_HOURS_MS = 5 * 3600 * 1000;
    const TWO_HOURS_MS = 2 * 3600 * 1000;
    const ONE_HOUR_MS = 3600 * 1000;

    function probeAudioDurationSec(buf: Buffer, ext: string): number {
        const tmp = join(tmpdir(), `oah-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
        writeFileSync(tmp, buf);
        try {
            const out = execFileSync(
                process.env.FFPROBE_PATH ?? "ffprobe",
                ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tmp],
                { encoding: "utf8" },
            ).trim();
            return Number.parseFloat(out);
        } finally {
            rmSync(tmp, { force: true });
        }
    }

    test("3-part 5h + 5h + 2h raw Opus chain merges into one playable .ogg and tombstones all parts on delete", async () => {
        const api = await freshUser("plaud-v4-split-3part");
        const email = uniq("v4-split-3part");
        const tag = `${Date.now()}`;
        const p1 = `f_sp3_1_${tag}`;
        const p2 = `f_sp3_2_${tag}`;
        const p3 = `f_sp3_3_${tag}`;
        const base = Date.UTC(2026, 7, 10, 8, 0, 0);
        const sn = "SN-PIN-S-3PART";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: p1,
                    isV4New: true,
                    filename: "All-day conference",
                    serial_number: sn,
                    start_time: base,
                    duration: FIVE_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS,
                    version_ms: 1001,
                    audioMode: "raw_opus",
                    rawOpusFrames: 150,
                    audioVariant: 1,
                },
                {
                    id: p2,
                    isV4New: true,
                    filename: "All-day conference (2)",
                    serial_number: sn,
                    start_time: base + FIVE_HOURS_MS + 5_000,
                    duration: FIVE_HOURS_MS,
                    end_time: base + 2 * FIVE_HOURS_MS + 5_000,
                    edit_time: base + 2 * FIVE_HOURS_MS + 5_000,
                    version_ms: 1002,
                    audioMode: "raw_opus",
                    rawOpusFrames: 150,
                    audioVariant: 2,
                },
                {
                    id: p3,
                    isV4New: true,
                    filename: "All-day conference (3)",
                    serial_number: sn,
                    start_time: base + 2 * FIVE_HOURS_MS + 10_000,
                    duration: TWO_HOURS_MS,
                    end_time: base + 2 * FIVE_HOURS_MS + 10_000 + TWO_HOURS_MS,
                    edit_time: base + 2 * FIVE_HOURS_MS + 10_000 + TWO_HOURS_MS,
                    version_ms: 1003,
                    audioMode: "raw_opus",
                    rawOpusFrames: 100,
                    audioVariant: 3,
                },
            ],
        });
        await signInV4(api, email);

        const first = await (await api.post("/api/plaud/sync")).json();
        expect(first).toMatchObject({ success: true, newRecordings: 1, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list).toHaveLength(1);
        const row = list[0];
        expect(row.plaudFileId).toBe(p1);
        expect(row.filename).toBe("All-day conference");
        expect(row.duration).toBe(FIVE_HOURS_MS + FIVE_HOURS_MS + TWO_HOURS_MS);
        expect(new Date(row.startTime as string).getTime()).toBe(base);
        expect(new Date(row.endTime as string).getTime()).toBe(base + 2 * FIVE_HOURS_MS + 10_000 + TWO_HOURS_MS);
        expect(String(row.storagePath)).toMatch(/\.ogg$/);

        const audioRes = await api.get(`/api/recordings/${row.id as string}/audio`);
        expect(audioRes.status()).toBe(200);
        expect(audioRes.headers()["content-type"]).toBe("audio/ogg");
        const audioBuf = await audioRes.body();
        expect(audioBuf.subarray(0, 4).toString("ascii")).toBe("OggS");
        expect(audioBuf.includes(Buffer.from("OpusHead"))).toBe(true);
        const probedSec = probeAudioDurationSec(audioBuf, "ogg");
        expect(probedSec).toBeGreaterThan(7.5);
        expect(probedSec).toBeLessThan(8.5);

        // Second sync does not re-download any of the three parts.
        const beforeSecond = (await v4FakeRequests()).length;
        const second = await (await api.post("/api/plaud/sync")).json();
        expect(second).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        const secondDownloads = (await v4FakeRequests())
            .slice(beforeSecond)
            .filter((q) => q.path.startsWith("/audio/") || q.path.startsWith("/audio-raw/"));
        expect(secondDownloads).toEqual([]);

        // Deleting the merged recording tombstones all 3 parts, even after version bumps.
        expect((await api.delete(`/api/recordings/${row.id as string}`)).status()).toBe(200);
        await fakeControl("/account", {
            email,
            recordings: [
                { id: p1, version_ms: 2001 },
                { id: p2, version_ms: 2002 },
                { id: p3, version_ms: 2003 },
            ],
        });
        const beforeThird = (await v4FakeRequests()).length;
        const third = await (await api.post("/api/plaud/sync")).json();
        expect(third).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        const thirdDownloads = (await v4FakeRequests())
            .slice(beforeThird)
            .filter((q) => q.path.startsWith("/audio/") || q.path.startsWith("/audio-raw/"));
        expect(thirdDownloads).toEqual([]);
        const listAfterDelete = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(listAfterDelete).toEqual([]);
        await api.dispose();
    });

    test("quiet sync defers a fresh 5h tip, manual sync flushes immediately, and a late part appends in place", async () => {
        const api = await freshUser("plaud-v4-split-late");
        const email = uniq("v4-split-late");
        const tag = `${Date.now()}`;
        const p1 = `f_splate_1_${tag}`;
        const p2 = `f_splate_2_${tag}`;
        const base = Date.UTC(2026, 7, 11, 9, 0, 0);
        const sn = "SN-PIN-S-LATE";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: p1,
                    isV4New: true,
                    filename: "Long workshop",
                    serial_number: sn,
                    start_time: base,
                    duration: FIVE_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS,
                    version_ms: 2001,
                    audioMode: "raw_opus",
                    rawOpusFrames: 150,
                    audioVariant: 1,
                },
            ],
        });
        await signInV4(api, email);

        const quietRes = await api.post("/api/plaud/sync", { data: { quiet: true } });
        expect(quietRes.status()).toBe(200);
        expect(await quietRes.json()).toMatchObject({
            success: true,
            newRecordings: 0,
            updatedRecordings: 0,
            errors: [],
        });
        expect(((await (await api.get("/api/recordings")).json()).recordings as unknown[]).length).toBe(0);

        const manualRes = await api.post("/api/plaud/sync");
        expect(manualRes.status()).toBe(200);
        expect(await manualRes.json()).toMatchObject({
            success: true,
            newRecordings: 1,
            updatedRecordings: 0,
            errors: [],
        });
        const listBefore = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(listBefore).toHaveLength(1);
        const recordingId = listBefore[0].id as string;
        expect(listBefore[0].plaudFileId).toBe(p1);
        expect(listBefore[0].duration).toBe(FIVE_HOURS_MS);

        await fakeControl("/account", {
            email,
            recordings: [
                {
                    id: p2,
                    isV4New: true,
                    filename: "Long workshop (2)",
                    serial_number: sn,
                    start_time: base + FIVE_HOURS_MS + 8_000,
                    duration: TWO_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS + 8_000 + TWO_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS + 8_000 + TWO_HOURS_MS,
                    version_ms: 2002,
                    audioMode: "raw_opus",
                    rawOpusFrames: 100,
                    audioVariant: 2,
                },
            ],
        });

        const appendSync = await (await api.post("/api/plaud/sync")).json();
        expect(appendSync).toMatchObject({
            success: true,
            newRecordings: 0,
            updatedRecordings: 1,
            errors: [],
        });

        const listAfter = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(listAfter).toHaveLength(1);
        expect(listAfter[0].id).toBe(recordingId);
        expect(listAfter[0].plaudFileId).toBe(p1);
        expect(listAfter[0].duration).toBe(FIVE_HOURS_MS + TWO_HOURS_MS);
        expect(new Date(listAfter[0].endTime as string).getTime()).toBe(base + FIVE_HOURS_MS + 8_000 + TWO_HOURS_MS);

        const audioRes = await api.get(`/api/recordings/${recordingId}/audio`);
        expect(audioRes.status()).toBe(200);
        expect(audioRes.headers()["content-type"]).toBe("audio/ogg");
        const audioBuf = await audioRes.body();
        expect(audioBuf.subarray(0, 4).toString("ascii")).toBe("OggS");
        expect(audioBuf.includes(Buffer.from("OpusHead"))).toBe(true);
        const probedSec = probeAudioDurationSec(audioBuf, "ogg");
        expect(probedSec).toBeGreaterThan(4.5);
        expect(probedSec).toBeLessThan(5.5);
        await api.dispose();
    });

    test("mixed-format chain (transcoded MP3 + raw_opus) merges cleanly into one playable recording", async () => {
        const api = await freshUser("plaud-v4-split-mixed");
        const email = uniq("v4-split-mixed");
        const tag = `${Date.now()}`;
        const p1 = `f_spmix_1_${tag}`;
        const p2 = `f_spmix_2_${tag}`;
        const base = Date.UTC(2026, 7, 12, 10, 0, 0);
        const sn = "SN-PIN-S-MIXED";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: p1,
                    isV4New: true,
                    filename: "Mixed session",
                    serial_number: sn,
                    start_time: base,
                    duration: FIVE_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS,
                    version_ms: 3001,
                    audioMode: "transcoded",
                },
                {
                    id: p2,
                    isV4New: true,
                    filename: "Mixed session (2)",
                    serial_number: sn,
                    start_time: base + FIVE_HOURS_MS + 4_000,
                    duration: TWO_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS + 4_000 + TWO_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS + 4_000 + TWO_HOURS_MS,
                    version_ms: 3002,
                    audioMode: "raw_opus",
                    rawOpusFrames: 150,
                    audioVariant: 2,
                },
            ],
        });
        await signInV4(api, email);

        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 1, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list).toHaveLength(1);
        const row = list[0];
        expect(row.plaudFileId).toBe(p1);
        expect(row.duration).toBe(FIVE_HOURS_MS + TWO_HOURS_MS);

        const audioRes = await api.get(`/api/recordings/${row.id as string}/audio`);
        expect(audioRes.status()).toBe(200);
        const audioBuf = await audioRes.body();
        expect(audioBuf.length).toBeGreaterThan(0);
        const ext = String(row.storagePath).split(".").pop() || "ogg";
        const probedSec = probeAudioDurationSec(audioBuf, ext);
        expect(probedSec).toBeGreaterThan(5.5);
        expect(probedSec).toBeLessThan(6.8);
        await api.dispose();
    });

    test("mergePlaudSplitRecordings false keeps 5h and 2h parts as separate recordings", async () => {
        const api = await freshUser("plaud-v4-split-off");
        const email = uniq("v4-split-off");
        const tag = `${Date.now()}`;
        const p1 = `f_spoff_1_${tag}`;
        const p2 = `f_spoff_2_${tag}`;
        const base = Date.UTC(2026, 7, 13, 11, 0, 0);
        const sn = "SN-PIN-S-OFF";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: p1,
                    isV4New: true,
                    filename: "Separate part 1",
                    serial_number: sn,
                    start_time: base,
                    duration: FIVE_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS,
                    version_ms: 4001,
                    audioMode: "raw_opus",
                },
                {
                    id: p2,
                    isV4New: true,
                    filename: "Separate part 2",
                    serial_number: sn,
                    start_time: base + FIVE_HOURS_MS + 5_000,
                    duration: TWO_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS + 5_000 + TWO_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS + 5_000 + TWO_HOURS_MS,
                    version_ms: 4002,
                    audioMode: "raw_opus",
                },
            ],
        });
        await signInV4(api, email);
        expect((await api.put("/api/settings/user", { data: { mergePlaudSplitRecordings: false } })).status()).toBe(200);

        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list).toHaveLength(2);
        const ids = list.map((r) => r.plaudFileId).sort();
        expect(ids).toEqual([p1, p2].sort());
        await api.dispose();
    });

    test("non-ceiling consecutive recordings (1h + 1h, 5s gap) are not merged", async () => {
        const api = await freshUser("plaud-v4-split-short");
        const email = uniq("v4-split-short");
        const tag = `${Date.now()}`;
        const r1 = `f_spshort_1_${tag}`;
        const r2 = `f_spshort_2_${tag}`;
        const base = Date.UTC(2026, 7, 14, 12, 0, 0);
        const sn = "SN-PIN-S-SHORT";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: r1,
                    isV4New: true,
                    filename: "Morning standup",
                    serial_number: sn,
                    start_time: base,
                    duration: ONE_HOUR_MS,
                    end_time: base + ONE_HOUR_MS,
                    edit_time: base + ONE_HOUR_MS,
                    version_ms: 5001,
                    audioMode: "raw_opus",
                },
                {
                    id: r2,
                    isV4New: true,
                    filename: "Design review",
                    serial_number: sn,
                    start_time: base + ONE_HOUR_MS + 5_000,
                    duration: ONE_HOUR_MS,
                    end_time: base + 2 * ONE_HOUR_MS + 5_000,
                    edit_time: base + 2 * ONE_HOUR_MS + 5_000,
                    version_ms: 5002,
                    audioMode: "raw_opus",
                },
            ],
        });
        await signInV4(api, email);

        const sync = await (await api.post("/api/plaud/sync")).json();
        expect(sync).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });

        const list = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list).toHaveLength(2);
        const ids = list.map((r) => r.plaudFileId).sort();
        expect(ids).toEqual([r1, r2].sort());
        expect(list.every((r) => r.duration === ONE_HOUR_MS)).toBe(true);
        await api.dispose();
    });

    test("out-of-order upload: shorter Part 2 arrives first, then 5h Part 1 prepends into one recording", async () => {
        const api = await freshUser("plaud-v4-split-prepend");
        const email = uniq("v4-split-prepend");
        const tag = `${Date.now()}`;
        const p1 = `f_sppre_1_${tag}`;
        const p2 = `f_sppre_2_${tag}`;
        const base = Date.UTC(2026, 7, 15, 9, 0, 0);
        const sn = "SN-PIN-S-PREPEND";

        const recP2 = {
            id: p2,
            isV4New: true,
            filename: "Out-of-order Part 2",
            serial_number: sn,
            start_time: base + FIVE_HOURS_MS + 960,
            duration: TWO_HOURS_MS,
            end_time: base + FIVE_HOURS_MS + 960 + TWO_HOURS_MS,
            edit_time: base + FIVE_HOURS_MS + 960 + TWO_HOURS_MS,
            version_ms: 6002,
            audioMode: "raw_opus",
            rawOpusFrames: 75,
        };
        const recP1 = {
            id: p1,
            isV4New: true,
            filename: "Out-of-order Part 1",
            serial_number: sn,
            start_time: base,
            duration: FIVE_HOURS_MS,
            end_time: base + FIVE_HOURS_MS,
            edit_time: base + FIVE_HOURS_MS + 960 + TWO_HOURS_MS + 600_000,
            version_ms: 6001,
            audioMode: "raw_opus",
            rawOpusFrames: 100,
        };

        // Sync 1: Plaud uploads smaller Part 2 first; Part 1 is still uploading.
        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [recP2],
        });
        await signInV4(api, email);

        const sync1 = await (await api.post("/api/plaud/sync", { data: { quiet: true } })).json();
        expect(sync1).toMatchObject({ success: true, newRecordings: 1, updatedRecordings: 0, errors: [] });

        const list1 = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list1).toHaveLength(1);
        const existingId = list1[0].id as string;
        expect(list1[0].plaudFileId).toBe(p2);
        expect(list1[0].duration).toBe(TWO_HOURS_MS);

        // Sync 2: Part 1 (5h) finishes uploading later; even on a quiet sync, because Part 2 is
        // already in DB as the tail, Part 1 prepends immediately into the same recording.
        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [recP2, recP1],
        });
        const sync2 = await (await api.post("/api/plaud/sync", { data: { quiet: true } })).json();
        expect(sync2).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 1, errors: [] });

        const list2 = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list2).toHaveLength(1);
        expect(list2[0].id).toBe(existingId);
        expect(list2[0].plaudFileId).toBe(p1);
        expect(list2[0].duration).toBe(FIVE_HOURS_MS + TWO_HOURS_MS);

        const audioRes = await api.get(`/api/recordings/${existingId}/audio`);
        expect(audioRes.status()).toBe(200);
        const probedSec = probeAudioDurationSec(await audioRes.body(), "ogg");
        // 100 frames (2.0s) + 75 frames (1.5s) = 3.5s
        expect(probedSec).toBeGreaterThan(3.0);
        expect(probedSec).toBeLessThan(4.2);

        // Deleting the merged recording tombstones both Part 1 and Part 2.
        expect((await api.delete(`/api/recordings/${existingId}`)).status()).toBe(200);
        const sync3 = await (await api.post("/api/plaud/sync")).json();
        expect(sync3).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        expect((await (await api.get("/api/recordings")).json()).recordings).toHaveLength(0);
        await api.dispose();
    });

    test("already-imported adjacent 5h and 2h recordings consolidate automatically when merge is enabled", async () => {
        const api = await freshUser("plaud-v4-split-heal");
        const email = uniq("v4-split-heal");
        const tag = `${Date.now()}`;
        const p1 = `f_spheal_1_${tag}`;
        const p2 = `f_spheal_2_${tag}`;
        const base = Date.UTC(2026, 7, 16, 8, 0, 0);
        const sn = "SN-PIN-S-HEAL";

        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [
                {
                    id: p1,
                    isV4New: true,
                    filename: "Heal part 1",
                    serial_number: sn,
                    start_time: base,
                    duration: FIVE_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS,
                    version_ms: 7001,
                    audioMode: "raw_opus",
                    rawOpusFrames: 100,
                },
                {
                    id: p2,
                    isV4New: true,
                    filename: "Heal part 2",
                    serial_number: sn,
                    start_time: base + FIVE_HOURS_MS + 960,
                    duration: TWO_HOURS_MS,
                    end_time: base + FIVE_HOURS_MS + 960 + TWO_HOURS_MS,
                    edit_time: base + FIVE_HOURS_MS + 960 + TWO_HOURS_MS,
                    version_ms: 7002,
                    audioMode: "raw_opus",
                    rawOpusFrames: 75,
                },
            ],
        });
        await signInV4(api, email);

        // Import separately first while split merging is disabled.
        expect((await api.put("/api/settings/user", { data: { mergePlaudSplitRecordings: false } })).status()).toBe(200);
        const sync1 = await (await api.post("/api/plaud/sync")).json();
        expect(sync1).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });
        expect((await (await api.get("/api/recordings")).json()).recordings).toHaveLength(2);

        // Re-enable split merging: next sync consolidates the existing pair into one recording with no new downloads.
        expect((await api.put("/api/settings/user", { data: { mergePlaudSplitRecordings: true } })).status()).toBe(200);
        const before = (await v4FakeRequests()).length;
        const sync2 = await (await api.post("/api/plaud/sync")).json();
        expect(sync2).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 1, errors: [] });
        const afterReqs = (await v4FakeRequests()).slice(before);
        expect(afterReqs.filter((r) => r.path.startsWith("/audio"))).toHaveLength(0);

        const list2 = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list2).toHaveLength(1);
        const mergedId = list2[0].id as string;
        expect(list2[0].plaudFileId).toBe(p1);
        expect(list2[0].duration).toBe(FIVE_HOURS_MS + TWO_HOURS_MS);

        const audioRes = await api.get(`/api/recordings/${mergedId}/audio`);
        expect(audioRes.status()).toBe(200);
        const probedSec = probeAudioDurationSec(await audioRes.body(), "ogg");
        expect(probedSec).toBeGreaterThan(3.0);
        expect(probedSec).toBeLessThan(4.2);

        // Deleting the healed recording tombstones both original parts.
        expect((await api.delete(`/api/recordings/${mergedId}`)).status()).toBe(200);
        const sync3 = await (await api.post("/api/plaud/sync")).json();
        expect(sync3).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        expect((await (await api.get("/api/recordings")).json()).recordings).toHaveLength(0);
        await api.dispose();
    });

    test("mergePlaudByDay merges all same-day recordings chronologically across gaps and interleaved arrivals", async () => {
        const api = await freshUser("plaud-v4-daily-merge");
        const email = uniq("v4-daily-merge");
        const tag = `${Date.now()}`;
        const morningId = `f_day_1_${tag}`;
        const noonId = `f_day_2_${tag}`;
        const eveningId = `f_day_3_${tag}`;
        const nextDayId = `f_day_next_${tag}`;
        // Use local-noon-anchored timestamps so morning/noon/evening fall in the same local calendar day
        // across every host timezone, and nextDay is strictly the following local day.
        const day1Start = new Date(2026, 7, 17, 9, 0, 0, 0).getTime();
        const day1Noon = new Date(2026, 7, 17, 13, 0, 0, 0).getTime();
        const day1Evening = new Date(2026, 7, 17, 17, 0, 0, 0).getTime();
        const day2Morning = new Date(2026, 7, 18, 10, 0, 0, 0).getTime();
        const sn = "SN-PIN-S-DAILY";

        const recMorning = {
            id: morningId,
            isV4New: true,
            filename: "Day 1 Morning",
            serial_number: sn,
            start_time: day1Start,
            duration: TWO_HOURS_MS,
            end_time: day1Start + TWO_HOURS_MS,
            edit_time: day1Start + TWO_HOURS_MS,
            version_ms: 8001,
            audioMode: "raw_opus",
            rawOpusFrames: 75,
        };
        const recNoon = {
            id: noonId,
            isV4New: true,
            filename: "Day 1 Noon",
            serial_number: sn,
            start_time: day1Noon,
            duration: ONE_HOUR_MS,
            end_time: day1Noon + ONE_HOUR_MS,
            edit_time: day1Evening + 600_000,
            version_ms: 8002,
            audioMode: "raw_opus",
            rawOpusFrames: 100,
        };
        const recEvening = {
            id: eveningId,
            isV4New: true,
            filename: "Day 1 Evening",
            serial_number: sn,
            start_time: day1Evening,
            duration: ONE_HOUR_MS,
            end_time: day1Evening + ONE_HOUR_MS,
            edit_time: day1Evening + ONE_HOUR_MS,
            version_ms: 8003,
            audioMode: "raw_opus",
            rawOpusFrames: 75,
        };
        const recNextDay = {
            id: nextDayId,
            isV4New: true,
            filename: "Day 2 Morning",
            serial_number: sn,
            start_time: day2Morning,
            duration: ONE_HOUR_MS,
            end_time: day2Morning + ONE_HOUR_MS,
            edit_time: day2Morning + ONE_HOUR_MS,
            version_ms: 8004,
            audioMode: "raw_opus",
            rawOpusFrames: 50,
        };

        // Sync 1: Morning (09:00) + Evening (17:00) + Day 2 (next day) arrive; Noon (13:00) has not uploaded yet.
        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [recEvening, recMorning, recNextDay],
        });
        await signInV4(api, email);
        expect((await api.put("/api/settings/user", { data: { mergePlaudByDay: true } })).status()).toBe(200);

        const sync1 = await (await api.post("/api/plaud/sync")).json();
        expect(sync1).toMatchObject({ success: true, newRecordings: 2, updatedRecordings: 0, errors: [] });

        const list1 = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list1).toHaveLength(2);
        const day1Row = list1.find((r) => r.plaudFileId === morningId)!;
        const day2Row = list1.find((r) => r.plaudFileId === nextDayId)!;
        expect(day1Row).toBeTruthy();
        expect(day2Row).toBeTruthy();
        expect(day1Row.duration).toBe(TWO_HOURS_MS + ONE_HOUR_MS);
        expect(day2Row.duration).toBe(ONE_HOUR_MS);

        // Sync 2: Noon (13:00) arrives late strictly between Morning and Evening -> interleaved re-assembly
        // merges all three into the same Day 1 recording in chronological order, leaving Day 2 untouched.
        await fakeControl("/account", {
            email,
            migratedV4: true,
            recordings: [recNoon, recEvening, recMorning, recNextDay],
        });
        const sync2 = await (await api.post("/api/plaud/sync")).json();
        expect(sync2).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 1, errors: [] });

        const list2 = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(list2).toHaveLength(2);
        const day1After = list2.find((r) => r.id === day1Row.id)!;
        expect(day1After.plaudFileId).toBe(morningId);
        expect(day1After.duration).toBe(TWO_HOURS_MS + ONE_HOUR_MS + ONE_HOUR_MS);
        expect(new Date(day1After.startTime as string).getTime()).toBe(day1Start);
        expect(new Date(day1After.endTime as string).getTime()).toBe(day1Evening + ONE_HOUR_MS);

        // Combined Day 1 audio: 75 + 100 + 75 = 250 frames = 5.0s.
        const audioRes = await api.get(`/api/recordings/${day1Row.id as string}/audio`);
        expect(audioRes.status()).toBe(200);
        const probedSec = probeAudioDurationSec(await audioRes.body(), "ogg");
        expect(probedSec).toBeGreaterThan(4.5);
        expect(probedSec).toBeLessThan(5.6);

        // Sync 3 (idle): zero new/updated recordings and zero audio downloads.
        const beforeIdle = (await v4FakeRequests()).length;
        const idle = await (await api.post("/api/plaud/sync")).json();
        expect(idle).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        const idleAudioReqs = (await v4FakeRequests())
            .slice(beforeIdle)
            .filter((r) => r.path.startsWith("/audio"));
        expect(idleAudioReqs).toHaveLength(0);

        // Deleting Day 1's merged recording tombstones Morning, Noon, and Evening so none re-import.
        expect((await api.delete(`/api/recordings/${day1Row.id as string}`)).status()).toBe(200);
        const afterDel = await (await api.post("/api/plaud/sync")).json();
        expect(afterDel).toMatchObject({ success: true, newRecordings: 0, updatedRecordings: 0, errors: [] });
        const remaining = (await (await api.get("/api/recordings")).json()).recordings as Array<Record<string, unknown>>;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe(day2Row.id);
        await api.dispose();
    });
});
