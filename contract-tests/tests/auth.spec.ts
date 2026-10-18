import { expect, test } from "@playwright/test";
import { baseURL, freshCredentials, type Credentials } from "../helpers/api";

// Black-box checks of the auth module, over HTTP only. Each test uses its own
// fresh accounts. The built-in sign-in, sign-up and reset limiter is per client
// IP, so helpers wait out 429 responses that carry no code.

const SESSION = process.env.OAH_SESSION_COOKIE ?? "oah_session";
const PASSWORD_OK = "password-long-enough-1";

interface Res {
    status: number;
    headers: Headers;
    cookies: string[];
    text: string;
    body: any;
}

async function call(
    method: "GET" | "POST",
    path: string,
    opts: {
        body?: unknown;
        cookie?: string;
        origin?: string | null;
        redirect?: RequestRedirect;
        /** Client address the limiter sees. Random per call unless given. */
        ip?: string;
    } = {},
): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.origin !== null) headers.origin = opts.origin ?? baseURL;
    headers["x-forwarded-for"] = opts.ip ?? randomIp();
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.cookie) headers.cookie = opts.cookie;
    const r = await fetch(baseURL + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: opts.redirect ?? "manual",
    });
    const text = await r.text();
    let body: any = null;
    try {
        body = JSON.parse(text);
    } catch {
        body = null;
    }
    return {
        status: r.status,
        headers: r.headers,
        cookies: r.headers.getSetCookie(),
        text,
        body,
    };
}

