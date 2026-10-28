import { describe, expect, it } from "vitest";
import { RESULT_TTL, choosePopupView } from "../../src/view";

const now = 1_800_000_000_000;

describe("choosePopupView", () => {
    it("shows the flow in progress first", () => {
        expect(choosePopupView({ hasFlow: true, result: null, isConnectPage: true, now })).toEqual({ state: "waiting" });
    });

    it("offers Connect on a connect page even after a successful sign-in", () => {
        const result = { ok: true as const, at: now - 1000 };
        expect(choosePopupView({ hasFlow: false, result, isConnectPage: true, now })).toEqual({
            state: "confirm",
            failure: null,
        });
    });

    it("shows a recent failure above Connect on a connect page", () => {
        const result = { ok: false as const, reason: "timeout" as const, at: now - 1000 };
        expect(choosePopupView({ hasFlow: false, result, isConnectPage: true, now })).toEqual({
            state: "confirm",
            failure: "timeout",
        });
    });

    it("drops an old failure on a connect page", () => {
        const result = { ok: false as const, reason: "timeout" as const, at: now - RESULT_TTL - 1 };
        expect(choosePopupView({ hasFlow: false, result, isConnectPage: true, now })).toEqual({
            state: "confirm",
            failure: null,
        });
    });

    it("shows a recent result on another page", () => {
        const result = { ok: false as const, reason: "page-gone" as const, at: now - 1000 };
        expect(choosePopupView({ hasFlow: false, result, isConnectPage: false, now })).toEqual({
            state: "result",
            result,
        });
    });

    it("shows help for an old result or one without a time", () => {
        const old = { ok: true as const, at: now - RESULT_TTL - 1 };
        expect(choosePopupView({ hasFlow: false, result: old, isConnectPage: false, now })).toEqual({ state: "help" });
        expect(choosePopupView({ hasFlow: false, result: { ok: true }, isConnectPage: false, now })).toEqual({
            state: "help",
        });
        expect(choosePopupView({ hasFlow: false, result: null, isConnectPage: false, now })).toEqual({ state: "help" });
    });
});
