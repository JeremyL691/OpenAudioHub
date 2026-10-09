// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "@/components/dashboard/user-menu";
import { DesktopModeProvider } from "@/components/desktop-mode-provider";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn() }));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

afterEach(() => {
    cleanup();
});

const EMAIL = "owner@example.test";

function renderMenu(isDesktop: boolean) {
    render(
        <DesktopModeProvider value={isDesktop}>
            <UserMenu
                initialTheme="system"
                userEmail={EMAIL}
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
            />
        </DesktopModeProvider>,
    );
    fireEvent.keyDown(screen.getByTestId("user-menu"), { key: "Enter" });
}

describe("user menu in web and desktop modes", () => {
    it("shows the email and Log out outside desktop mode", () => {
        renderMenu(false);

        expect(screen.getByText(EMAIL)).toBeTruthy();
        expect(screen.getByText("Log out")).toBeTruthy();
    });

    it("hides the email and Log out in desktop mode", () => {
        renderMenu(true);

        expect(screen.queryByText(EMAIL)).toBeNull();
        expect(screen.queryByText("Log out")).toBeNull();
        expect(screen.getByText("OpenAudioHub")).toBeTruthy();
    });
});

describe("Plaud connect tabs in desktop mode", () => {
    it("explains that the browser extension cannot reach the desktop app", () => {
        render(
            <DesktopModeProvider value={true}>
                <PlaudConnectTabs onConnected={vi.fn()} />
            </DesktopModeProvider>,
        );

        expect(
            screen.getByText(/browser extension cannot reach the desktop app/),
        ).toBeTruthy();
        expect(screen.queryByText("Install the browser extension")).toBeNull();
    });
});
