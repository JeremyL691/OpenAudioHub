/**
 * Desktop preferences the web UI can read and change through the desktop bridge (preload/connector.ts):
 * what closing the window does, and whether the menu-bar item is shown. Both are kept in config.json. Only the
 * app origin may call the channels. The pure functions take the config as data, so they test without Electron;
 * index.ts passes in the callbacks that read, save and apply the change.
 */

import { ipcMain } from "electron";
import type { CloseAction, DesktopConfig } from "./config.js";
import { isAppUrl } from "./guards.js";

export const PREFERENCES_GET_CHANNEL = "oah:desktop-prefs:get";
export const PREFERENCES_SET_CHANNEL = "oah:desktop-prefs:set";

export interface DesktopPreferences {
    closeAction: CloseAction;
    showTray: boolean;
}

/** Applies the defaults for keys the config does not hold (defaults are never written by readers). */
export function resolvePreferences(config: DesktopConfig): DesktopPreferences {
    return {
        closeAction: config.closeAction ?? "background",
        showTray: config.showTray ?? true,
    };
}

/** Keeps only the two known keys with valid values. Anything else from the web UI is dropped. */
export function parsePreferenceUpdates(
    input: unknown,
): Partial<DesktopPreferences> {
    if (!input || typeof input !== "object") return {};
    const raw = input as Record<string, unknown>;
    const updates: Partial<DesktopPreferences> = {};
    if (raw.closeAction === "background" || raw.closeAction === "quit") {
        updates.closeAction = raw.closeAction;
    }
    if (typeof raw.showTray === "boolean") {
        updates.showTray = raw.showTray;
    }
    return updates;
}

/** The config after the valid updates are applied. The input is not trusted, so it is parsed first. */
export function applyPreferenceUpdates(
    config: DesktopConfig,
    input: unknown,
): DesktopConfig {
    return { ...config, ...parsePreferenceUpdates(input) };
}

export type PreferencesResult =
    | { ok: true; preferences: DesktopPreferences }
    | { ok: false; error: string };

export interface PreferenceCallbacks {
    appOrigin: string;
    getConfig: () => DesktopConfig;
    /** Writes the config to disk and keeps the caller's copy in step. */
    saveConfig: (config: DesktopConfig) => void;
    /** Creates or removes the menu-bar item to match showTray, at runtime. */
    applyTray: (showTray: boolean) => void;
}

let ipcRegistered = false;

export function registerDesktopPrefsIpc(callbacks: PreferenceCallbacks): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    const allowed = (senderUrl: string | undefined): boolean =>
        isAppUrl(senderUrl ?? "", callbacks.appOrigin);

    ipcMain.handle(PREFERENCES_GET_CHANNEL, (event): PreferencesResult => {
        if (!allowed(event.senderFrame?.url)) {
            return { ok: false, error: "Not allowed." };
        }
        return {
            ok: true,
            preferences: resolvePreferences(callbacks.getConfig()),
        };
    });

    ipcMain.handle(
        PREFERENCES_SET_CHANNEL,
        (event, input: unknown): PreferencesResult => {
            if (!allowed(event.senderFrame?.url)) {
                return { ok: false, error: "Not allowed." };
            }
            try {
                const next = applyPreferenceUpdates(
                    callbacks.getConfig(),
                    input,
                );
                callbacks.saveConfig(next);
                callbacks.applyTray(resolvePreferences(next).showTray);
                return { ok: true, preferences: resolvePreferences(next) };
            } catch (error) {
                return {
                    ok: false,
                    error:
                        error instanceof Error ? error.message : String(error),
                };
            }
        },
    );
}
