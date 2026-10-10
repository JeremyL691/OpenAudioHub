import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn(),
}));

vi.mock("@/lib/plaud/connect-with-token", () => ({
    connectPlaudWithToken: vi.fn(),
}));

import { POST as completeRoute } from "@/app/api/plaud/auth/handoff/complete/route";
import {
    POST as createHandoffRoute,
    DELETE,
    GET,
} from "@/app/api/plaud/auth/handoff/route";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, ErrorCode } from "@/lib/errors";
import { connectPlaudWithToken } from "@/lib/plaud/connect-with-token";
import {
    createHandoff,
    getHandoff,
    markHandoffError,
} from "@/lib/plaud/handoff-store";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const HANDOFF_URL = "http://localhost/api/plaud/auth/handoff";
const COMPLETE_URL = "http://localhost/api/plaud/auth/handoff/complete";

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function sessionAs(userId: string): void {
    (requireApiSession as unknown as Mock).mockResolvedValue({
        user: { id: userId },
    });
}

function getReq(code: string): Request {
    return new Request(`${HANDOFF_URL}?code=${encodeURIComponent(code)}`);
}

function deleteReq(code: string): Request {
    return new Request(`${HANDOFF_URL}?code=${encodeURIComponent(code)}`, {
        method: "DELETE",
    });
}

function completeReq(
    body: unknown,
    headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
): Request {
    return new Request(COMPLETE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

async function createCodeFor(userId: string): Promise<string> {
    sessionAs(userId);
    const res = await createHandoffRoute(
        new Request(HANDOFF_URL, { method: "POST" }),
    );
    return ((await res.json()) as { code: string }).code;
}

describe("handoff routes", () => {
    it("creates a code and reports it as pending to its owner", async () => {
        const code = await createCodeFor("user-create");
        expect(code.length).toBeGreaterThanOrEqual(43);

        sessionAs("user-create");
        const res = await GET(getReq(code));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "pending" });
    });

    it("reports another user's code as expired without leaking existence", async () => {
        const code = await createCodeFor("user-owner");

        sessionAs("user-intruder");
        const res = await GET(getReq(code));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "expired" });
    });

    it("reports an unknown code as expired", async () => {
        sessionAs("user-unknown");
        const res = await GET(getReq("does-not-exist"));
        expect(await res.json()).toEqual({ status: "expired" });
    });

    it("lets the owner delete a code, and ignores deletes from other users", async () => {
        const code = await createCodeFor("user-delete");

        sessionAs("user-other");
        const foreign = await DELETE(deleteReq(code));
        expect(foreign.status).toBe(200);
        expect(await foreign.json()).toEqual({ success: true });
        expect(getHandoff(code)).toBeDefined();

        sessionAs("user-delete");
        const own = await DELETE(deleteReq(code));
        expect(await own.json()).toEqual({ success: true });
        expect(getHandoff(code)).toBeUndefined();
    });
});

