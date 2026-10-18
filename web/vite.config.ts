import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.OAH_API ?? "http://localhost:3000";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    // In development the Rust server answers /api (port 3000 unless OAH_API names another).
    // The server checks Origin against its own URL, so the proxy presents that origin.
    server: {
        proxy: {
            "/api": {
                target: api,
                configure: (proxy) => proxy.on("proxyReq", (req) => req.setHeader("origin", api)),
            },
        },
    },
    build: { outDir: "dist", emptyOutDir: true },
});
