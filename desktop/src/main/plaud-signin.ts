/**
 * "Sign in with Plaud" for the Electron app. The web app's button calls the connector bridge (preload/connector.ts),
 * which invokes PLAUD_CONNECT_CHANNEL. This module opens web.plaud.ai in its own partition, waits for the user to sign
 * in, and reads the bearer token from the pld_ut cookie (Google and Apple logins) or localStorage pld_tokenstr. The
 * token never reaches the log.
 */
import {
    BrowserWindow,
    type BrowserWindow as BrowserWindowType,
    ipcMain,
    session,
    type WebContents,
} from "electron";
import { isAppUrl } from "./guards.js";
import {
    apiBaseFromRequestUrl,
    apiBaseFromTokenRegion,
    chromeLikeUserAgent,
    defaultApiBaseForWebOrigin,
    isPlaudWebUrl,
    isSigninNavigationAllowed,
    isTokenExpired,
    PLAUD_SIGNIN_PARTITION,
    PLAUD_UT_COOKIE,
    type PlaudConnectPayload,
    parsePldTokenstr,
    parseUtCookie,
    regionOf,
} from "./plaud-signin-core.js";

export const PLAUD_CONNECT_CHANNEL = "oah:plaud-connect";

const POLL_INTERVAL_MS = 1000;
/** Polls to wait for the API request that carries the token before falling back to the web origin. */
const API_BASE_WAIT_POLLS = 3;
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WEB_ORIGIN = "https://web.plaud.ai";
const PLAUD_CN_ORIGIN = "https://web.plaud.cn";
const PLAUD_CN_API_BASE = "https://api.plaud.cn";
const READ_TOKEN_SCRIPT =
    '(()=>{try{return localStorage.getItem("pld_tokenstr")}catch{return null}})()';

export interface OpenPlaudSignInOptions {
    parent?: BrowserWindowType;
    webOrigin?: string;
    log?: (message: string) => void;
}

interface InFlightSignIn {
    promise: Promise<PlaudConnectPayload>;
    win: BrowserWindowType;
}

let inFlight: InFlightSignIn | null = null;
const sessionsWithPolicy = new WeakSet<object>();

/** Denies every permission on the sign-in partition, once per session. */
function installSigninPolicy(signinSession: Electron.Session): void {
    if (sessionsWithPolicy.has(signinSession)) return;
    sessionsWithPolicy.add(signinSession);
    signinSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
    );
    signinSession.setPermissionCheckHandler(() => false);
}