describe("POST /api/plaud/auth/handoff/complete", () => {
    it("rejects requests without sec-fetch-site same-origin", async () => {
        const code = await createCodeFor("user-csrf");
        const res = await completeRoute(
            completeReq({ code, accessToken: "a.b.c" }, {}),
        );
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe(ErrorCode.FORBIDDEN);
        expect(connectPlaudWithToken).not.toHaveBeenCalled();
    });

    it("rejects cross-site requests", async () => {
        const code = await createCodeFor("user-cross");
        const res = await completeRoute(
            completeReq(
                { code, accessToken: "a.b.c" },
                { "sec-fetch-site": "cross-site" },
            ),
        );
        expect(res.status).toBe(403);
    });

    it("returns 410 for an unknown code", async () => {
        const res = await completeRoute(
            completeReq({ code: "bogus", accessToken: "a.b.c" }),
        );
        expect(res.status).toBe(410);
        const body = await res.json();
        expect(body.error).toBe(
            "This sign-in link has expired. Start again from the OpenAudioHub app.",
        );
        expect(body.code).toBe(ErrorCode.PLAUD_HANDOFF_EXPIRED);
        expect(connectPlaudWithToken).not.toHaveBeenCalled();
    });

    it("returns 410 when the code is missing from the body", async () => {
        const res = await completeRoute(completeReq({ accessToken: "a.b.c" }));
        expect(res.status).toBe(410);
    });

    it("returns 400 when accessToken is missing", async () => {
        const code = await createCodeFor("user-no-token");
        const res = await completeRoute(completeReq({ code }));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe(ErrorCode.MISSING_REQUIRED_FIELD);
        expect(connectPlaudWithToken).not.toHaveBeenCalled();
    });

    it("connects for the code owner, marks the handoff connected, and rejects reuse", async () => {
        const code = await createCodeFor("user-success");
        (connectPlaudWithToken as Mock).mockResolvedValue({ devices: [] });

        const res = await completeRoute(
            completeReq({
                code,
                accessToken: "a.b.c",
                apiBase: "https://api-euc1.plaud.ai",
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(connectPlaudWithToken).toHaveBeenCalledWith({
            userId: "user-success",
            accessToken: "a.b.c",
            apiBase: "https://api-euc1.plaud.ai",
            source: "connector",
        });

        sessionAs("user-success");
        const status = await GET(getReq(code));
        expect(await status.json()).toEqual({ status: "connected" });

        const again = await completeRoute(
            completeReq({ code, accessToken: "a.b.c" }),
        );
        expect(again.status).toBe(410);
        expect(connectPlaudWithToken).toHaveBeenCalledTimes(1);
    });

    it("records the AppError on the handoff and keeps it pending for retry", async () => {
        const code = await createCodeFor("user-retry");
        (connectPlaudWithToken as Mock).mockRejectedValue(
            new AppError(
                ErrorCode.PLAUD_INVALID_TOKEN,
                "Plaud rejected this token.",
                401,
            ),
        );

        const res = await completeRoute(
            completeReq({ code, accessToken: "a.b.c" }),
        );
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe(ErrorCode.PLAUD_INVALID_TOKEN);

        sessionAs("user-retry");
        const status = await GET(getReq(code));
        expect(await status.json()).toEqual({
            status: "pending",
            error: "Plaud rejected this token.",
        });
    });

    it("does not record non-AppError failures on the handoff", async () => {
        const code = await createCodeFor("user-crash");
        (connectPlaudWithToken as Mock).mockRejectedValue(new Error("boom"));
        const res = await completeRoute(
            completeReq({ code, accessToken: "a.b.c" }),
        );
        expect(res.status).toBe(500);
        expect(getHandoff(code)?.error).toBeUndefined();
        expect(getHandoff(code)?.status).toBe("pending");
    });
});

describe("handoff store", () => {
    it("expires codes after ten minutes", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));

        const { code, expiresAt } = createHandoff("user-ttl");
        expect(expiresAt).toBe(Date.now() + TEN_MINUTES_MS);
        expect(getHandoff(code)).toBeDefined();

        vi.setSystemTime(Date.now() + TEN_MINUTES_MS - 1);
        expect(getHandoff(code)).toBeDefined();

        vi.setSystemTime(Date.now() + 1);
        expect(getHandoff(code)).toBeUndefined();
    });

    it("keeps at most five live codes per user and drops the oldest", () => {
        const codes = Array.from(
            { length: 6 },
            () => createHandoff("user-cap").code,
        );
        const other = createHandoff("user-cap-other").code;

        expect(getHandoff(codes[0])).toBeUndefined();
        for (const code of codes.slice(1)) {
            expect(getHandoff(code)?.userId).toBe("user-cap");
        }
        expect(getHandoff(other)?.userId).toBe("user-cap-other");
    });

    it("stores errors without changing the pending status", () => {
        const { code } = createHandoff("user-error-store");
        markHandoffError(code, "nope");
        expect(getHandoff(code)).toMatchObject({
            status: "pending",
            error: "nope",
        });
    });
});
