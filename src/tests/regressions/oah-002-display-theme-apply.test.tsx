// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplaySection } from "@/components/settings-sections/display-section";
import { ThemeProvider } from "@/components/theme-provider";

// Regression for defect fix ②: choosing a display theme
// applies it to the page at once. Before the fix the section kept its own copy of
// the choice, so the page changed only after a reload.

let fetchMock: ReturnType<typeof vi.fn>;
let saveFails: boolean;

beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("light", "dark");
    saveFails = false;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
            if (saveFails) throw new Error("offline");
            return new Response(JSON.stringify({ theme: "dark" }), {
                status: 200,
            });
        }
        return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    // jsdom has no matchMedia (next-themes reads it for the "System" choice),
    // and no pointer capture or scrollIntoView (Radix Select calls them).
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    }));
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

// Renders the section inside the same provider the root layout uses.
function renderSection() {
    return render(
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
        >
            <DisplaySection />
        </ThemeProvider>,
    );
}

// Opens the Theme select and chooses an option, as a keyboard user would.
async function chooseTheme(name: "Light" | "Dark" | "System") {
    // The section renders its controls once its settings have loaded.
    const trigger = await screen.findByRole("combobox", { name: "Theme" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const option = await screen.findByRole("option", { name });
    fireEvent.keyDown(option, { key: "Enter" });
}

describe("display theme applies at once (oah-002)", () => {
    it("choosing Dark adds the dark class to the page without a reload", async () => {
        renderSection();

        await chooseTheme("Dark");

        await waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(
                true,
            ),
        );
        expect(
            screen.getByRole("combobox", { name: "Theme" }).textContent,
        ).toContain("Dark");
    });

    it("choosing Light after Dark removes the dark class", async () => {
        renderSection();

        await chooseTheme("Dark");
        await waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(
                true,
            ),
        );

        await chooseTheme("Light");

        await waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(
                false,
            ),
        );
        expect(document.documentElement.classList.contains("light")).toBe(true);
    });

    it("the choice is saved to the account", async () => {
        renderSection();

        await chooseTheme("Dark");

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/settings/user",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({ theme: "dark" }),
                }),
            ),
        );
    });

    it("a failed save still applies the theme to the page", async () => {
        saveFails = true;
        renderSection();

        await chooseTheme("Dark");

        await waitFor(() =>
            expect(document.documentElement.classList.contains("dark")).toBe(
                true,
            ),
        );
    });
});