/** Blocks navigations to anything but https (and about:blank), for the window and for every popup it opens. */
function guardContents(
    contents: WebContents,
    parent: BrowserWindowType,
    signinSession: Electron.Session,
): void {
    const guard = (event: Electron.Event, url: string) => {
        if (!isSigninNavigationAllowed(url)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.setWindowOpenHandler(({ url }) => {
        if (!isSigninNavigationAllowed(url)) return { action: "deny" };
        return {
            action: "allow",
            overrideBrowserWindowOptions: {
                parent,
                width: 520,
                height: 700,
                webPreferences: {
                    session: signinSession,
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                },
            },
        };
    });
    contents.on("did-create-window", (child) => {
        guardContents(child.webContents, child, signinSession);
    });
}

/**
 * Opens the Plaud sign-in window and resolves with the captured token. Only one sign-in runs at a time: a second call
 * brings the open window forward and returns the same promise.
 */
export function openPlaudSignIn(
    options: OpenPlaudSignInOptions,
): Promise<PlaudConnectPayload> {
    if (inFlight) {
        if (!inFlight.win.isDestroyed()) {
            inFlight.win.show();
            inFlight.win.focus();
        }
        return inFlight.promise;
    }

    const log = options.log ?? (() => undefined);
    const signinSession = session.fromPartition(PLAUD_SIGNIN_PARTITION);
    signinSession.setUserAgent(
        chromeLikeUserAgent(signinSession.getUserAgent()),
    );
    installSigninPolicy(signinSession);

    const win = new BrowserWindow({
        width: 520,
        height: 760,
        parent: options.parent,
        modal: false,
        show: false,
        title: "Sign in to Plaud",
        webPreferences: {
            session: signinSession,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
        },
    });
    win.once("ready-to-show", () => win.show());
    guardContents(win.webContents, win, signinSession);

    let observedApiBase: string | null = null;
    signinSession.webRequest.onBeforeSendHeaders(
        { urls: ["https://*.plaud.ai/*", "https://*.plaud.cn/*"] },
        (details, callback) => {
            const base = apiBaseFromRequestUrl(details.url);
            if (base) observedApiBase = base;
            callback({ requestHeaders: details.requestHeaders });
        },
    );

    const promise = new Promise<PlaudConnectPayload>((resolve, reject) => {
        let settled = false;
        let polling = false;
        let tokenSeen = false;
        let pollsSinceToken = 0;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = (): void => {
            if (pollTimer) clearInterval(pollTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            signinSession.webRequest.onBeforeSendHeaders(null);
            inFlight = null;
        };
        const close = (): void => {
            if (!win.isDestroyed()) win.close();
        };
        const succeed = (payload: PlaudConnectPayload): void => {
            if (settled) return;
            settled = true;
            cleanup();
            log(`captured token for ${payload.apiBase}`);
            close();
            resolve(payload);
        };
        const succeedWith = (accessToken: string, apiBase: string): void => {
            succeed({
                accessToken,
                apiBase,
                region: regionOf(apiBase),
                capturedAt: Date.now(),
            });
        };
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            close();
            reject(error);
        };

        const readSigninToken = async (
            origin: string,
        ): Promise<string | null> => {
            const cookies = await signinSession.cookies.get({
                url: `${origin}/`,
                name: PLAUD_UT_COOKIE,
            });
            const fromCookie = parseUtCookie(cookies[0]?.value);
            if (fromCookie && !isTokenExpired(fromCookie, Date.now()))
                return fromCookie;
            const raw: unknown = await win.webContents.executeJavaScript(
                READ_TOKEN_SCRIPT,
                true,
            );
            const fromStorage = parsePldTokenstr(raw);
            return fromStorage && !isTokenExpired(fromStorage, Date.now())
                ? fromStorage
                : null;
        };

        const poll = async (): Promise<void> => {
            if (polling || settled || win.isDestroyed()) return;
            polling = true;
            try {
                const url = win.webContents.getURL();
                if (!isPlaudWebUrl(url)) return;
                const origin = new URL(url).origin;
                const token = await readSigninToken(origin);
                if (!token) return;
                const isFirstToken = !tokenSeen;
                tokenSeen = true;
                if (origin === PLAUD_CN_ORIGIN) {
                    succeedWith(token, PLAUD_CN_API_BASE);
                    return;
                }
                const tokenApiBase = apiBaseFromTokenRegion(token);
                if (tokenApiBase) {
                    succeedWith(token, tokenApiBase);
                    return;
                }
                if (observedApiBase) {
                    succeedWith(token, observedApiBase);
                    return;
                }
                if (isFirstToken)
                    log("plaud sign-in detected; waiting for the API host");
                pollsSinceToken += 1;
                if (pollsSinceToken < API_BASE_WAIT_POLLS) return;
                succeedWith(token, defaultApiBaseForWebOrigin(origin));
            } catch (error) {
                log(
                    `plaud sign-in poll failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            } finally {
                polling = false;
            }
        };

        win.on("closed", () => {
            fail(new Error("Plaud sign-in was cancelled."));
        });
        pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        timeoutTimer = setTimeout(() => {
            fail(new Error("Plaud sign-in timed out. Try again."));
        }, SIGNIN_TIMEOUT_MS);

        log("plaud sign-in window opened");
        const origin = options.webOrigin ?? DEFAULT_WEB_ORIGIN;
        win.loadURL(origin).catch((error: unknown) => {
            if (error instanceof Error && error.message.includes("ERR_ABORTED"))
                return;
            log(
                `plaud sign-in page failed to load: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    });

    inFlight = { promise, win };
    return promise;
}

let ipcRegistered = false;

/** Registers the connector IPC handler once. Returns a result object so the renderer gets a clean error message. */
export function registerPlaudConnectorIpc(options: {
    appOrigin: string;
    getParent: () => BrowserWindowType | undefined;
    log?: (message: string) => void;
}): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle(PLAUD_CONNECT_CHANNEL, async (event) => {
        const frameUrl = event.senderFrame?.url ?? "";
        if (!isAppUrl(frameUrl, options.appOrigin)) {
            return { ok: false, error: "Not allowed." };
        }
        try {
            const payload = await openPlaudSignIn({
                parent: options.getParent(),
                log: options.log,
            });
            return { ok: true, payload };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
}
