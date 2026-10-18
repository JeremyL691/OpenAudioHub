// Minimal Plaud API for the contract suite. It answers the calls the app makes, keeps state per
// account email, and offers test-only control routes under /__control/. Never contacts real Plaud servers.
// Usage: node fakes/fake-plaud.mjs [port]     Point the server at it with OAH_PLAUD_API_BASE=http://127.0.0.1:<port>
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const port = Number(process.argv[2] ?? process.env.FAKE_PLAUD_PORT ?? 3298);
const origin = `http://127.0.0.1:${port}`;
const AUDIO = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/tone-3s.mp3"));
const DAY = 24 * 3600;

const accounts = new Map(); // email -> { recordings: Map<id, record>, devices: [], revoked: boolean }
const tokens = new Map(); // bearer -> { kind: "ut" | "wt", email }
const failures = []; // { path, status, retryAfter?, email?, times }
const log = []; // { method, path, query, ua, auth, at }
let seq = 0;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.ZmFrZQ`;
const now = () => Math.floor(Date.now() / 1000);
const wsId = (email) => `ws-${Buffer.from(email).toString("hex").slice(0, 16)}`;

function account(email) {
    if (!accounts.has(email)) {
        accounts.set(email, {
            recordings: new Map(),
            devices: [{ sn: "SN-FAKE-1", name: "Fake Pin", model: "PLAUD-NOTE", version_number: 1234 }],
            revoked: false,
        });
    }
    return accounts.get(email);
}

function recordingDefaults(partial) {
    const start = Date.now() - 3600_000;
    const id = partial.id ?? `rec-${++seq}`;
    return {
        id,
        filename: `Fake recording ${id}`,
        keywords: [],
        filesize: AUDIO.length,
        filetype: "mp3",
        fullname: `${id}.mp3`,
        file_md5: "d41d8cd98f00b204e9800998ecf8427e",
        ori_ready: true,
        version: 1,
        version_ms: 1000,
        edit_time: start,
        edit_from: "web",
        is_trash: false,
        start_time: start,
        end_time: start + 3000,
        duration: 3000,
        timezone: 0,
        zonemins: 0,
        scene: 0,
        filetag_id_list: [],
        serial_number: "SN-FAKE-1",
        is_trans: false,
        is_summary: false,
    };
}

function bearerOf(req) {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** The account behind a valid, unrevoked token, or null. */
function authed(req) {
    const t = tokens.get(bearerOf(req) ?? "");
    if (!t) return null;
    const acct = accounts.get(t.email);
    if (!acct || acct.revoked) return null;
    return { ...t, acct };
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
}

function takeFailure(path, email) {
    const i = failures.findIndex(
        (f) => path.startsWith(f.path) && (f.email === undefined || f.email === email) && f.times > 0,
    );
    if (i < 0) return null;
    failures[i].times -= 1;
    return failures[i];
}

async function control(req, res, url, body) {
    const data = body ? JSON.parse(body) : {};
    if (url.pathname === "/__control/health") return send(res, 200, { ok: true });
    if (url.pathname === "/__control/reset") {
        accounts.clear();
        tokens.clear();
        failures.length = 0;
        log.length = 0;
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__control/account") {
        const acct = account(data.email);
        if (typeof data.revoked === "boolean") acct.revoked = data.revoked;
        if (Array.isArray(data.devices)) acct.devices = data.devices;
        for (const partial of data.recordings ?? []) {
            const prev = acct.recordings.get(partial.id);
            const next = prev ? { ...prev, ...partial } : { ...recordingDefaults(partial), ...partial };
            acct.recordings.set(next.id, next);
        }
        return send(res, 200, { ok: true, recordings: acct.recordings.size });
    }
    if (url.pathname === "/__control/fail") {
        failures.push({ path: data.path, status: data.status, retryAfter: data.retryAfter, email: data.email, times: data.times ?? 1 });
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__control/requests") return send(res, 200, { requests: log });
    return send(res, 404, { status: -1, msg: "unknown control route" });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname.startsWith("/__control/")) return control(req, res, url, body);
    // Audio and content links are presigned in production, so these routes take no bearer token.
    const audio = url.pathname.match(/^\/audio\/[^/]+$/);
    if (req.method === "GET" && audio) {
        log.push({ method: "GET", path: url.pathname, query: "", ua: req.headers["user-agent"] ?? null, auth: "none", at: Date.now() });
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": AUDIO.length });
        return res.end(AUDIO);
    }
    const content = url.pathname.match(/^\/content\/([^/]+)\/(transcript|summary)\.json$/);
    if (req.method === "GET" && content) {
        const [, id, kind] = content;
        if (kind === "transcript") {
            const segments = [{ start_time: 0, end_time: 1000, speaker: "1", content: `Fake transcript line for ${id}` }];
            res.writeHead(200, { "content-type": "application/octet-stream" });
            return res.end(gzipSync(Buffer.from(JSON.stringify(segments))));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ai_content: "Fake summary from Plaud", key_points: ["Key point"] }));
    }


    // "/eu" and "/loop" are the regional prefixes the sign-in redirect hands out. They route to the same handlers.
    const path = url.pathname.replace(/^\/(eu|loop)(?=\/)/, "");
    const auth = authed(req);
    const bearer = bearerOf(req);
    log.push({
        method: req.method,
        path,
        query: url.search.slice(1),
        ua: req.headers["user-agent"] ?? null,
        auth: bearer ? (tokens.get(bearer)?.kind ?? "unknown") : "none",
        at: Date.now(),
    });

    const failure = takeFailure(path, auth?.email);
    if (failure) {
        const headers = failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : {};
        return send(res, failure.status, { status: -1, msg: "injected failure" }, headers);
    }

    if (req.method === "POST" && path === "/auth/otp-send-code") {
        const { username = "" } = JSON.parse(body || "{}");
        if (username.startsWith("unknown.")) return send(res, 200, { status: 1, msg: "Email not registered" });
        if (username.startsWith("loop.")) {
            return send(res, 200, { status: -302, msg: "", data: { domains: { api: `${origin}/loop` } } });
        }
        if (username.startsWith("region.") && path === url.pathname) {
            return send(res, 200, { status: -302, msg: "", data: { domains: { api: `${origin}/eu` } } });
        }
        account(username);
        return send(res, 200, { status: 0, msg: "ok", token: `otp:${username}:${++seq}` });
    }

    if (req.method === "POST" && path === "/auth/otp-login") {
        const { code, token = "" } = JSON.parse(body || "{}");
        const email = token.startsWith("otp:") ? token.split(":")[1] : null;
        if (!email || code !== "123456" && code !== "999999") {
            return send(res, 200, { status: -1, msg: "Verification code is wrong" });
        }
        const claims = { sub: email, iat: now(), jti: ++seq };
        const access =
            code === "999999"
                ? jwt({ ...claims, exp: now() + DAY, ut_ref: "ut-ref", wid: wsId(email), wtype: "0" })
                : jwt({ ...claims, exp: now() + 300 * DAY });
        tokens.set(access, { kind: code === "999999" ? "wt" : "ut", email });
        account(email);
        return send(res, 200, { status: 0, msg: "ok", access_token: access });
    }

    if (!auth) return send(res, 401, { status: -1, msg: "Unauthorized" });

    if (req.method === "GET" && path === "/user/me") {
        return send(res, 200, { status: 0, msg: "ok", data: { email: auth.email } });
    }

    if (req.method === "GET" && path === "/team-app/workspaces/list") {
        return send(res, 200, {
            status: 0,
            msg: "ok",
            data: { workspaces: [{ workspace_id: wsId(auth.email), workspace_type: "0", name: "Personal", role: "owner" }] },
        });
    }

    const wtMatch = path.match(/^\/user-app\/auth\/workspace\/token\/(.+)$/);
    if (req.method === "POST" && wtMatch) {
        if (auth.kind !== "ut") return send(res, 401, { status: -1, msg: "Unauthorized" });
        if (decodeURIComponent(wtMatch[1]) !== wsId(auth.email)) {
            return send(res, 404, { status: -1, msg: "Workspace not found" });
        }
        const wt = jwt({ sub: auth.email, iat: now(), exp: now() + DAY, ut_ref: "ut-ref", wid: wsId(auth.email), wtype: "0" });
        tokens.set(wt, { kind: "wt", email: auth.email });
        return send(res, 200, {
            status: 0,
            msg: "ok",
            data: { status: 0, workspace_token: wt, expires_in: DAY, workspace_id: wsId(auth.email) },
        });
    }

    if (req.method === "GET" && path === "/device/list") {
        return send(res, 200, { status: 0, msg: "ok", data_devices: auth.acct.devices });
    }

    if (req.method === "GET" && path === "/file/simple/web") {
        const skip = Number(url.searchParams.get("skip") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const trash = url.searchParams.get("is_trash") === "1";
        const all = [...auth.acct.recordings.values()]
            .filter((r) => r.is_trash === trash)
            .sort((a, b) => b.edit_time - a.edit_time);
        return send(res, 200, {
            status: 0,
            msg: "ok",
            data_file_total: all.length,
            data_file_list: all.slice(skip, skip + limit),
        });
    }

    const tempMatch = path.match(/^\/file\/temp-url\/([^/]+)$/);
    if (req.method === "GET" && tempMatch) {
        const id = tempMatch[1];
        if (!auth.acct.recordings.has(id)) return send(res, 404, { status: -1, msg: "File not found" });
        return send(res, 200, {
            status: 0,
            temp_url: `${origin}/audio/${id}.mp3`,
            temp_url_opus: `${origin}/audio/${id}.opus`,
        });
    }

    const detailMatch = path.match(/^\/file\/detail\/([^/]+)$/);
    if (req.method === "GET" && detailMatch) {
        const rec = auth.acct.recordings.get(detailMatch[1]);
        if (!rec) return send(res, 404, { status: -1, msg: "File not found" });
        const content_list = [];
        const pre_download_content_list = [];
        if (rec.is_trans) {
            content_list.push({
                data_id: `source_transaction:${rec.id}`,
                data_type: "transaction",
                task_status: 1,
                data_link: `${origin}/content/${rec.id}/transcript.json`,
            });
        }
        if (rec.is_summary) {
            content_list.push({
                data_id: `auto_sum:${rec.id}`,
                data_type: "auto_sum_note",
                task_status: 1,
                data_link: `${origin}/content/${rec.id}/summary.json`,
            });
            pre_download_content_list.push({
                data_id: `auto_sum:${rec.id}`,
                data_content: JSON.stringify({
                    ai_content: "Fake summary from Plaud",
                    key_points: ["Key point"],
                    action_items: ["Follow up"],
                }),
            });
        }
        return send(res, 200, {
            status: 0,
            msg: "ok",
            data: { file_id: rec.id, file_name: rec.filename, content_list, pre_download_content_list },
        });
    }

    if (req.method === "PATCH" && path.startsWith("/file/")) {
        const id = path.slice("/file/".length);
        const rec = auth.acct.recordings.get(id);
        if (!rec) return send(res, 404, { status: -1, msg: "File not found" });
        rec.filename = JSON.parse(body || "{}").filename ?? rec.filename;
        return send(res, 200, { status: 0, msg: "ok", data_file: {} });
    }

    return send(res, 404, { status: -1, msg: "not found" });
});


server.listen(port, "127.0.0.1", () => {
    console.log(`fake Plaud API on ${origin}`);
});
