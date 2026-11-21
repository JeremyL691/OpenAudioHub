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
// 150 frames * 80 bytes = 3.0s of headerless CBR CELT WB 20ms mono Opus frames (TOC 0xB8).
const RAW_OPUS_AUDIO = (() => {
    const buf = Buffer.alloc(150 * 80);
    for (let i = 0; i < 150; i++) {
        buf[i * 80] = 0xb8;
        buf[i * 80 + 1] = 0xff;
        buf[i * 80 + 2] = 0xfe;
    }
    return buf;
})();
const DAY = 24 * 3600;

const accounts = new Map(); // email -> { recordings: Map<id, record>, devices: [], revoked: boolean, migratedV4: boolean }
const tokens = new Map(); // bearer -> { kind: "ut" | "wt", email }
const contentUrls = new Map(); // content_id -> url
const failures = []; // { path, status, plaudStatus?, msg?, retryAfter?, email?, times }
const log = []; // { method, path, query, ua, auth, "x-scope-type", "x-scope-id", at }
let seq = 0;

const MIGRATED_BODY = {
    status: -1800907,
    msg: "Account migrated to 4.0. Please update and reinitialize.",
};

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
            migratedV4: false,
        });
    }
    return accounts.get(email);
}

function v4FileIdOf(rec) {
    if (rec.v4FileId) return rec.v4FileId;
    if (rec.isV4New || rec.id.startsWith("f_") || rec.id.startsWith("of_")) return rec.id;
    return `of_${rec.id}`;
}

function findByV4FileId(acct, fileId) {
    const direct = acct.recordings.get(fileId);
    if (direct) return direct;
    if (fileId.startsWith("of_")) {
        const stripped = acct.recordings.get(fileId.slice(3));
        if (stripped) return stripped;
    }
    for (const rec of acct.recordings.values()) {
        if (v4FileIdOf(rec) === fileId) return rec;
    }
    return null;
}

function recordingDefaults(partial) {
    const start = Date.now() - 3600_000;
    const id = partial.id ?? `rec-${++seq}`;
    const filename = partial.filename ?? `Fake recording ${id}`;
    const versionMs = partial.version_ms ?? 1000;
    return {
        id,
        filename,
        keywords: [],
        filesize: AUDIO.length,
        filetype: "mp3",
        fullname: `${id}.mp3`,
        file_md5: "d41d8cd98f00b204e9800998ecf8427e",
        ori_ready: true,
        version: 1,
        version_ms: versionMs,
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
        timezone_iana: null,
        audioMode: "transcoded",
        migratedContentStatusNull: false,
        summaryMarkdown: false,
        v4FileId: undefined,
        isV4New: false,
        renameConflictOnce: false,
        folderName: partial.folderName ?? filename,
        folderVersionMs: partial.folderVersionMs ?? versionMs,
    };
}

