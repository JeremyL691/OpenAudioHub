// Prepares the E2E environment: writes e2e/.env.e2e with fresh local
// test secrets, recreates the oah_e2e database on the test stack, and applies the
// migrations. Secret values go only into the env file and are never printed.
// Requires scripts/dev/test-stack.sh up.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ROOT = resolve(import.meta.dir, "../..");
const ENV_FILE = resolve(ROOT, "e2e/.env.e2e");
const MIGRATIONS_FOLDER = resolve(ROOT, "src/db/migrations");
const ADMIN_URL = "postgres://oah_test:oah_test@127.0.0.1:54329/postgres";
const DB_NAME = "oah_e2e";
const APP_DB_URL = `postgres://oah_test:oah_test@127.0.0.1:54329/${DB_NAME}`;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

const values: Record<string, string> = {
    DATABASE_URL: APP_DB_URL,
    APP_URL: "http://localhost:3210",
    BETTER_AUTH_SECRET: hex(32),
    API_TOKEN_HASH_SECRET: hex(32),
    ENCRYPTION_KEY: hex(32),
    DEFAULT_STORAGE_TYPE: "local",
    LOCAL_STORAGE_PATH: ".dev-artifacts/e2e/storage",
    DISABLE_UPDATE_CHECK: "true",
    E2E_EMAIL: "e2e@openaudiohub.test",
    E2E_PASSWORD: hex(16),
    FAKE_AI_BASE_URL: "http://127.0.0.1:3299/v1",
};

async function recreateDatabase(): Promise<void> {
    const admin = postgres(ADMIN_URL, { max: 1, connect_timeout: 5 });
    try {
        await admin`drop database if exists ${admin(DB_NAME)} with (force)`;
        await admin`create database ${admin(DB_NAME)}`;
    } catch (error) {
        throw new Error(
            `could not reach the test stack; run scripts/dev/test-stack.sh up first (${error instanceof Error ? error.message : String(error)})`,
        );
    } finally {
        await admin.end();
    }
}

async function applyMigrations(): Promise<void> {
    const connection = postgres(APP_DB_URL, { max: 1 });
    try {
        await migrate(drizzle(connection), {
            migrationsFolder: MIGRATIONS_FOLDER,
        });
    } finally {
        await connection.end();
    }
}

await recreateDatabase();
await applyMigrations();

mkdirSync(dirname(ENV_FILE), { recursive: true });
writeFileSync(
    ENV_FILE,
    `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    { mode: 0o600 },
);

console.log(`e2e database ${DB_NAME} is ready; env written to e2e/.env.e2e`);
