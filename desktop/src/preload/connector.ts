/**
 * Sandboxed preload for the app window. Exposes the same `window.__openaudiohubConnector` bridge that the Chrome
 * extension injects for the web app (src/components/plaud-connect-tabs.tsx). The main process does the sign-in.
 * Also exposes `__openaudiohubDesktop.pickFolder` for the native folder picker (channel oah:pick-folder in
 * src/main/folder-picker.ts). The channel names must match the main-process constants; this file is bundled separately,
 * so it does not import from main.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__openaudiohubConnector", {
    version: 1,
    connect: async () => {
        const result = await ipcRenderer.invoke("oah:plaud-connect");
        if (result?.ok) return result.payload;
        throw new Error(result?.error ?? "Plaud sign-in failed.");
    },
});
contextBridge.exposeInMainWorld("__openaudiohubDesktop", {
    version: 1,
    pickFolder: async (): Promise<string | null> => {
        const result = await ipcRenderer.invoke("oah:pick-folder");
        if (result?.ok) return result.path ?? null;
        throw new Error(result?.error ?? "Could not open the folder picker.");
    },
});