function logRequest(req, path, query) {
    const bearer = bearerOf(req);
    log.push({
        method: req.method,
        path,
        query,
        ua: req.headers["user-agent"] ?? null,
        auth: bearer ? (tokens.get(bearer)?.kind ?? "unknown") : "none",
        "x-scope-type": req.headers["x-scope-type"] ?? null,
        "x-scope-id": req.headers["x-scope-id"] ?? null,
        at: Date.now(),
    });
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
        contentUrls.clear();
        failures.length = 0;
        log.length = 0;
        return send(res, 200, { ok: true });
    }
    if (url.pathname === "/__control/account") {
        const acct = account(data.email);
        if (typeof data.revoked === "boolean") acct.revoked = data.revoked;
        if (typeof data.migratedV4 === "boolean") acct.migratedV4 = data.migratedV4;
        if (Array.isArray(data.devices)) acct.devices = data.devices;
        for (const partial of data.recordings ?? []) {
            const prev = acct.recordings.get(partial.id);
            const next = prev ? { ...prev, ...partial } : { ...recordingDefaults(partial), ...partial };
            acct.recordings.set(next.id, next);
        }
        return send(res, 200, { ok: true, recordings: acct.recordings.size });
    }
    if (url.pathname === "/__control/fail") {
        failures.push({
            path: data.path,
            status: data.status ?? 200,
            plaudStatus: data.plaudStatus,
            msg: data.msg,
            retryAfter: data.retryAfter,
            email: data.email,
            times: data.times ?? 1,
        });
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
        logRequest(req, url.pathname, "");
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": AUDIO.length });
        return res.end(AUDIO);
    }
    const rawAudio = url.pathname.match(/^\/audio-raw\/[^/]+$/);
    if (req.method === "GET" && rawAudio) {
        logRequest(req, url.pathname, "");
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": RAW_OPUS_AUDIO.length });
        return res.end(RAW_OPUS_AUDIO);
    }
    const content = url.pathname.match(/^\/content\/([^/]+)\/(transcript|summary)\.json$/);
    if (req.method === "GET" && content) {
        logRequest(req, url.pathname, "");
        const [, id, kind] = content;
        if (kind === "transcript") {
            const segments = [{ start_time: 0, end_time: 1000, speaker: "1", content: `Fake transcript line for ${id}` }];
            res.writeHead(200, { "content-type": "application/octet-stream" });
            return res.end(gzipSync(Buffer.from(JSON.stringify(segments))));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ai_content: "Fake summary from Plaud", key_points: ["Key point"] }));
    }
    const mdSummary = url.pathname.match(/^\/content\/([^/]+)\/summary\.md$/);
    if (req.method === "GET" && mdSummary) {
        logRequest(req, url.pathname, "");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(gzipSync(Buffer.from("# Summary\nFake v4 markdown summary")));
    }


    // "/eu" and "/loop" are the regional prefixes the sign-in redirect hands out. They route to the same handlers.
    const path = url.pathname.replace(/^\/(eu|loop)(?=\/)/, "");
    const auth = authed(req);
    logRequest(req, path, url.search.slice(1));

    const failure = takeFailure(path, auth?.email);
    if (failure) {
        const headers = failure.retryAfter !== undefined ? { "retry-after": String(failure.retryAfter) } : {};
        return send(
            res,
            failure.status,
            { status: failure.plaudStatus ?? -1, msg: failure.msg ?? "injected failure" },
            headers,
        );
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
        const wt = jwt({
            sub: auth.email,
            iat: now(),
            exp: now() + DAY,
            jti: ++seq,
            ut_ref: "ut-ref",
            wid: wsId(auth.email),
            wtype: "0",
        });
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
        if (auth.acct.migratedV4) return send(res, 200, MIGRATED_BODY);
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
        if (auth.acct.migratedV4) return send(res, 200, MIGRATED_BODY);
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
        if (auth.acct.migratedV4) return send(res, 200, MIGRATED_BODY);
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
        if (auth.acct.migratedV4) return send(res, 200, MIGRATED_BODY);
        const id = path.slice("/file/".length);
        const rec = auth.acct.recordings.get(id);
        if (!rec) return send(res, 404, { status: -1, msg: "File not found" });
        rec.filename = JSON.parse(body || "{}").filename ?? rec.filename;
        return send(res, 200, { status: 0, msg: "ok", data_file: {} });
    }

    if (req.method === "GET" && path === "/file-app/v4/recordings/all") {
        const pageSize = Math.max(1, Number(url.searchParams.get("page_size") ?? 50));
        const cursorRaw = url.searchParams.get("cursor");
        const parsedOffset = cursorRaw ? Number(cursorRaw) : 0;
        const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
        const all = [...auth.acct.recordings.values()]
            .filter((r) => !r.is_trash)
            .sort((a, b) => {
                const diff = (b.created_at_show_ms ?? b.start_time) - (a.created_at_show_ms ?? a.start_time);
                return diff !== 0 ? diff : b.id.localeCompare(a.id);
            });
        const slice = all.slice(offset, offset + pageSize);
        const items = slice.map((r) => {
            const fileId = v4FileIdOf(r);
            return {
                file_id: fileId,
                node_id: `node_${fileId}`,
                parent_id: `wrap_${fileId}`,
                name: r.filename,
                duration_ms: r.duration,
                created_at_show_ms: r.created_at_show_ms ?? r.start_time,
                updated_at_show_ms: r.updated_at_show_ms ?? r.edit_time,
                version_ms: r.version_ms,
            };
        });
        const next_cursor = offset + slice.length < all.length ? String(offset + slice.length) : null;
        return send(res, 200, { status: 0, msg: "ok", data: { items, next_cursor } });
    }

    const v4DetailMatch = path.match(/^\/file-app\/v4\/files\/detail\/([^/]+)$/);
    if (req.method === "GET" && v4DetailMatch) {
        const rec = findByV4FileId(auth.acct, decodeURIComponent(v4DetailMatch[1]));
        if (!rec) return send(res, 404, { status: -1, msg: "File not found" });
        const fileId = v4FileIdOf(rec);
        const nodeId = `node_${fileId}`;
        const parentId = `wrap_${fileId}`;
        const objects = [];
        const audioMode = rec.audioMode ?? "transcoded";
        const mp3Url = `${origin}/audio/${rec.id}.mp3`;
        const opusUrl = `${origin}/audio/${rec.id}.opus`;
        const cidTranscoded = `cid_at_${fileId}`;
        const cidAudio = `cid_a_${fileId}`;
        contentUrls.set(cidTranscoded, mp3Url);
        contentUrls.set(cidAudio, mp3Url);

        if (audioMode === "transcoded") {
            objects.push({
                object_id: `obj_at_${fileId}`,
                object_type: "AUDIO_TRANSCODED",
                content_id: cidTranscoded,
                content_url: mp3Url,
                mime_type: "audio/mpeg",
                object_size: rec.filesize,
                task_status: 1,
            });
            objects.push({
                object_id: `obj_a_${fileId}`,
                object_type: "AUDIO",
                content_id: cidAudio,
                content_url: opusUrl,
                mime_type: "audio/ogg",
                object_size: rec.filesize,
                task_status: 1,
            });
        } else if (audioMode === "audio_only") {
            objects.push({
                object_id: `obj_a_${fileId}`,
                object_type: "AUDIO",
                content_id: cidAudio,
                content_url: mp3Url,
                mime_type: "audio/mpeg",
                object_size: rec.filesize,
                task_status: 1,
            });
        } else if (audioMode === "content_id_only") {
            objects.push({
                object_id: `obj_a_${fileId}`,
                object_type: "AUDIO",
                content_id: cidAudio,
                content_url: null,
                mime_type: "audio/mpeg",
                object_size: rec.filesize,
                task_status: 1,
            });
        } else if (audioMode === "raw_opus") {
            const rawUrl = `${origin}/audio-raw/${rec.id}.mp3`;
            objects.push({
                object_id: `obj_at_${fileId}`,
                object_type: "AUDIO_TRANSCODED",
                content_id: cidTranscoded,
                content_url: null,
                mime_type: "audio/mpeg",
                object_size: rec.filesize,
                task_status: 0,
            });
            objects.push({
                object_id: `obj_a_${fileId}`,
                object_type: "AUDIO",
                content_id: cidAudio,
                content_url: rawUrl,
                mime_type: "audio/opus",
                object_size: RAW_OPUS_AUDIO.length,
                task_status: null,
            });
        }

        if (rec.is_trans) {
            const cidTr = `cid_tr_${fileId}`;
            const trUrl = `${origin}/content/${rec.id}/transcript.json`;
            contentUrls.set(cidTr, trUrl);
            objects.push({
                object_id: `obj_tr_${fileId}`,
                object_type: "TRANSCRIPT",
                content_id: cidTr,
                content_url: trUrl,
                mime_type: "application/json",
                object_size: 128,
                task_status: rec.migratedContentStatusNull ? null : 1,
            });
        }
        if (rec.is_summary) {
            const cidSum = `cid_sum_${fileId}`;
            const sumUrl = rec.summaryMarkdown
                ? `${origin}/content/${rec.id}/summary.md`
                : `${origin}/content/${rec.id}/summary.json`;
            contentUrls.set(cidSum, sumUrl);
            objects.push({
                object_id: `obj_sum_${fileId}`,
                object_type: "SUMMARY",
                content_id: cidSum,
                content_url: sumUrl,
                mime_type: rec.summaryMarkdown ? "text/markdown" : "application/json",
                object_size: 128,
                task_status: rec.migratedContentStatusNull ? null : 1,
            });
        }

        return send(res, 200, {
            status: 0,
            msg: "ok",
            data: {
                node: {
                    node_id: nodeId,
                    parent_id: parentId,
                    name: rec.filename,
                    version_ms: rec.version_ms,
                    folder: {
                        folder_id: parentId,
                        name: rec.folderName,
                    },
                    breadcrumbs: [{ node_id: "root_folder", name: "Recordings" }],
                },
                meta: {
                    file_id: fileId,
                    duration: rec.duration,
                    size_bytes: rec.filesize,
                    timezone_iana: rec.timezone_iana ?? null,
                    start_time: rec.start_time,
                    serial_number: rec.serial_number,
                    version_ms: rec.version_ms,
                },
                objects,
            },
        });
    }

    if (req.method === "POST" && path === "/file-app/v4/files/content/url") {
        const { content_ids = [] } = JSON.parse(body || "{}");
        const url_map = {};
        for (const cid of Array.isArray(content_ids) ? content_ids : []) {
            if (contentUrls.has(cid)) url_map[cid] = contentUrls.get(cid);
        }
        return send(res, 200, { status: 0, msg: "ok", data: { url_map } });
    }

    const v4RenameMatch = path.match(/^\/file-app\/v4\/nodes\/rename\/([^/]+)$/);
    if (req.method === "PATCH" && v4RenameMatch) {
        const nodeId = decodeURIComponent(v4RenameMatch[1]);
        const { name, origin_version } = JSON.parse(body || "{}");
        if (nodeId.startsWith("node_")) {
            const rec = findByV4FileId(auth.acct, nodeId.slice(5));
            if (!rec) return send(res, 404, { status: -1, msg: "Node not found" });
            if (rec.renameConflictOnce) {
                rec.renameConflictOnce = false;
                rec.version_ms += 1000;
                return send(res, 200, { status: -1800313, msg: "Version conflict" });
            }
            if (
                origin_version !== undefined &&
                origin_version !== null &&
                Number(origin_version) !== Number(rec.version_ms)
            ) {
                return send(res, 200, { status: -1800313, msg: "Version conflict" });
            }
            rec.filename = name ?? rec.filename;
            rec.version_ms += 1000;
            const fileId = v4FileIdOf(rec);
            const fileNode = {
                node_id: `node_${fileId}`,
                parent_id: `wrap_${fileId}`,
                name: rec.filename,
                version_ms: rec.version_ms,
            };
            const folderNode = {
                node_id: `wrap_${fileId}`,
                parent_id: "root_folder",
                name: rec.folderName,
                version_ms: rec.folderVersionMs,
            };
            return send(res, 200, { status: 0, msg: "ok", data: { items: [fileNode], parent_items: [folderNode] } });
        }
        if (nodeId.startsWith("wrap_")) {
            const rec = findByV4FileId(auth.acct, nodeId.slice(5));
            if (!rec) return send(res, 404, { status: -1, msg: "Node not found" });
            if (
                origin_version !== undefined &&
                origin_version !== null &&
                Number(origin_version) !== Number(rec.folderVersionMs)
            ) {
                return send(res, 200, { status: -1800313, msg: "Version conflict" });
            }
            rec.folderName = name ?? rec.folderName;
            rec.folderVersionMs += 1000;
            const fileId = v4FileIdOf(rec);
            const folderNode = {
                node_id: `wrap_${fileId}`,
                parent_id: "root_folder",
                name: rec.folderName,
                version_ms: rec.folderVersionMs,
            };
            return send(res, 200, { status: 0, msg: "ok", data: { items: [folderNode], parent_items: [] } });
        }
        return send(res, 404, { status: -1, msg: "Node not found" });
    }

    if (req.method === "GET" && path === "/file-app/v4/folders/children") {
        const items = [...auth.acct.recordings.values()]
            .filter((r) => !r.is_trash)
            .map((r) => {
                const fileId = v4FileIdOf(r);
                return {
                    node_id: `wrap_${fileId}`,
                    parent_id: "root_folder",
                    name: r.folderName,
                    version_ms: r.folderVersionMs,
                };
            });
        return send(res, 200, { status: 0, msg: "ok", data: { items, next_cursor: null } });
    }

    return send(res, 404, { status: -1, msg: "not found" });
});


server.listen(port, "127.0.0.1", () => {
    console.log(`fake Plaud API on ${origin}`);
});
