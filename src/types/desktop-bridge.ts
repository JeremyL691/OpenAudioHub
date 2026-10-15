/** Close-window and menu-bar preferences kept in the desktop config.json. */
export interface DesktopPreferences {
    closeAction: "background" | "quit";
    showTray: boolean;
}

// Desktop-only bridge published by the Electron preload (see desktop/src/preload/connector.ts).
export interface DesktopBridge {
    version: 1;
    pickFolder(): Promise<string | null>;
    /** Absent in desktop builds older than 1.5.0. */
    getPreferences?(): Promise<DesktopPreferences>;
    setPreferences?(
        updates: Partial<DesktopPreferences>,
    ): Promise<DesktopPreferences>;
}

declare global {
    interface Window {
        __openaudiohubDesktop?: DesktopBridge;
    }
}
