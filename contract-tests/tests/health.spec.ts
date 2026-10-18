import { expect, test } from "@playwright/test";
import { anonymousContext } from "../helpers/api";

test("health answers without a session", async () => {
    const api = await anonymousContext();
    const res = await api.get("/api/health");
    expect(res.status()).toBe(200);
    await api.dispose();
});

test("signed-in session can list recordings", async ({ request }) => {
    const res = await request.get("/api/recordings");
    expect(res.status()).toBe(200);
});
