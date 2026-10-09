// Desktop launcher for the Next.js standalone server (PLAN D-319).
// It starts the server the same way as the standalone server.js, with two differences:
// the config is read from .next/required-server-files.json, and experimental.isrFlushToDisk
// is false, so Next never writes its fetch cache into this directory (the app bundle is read-only).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
process.env.NODE_ENV = "production";
process.chdir(dir);

const requiredServerFiles = JSON.parse(
    fs.readFileSync(path.join(dir, ".next", "required-server-files.json"), "utf8"),
);
const nextConfig = requiredServerFiles.config;
nextConfig.experimental = {
    ...(nextConfig.experimental || {}),
    isrFlushToDisk: false,
};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

const port = Number.parseInt(process.env.PORT || "", 10);
const hostname = process.env.OAH_LISTEN_HOST || "127.0.0.1";

startServer({
    dir,
    isDev: false,
    config: nextConfig,
    hostname,
    port,
    allowRetry: false,
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
