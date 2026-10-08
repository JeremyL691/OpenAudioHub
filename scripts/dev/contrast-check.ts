// Checks the color token pairs in src/app/globals.css against WCAG 2.2 AA.
// Run with: node scripts/dev/contrast-check.ts
// Text pairs need 4.5:1. Non-text UI boundaries need 3:1. Both schemes are checked.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "src", "app", "globals.css"), "utf8");

type Scheme = "light" | "dark";
type TokenMap = Map<string, string>;

function declarations(block: string): TokenMap {
    const tokens: TokenMap = new Map();
    for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
        tokens.set(match[1], match[2].trim());
    }
    return tokens;
}

const lightBlock = /^:root \{([\s\S]*?)^\}/m.exec(css)?.[1];
const darkBlock = /^\.dark \{([\s\S]*?)^\}/m.exec(css)?.[1];
if (!lightBlock || !darkBlock) {
    throw new Error("Could not find the :root and .dark blocks in globals.css");
}

const schemes: Record<Scheme, TokenMap> = {
    light: declarations(lightBlock),
    // Dark tokens override the light ones. Anything dark does not set falls back to light.
    dark: new Map([...declarations(lightBlock), ...declarations(darkBlock)]),
};

// Follows var(--name) references until it reaches a literal color.
function resolveColor(
    name: string,
    tokens: TokenMap,
    depth = 0,
): string | null {
    if (depth > 8) return null;
    const value = tokens.get(name);
    if (value === undefined) return null;
    const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
    if (reference) return resolveColor(reference[1], tokens, depth + 1);
    return value;
}

// oklch(L C H) to linear sRGB, clamped to the gamut. Relative luminance works on linear values.
function oklchToLinearRgb(value: string): [number, number, number] | null {
    const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
    if (!match) return null;
    const L = Number(match[1]);
    const C = Number(match[2]);
    const hue = (Number(match[3]) * Math.PI) / 180;
    const a = C * Math.cos(hue);
    const b = C * Math.sin(hue);
    const lPrime = L + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = L - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = L - 0.0894841775 * a - 1.291485548 * b;
    const l = lPrime ** 3;
    const m = mPrime ** 3;
    const s = sPrime ** 3;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    return [
        clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
}

function luminance(rgb: [number, number, number]): number {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(
    foreground: string,
    background: string,
    tokens: TokenMap,
): number | null {
    const fg = resolveColor(foreground, tokens);
    const bg = resolveColor(background, tokens);
    if (!fg || !bg) return null;
    const fgRgb = oklchToLinearRgb(fg);
    const bgRgb = oklchToLinearRgb(bg);
    if (!fgRgb || !bgRgb) return null;
    const a = luminance(fgRgb);
    const b = luminance(bgRgb);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [foreground, background, required ratio, what the pair is used for].
// The warning color is a chip background only (with warning-foreground), never page
// text or an icon on the page, so it has no page-level pair here.
const PAIRS: [string, string, number, string][] = [
    ["foreground", "background", 4.5, "page text"],
    ["card-foreground", "card", 4.5, "card text"],
    ["popover-foreground", "popover", 4.5, "popover text"],
    ["primary-foreground", "primary", 4.5, "primary button"],
    ["secondary-foreground", "secondary", 4.5, "secondary button"],
    ["muted-foreground", "background", 4.5, "helper text on page"],
    ["muted-foreground", "muted", 4.5, "helper text on muted surface"],
    ["accent-foreground", "accent", 4.5, "hover and active items"],
    ["destructive", "background", 4.5, "error text on page"],
    ["destructive-foreground", "destructive", 4.5, "destructive button"],
    ["success-foreground", "success", 4.5, "success chip"],
    ["info-foreground", "info", 4.5, "info chip"],
    ["warning-foreground", "warning", 4.5, "warning chip"],
    ["sidebar-foreground", "sidebar", 4.5, "sidebar text"],
    ["sidebar-accent-foreground", "sidebar-accent", 4.5, "sidebar active item"],
    ["sidebar-primary-foreground", "sidebar-primary", 4.5, "sidebar primary"],
    ["input", "background", 3, "input boundary"],
    ["ring", "background", 3, "focus ring"],
    ["brand-blue", "background", 3, "brand accent on page"],
    ["success", "background", 3, "success icon on page"],
    ["info", "background", 3, "info icon on page"],
    ["destructive", "background", 3, "destructive icon on page"],
];

let failures = 0;
for (const scheme of ["light", "dark"] as const) {
    console.log(`\n${scheme}`);
    for (const [fg, bg, required, purpose] of PAIRS) {
        const ratio = contrast(fg, bg, schemes[scheme]);
        if (ratio === null) {
            console.log(`  ?  ${fg} on ${bg}: token not found`);
            failures++;
            continue;
        }
        const pass = ratio >= required;
        if (!pass) failures++;
        console.log(
            `  ${pass ? "ok" : "FAIL"}  ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${required}:1, ${purpose})`,
        );
    }
}

if (failures > 0) {
    console.error(`\ncontrast-check: ${failures} pair(s) below AA or missing`);
    process.exit(1);
}
console.log("\ncontrast-check: all pairs meet AA");
