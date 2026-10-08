// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    AppSettingsSync,
    AppShellProviders,
    useAppSettings,
    useDialogs,
} from "@/components/app-shell/providers";
import {
    INITIAL_SETTINGS_DEFAULTS,
    type InitialSettings,
} from "@/lib/settings/initial-settings";

const nav = vi.hoisted(() => ({ pathname: "/recordings" }));
const seen = vi.hoisted(() => ({
    settings: null as InitialSettings | null,
    shortcutsOpen: false,
    onboardingOpen: false,
    openShortcuts: null as (() => void) | null,
    latestAutoSyncOptions: null as Record<string, unknown> | null,
}));

vi.mock("next/navigation", () => ({
    usePathname: () => nav.pathname,
    useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

vi.mock("@/hooks/use-auto-sync", () => ({
    useAutoSync: (options: Record<string, unknown>) => {
        seen.latestAutoSyncOptions = options;
        return {
            isAutoSyncing: false,
            lastSyncTime: null,
            nextSyncTime: null,
            lastSyncResult: null,
            manualSync: () => {},
        };
    },
}));

vi.mock("@/hooks/use-upload-queue", () => ({
    useUploadQueue: () => ({
        isUploading: false,
        pendingUploads: [],
        uploadInputRef: { current: null },
        handleUpload: () => {},
        triggerUpload: () => {},
    }),
}));

function Probe() {
    const { settings } = useAppSettings();
    const dialogs = useDialogs();
    seen.settings = settings;
    seen.shortcutsOpen = dialogs.shortcutsOpen;
    seen.onboardingOpen = dialogs.onboardingOpen;
    seen.openShortcuts = () => dialogs.setShortcutsOpen(true);
    return null;
}

const defaults: InitialSettings = {
    ...INITIAL_SETTINGS_DEFAULTS,
    onboardingCompleted: true,
};

function shell(initial: InitialSettings, extra: React.ReactNode = null) {
    return (
        <AppShellProviders initialSettings={initial}>
            {extra}
            <Probe />
        </AppShellProviders>
    );
}

beforeEach(() => {
    nav.pathname = "/recordings";
    seen.settings = null;
    seen.shortcutsOpen = false;
    seen.onboardingOpen = false;
    seen.openShortcuts = null;
    seen.latestAutoSyncOptions = null;
});

describe("AppShellProviders", () => {
    it("pushes saved settings into the sync loop when a navigation delivers them", () => {
        const { rerender } = render(shell(defaults));
        expect(seen.latestAutoSyncOptions).toMatchObject({
            enabled: true,
            interval: defaults.syncInterval,
        });

        const fresh = {
            ...defaults,
            syncInterval: 60_000,
            autoSyncEnabled: false,
        };
        rerender(shell(defaults, <AppSettingsSync settings={fresh} />));

        expect(seen.settings?.autoSyncEnabled).toBe(false);
        expect(seen.latestAutoSyncOptions).toMatchObject({
            enabled: false,
            interval: 60_000,
        });
    });

    it("closes the shortcuts dialog on route change, as leaving the dashboard used to", () => {
        const { rerender } = render(shell(defaults));
        act(() => seen.openShortcuts?.());
        expect(seen.shortcutsOpen).toBe(true);

        nav.pathname = "/settings/sync";
        rerender(shell(defaults));
        expect(seen.shortcutsOpen).toBe(false);
    });

    it("follows the onboarding gate in the saved settings", () => {
        const pending = { ...defaults, onboardingCompleted: false };
        const { rerender } = render(shell(pending));
        expect(seen.onboardingOpen).toBe(true);

        rerender(
            shell(
                pending,
                <AppSettingsSync
                    settings={{ ...pending, onboardingCompleted: true }}
                />,
            ),
        );
        expect(seen.onboardingOpen).toBe(false);
    });

    it("throws a clear error when a hook is used outside the provider", () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        expect(() => render(<Probe />)).toThrow(
            "useAppSettings must be used inside AppShellProviders",
        );
        consoleError.mockRestore();
    });
});
