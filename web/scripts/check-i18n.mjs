#!/usr/bin/env node
/**
 * Checks the interface catalogs under web/src/locales.
 *
 * 1. Every language has the same key set as English, in every namespace.
 * 2. No translation is empty.
 * 3. Every message keeps the named placeholders of its English text (`{name}`).
 * 4. Every plural base has the `one` and `other` categories English uses.
 *
 * The build runs this, so a new interface string that is only written in English fails
 * before it reaches a release. Run it alone with: node scripts/check-i18n.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = join(root, "src/locales");
const REFERENCE = "en";

function languages() {
    return readdirSync(localesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function namespaces(language) {
    return readdirSync(join(localesDir, language))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .sort();
}

function flatten(source, prefix = "", into = new Map()) {
    for (const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, into);
        else into.set(path, value);
    }
    return into;
}

function read(language, namespace) {
    const text = readFileSync(join(localesDir, language, namespace + ".json"), "utf8");
    return flatten(JSON.parse(text));
}

function placeholders(text) {
    return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

const problems = [];
const languagesFound = languages();
if (!languagesFound.includes(REFERENCE)) {
    console.error(`locales: no ${REFERENCE} catalog at ${localesDir}`);
    process.exit(1);
}
const referenceNamespaces = namespaces(REFERENCE);
let keyCount = 0;

for (const namespace of referenceNamespaces) {
    const reference = read(REFERENCE, namespace);
    for (const [key, english] of reference) {
        keyCount++;
        if (typeof english !== "string") {
            problems.push(`${namespace}: ${key} is not a string in ${REFERENCE}`);
            continue;
        }
        const expected = placeholders(english);
        for (const language of languagesFound) {
            if (language === REFERENCE) continue;
            let catalog;
            try {
                catalog = read(language, namespace);
            } catch (error) {
                problems.push(`${language}/${namespace}.json: ${error.message}`);
                continue;
            }
            if (!catalog.has(key)) {
                problems.push(`${language}/${namespace}.json: missing key ${key}`);
                continue;
            }
            const text = catalog.get(key);
            if (typeof text !== "string" || text.trim() === "") {
                problems.push(`${language}/${namespace}.json: empty or non-string ${key}`);
                continue;
            }
            const got = placeholders(text);
            if (got.join(",") !== expected.join(",")) {
                problems.push(`${language}/${namespace}.json: ${key} has placeholders {${got}} but English has {${expected}}`);
            }
        }
    }
    for (const language of languagesFound) {
        const catalog = read(language, namespace);
        for (const key of catalog.keys()) {
            if (!reference.has(key)) problems.push(`${language}/${namespace}.json: unknown key ${key} (not in ${REFERENCE})`);
        }
    }
}

for (const language of languagesFound) {
    const found = namespaces(language);
    for (const namespace of referenceNamespaces) {
        if (!found.includes(namespace)) problems.push(`${language}: missing namespace ${namespace}.json`);
    }
    for (const namespace of found) {
        if (!referenceNamespaces.includes(namespace)) problems.push(`${language}: namespace ${namespace}.json has no ${REFERENCE} counterpart`);
    }
}

if (problems.length > 0) {
    for (const problem of problems) console.error(`locales: ${problem}`);
    console.error(`locales: ${problems.length} problem(s) in ${keyCount} keys across ${languagesFound.length} languages`);
    process.exit(1);
}

// Long interface text sitting in a component instead of a catalog is a missed translation.
// The scan is deliberately narrow: JSX text between tags of at least three words, which is the
// shape of a sentence a person reads. Attributes, code, comments and user data are not scanned.
const sourceRoots = [join(root, "src/components"), join(root, "src/pages")];
const SKIP = [
    // Brand and licence text, kept identical in every language.
    /OpenAudioHub contributors/i,
    /Licensed under AGPL-3\.0/i,
];

function* sourceFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(path);
        else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) yield path;
    }
}

const hardcoded = [];
for (const directory of sourceRoots) {
    let files;
    try {
        files = [...sourceFiles(directory)];
    } catch {
        continue;
    }
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/>([^<>{}]{12,})</g)) {
            const content = match[1].replace(/\s+/g, " ").trim();
            // A sentence a person reads: several words, letters first, and no code punctuation.
            if (content.split(" ").length < 3) continue;
            if (!/^[A-Za-z"“(]/.test(content)) continue;
            if (/[=;()\[\]{}]|=>|<|>|\||const |return |useState|useRef|useEffect/.test(content)) continue;
            if (!/[A-Za-z]/.test(content)) continue;
            if (SKIP.some((pattern) => pattern.test(content))) continue;
            const line = text.slice(0, match.index).split("\n").length;
            hardcoded.push(`${file.slice(root.length + 1)}:${line}: ${content}`);
        }
    }
}

if (hardcoded.length > 0) {
    for (const finding of hardcoded) console.error(`locales: interface text outside the catalogs: ${finding}`);
    console.error(`locales: ${hardcoded.length} hard-coded interface string(s); move them into the catalogs`);
    process.exit(1);
}

console.log(`locales: ${keyCount} keys in ${languagesFound.length} languages (${languagesFound.join(", ")})`);