function randomIp(): string {
    const n = () => Math.floor(Math.random() * 250) + 1;
    return `10.${n()}.${n()}.${n()}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries a request while the built-in limiter (429 with no code) answers. */
async function patient(fn: () => Promise<Res>): Promise<Res> {
    let res = await fn();
    for (let i = 0; i < 6 && res.status === 429 && !res.body?.code; i++) {
        await sleep(11_000);
        res = await fn();
    }
    return res;
}

function signUp(who: Credentials): Promise<Res> {
    return patient(() =>
        call("POST", "/api/auth/sign-up/email", {
            body: { name: who.name, email: who.email, password: who.password },
        }),
    );
}

function signIn(who: Credentials, password = who.password): Promise<Res> {
    return patient(() =>
        call("POST", "/api/auth/sign-in/email", {
            body: { email: who.email, password },
        }),
    );
}

function sessionCookie(res: Res): string {
    const line = res.cookies.find((c) => c.startsWith(`${SESSION}=`));
    return line ? line.split(";")[0] : "";
}

/** A fresh account, signed in. Returns the cookie for later requests. */
async function newSession(label: string): Promise<{ who: Credentials; cookie: string }> {
    const who = freshCredentials(label);
    const up = await signUp(who);
    expect(up.status, "sign-up for fresh account").toBe(200);
    const si = await signIn(who);
    expect(si.status, "sign-in for fresh account").toBe(200);
    const cookie = sessionCookie(si);
    expect(cookie, "session cookie").toMatch(new RegExp(`^${SESSION}=.+`));
    return { who, cookie };
}

/**
 * One reset request. Retries after a wait when only the built-in limiter
 * (3 per 60 s per IP) answers, since that limit is shared by every client.
 */
async function resetRequest(email: string): Promise<Res> {
    let res = await call("POST", "/api/auth/request-password-reset", {
        body: { email, redirectTo: "/reset-password" },
    });
    for (let i = 0; i < 2 && res.status === 429 && !res.body?.code; i++) {
        await sleep(61_000);
        res = await call("POST", "/api/auth/request-password-reset", {
            body: { email, redirectTo: "/reset-password" },
        });
    }
    return res;
}

test.describe("auth", () => {
    test.setTimeout(180_000);

    test("anonymous get-session answers null", async () => {
        const res = await call("GET", "/api/auth/get-session");
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    test("sign-up returns the user and sets the session cookie", async () => {
        const who = freshCredentials("signup");
        const res = await signUp(who);
        expect(res.status).toBe(200);
        // The session token stays out of the body: the cookie is HttpOnly for a reason.
        expect(res.body.user.email).toBe(who.email);
        expect(res.body.user.name).toBe(who.name);
        expect(res.body.user.emailVerified).toBe(false);
        expect(typeof res.body.user.id).toBe("string");

        const line = res.cookies.find((c) => c.startsWith(`${SESSION}=`));
        expect(line, "session cookie set").toBeTruthy();
        expect(line).toContain("Max-Age=604800");
        expect(line).toContain("Path=/");
        expect(line).toContain("HttpOnly");
        expect(line).toContain("SameSite=Lax");
        expect(line).not.toMatch(/Domain=/i);
    });

    test("sign-in returns the token, user and session cookie", async () => {
        const who = freshCredentials("signin");
        expect((await signUp(who)).status).toBe(200);
        const res = await signIn(who);
        expect(res.status).toBe(200);
        expect(res.body.redirect).toBe(false);
        expect(res.body.user.email).toBe(who.email);
        expect(sessionCookie(res)).toMatch(new RegExp(`^${SESSION}=`));
    });

    test("get-session returns the session and user for the cookie", async () => {
        const { who, cookie } = await newSession("getsession");
        const res = await call("GET", "/api/auth/get-session", { cookie });
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe(who.email);
        expect(typeof res.body.session.userId).toBe("string");
        expect(res.body.session.userId).toBe(res.body.user.id);

        const ttl = Date.parse(res.body.session.expiresAt) - Date.now();
        const day = 24 * 60 * 60 * 1000;
        expect(ttl).toBeGreaterThan(6.9 * day);
        expect(ttl).toBeLessThan(7.1 * day);
    });

    test("a tampered session cookie reads as signed out", async () => {
        const res = await call("GET", "/api/auth/get-session", {
            cookie: `${SESSION}=abc.def`,
        });
        expect(res.status).toBe(200);
        expect(res.body).toBeNull();
    });

    test("sign-out ends the session and clears the cookie", async () => {
        const { cookie } = await newSession("signout");
        const out = await call("POST", "/api/auth/sign-out", {
            body: {},
            cookie,
        });
        expect(out.status).toBe(200);
        expect(out.body).toEqual({ success: true });
        const cleared = out.cookies.find((c) => c.startsWith(`${SESSION}=;`));
        expect(cleared, "session cookie cleared").toBeTruthy();
        expect(cleared).toContain("Max-Age=0");

        const after = await call("GET", "/api/auth/get-session", { cookie });
        expect(after.body).toBeNull();
    });

    test("wrong password and unknown email give the same error", async () => {
        const who = freshCredentials("wrongpw");
        expect((await signUp(who)).status).toBe(200);

        const wrong = await signIn(who, "not-the-password-1");
        expect(wrong.status).toBe(401);
        expect(wrong.body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
        expect(wrong.body.message ?? wrong.body.error).toBe("Invalid email or password");

        const unknown = await patient(() =>
            call("POST", "/api/auth/sign-in/email", {
                body: { email: `nobody-${who.email}`, password: PASSWORD_OK },
            }),
        );
        expect(unknown.status).toBe(401);
        expect(unknown.body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
        expect(unknown.body.message ?? unknown.body.error).toBe("Invalid email or password");
    });

    test("a second sign-up with the same email is rejected with 422", async () => {
        const who = freshCredentials("dupe");
        expect((await signUp(who)).status).toBe(200);
        const again = await signUp(who);
        expect(again.status).toBe(422);
        expect(again.body.code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
    });

    test("a password under 8 characters is rejected", async () => {
        const who = freshCredentials("shortpw");
        const res = await signUp({ ...who, password: "short12" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("PASSWORD_TOO_SHORT");
    });

    test("a malformed email or a missing name is a validation error", async () => {
        const who = freshCredentials("invalid");
        const badEmail = await signUp({ ...who, email: "not-an-email" });
        expect(badEmail.status).toBe(400);
        expect(badEmail.body.code).toBe("VALIDATION_ERROR");

        const noName = await patient(() =>
            call("POST", "/api/auth/sign-up/email", {
                body: { email: who.email, password: PASSWORD_OK },
            }),
        );
        expect(noName.status).toBe(400);
        expect(noName.body.code).toBe("VALIDATION_ERROR");
    });

    test("a cookie request from another origin is refused, and the session survives", async () => {
        const { cookie } = await newSession("forged");
        const forged = await call("POST", "/api/auth/sign-out", {
            body: {},
            cookie,
            origin: "https://evil.example",
        });
        expect(forged.status).toBe(403);
        expect(forged.body.code).toBe("INVALID_ORIGIN");

        const still = await call("GET", "/api/auth/get-session", { cookie });
        expect(still.body?.user).toBeTruthy();
    });

    test("a cookie request without an Origin header is refused", async () => {
        const { cookie } = await newSession("noorigin");
        const res = await call("POST", "/api/auth/sign-out", {
            body: {},
            cookie,
            origin: null,
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("MISSING_OR_NULL_ORIGIN");
    });

    test("a burst of sign-in attempts is throttled with 429", async () => {
        const who = freshCredentials("burst");
        expect((await signUp(who)).status).toBe(200);
        // The sign-in limiter allows 10 requests per minute per IP.
        const ip = randomIp();
        let last: Res | undefined;
        for (let i = 0; i < 12 && last?.status !== 429; i++) {
            last = await call("POST", "/api/auth/sign-in/email", {
                body: { email: who.email, password: "wrong-password-1" },
                ip,
            });
        }
        expect(last!.status).toBe(429);
        expect(typeof (last!.body.message ?? last!.body.error)).toBe("string");
    });

    test("the reset request answers the same for unknown emails", async () => {
        const res = await resetRequest(freshCredentials("unknown").email);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(true);
        expect(res.body.message).toBe(
            "If this email exists in our system, check your email for the reset link",
        );
    });

    test("the fourth reset request for one email in 60 seconds gets RATE_LIMITED", async () => {
        // Fresh email and clean window. Retry the whole sequence if the
        // shared per-IP reset limit answers first.
        let email = freshCredentials("resetflood").email;
        let ip = randomIp();
        let sent: Res[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
            sent = [];
            for (let i = 0; i < 3; i++) sent.push(await call("POST", "/api/auth/request-password-reset", {
                body: { email, redirectTo: "/reset-password" },
                ip,
            }));
            if (sent.every((r) => r.status === 200)) break;
            await sleep(61_000);
            email = freshCredentials("resetflood").email;
            ip = randomIp();
        }
        expect(sent.map((r) => r.status)).toEqual([200, 200, 200]);

        const limited = await call("POST", "/api/auth/request-password-reset", {
            body: { email, redirectTo: "/reset-password" },
            ip,
        });
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe("RATE_LIMITED");
        expect(limited.body.error).toBe(limited.body.message);
        const retry = Number(limited.headers.get("retry-after"));
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(60);
        expect(limited.headers.get("x-ratelimit-limit")).toBe("3");
        expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
        expect(Number(limited.headers.get("x-ratelimit-reset"))).toBeGreaterThan(
            Date.now() / 1000,
        );
    });

    test("a reset with a bogus token is refused as INVALID_TOKEN", async () => {
        const res = await call("POST", "/api/auth/reset-password", {
            body: { newPassword: PASSWORD_OK, token: "bogus-token" },
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_TOKEN");
        expect(res.body.message).toBe("Invalid token");
    });

    test("a reset with a short new password is refused before the token is checked", async () => {
        const res = await call("POST", "/api/auth/reset-password", {
            body: { newPassword: "short", token: "bogus-token" },
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("PASSWORD_TOO_SHORT");
    });

    test("the reset link for a bad token redirects with error=INVALID_TOKEN", async () => {
        const res = await call(
            "GET",
            "/api/auth/reset-password/bogus-token?callbackURL=/reset-password",
        );
        expect(res.status).toBe(302);
        const target = new URL(res.headers.get("location") ?? "", baseURL);
        expect(target.pathname).toBe("/reset-password");
        expect(target.searchParams.get("error")).toBe("INVALID_TOKEN");
    });

    test("an unknown /api/auth path is not found", async () => {
        const res = await call("POST", "/api/auth/no-such-endpoint", { body: {} });
        expect(res.status).toBe(404);
    });

    test("the desktop session exchange does not exist on a web build", async () => {
        const plain = await call("POST", "/api/desktop/session", { body: {} });
        expect(plain.status).toBe(404);
        const bearer = await call("POST", "/api/desktop/session", {
            body: {},
            origin: null,
        });
        expect(bearer.status).toBe(404);
    });

    test("API routes need a session, and accept the session cookie", async () => {
        const anon = await call("GET", "/api/recordings");
        expect(anon.status).toBe(401);
        expect(anon.body.code).toBe("AUTH_SESSION_MISSING");

        const { cookie } = await newSession("apiauth");
        const ok = await call("GET", "/api/recordings", { cookie });
        expect(ok.status).toBe(200);
    });

    test("the login page sends a signed-in visitor to the dashboard", async () => {
        const { cookie } = await newSession("loginredirect");
        const res = await call("GET", "/login", { cookie });
        expect([301, 302, 307, 308]).toContain(res.status);
        expect(new URL(res.headers.get("location") ?? "", baseURL).pathname).toBe(
            "/dashboard",
        );
    });

    test("the auth pages render for an anonymous visitor", async () => {
        for (const path of ["/login", "/register"]) {
            const res = await call("GET", path);
            expect(res.status, path).toBe(200);
        }
    });

    test("the reset page with a token shows the set-password mode", async ({ browser }) => {
        const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
        const page = await context.newPage();
        const res = await page.goto("/reset-password?token=some-token");
        expect(res?.status()).toBe(200);
        await expect(page.getByText("Set a new password").first()).toBeVisible();
        await context.close();
    });

    test("the forgot-password and reset-password pages render anonymously", async () => {
        for (const path of ["/forgot-password", "/reset-password"]) {
            const res = await call("GET", path);
            expect(res.status, path).toBe(200);
        }
    });

    test("the suspended page sends an anonymous visitor to login", async () => {
        const res = await call("GET", "/suspended");
        expect([307, 308, 302]).toContain(res.status);
        expect(new URL(res.headers.get("location") ?? "", baseURL).pathname).toBe(
            "/login",
        );
    });
});
