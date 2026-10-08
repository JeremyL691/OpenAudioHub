import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiEnhancements,
    audioPipelineJobs,
    recordings,
    transcriptions,
} from "@/db/schema";

type Row = Record<string, unknown>;

const fixtures = vi.hoisted(() => ({
    recording: [] as Row[],
    job: [] as Row[],
    removedTranscriptions: [] as Row[],
    deletedTables: [] as unknown[],
}));

vi.mock("@/db", () => {
    const rowsFor = (table: unknown): Row[] => {
        if (table === recordings) return fixtures.recording;
        if (table === audioPipelineJobs) return fixtures.job;
        return [];
    };
    const tx = {
        delete: vi.fn((table: unknown) => {
            fixtures.deletedTables.push(table);
            const done = Promise.resolve();
            return Object.assign(done, {
                where: () =>
                    Object.assign(Promise.resolve(), {
                        returning: async () =>
                            table === transcriptions
                                ? fixtures.removedTranscriptions
                                : [],
                    }),
            });
        }),
        update: vi.fn(() => ({
            set: () => ({ where: async () => undefined }),
        })),
    };
    return {
        db: {
            select: vi.fn(() => ({
                from: (table: unknown) => {
                    const rows = () => rowsFor(table);
                    const limited = { limit: async () => rows() };
                    return {
                        where: () => ({
                            ...limited,
                            orderBy: () => limited,
                        }),
                    };
                },
            })),
            transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
        },
    };
});

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

import { DELETE } from "@/app/api/recordings/[id]/transcription/route";

function call(query = "?source=openaudiohub") {
    return DELETE(
        new Request(
            `http://localhost/api/recordings/rec-1/transcription${query}`,
            {
                method: "DELETE",
            },
        ),
        { params: Promise.resolve({ id: "rec-1" }) },
    );
}

describe("DELETE /api/recordings/[id]/transcription", () => {
    beforeEach(() => {
        fixtures.recording = [{ id: "rec-1" }];
        fixtures.job = [];
        fixtures.removedTranscriptions = [{ id: "t-1" }];
        fixtures.deletedTables = [];
    });

    it("deletes the transcript and the summary written from it", async () => {
        const response = await call();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true });
        expect(fixtures.deletedTables).toContain(transcriptions);
        expect(fixtures.deletedTables).toContain(aiEnhancements);
    });

    it("returns 404 for a recording that is not the caller's or is deleted", async () => {
        fixtures.recording = [];
        const response = await call();
        expect(response.status).toBe(404);
        expect(fixtures.deletedTables).toEqual([]);
    });

    it("refuses to delete while a pipeline job is still running", async () => {
        fixtures.job = [{ status: "running" }];
        const response = await call();
        expect(response.status).toBe(409);
        expect(fixtures.deletedTables).toEqual([]);
    });

    it("returns 404 and keeps the summary when no transcript matches the source", async () => {
        fixtures.removedTranscriptions = [];
        const response = await call("?source=plaud");
        expect(response.status).toBe(404);
        expect(fixtures.deletedTables).not.toContain(aiEnhancements);
    });

    it("rejects an unknown source", async () => {
        const response = await call("?source=elsewhere");
        expect(response.status).toBe(400);
    });
});
