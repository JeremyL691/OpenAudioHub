#!/usr/bin/env node
// Checks relative links and in-repo anchors in the published documentation.
// External URLs are not fetched. Site paths under /docs map to content/docs.
// Usage: node scripts/dev/check-doc-links.mjs

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROOT_DOCS = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "BRANCHING.md",
    "CODE_OF_CONDUCT.md",
    "AGENTS.md",
    "CHANGELOG.md",
    "audio-pipeline/README.md",
];

// docs/dev holds working logs for the rebuild and is not published.
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dev"]);

function walk(dir, exts, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(entry)) walk(full, exts, out);
        } else if (exts.includes(extname(entry))) {
            out.push(full);
        }
    }
    return out;
}

function collectFiles() {
    const files = ROOT_DOCS.map((f) => join(root, f)).filter((f) =>
        existsSync(f),
    );
    files.push(...walk(join(root, "docs"), [".md"]));
    files.push(...walk(join(root, "content", "docs"), [".mdx"]));
    return files;
}

function stripFences(text) {
    const lines = text.split("\n");
    const kept = [];
    let inFence = false;
    lines.forEach((line, index) => {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            kept.push({ line: index + 1, text: "" });
            return;
        }
        kept.push({ line: index + 1, text: inFence ? "" : line });
    });
    return kept;
}

function extractLinks(text) {
    const links = [];
    for (const { line, text: content } of stripFences(text)) {
        // Blank out inline code so example link syntax is not checked.
        const visible = content.replace(/`[^`]*`/g, (m) =>
            " ".repeat(m.length),
        );
        const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
        let match = re.exec(visible);
        while (match !== null) {
            links.push({ line, target: match[1] });
            match = re.exec(visible);
        }
    }
    return links;
}

function slugify(heading) {
    return heading
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*~]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
}

const slugCache = new Map();

function headingSlugs(file) {
    if (slugCache.has(file)) return slugCache.get(file);
    const slugs = new Set();
    const seen = new Map();
    for (const { text } of stripFences(readFileSync(file, "utf8"))) {
        const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
        if (!match) continue;
        const base = slugify(match[1]);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        slugs.add(count === 0 ? base : `${base}-${count}`);
    }
    slugCache.set(file, slugs);
    return slugs;
}

function existingFile(candidate) {
    const options = [
        candidate,
        `${candidate}.md`,
        `${candidate}.mdx`,
        join(candidate, "index.md"),
        join(candidate, "index.mdx"),
    ];
    return options.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

function checkLink(fromFile, target) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { external: true };

    const hashAt = target.indexOf("#");
    const pathPart = (hashAt === -1 ? target : target.slice(0, hashAt)).split(
        "?",
    )[0];
    const anchor =
        hashAt === -1 ? null : decodeURIComponent(target.slice(hashAt + 1));

    if (pathPart === "") {
        if (anchor === null) return { ok: true };
        const slugs = headingSlugs(fromFile);
        return slugs.has(anchor)
            ? { ok: true }
            : { ok: false, reason: `no heading for #${anchor}` };
    }

    let resolved;
    if (pathPart.startsWith("/docs")) {
        const sitePath = pathPart.replace(/\/$/, "");
        const rel = sitePath === "/docs" ? "" : sitePath.slice("/docs/".length);
        resolved = join(root, "content", "docs", rel);
    } else if (pathPart.startsWith("/")) {
        // Runtime routes such as /api/... are not files in this repository.
        return { ok: true, skipped: true };
    } else {
        resolved = resolve(dirname(fromFile), decodeURIComponent(pathPart));
    }

    const file = existingFile(resolved);
    if (file === null) {
        return {
            ok: false,
            reason: `no such file: ${relative(root, resolved)}`,
        };
    }
    if (anchor === null) return { ok: true };
    if (![".md", ".mdx"].includes(extname(file))) return { ok: true };
    return headingSlugs(file).has(anchor)
        ? { ok: true }
        : {
              ok: false,
              reason: `no heading for #${anchor} in ${relative(root, file)}`,
          };
}

const files = collectFiles();
let checked = 0;
let external = 0;
let skipped = 0;
const broken = [];

for (const file of files) {
    for (const { line, target } of extractLinks(readFileSync(file, "utf8"))) {
        const result = checkLink(file, target);
        if (result.external) {
            external += 1;
        } else if (result.skipped) {
            skipped += 1;
        } else {
            checked += 1;
            if (!result.ok) {
                broken.push(
                    `${relative(root, file)}:${line}: ${target}: ${result.reason}`,
                );
            }
        }
    }
}

for (const entry of broken) console.error(entry);
console.log(
    `Checked ${checked} internal links in ${files.length} files. ` +
        `${external} external and ${skipped} runtime-route links were not checked. ` +
        `${broken.length} broken.`,
);
process.exitCode = broken.length === 0 ? 0 : 1;
