// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaudBrowserHandoff } from "@/components/plaud-browser-handoff";

afterEach(() => {
    cleanup();
    delete window.__openaudiohubConnector;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const CONNECT_PAYLOAD = {
    accessToken: "token-value",
    apiBase: "https://api.plaud.ai",
    region: "global" as const,
    capturedAt: 1,
};

describe("Plaud browser handoff page", () => {
    it("explains that the link is invalid when no code is given", () => {
        render(<PlaudBrowserHandoff code={null} />);

        expect(
            screen.getByText(
                "This sign-in link is invalid. Start again from the OpenAudioHub app.",
            ),
        ).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("asks for the extension when no connector appears", () => {
        vi.useFakeTimers();
        render(<PlaudBrowserHandoff code="abc" />);

        act(() => {
            vi.advanceTimersByTime(10_000);
        });

        expect(
            screen.getByText(
                /Install the OpenAudioHub Connector extension in this browser, then reload this page\./,
            ),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("link", {
                    name: "Install the OpenAudioHub Connector",
                })
                .getAttribute("href"),
        ).toBe(
            "https://github.com/JeremyL691/openaudiohub-connector#installation",
        );
        expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    });

    it("connects and shows the success message", async () => {
        const connect = vi.fn().mockResolvedValue(CONNECT_PAYLOAD);
        window.__openaudiohubConnector = { version: 1, connect };
        const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
        vi.stubGlobal("fetch", fetchMock);

        render(<PlaudBrowserHandoff code="abc" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Continue with Plaud" }),
        );

        await waitFor(() =>
            expect(
                screen.getByText(
                    "Plaud is connected. Return to the OpenAudioHub app. You can close this tab.",
                ),
            ).toBeTruthy(),
        );
        expect(connect).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe("/api/plaud/auth/handoff/complete");
        expect(JSON.parse(String(init.body))).toEqual({
            code: "abc",
            accessToken: "token-value",
            apiBase: "https://api.plaud.ai",
        });
    });

    it("shows the expired message from the API on a 410 response", async () => {
        window.__openaudiohubConnector = {
            version: 1,
            connect: vi.fn().mockResolvedValue(CONNECT_PAYLOAD),
        };
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                jsonResponse(
                    {
                        error: "This sign-in link has expired.",
                        code: "PLAUD_HANDOFF_EXPIRED",
                    },
                    410,
                ),
            ),
        );

        render(<PlaudBrowserHandoff code="abc" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Continue with Plaud" }),
        );

        await waitFor(() =>
            expect(screen.getByRole("alert").textContent).toBe(
                "This sign-in link has expired.",
            ),
        );
        expect(
            screen.getByRole("button", { name: "Continue with Plaud" }),
        ).toBeTruthy();
    });
});
