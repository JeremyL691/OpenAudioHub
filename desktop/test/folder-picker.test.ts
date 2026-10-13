import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
    handle: vi.fn(),
    showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
    BrowserWindow: vi.fn(),
    dialog: { showOpenDialog: electron.showOpenDialog },
    ipcMain: { handle: electron.handle },
}));

const APP_ORIGIN = "http://127.0.0.1:38400";

async function loadHandler() {
    vi.resetModules();
    const { registerFolderPickerIpc, FOLDER_PICKER_CHANNEL } = await import(
        "../src/main/folder-picker.js"
    );
    registerFolderPickerIpc({
        appOrigin: APP_ORIGIN,
        getParent: () => undefined,
    });
    const handler = electron.handle.mock.calls.find(
        ([channel]) => channel === FOLDER_PICKER_CHANNEL,
    )?.[1] as (event: unknown) => Promise<unknown>;
    return handler;
}

describe("registerFolderPickerIpc", () => {
    beforeEach(() => {
        electron.handle.mockReset();
        electron.showOpenDialog.mockReset();
    });

    it("rejects a sender from another origin without showing the dialog", async () => {
        const handler = await loadHandler();
        const result = await handler({
            senderFrame: { url: "https://evil.example/page" },
        });
        expect(result).toEqual({ ok: false, error: "Not allowed." });
        expect(electron.showOpenDialog).not.toHaveBeenCalled();
    });

    it("returns the picked folder path", async () => {
        electron.showOpenDialog.mockResolvedValue({
            canceled: false,
            filePaths: ["/Users/me/Exports"],
        });
        const handler = await loadHandler();
        const result = await handler({
            senderFrame: { url: `${APP_ORIGIN}/settings` },
        });
        expect(result).toEqual({ ok: true, path: "/Users/me/Exports" });
    });

    it("returns null when the dialog is canceled", async () => {
        electron.showOpenDialog.mockResolvedValue({
            canceled: true,
            filePaths: [],
        });
        const handler = await loadHandler();
        const result = await handler({
            senderFrame: { url: `${APP_ORIGIN}/settings` },
        });
        expect(result).toEqual({ ok: true, path: null });
    });
});
