import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    handle: vi.fn(),
    BrowserWindow: vi.fn(),
}));

vi.mock("electron", () => ({
    app: { getName: () => "OpenAudioHub" },
    BrowserWindow: electron.BrowserWindow,
    ipcMain: { handle: electron.handle },
    session: { fromPartition: vi.fn() },
}));

const APP_ORIGIN = "http://127.0.0.1:38400";

async function loadModule() {
    vi.resetModules();
    return import("../src/main/plaud-signin.js");
}

describe("registerPlaudConnectorIpc", () => {
    beforeEach(() => {
        electron.handle.mockReset();
        electron.BrowserWindow.mockReset();
    });

    it("rejects a sender frame from another origin without opening a window", async () => {
        const { registerPlaudConnectorIpc, PLAUD_CONNECT_CHANNEL } =
            await loadModule();
        registerPlaudConnectorIpc({
            appOrigin: APP_ORIGIN,
            getParent: () => undefined,
        });

        const handler = electron.handle.mock.calls.find(
            ([channel]) => channel === PLAUD_CONNECT_CHANNEL,
        )?.[1] as (event: unknown) => Promise<unknown>;
        expect(handler).toBeTypeOf("function");

        const result = await handler({
            senderFrame: { url: "https://evil.example/page" },
        });
        expect(result).toEqual({ ok: false, error: "Not allowed." });
        expect(electron.BrowserWindow).not.toHaveBeenCalled();
    });

    it("registers the handler once, however many times it is called", async () => {
        const { registerPlaudConnectorIpc, PLAUD_CONNECT_CHANNEL } =
            await loadModule();
        const options = { appOrigin: APP_ORIGIN, getParent: () => undefined };
        registerPlaudConnectorIpc(options);
        registerPlaudConnectorIpc(options);

        const calls = electron.handle.mock.calls.filter(
            ([channel]) => channel === PLAUD_CONNECT_CHANNEL,
        );
        expect(calls).toHaveLength(1);
    });
});
