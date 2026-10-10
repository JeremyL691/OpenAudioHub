// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
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
    delete window.__openaudiohubConnector;
    vi.unstubAllGlobals();
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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("Plaud connect tabs in desktop mode", () => {
    it("offers the browser handoff and hides the window option without the bridge", () => {
        render(
            <DesktopModeProvider value={true}>
                <PlaudConnectTabs onConnected={vi.fn()} />
            </DesktopModeProvider>,
        );

        expect(
            screen.getByRole("button", { name: "Continue in browser" }),
        ).toBeTruthy();
        expect(
            screen.getByText(/Needs the OpenAudioHub Connector extension/),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", {
                name: "Sign in in a window instead",
            }),
        ).toBeNull();
        expect(
            screen.getByText(/Sign-in blocked or not working\?/),
        ).toBeTruthy();
    });

    it("offers the sign-in window next to the browser handoff when the desktop bridge is present", () => {
        window.__openaudiohubConnector = { version: 1, connect: vi.fn() };
        render(
            <DesktopModeProvider value={true}>
                <PlaudConnectTabs onConnected={vi.fn()} />
            </DesktopModeProvider>,
        );

        expect(
            screen.getByRole("button", { name: "Continue in browser" }),
        ).toBeTruthy();
        expect(
            screen.getByRole("button", {
                name: "Sign in in a window instead",
            }),
        ).toBeTruthy();
    });

    it("does not post a token when the desktop sign-in is cancelled", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const connect = vi
            .fn()
            .mockRejectedValue(new Error("Plaud sign-in was cancelled."));
        window.__openaudiohubConnector = { version: 1, connect };
        render(
            <DesktopModeProvider value={true}>
                <PlaudConnectTabs onConnected={vi.fn()} />
            </DesktopModeProvider>,
        );

        fireEvent.click(
            screen.getByRole("button", {
                name: "Sign in in a window instead",
            }),
        );

        await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(
                screen.getByRole("button", {
                    name: "Sign in in a window instead",
                }),
            ).toBeTruthy(),
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("opens the browser handoff and completes when the status becomes connected", async () => {
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === "POST") {
                    return jsonResponse({
                        code: "abc",
                        expiresAt: Date.now() + 600_000,
                    });
                }
                return jsonResponse({ status: "connected" });
            },
        );
        vi.stubGlobal("fetch", fetchMock);
        const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
        const onConnected = vi.fn();
        render(
            <DesktopModeProvider value={true}>
                <PlaudConnectTabs onConnected={onConnected} />
            </DesktopModeProvider>,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Continue in browser" }),
        );

        await waitFor(() =>
            expect(openSpy).toHaveBeenCalledWith(
                `${window.location.origin}/connect/plaud?code=abc`,
                "_blank",
            ),
        );
        expect(
            screen.getByText(/Finish signing in in your browser/),
        ).toBeTruthy();
        await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), {
            timeout: 6000,
        });
        expect(
            fetchMock.mock.calls.some(
                ([url]) => url === "/api/plaud/auth/handoff?code=abc",
            ),
        ).toBe(true);
        openSpy.mockRestore();
    });
});
