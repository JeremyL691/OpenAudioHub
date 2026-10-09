import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { buildTrayTemplate, type MenuActions } from "../src/main/menu.js";

function actions(): MenuActions {
    return {
        openWindow: vi.fn(),
        openDataFolder: vi.fn(),
        openLogsFolder: vi.fn(),
        editConfiguration: vi.fn(),
        exportKeys: vi.fn(),
        importFromDocker: vi.fn(),
        setLaunchAtLogin: vi.fn(),
        quit: vi.fn(),
    };
}

function itemLabeled(
    template: MenuItemConstructorOptions[],
    label: string,
): MenuItemConstructorOptions {
    const item = template.find((entry) => entry.label === label);
    if (!item) throw new Error(`no menu item ${label}`);
    return item;
}

describe("tray menu template", () => {
    it("lists the menu-bar actions in order, with separators", () => {
        const template = buildTrayTemplate(actions(), {
            launchAtLogin: false,
            launchAtLoginAvailable: true,
        });

        const labels = template.map((entry) => entry.label ?? entry.type);
        expect(labels).toEqual([
            "Open OpenAudioHub",
            "separator",
            "Open Data Folder",
            "Open Logs Folder",
            "Edit Configuration…",
            "Export Keys…",
            "Import from Docker…",
            "separator",
            "Launch at Login",
            "separator",
            "Quit OpenAudioHub",
        ]);
    });

    it("routes each item to its action", () => {
        const handlers = actions();
        const template = buildTrayTemplate(handlers, {
            launchAtLogin: false,
            launchAtLoginAvailable: true,
        });

        itemLabeled(template, "Open OpenAudioHub").click?.(
            {} as never,
            undefined,
            {} as never,
        );
        itemLabeled(template, "Open Data Folder").click?.(
            {} as never,
            undefined,
            {} as never,
        );
        itemLabeled(template, "Export Keys…").click?.(
            {} as never,
            undefined,
            {} as never,
        );
        itemLabeled(template, "Import from Docker…").click?.(
            {} as never,
            undefined,
            {} as never,
        );
        itemLabeled(template, "Quit OpenAudioHub").click?.(
            {} as never,
            undefined,
            {} as never,
        );

        expect(handlers.openWindow).toHaveBeenCalledOnce();
        expect(handlers.openDataFolder).toHaveBeenCalledOnce();
        expect(handlers.exportKeys).toHaveBeenCalledOnce();
        expect(handlers.importFromDocker).toHaveBeenCalledOnce();
        expect(handlers.quit).toHaveBeenCalledOnce();
    });

    it("sets the login item from the checkbox state, and is disabled in development", () => {
        const handlers = actions();
        const packaged = buildTrayTemplate(handlers, {
            launchAtLogin: true,
            launchAtLoginAvailable: true,
        });
        const login = itemLabeled(packaged, "Launch at Login");
        expect(login.checked).toBe(true);
        expect(login.enabled).toBe(true);

        login.click?.({ checked: false } as never, undefined, {} as never);
        expect(handlers.setLaunchAtLogin).toHaveBeenCalledWith(false);

        const development = buildTrayTemplate(actions(), {
            launchAtLogin: false,
            launchAtLoginAvailable: false,
        });
        expect(itemLabeled(development, "Launch at Login").enabled).toBe(false);
    });
});
