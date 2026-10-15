import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    handle: vi.fn(),
}));

vi.mock("electron", () => ({
    BrowserWindow: vi.fn(),
    dialog: {},
    ipcMain: { handle: electron.handle },
}));

import { defaultConfig, loadConfig, saveConfig } from "../src/main/config.js";
import {
    applyPreferenceUpdates,
    PREFERENCES_GET_CHANNEL,
    PREFERENCES_SET_CHANNEL,
    parsePreferenceUpdates,
    resolvePreferences,
} from "../src/main/desktop-prefs.js";

const APP_ORIGIN = "http://127.0.0.1:38400";

describe("config preferences", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "oah-prefs-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("keeps valid closeAction and showTray values", () => {
        const path = join(dir, "config.json");
        saveConfig(path, {
            ...defaultConfig(),
            closeAction: "quit",
            showTray: false,
        });
        const { config } = loadConfig(path);
        expect(config.closeAction).toBe("quit");
        expect(config.showTray).toBe(false);
    });

    it("drops unknown closeAction values and non-boolean showTray", () => {
        const path = join(dir, "config.json");
        writeFileSync(
            path,
            JSON.stringify({
                schemaVersion: 1,
                ports: { app: 38400, pipeline: 38401, postgres: 38402 },
                closeAction: "minimize",
                showTray: "no",
            }),
        );
        const { config } = loadConfig(path);
        expect(config.closeAction).toBeUndefined();
        expect(config.showTray).toBeUndefined();
    });

    it("leaves the fields unset in a fresh config (defaults are applied by readers)", () => {
        const config = defaultConfig();
        expect("closeAction" in config).toBe(false);
        expect("showTray" in config).toBe(false);
    });
});

describe("preference logic", () => {
    it("applies the defaults when the config has no preferences", () => {
        expect(resolvePreferences(defaultConfig())).toEqual({
            closeAction: "background",
            showTray: true,
        });
    });

    it("reads stored preferences", () => {
        expect(
            resolvePreferences({
                ...defaultConfig(),
                closeAction: "quit",
                showTray: false,
            }),
        ).toEqual({ closeAction: "quit", showTray: false });
    });

    it("keeps only known keys with valid values", () => {
        expect(
            parsePreferenceUpdates({
                closeAction: "quit",
                showTray: false,
                launchAtLogin: true,
                ports: { app: 1 },
            }),
        ).toEqual({ closeAction: "quit", showTray: false });
        expect(parsePreferenceUpdates({ closeAction: "hide" })).toEqual({});
        expect(parsePreferenceUpdates({ showTray: 0 })).toEqual({});
        expect(parsePreferenceUpdates(null)).toEqual({});
        expect(parsePreferenceUpdates("quit")).toEqual({});
    });

    it("merges valid updates into the config and leaves the rest alone", () => {
        const base = { ...defaultConfig(), launchAtLogin: true };
        const next = applyPreferenceUpdates(base, { showTray: false, x: 1 });
        expect(next.showTray).toBe(false);
        expect(next.closeAction).toBeUndefined();
        expect(next.launchAtLogin).toBe(true);
        expect(next.ports).toEqual(base.ports);
    });
});

describe("registerDesktopPrefsIpc", () => {
    function setup() {
        electron.handle.mockReset();
        const config = { ...defaultConfig() };
        const saved: unknown[] = [];
        const trayCalls: boolean[] = [];
        const callbacks = {
            appOrigin: APP_ORIGIN,
            getConfig: () => config,
            saveConfig: (next: typeof config) => {
                saved.push(next);
                Object.assign(config, next);
            },
            applyTray: (show: boolean) => trayCalls.push(show),
        };
        return { callbacks, saved, trayCalls, config };
    }

    async function handlers() {
        vi.resetModules();
        const mod = await import("../src/main/desktop-prefs.js");
        const env = setup();
        mod.registerDesktopPrefsIpc(env.callbacks);
        const get = electron.handle.mock.calls.find(
            ([c]) => c === PREFERENCES_GET_CHANNEL,
        )?.[1] as (e: unknown) => unknown;
        const set = electron.handle.mock.calls.find(
            ([c]) => c === PREFERENCES_SET_CHANNEL,
        )?.[1] as (e: unknown, input: unknown) => unknown;
        return { get, set, ...env };
    }

    const appSender = { senderFrame: { url: `${APP_ORIGIN}/settings` } };
    const foreignSender = { senderFrame: { url: "https://evil.example/" } };

    it("rejects callers outside the app origin", async () => {
        const { get, set, trayCalls, saved } = await handlers();
        expect(get(foreignSender)).toEqual({
            ok: false,
            error: "Not allowed.",
        });
        expect(set(foreignSender, { showTray: false })).toEqual({
            ok: false,
            error: "Not allowed.",
        });
        expect(trayCalls).toEqual([]);
        expect(saved).toEqual([]);
    });

    it("returns the resolved preferences", async () => {
        const { get } = await handlers();
        expect(get(appSender)).toEqual({
            ok: true,
            preferences: { closeAction: "background", showTray: true },
        });
    });

    it("saves valid updates, applies the tray, and returns the full preferences", async () => {
        const { set, saved, trayCalls } = await handlers();
        const result = set(appSender, {
            closeAction: "quit",
            showTray: false,
            ports: { app: 1 },
        });
        expect(result).toEqual({
            ok: true,
            preferences: { closeAction: "quit", showTray: false },
        });
        expect(saved).toHaveLength(1);
        expect(trayCalls).toEqual([false]);
    });
});
