import { join } from "node:path";
import {
    Menu,
    type MenuItemConstructorOptions,
    nativeImage,
    Tray,
} from "electron";

/**
 * The menu-bar item (PLAN T13.5, D-305). The icon is a template image (trayTemplate.png), so macOS tints
 * it for light and dark menu bars.
 */
export function createTray(
    iconDir: string,
    template: MenuItemConstructorOptions[],
): Tray {
    const icon = nativeImage.createFromPath(join(iconDir, "trayTemplate.png"));
    const tray = new Tray(icon);
    tray.setToolTip("OpenAudioHub");
    tray.setContextMenu(Menu.buildFromTemplate(template));
    return tray;
}
