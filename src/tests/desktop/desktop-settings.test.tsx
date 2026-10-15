// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    visibleSettingsNav,
    visibleSettingsNavGroups,
} from "@/components/settings-nav-config";
import { DesktopSection } from "@/components/settings-sections/desktop-section";
import type { DesktopPreferences } from "@/types/desktop-bridge";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
    cleanup();
    delete window.__openaudiohubDesktop;
    vi.clearAllMocks();
});

function installBridge(
    prefs: DesktopPreferences,
    setPreferences?: (
        updates: Partial<DesktopPreferences>,
    ) => Promise<DesktopPreferences>,
) {
    const bridge = {
        version: 1 as const,
        pickFolder: vi.fn(async () => null),
        getPreferences: vi.fn(async () => prefs),
        setPreferences:
            setPreferences ??
            vi.fn(async (updates) => ({ ...prefs, ...updates })),
    };
    window.__openaudiohubDesktop = bridge;
    return bridge;
}

function traySwitch(): HTMLButtonElement {
    return document.getElementById(
        "desktop-show-tray-switch",
    ) as HTMLButtonElement;
}

describe("desktop settings section", () => {
    it("shows the desktop-only note without the bridge", async () => {
        render(<DesktopSection />);
        expect(
            screen.getByText("Available in the OpenAudioHub desktop app."),
        ).toBeTruthy();
        expect(screen.queryByTestId("desktop-close-action")).toBeNull();
    });

    it("loads preferences and shows the dock hint while closing keeps running", async () => {
        installBridge({ closeAction: "background", showTray: false });
        render(<DesktopSection />);

        await screen.findByTestId("desktop-close-action");
        expect(
            screen.getByTestId("desktop-close-action").textContent,
        ).toContain("Keep running in the background");
        expect(traySwitch().getAttribute("aria-checked")).toBe("false");
        expect(
            screen.getByText(
                "The app stays in the Dock while it runs in the background.",
            ),
        ).toBeTruthy();
    });

    it("hides the dock hint once the menu bar icon is on", async () => {
        installBridge({ closeAction: "background", showTray: true });
        render(<DesktopSection />);

        await screen.findByTestId("desktop-close-action");
        expect(traySwitch().getAttribute("aria-checked")).toBe("true");
        expect(
            screen.queryByText(
                "The app stays in the Dock while it runs in the background.",
            ),
        ).toBeNull();
    });

    it("saves the menu bar toggle", async () => {
        const bridge = installBridge({ closeAction: "quit", showTray: false });
        render(<DesktopSection />);

        await screen.findByTestId("desktop-close-action");
        fireEvent.click(traySwitch());

        await waitFor(() =>
            expect(bridge.setPreferences).toHaveBeenCalledWith({
                showTray: true,
            }),
        );
        await waitFor(() =>
            expect(traySwitch().getAttribute("aria-checked")).toBe("true"),
        );
    });

    it("rolls the toggle back and shows an error when saving fails", async () => {
        installBridge(
            { closeAction: "quit", showTray: false },
            vi.fn(async () => {
                throw new Error("boom");
            }),
        );
        render(<DesktopSection />);

        await screen.findByTestId("desktop-close-action");
        fireEvent.click(traySwitch());

        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Failed to save settings. Changes reverted.",
            ),
        );
        expect(traySwitch().getAttribute("aria-checked")).toBe("false");
    });
});

describe("desktop settings navigation", () => {
    it("lists the Desktop section only in desktop mode", () => {
        const webIds = visibleSettingsNav(false).map((item) => item.id);
        const desktopIds = visibleSettingsNav(true).map((item) => item.id);
        expect(webIds).not.toContain("desktop");
        expect(desktopIds).toContain("desktop");
        expect(
            visibleSettingsNavGroups(false)
                .flatMap((group) => group.items)
                .some((item) => item.id === "desktop"),
        ).toBe(false);
    });

    it("no longer lists Notifications", () => {
        expect(visibleSettingsNav(true).map((item) => item.id)).not.toContain(
            "notifications",
        );
    });
});
