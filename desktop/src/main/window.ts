import { join } from "node:path";
import { app, BrowserWindow, dialog, type Session, shell } from "electron";
import {
    isOpenableExternally,
    isPermissionGranted,
    needsSessionExchange,
    safeDownloadName,
} from "./guards.js";

export const APP_PARTITION = "persist:oah";

export interface AppWindowOptions {
    /** Origin of the local server, for example http://127.0.0.1:38400. */
    appOrigin: string;
    /** Exchanges the launch secret for a session on the window's partition (session.ts). */
    reauthenticate: () => Promise<void>;
    /** Called when the window needs to be shown from the tray or the dock. */
    onDownloadStarted?: (name: string) => void;
}

/**
 * Creates the app window (PLAN T13.4). The renderer has no Node access, runs in a sandbox with
 * context isolation, and can only reach the app origin. Sign-in pages are replaced by a session
 * exchange, downloads go through a save dialog, and external links open in the browser.
 */
export function createAppWindow(options: AppWindowOptions): BrowserWindow {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 360,
        minHeight: 560,
        show: false,
        title: app.getName(),
        webPreferences: {
            partition: APP_PARTITION,
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

    const guardNavigation = (event: Electron.Event, url: string) => {
        if (!url.startsWith(options.appOrigin)) {
            event.preventDefault();
            if (isOpenableExternally(url)) void shell.openExternal(url);
            return;
        }
        if (needsSessionExchange(url, options.appOrigin)) {
            event.preventDefault();
            void reloadWithSession(win, options);
        }
    };
    win.webContents.on("will-navigate", guardNavigation);
    win.webContents.on("will-redirect", guardNavigation);

    win.once("ready-to-show", () => win.show());
    return win;
}

async function reloadWithSession(
    win: BrowserWindow,
    options: AppWindowOptions,
): Promise<void> {
    try {
        await options.reauthenticate();
        await win.loadURL(new URL("/dashboard", options.appOrigin).toString());
    } catch {
        await dialog.showMessageBox(win, {
            type: "error",
            message: "OpenAudioHub could not sign in to the local account.",
            detail: "Restart the app. If the problem continues, check the log folder from the menu.",
        });
    }
}

/** Permissions, downloads, and certificates for the app partition. */
export function installSessionPolicy(appSession: Session): void {
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
