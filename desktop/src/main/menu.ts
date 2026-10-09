import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
    openWindow(): void;
    openDataFolder(): void;
    openLogsFolder(): void;
    editConfiguration(): void;
    exportKeys(): void;
    setLaunchAtLogin(enabled: boolean): void;
    quit(): void;
}

export interface MenuState {
    launchAtLogin: boolean;
    /** The login item can only be set for the packaged app (a development run must not register Electron). */
    launchAtLoginAvailable: boolean;
}

/**
 * The menu-bar (tray) menu (PLAN T13.5, D-305, D-309). Pure data, so the actions can be tested without
 * Electron. The tray is built from this template in tray.ts.
 */
export function buildTrayTemplate(
    actions: MenuActions,
    state: MenuState,
): MenuItemConstructorOptions[] {
    return [
        { label: "Open OpenAudioHub", click: () => actions.openWindow() },
        { type: "separator" },
        { label: "Open Data Folder", click: () => actions.openDataFolder() },
        { label: "Open Logs Folder", click: () => actions.openLogsFolder() },
        {
            label: "Edit Configuration…",
            click: () => actions.editConfiguration(),
        },
        { label: "Export Keys…", click: () => actions.exportKeys() },
        { type: "separator" },
        {
            label: "Launch at Login",
            type: "checkbox",
            checked: state.launchAtLogin,
            enabled: state.launchAtLoginAvailable,
            click: (item) => actions.setLaunchAtLogin(item.checked),
        },
        { type: "separator" },
        { label: "Quit OpenAudioHub", click: () => actions.quit() },
    ];
}
