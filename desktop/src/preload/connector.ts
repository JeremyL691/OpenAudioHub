/**
 * Sandboxed preload for the app window. Exposes the same `window.__openaudiohubConnector` bridge that the Chrome
 * extension injects for the web app (src/components/plaud-connect-tabs.tsx). The main process does the sign-in.
 * The channel name must match PLAUD_CONNECT_CHANNEL in src/main/plaud-signin.ts; this file is bundled separately,
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
