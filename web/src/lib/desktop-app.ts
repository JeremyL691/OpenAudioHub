/** The desktop app's bridge (defined by the Tauri window), or null in a normal browser. */
export interface DesktopApp {
    version?: number;
    /** Signs the window in again through the launch-secret exchange. True when it worked. */
    reconnect?: () => Promise<boolean>;
}

export function desktopApp(): DesktopApp | null {
    return (window as unknown as { __openaudiohubDesktop?: DesktopApp }).__openaudiohubDesktop ?? null;
}
