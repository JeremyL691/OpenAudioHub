import { describe, expect, it } from "vitest";
import {
    moveItem,
    orderRecordings,
} from "@/components/recordings/merge-recordings-dialog";
import type { Recording } from "@/types/recording";

function rec(id: string, startTime: string, createdAt: string): Recording {
    return {
        id,
        filename: id,
        duration: 1000,
        filesize: 1,
        deviceSn: "",
        startTime,
        createdAt,
    } as Recording;
}

describe("orderRecordings", () => {
    const a = rec("a", "2026-01-02T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
    const b = rec("b", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    const c = rec("c", "2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    it("sorts by recording time ascending", () => {
        expect(orderRecordings([a, b, c], "time").map((r) => r.id)).toEqual([
            "b",
            "a",
            "c",
        ]);
    });

    it("sorts by import time ascending", () => {
        expect(orderRecordings([a, b, c], "import").map((r) => r.id)).toEqual([
            "c",
            "b",
            "a",
        ]);
    });

    it("does not mutate the input", () => {
        const input = [a, b, c];
        orderRecordings(input, "time");
        expect(input.map((r) => r.id)).toEqual(["a", "b", "c"]);
    });
});

describe("moveItem", () => {
    it("swaps with the neighbour in each direction", () => {
        expect(moveItem(["x", "y", "z"], 1, -1)).toEqual(["y", "x", "z"]);
        expect(moveItem(["x", "y", "z"], 1, 1)).toEqual(["x", "z", "y"]);
    });

    it("returns the same list when moving past an end", () => {
        const list = ["x", "y"];
        expect(moveItem(list, 0, -1)).toBe(list);
        expect(moveItem(list, 1, 1)).toBe(list);
    });
});
