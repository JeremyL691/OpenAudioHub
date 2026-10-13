/**
 * Native "choose folder" dialog for the app window. The web UI asks through the desktop bridge
 * (preload/connector.ts), which invokes FOLDER_PICKER_CHANNEL; only the app origin may ask.
 */
import {
    type BrowserWindow as BrowserWindowType,
    dialog,
    ipcMain,
    type OpenDialogOptions,
} from "electron";
import { isAppUrl } from "./guards.js";

export const FOLDER_PICKER_CHANNEL = "oah:pick-folder";

let ipcRegistered = false;

export function registerFolderPickerIpc(options: {
    appOrigin: string;
    getParent: () => BrowserWindowType | undefined;
}): void {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle(FOLDER_PICKER_CHANNEL, async (event) => {
        const frameUrl = event.senderFrame?.url ?? "";
        if (!isAppUrl(frameUrl, options.appOrigin)) {
            return { ok: false, error: "Not allowed." };
        }
        try {
            const parent = options.getParent();
            const dialogOptions: OpenDialogOptions = {
                title: "Choose the export folder",
                properties: ["openDirectory", "createDirectory"],
            };
            const { canceled, filePaths } = parent
                ? await dialog.showOpenDialog(parent, dialogOptions)
                : await dialog.showOpenDialog(dialogOptions);
            return {
                ok: true,
                path: canceled || !filePaths[0] ? null : filePaths[0],
            };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
}
