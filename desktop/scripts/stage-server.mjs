#!/usr/bin/env node
// Stages the Next.js standalone server for the desktop app into desktop/build/server (PLAN T12.2).
// Input: the repository's `pnpm build` output (.next/standalone, .next/static, public, src/db/migrations, scripts/install.sh).
// Output: a tree the Electron main process can run from a read-only app bundle.
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "..");
const out = join(desktopRoot, "build", "server");

function requireExists(path, hint) {
    if (!existsSync(path)) {
        throw new Error(`missing ${path}; ${hint}`);
    }
}

requireExists(
    join(repoRoot, ".next", "standalone", "server.js"),
    "run `pnpm build` at the repository root first",
);
requireExists(
    join(repoRoot, ".next", "static"),
    "run `pnpm build` at the repository root first",
);
requireExists(
    join(
        repoRoot,
        ".next",
        "standalone",
        ".next",
        "required-server-files.json",
    ),
    "the standalone build is incomplete",
);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Next standalone output (node_modules is traced by Next and includes everything the server needs).
// Keep the standalone layout as Next writes it: pnpm links are relative and valid inside the tree (as in the Docker image).
cpSync(join(repoRoot, ".next", "standalone"), out, {
    recursive: true,
    verbatimSymlinks: true,
});
// The standalone entry point is replaced by the desktop launcher.
rmSync(join(out, "server.js"), { force: true });
copyFileSync(
    join(desktopRoot, "resources", "server-desktop.js"),
    join(out, "server-desktop.js"),
);

// 2. Static assets and public files are not copied by Next into the standalone folder.
cpSync(join(repoRoot, ".next", "static"), join(out, ".next", "static"), {
    recursive: true,
});
cpSync(join(repoRoot, "public"), join(out, "public"), { recursive: true });

// 3. Migrations (read at startup) and the install script (served by /install.sh).
cpSync(
    join(repoRoot, "src", "db", "migrations"),
    join(out, "src", "db", "migrations"),
    { recursive: true },
);
mkdirSync(join(out, "scripts"), { recursive: true });
copyFileSync(
    join(repoRoot, "scripts", "install.sh"),
    join(out, "scripts", "install.sh"),
);
chmodSync(join(out, "scripts", "install.sh"), 0o755);

// 4. Idempotent migration runner, bundled for Node (no bun at runtime).
await build({
    entryPoints: [join(repoRoot, "src", "db", "migrate-idempotent.ts")],
    outfile: join(out, "migrate.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    logLevel: "warning",
});

console.log(`staged server at ${out}`);
