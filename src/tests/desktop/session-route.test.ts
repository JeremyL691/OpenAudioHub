import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const databaseUrl = getTestDatabaseUrl();
const APP_URL = "http://127.0.0.1:38540";
const LAUNCH_SECRET = "d".repeat(40);
const MANAGED_ENV = [
    "NEXT_PHASE",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "APP_URL",
    "OAH_DESKTOP",
    "OAH_DESKTOP_LAUNCH_SECRET",
    "OAH_DESKTOP_USER_ID",
] as const;

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

type Loaded = Awaited<ReturnType<typeof loadModules>>;

async function loadModules(
    desktop: boolean,
    extra: Partial<Record<(typeof MANAGED_ENV)[number], string>> = {},
) {
    vi.resetModules();
    setEnv("NEXT_PHASE", "phase-production-build");
    setEnv("BETTER_AUTH_SECRET", "b".repeat(40));
    setEnv("ENCRYPTION_KEY", "e".repeat(64));
    setEnv("APP_URL", APP_URL);
    setEnv("OAH_DESKTOP", desktop ? "1" : undefined);
    setEnv("OAH_DESKTOP_LAUNCH_SECRET", LAUNCH_SECRET);
    setEnv("OAH_DESKTOP_USER_ID", extra.OAH_DESKTOP_USER_ID);
    setEnv("DATABASE_URL", currentDatabase.url);

    const route = await import("@/app/api/desktop/session/route");
    const { auth } = await import("@/lib/auth");
    const { DESKTOP_USER_EMAIL } = await import("@/lib/desktop/local-user");
    return { route, auth, DESKTOP_USER_EMAIL };
}

let currentDatabase: TestPostgresDatabase;

function exchange(
    loaded: Loaded,
    init: { host?: string; authorization?: string | null } = {},
): Promise<Response> {
    const headers = new Headers({ host: init.host ?? "127.0.0.1:38540" });
    if (init.authorization !== null) {
        headers.set(
            "authorization",
            init.authorization ?? `Bearer ${LAUNCH_SECRET}`,
        );
    }
    return loaded.route.POST(
        new Request(`${APP_URL}/api/desktop/session`, {
            method: "POST",
            headers,
        }),
    );
}

function cookieHeaderFrom(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
}

describe.skipIf(!databaseUrl)("desktop session route", () => {
    const saved = new Map<string, string | undefined>();
    let loaded: Loaded;

    beforeAll(async () => {
        for (const key of MANAGED_ENV) {
            saved.set(key, process.env[key]);
        }
        currentDatabase = await createMigratedTestDatabase(
            databaseUrl as string,
            "desktop-session",
        );
        loaded = await loadModules(true);
    });

    afterAll(async () => {
        for (const [key, value] of saved) {
            setEnv(key, value);
        }
        await currentDatabase?.dispose();
    });

    it("creates one local user when exchanges run concurrently", async () => {
        const responses = await Promise.all(
            Array.from({ length: 5 }, () => exchange(loaded)),
        );

        expect(responses.map((response) => response.status)).toEqual([
            204, 204, 204, 204, 204,
        ]);
        const rows = await currentDatabase.sql<{ n: number }[]>`
            select count(*)::int as n from users where email = ${loaded.DESKTOP_USER_EMAIL}
        `;
        expect(rows[0].n).toBe(1);
    });

    it("returns a session cookie that auth accepts", async () => {
        const response = await exchange(loaded);

        expect(response.status).toBe(204);
        const cookie = cookieHeaderFrom(response);
        expect(cookie).toContain("=");
        const session = await loaded.auth.api.getSession({
            headers: new Headers({ cookie }),
        });
        expect(session?.user.email).toBe(loaded.DESKTOP_USER_EMAIL);
    });

    it("refuses a host other than the loopback address and port", async () => {
        expect(
            (await exchange(loaded, { host: "evil.example:38540" })).status,
        ).toBe(403);
        expect(
            (await exchange(loaded, { host: "localhost:38540" })).status,
        ).toBe(403);
    });

    it("refuses a missing or wrong bearer", async () => {
        expect((await exchange(loaded, { authorization: null })).status).toBe(
            401,
        );
        expect(
            (await exchange(loaded, { authorization: "Bearer wrong" })).status,
        ).toBe(401);
        expect(
            (
                await exchange(loaded, {
                    authorization: `Basic ${LAUNCH_SECRET}`,
                })
            ).status,
        ).toBe(401);
    });

    it("refuses password sign-in for the local account", async () => {
        const response = await loaded.auth.handler(
            new Request(`${APP_URL}/api/auth/sign-in/email`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: APP_URL,
                },
                body: JSON.stringify({
                    email: loaded.DESKTOP_USER_EMAIL,
                    password: "not-a-real-password",
                }),
            }),
        );

        expect(response.status).not.toBe(200);
    });

    it("binds the earliest-created user when no id is configured", async () => {
        const owner = await currentDatabase.sql<{ id: string }[]>`
            insert into users (id, email, email_verified, name, created_at, updated_at)
            values ('owner_test_1', 'owner@example.test', true, 'Owner', '2020-01-01T00:00:00Z', now())
            returning id
        `;
        expect(owner).toHaveLength(1);

        const response = await exchange(loaded);
        expect(response.status).toBe(204);
        const session = await loaded.auth.api.getSession({
            headers: new Headers({ cookie: cookieHeaderFrom(response) }),
        });
        expect(session?.user.email).toBe("owner@example.test");
    });

    it("binds the configured user id", async () => {
        const configured = await loadModules(true, {
            OAH_DESKTOP_USER_ID: "owner_test_1",
        });
        const response = await exchange(configured);

        expect(response.status).toBe(204);
        const session = await configured.auth.api.getSession({
            headers: new Headers({ cookie: cookieHeaderFrom(response) }),
        });
        expect(session?.user.id).toBe("owner_test_1");
    });

    it("fails closed when the configured user id does not exist", async () => {
        const missing = await loadModules(true, {
            OAH_DESKTOP_USER_ID: "no_such_user",
        });

        expect((await exchange(missing)).status).toBe(500);
    });

    it("answers 404 outside desktop mode", async () => {
        const web = await loadModules(false);

        expect((await exchange(web)).status).toBe(404);
    });
});
