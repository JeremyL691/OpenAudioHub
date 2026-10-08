import { usesDefaultPostgresPassword } from "./lib/postgres-password";

type WebhookWorkerModule = {
    startWebhookWorker: () => void;
};

type BackgroundSyncWorkerModule = {
    startBackgroundSyncWorker: () => void;
};

type ExportWorkerModule = {
    startExportWorker: () => void;
};

type AudioPipelineWorkerModule = {
    startAudioPipelineWorker: () => void;
};

type EnvModule = {
    env: {
        RATE_LIMIT_TRUST_PROXY_HEADERS?: boolean;
        DATABASE_URL?: string;
    };
};

export async function register() {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;

    // Deferred require (matches the worker import below): a top-level
    // `import { env }` would run full env validation at module load in every
    // runtime -- including edge, where this hook must no-op -- before the
    // guard above. Loading it here keeps validation inside the nodejs branch.
    const { env } = require("./lib/env") as EnvModule;

    // Per-IP auth rate limiting needs a trustworthy client IP. When proxy
    // headers aren't trusted, `getClientIp` returns "unknown" and the per-IP
    // cap on /sign-in, /sign-up and /reset-password is skipped to avoid
    // collapsing every client into one cross-user-lockout bucket. Warn loudly
    // at startup so a self-host operator knows credential-stuffing protection
    // on those routes is inactive until they front the app with a proxy that
    // sets X-Forwarded-For (or cf-connecting-ip / x-real-ip) and set
    // RATE_LIMIT_TRUST_PROXY_HEADERS=true. (/request-password-reset keeps its
    // IP-independent per-email cap regardless.)
    if (env.RATE_LIMIT_TRUST_PROXY_HEADERS !== true) {
        console.warn(
            "[rate-limit] RATE_LIMIT_TRUST_PROXY_HEADERS is not true: per-IP rate limiting on sign-in/sign-up/reset-password is INACTIVE. Set it to true behind a trusted reverse proxy to enable credential-stuffing protection.",
        );
    }

    if (usesDefaultPostgresPassword(env.DATABASE_URL)) {
        console.warn(
            "[db] DATABASE_URL uses the known default password \"postgres\". Set a unique POSTGRES_PASSWORD in .env and rotate the role in place (ALTER USER postgres WITH PASSWORD '...'; then recreate the app). Recreating the db volume is not required.",
        );
    }

    const { startWebhookWorker } =
        require("./lib/webhooks/worker") as WebhookWorkerModule;
    startWebhookWorker();

    const { startBackgroundSyncWorker } =
        require("./lib/sync/worker") as BackgroundSyncWorkerModule;
    startBackgroundSyncWorker();

    const { startExportWorker } =
        require("./lib/export/worker") as ExportWorkerModule;
    startExportWorker();

    const { startAudioPipelineWorker } =
        require("./lib/transcription/audio-pipeline") as AudioPipelineWorkerModule;
    startAudioPipelineWorker();

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
