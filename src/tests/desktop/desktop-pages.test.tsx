// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import HomePage from "@/app/page";
import { LandingPage } from "@/components/landing/landing-page";

const state = vi.hoisted(() => ({ desktop: false, signedIn: false }));

vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        throw new Error(`redirect:${url}`);
    },
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/env", () => ({
    env: { DISABLE_REGISTRATION: false },
}));
vi.mock("@/lib/smtp", () => ({
    isSmtpConfigured: () => false,
}));
vi.mock("@/lib/desktop/mode", () => ({
    isDesktopMode: () => state.desktop,
}));
vi.mock("@/lib/auth-server", () => ({
    getSession: async () =>
        state.signedIn ? { user: { id: "user-1" } } : null,
    redirectIfAuthenticated: async () => {},
}));

afterEach(() => {
    cleanup();
    state.desktop = false;
    state.signedIn = false;
});

describe("root page in web and desktop modes", () => {
    it("sends the desktop app to the dashboard without a session", async () => {
        state.desktop = true;

        await expect(HomePage()).rejects.toThrow("redirect:/dashboard");
    });

    it("sends a signed-in web visitor to the dashboard", async () => {
        state.signedIn = true;

        await expect(HomePage()).rejects.toThrow("redirect:/dashboard");
    });

    it("keeps the landing page for a signed-out web visitor", async () => {
        const element = await HomePage();

        expect(element.type).toBe(LandingPage);
    });
});

describe("login page in web and desktop modes", () => {
    it("shows the reconnect state in desktop mode", async () => {
        state.desktop = true;

        render(await LoginPage());

        expect(screen.getAllByText("Reconnecting…").length).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    });

    it("keeps the sign-in form in web mode", async () => {
        const element = await LoginPage();

        expect(element.props.title).toBe("Sign in");
    });
});
