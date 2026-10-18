import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import {
    clientHeaders,
    configureAccount,
    credentials,
    signUpAndIn,
    storageStatePath,
} from "./api";

// Creates the main test account through the public API, configures it, and saves
// its session for the tests. A saved session that still works is reused, because
// sign-in is rate limited per email and many runs share one server.
export default async function globalSetup(): Promise<void> {
    const baseURL = process.env.OAH_BASE_URL ?? "http://localhost:3210";
    if (existsSync(storageStatePath)) {
        const saved = await request.newContext({
            baseURL,
            extraHTTPHeaders: clientHeaders(),
            storageState: storageStatePath,
        });
        const res = await saved.get("/api/recordings");
        await saved.dispose();
        if (res.ok()) return;
    }
    const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: clientHeaders(),
    });
    await signUpAndIn(api, credentials());
    await configureAccount(api);
    mkdirSync(dirname(storageStatePath), { recursive: true });
    await api.storageState({ path: storageStatePath });
    await api.dispose();
}
