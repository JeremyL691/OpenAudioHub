import { join } from "node:path";
import { app, BrowserWindow, dialog, type Session, shell } from "electron";
import {
    isAppUrl,
    isOpenableExternally,
    isPermissionGranted,
    needsSessionExchange,
    safeDownloadName,
} from "./guards.js";
import { loadWithSession } from "./session.js";

export const APP_PARTITION = "persist:oah";

export interface AppWindowOptions {
    /** Origin of the local server, for example http://127.0.0.1:38400. */
    appOrigin: string;
    /** Exchanges the launch secret for a session on the window's partition (session.ts). */
    reauthenticate: () => Promise<void>;
    /** Writes a line to the main log. */
    log?: (message: string) => void;
}

export interface AppWindow {
    win: BrowserWindow;
    /**
     * Exchanges the session and loads the dashboard, retrying a failed load (B-013). Only one load runs at a
     * time: a sign-in redirect during a load is left to that load's retry.
     */
    load(): Promise<void>;
}

/**
 * Creates the app window (PLAN T13.4). The renderer has no Node access, runs in a sandbox with
 * context isolation, and can only reach the app origin. Sign-in pages are replaced by a session
 * exchange, downloads go through a save dialog, and external links open in the browser.
 */
export function createAppWindow(options: AppWindowOptions): AppWindow {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 360,
        minHeight: 560,
        show: false,
        title: app.getName(),
        webPreferences: {
            partition: APP_PARTITION,
            preload: join(__dirname, "preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
        },
    });

    const appSession = win.webContents.session;
    installSessionPolicy(appSession);

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isOpenableExternally(url)) void shell.openExternal(url);
        return { action: "deny" };
    });

    const dashboardUrl = new URL("/dashboard", options.appOrigin).toString();
    let loading: Promise<void> | null = null;
    const load = (): Promise<void> => {
        loading ??= loadWithSession({
            reauthenticate: options.reauthenticate,
            load: () => win.loadURL(dashboardUrl),
            isDestroyed: () => win.isDestroyed(),
            log: options.log,
        }).finally(() => {
            loading = null;
        });
        return loading;
    };

    const guardNavigation = (event: Electron.Event, url: string) => {
        // An origin comparison, not a prefix test: http://127.0.0.1:38400@example.com/ starts with the origin.
        if (!isAppUrl(url, options.appOrigin)) {
            event.preventDefault();
            if (isOpenableExternally(url)) void shell.openExternal(url);
            return;
        }
        if (needsSessionExchange(url, options.appOrigin)) {
            event.preventDefault();
            options.log?.(
                `the window was sent to ${new URL(url).pathname}; exchanging the session again`,
            );
            // A running load retries by itself; starting another would abort it.
            if (loading) return;
            void load().catch((error: unknown) => {
                options.log?.(
                    `signing in again failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                if (win.isDestroyed()) return;
                void dialog.showMessageBox(win, {
                    type: "error",
                    message:
                        "OpenAudioHub could not sign in to the local account.",
                    detail: "Restart the app. If the problem continues, check the log folder from the menu.",
                });
            });
        }
    };
    win.webContents.on("will-navigate", guardNavigation);
    win.webContents.on("will-redirect", guardNavigation);
    win.webContents.on(
        "did-fail-load",
        (_event, code, description, url, isMainFrame) => {
            if (isMainFrame)
                options.log?.(
                    `window load failed: ${description} (${code}) for ${url}`,
                );
        },
    );

    win.once("ready-to-show", () => win.show());
    return { win, load };
}

const sessionsWithPolicy = new WeakSet<Session>();

/**
 * Permissions, downloads, and certificates for the app partition. Every window shares the partition's session, so
 * the policy is installed once; a second `will-download` listener would ask where to save each download twice.
 */
export function installSessionPolicy(appSession: Session): void {
    if (sessionsWithPolicy.has(appSession)) return;
    sessionsWithPolicy.add(appSession);
    appSession.setPermissionRequestHandler((_wc, permission, callback) =>
        callback(isPermissionGranted(permission)),
    );
    appSession.setPermissionCheckHandler((_wc, permission) =>
        isPermissionGranted(permission),
    );
    appSession.on("will-download", (event, item, webContents) => {
        const parent = BrowserWindow.fromWebContents(webContents) ?? undefined;
        const suggested = safeDownloadName(item.getFilename());
        const target = dialog.showSaveDialogSync(parent as BrowserWindow, {
            defaultPath: join(app.getPath("downloads"), suggested),
        });
        if (!target) {
            event.preventDefault();
            return;
        }
        item.setSavePath(target);
    });
}
