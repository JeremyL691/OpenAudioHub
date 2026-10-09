// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistedToggle } from "@/hooks/use-persisted-toggle";

const KEY = "oah.test.card.open";

describe("usePersistedToggle", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it("starts open when nothing is saved", () => {
        const { result } = renderHook(() => usePersistedToggle(KEY));
        expect(result.current[0]).toBe(true);
    });

    it("restores a saved collapsed state after mount", () => {
        window.localStorage.setItem(KEY, "closed");
        const { result } = renderHook(() => usePersistedToggle(KEY));
        expect(result.current[0]).toBe(false);
    });

    it("saves each toggle so a later mount restores it", () => {
        const first = renderHook(() => usePersistedToggle(KEY));
        act(() => first.result.current[1]());
        expect(first.result.current[0]).toBe(false);
        expect(window.localStorage.getItem(KEY)).toBe("closed");
        first.unmount();

        const second = renderHook(() => usePersistedToggle(KEY));
        expect(second.result.current[0]).toBe(false);
    });

    it("still toggles in memory when storage throws", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const { result } = renderHook(() => usePersistedToggle(KEY));
        expect(result.current[0]).toBe(true);
        act(() => result.current[1]());
        expect(result.current[0]).toBe(false);
    });
});
