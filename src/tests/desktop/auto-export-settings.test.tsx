// @vitest-environment jsdom
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportSection } from "@/components/settings-sections/export-section";

// Stable setter, like the real hook; a fresh one each render would refetch.
const settingsHook = vi.hoisted(() => ({
    setIsLoadingSettings: () => {},
}));
vi.mock("@/hooks/use-settings", () => ({
    useSettings: () => ({
        isLoadingSettings: false,
        setIsLoadingSettings: settingsHook.setIsLoadingSettings,
        isSavingSettings: false,
    }),
}));

afterEach(() => {
    cleanup();
    delete window.__openaudiohubDesktop;
    vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

// Stubs the settings GET, the backup GET, and the settings PUT.
function installFetch() {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/settings/user" && init?.method === "PUT") {
            return jsonResponse({});
        }
        if (url === "/api/settings/user") {
            return jsonResponse({
                defaultExportFormat: "json",
                autoExport: false,
                autoExportFolder: null,
                autoExportTitleMode: "original",
                backupFrequency: null,
            });
        }
        if (url === "/api/backup") return jsonResponse({ jobs: [] });
        throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

// The backup-frequency row also shows "Coming soon", so scope to this row.
function autoExportRowText(): string {
    return (
        screen.getByText("Auto-export new recordings").parentElement
            ?.textContent ?? ""
    );
}

function putBodies(fetchMock: ReturnType<typeof installFetch>) {
    return fetchMock.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([, init]) => JSON.parse(String(init?.body)));
}

describe("export section auto-export settings", () => {
    it("shows Coming soon and a disabled switch without the desktop bridge", async () => {
        installFetch();
        render(<ExportSection />);

        await screen.findByText("Auto-export new recordings");
        expect(autoExportRowText()).toContain("Coming soon");
        const toggle = document.getElementById(
            "auto-export",
        ) as HTMLButtonElement;
        expect(toggle.disabled).toBe(true);
        expect(screen.queryByTestId("auto-export-folder")).toBeNull();
        expect(screen.queryByTestId("auto-export-title-mode")).toBeNull();
    });

    it("saves a chosen folder and enables the switch", async () => {
        window.__openaudiohubDesktop = {
            version: 1,
            pickFolder: vi.fn(async () => "/Users/me/Recordings"),
        };
        const fetchMock = installFetch();
        render(<ExportSection />);

        const chooseButton = await screen.findByTestId("auto-export-folder");
        fireEvent.click(chooseButton);

        await waitFor(() =>
            expect(putBodies(fetchMock)).toEqual([
                { autoExportFolder: "/Users/me/Recordings" },
            ]),
        );
        expect(autoExportRowText()).not.toContain("Coming soon");
        await waitFor(() => {
            const toggle = document.getElementById(
                "auto-export",
            ) as HTMLButtonElement;
            expect(toggle.disabled).toBe(false);
        });
        expect(screen.getByText("/Users/me/Recordings")).toBeTruthy();
    });

    it("does not save when the folder picker is canceled", async () => {
        window.__openaudiohubDesktop = {
            version: 1,
            pickFolder: vi.fn(async () => null),
        };
        const fetchMock = installFetch();
        render(<ExportSection />);

        fireEvent.click(await screen.findByTestId("auto-export-folder"));

        await waitFor(() =>
            expect(window.__openaudiohubDesktop?.pickFolder).toHaveBeenCalled(),
        );
        expect(putBodies(fetchMock)).toEqual([]);
        expect(screen.getByText("No folder chosen")).toBeTruthy();
    });

    it("saves the file name mode when Date is selected", async () => {
        window.__openaudiohubDesktop = {
            version: 1,
            pickFolder: vi.fn(async () => null),
        };
        const fetchMock = installFetch();
        render(<ExportSection />);

        fireEvent.click(
            await screen.findByTestId("auto-export-title-mode-date"),
        );

        await waitFor(() =>
            expect(putBodies(fetchMock)).toEqual([
                { autoExportTitleMode: "date" },
            ]),
        );
    });
});
