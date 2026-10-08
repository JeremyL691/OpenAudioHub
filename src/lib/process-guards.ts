/**
 * Process-level error handlers for the Node server. Installed once from
 * `src/instrumentation.ts`, nodejs runtime only.
 */
export function installProcessGuards(): void {
    // `uncaughtException` means the process is in an unknown state: log, then
    // exit. Swallowing the error and continuing would leave a corrupted process
    // running.
    process.on("uncaughtException", (error) => {
        console.error("[process] uncaughtException:", error);
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("[process] unhandledRejection:", reason);
    });
}
