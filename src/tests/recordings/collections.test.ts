import { describe, expect, it } from "vitest";
import { inCollection, isCollectionId } from "@/lib/recordings/collections";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function rec(overrides: {
    starred?: boolean;
    startTime?: string;
    deviceSn?: string;
}) {
    return {
        starred: false,
        startTime: "2026-10-15T11:00:00.000Z",
        deviceSn: "SN-1",
        ...overrides,
    };
}

describe("isCollectionId", () => {
    it("accepts the known collection ids", () => {
        for (const id of ["starred", "recent", "plaud", "uploaded"]) {
            expect(isCollectionId(id)).toBe(true);
        }
    });

    it("rejects unknown values", () => {
        expect(isCollectionId("all")).toBe(false);
        expect(isCollectionId("")).toBe(false);
        expect(isCollectionId(undefined)).toBe(false);
        expect(isCollectionId(null)).toBe(false);
        expect(isCollectionId(1)).toBe(false);
    });
});

describe("inCollection", () => {
    it("starred: only recordings with starred true", () => {
        expect(inCollection(rec({ starred: true }), "starred", now)).toBe(true);
        expect(inCollection(rec({ starred: false }), "starred", now)).toBe(
            false,
        );
    });

    it("recent: within 7 days is included, older is excluded", () => {
        expect(
            inCollection(
                rec({ startTime: new Date(now - 6 * DAY).toISOString() }),
                "recent",
                now,
            ),
        ).toBe(true);
        expect(
            inCollection(
                rec({ startTime: new Date(now - 7 * DAY).toISOString() }),
                "recent",
                now,
            ),
        ).toBe(true);
        expect(
            inCollection(
                rec({ startTime: new Date(now - 8 * DAY).toISOString() }),
                "recent",
                now,
            ),
        ).toBe(false);
    });

    it("uploaded: only local device recordings", () => {
        expect(inCollection(rec({ deviceSn: "local" }), "uploaded", now)).toBe(
            true,
        );
        expect(inCollection(rec({ deviceSn: "SN-1" }), "uploaded", now)).toBe(
            false,
        );
    });

    it("plaud: every recording not from the local device", () => {
        expect(inCollection(rec({ deviceSn: "SN-1" }), "plaud", now)).toBe(
            true,
        );
        expect(inCollection(rec({ deviceSn: "local" }), "plaud", now)).toBe(
            false,
        );
    });
});
