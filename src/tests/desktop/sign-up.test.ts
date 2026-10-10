import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
    createMigratedTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const databaseUrl = getTestDatabaseUrl();
const APP_URL = "http://127.0.0.1:38541";
const INTRUDER_EMAIL = "intruder@example.test";
const MANAGED_ENV = [
    "NEXT_PHASE",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "APP_URL",
    "OAH_DESKTOP",
    "OAH_DESKTOP_LAUNCH_SECRET",
] as const;

describe.skipIf(!databaseUrl)("desktop email sign-up", () => {
    const saved = new Map<string, string | undefined>();
    let database: TestPostgresDatabase;
    let auth: Awaited<typeof import("@/lib/auth")>["auth"];

    beforeAll(async () => {
        for (const key of MANAGED_ENV) {
            saved.set(key, process.env[key]);
        }
        database = await createMigratedTestDatabase(
            databaseUrl as string,
            "desktop-sign-up",
        );
        vi.resetModules();
        process.env.NEXT_PHASE = "phase-production-build";
        process.env.DATABASE_URL = database.url;
        process.env.BETTER_AUTH_SECRET = "b".repeat(40);
        process.env.ENCRYPTION_KEY = "e".repeat(64);
        process.env.APP_URL = APP_URL;
        process.env.OAH_DESKTOP = "1";
        process.env.OAH_DESKTOP_LAUNCH_SECRET = "d".repeat(40);
        ({ auth } = await import("@/lib/auth"));
    });

    afterAll(async () => {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await database?.dispose();
    });

    it("refuses sign-up in desktop mode and creates no account", async () => {
        const response = await auth.handler(
            new Request(`${APP_URL}/api/auth/sign-up/email`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: APP_URL,
                },
                body: JSON.stringify({
                    email: INTRUDER_EMAIL,
                    password: "not-a-real-password",
                    name: "Intruder",
                }),
            }),
        );

        expect(response.status).not.toBe(200);
        const rows = await database.sql<{ n: number }[]>`
            select count(*)::int as n from users where email = ${INTRUDER_EMAIL}
        `;
        expect(rows[0].n).toBe(0);
    });
});
