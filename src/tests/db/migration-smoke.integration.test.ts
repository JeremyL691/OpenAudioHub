import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transcriptions, users } from "@/db/schema";
import {
    createMigratedTestDatabase,
    createTestDatabase,
    getTestDatabaseUrl,
    type TestPostgresDatabase,
} from "@/tests/integration/postgres";

const testDatabaseUrl = getTestDatabaseUrl();
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

describeWithDatabase("PostgreSQL migration chain", () => {
    let database: TestPostgresDatabase | null = null;

    beforeAll(async () => {
        database = await createMigratedTestDatabase(
            testDatabaseUrl ?? "",
            "migration_smoke",
        );
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
    }, 30_000);

    it("applies every migration to an empty database", async () => {
        if (!database) throw new Error("test database was not initialized");

        const rows = await database.sql<
            { users_table: string | null; founding_table: string | null }[]
        >`
            select
                to_regclass('public.users')::text as users_table,
                to_regclass('public.founding_member_reservations')::text as founding_table
        `;

        expect(rows[0]).toEqual({
            users_table: "users",
            founding_table: "founding_member_reservations",
        });
    });
});

const MIGRATIONS_DIR = "./src/db/migrations";
const LAST_BEFORE_REBRAND = "0040_worried_lethal_legion";
const LATEST_TAG = "0048_scheduled_backup";

/** Copies migrations up to and including `tag` into a temporary folder. */
function migrationsUpTo(tag: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "oah-migrations-"));
    const journal = JSON.parse(
        readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const idx = journal.entries.findIndex((entry) => entry.tag === tag);
    const entries = journal.entries.slice(0, idx + 1);
    mkdirSync(path.join(dir, "meta"));
    writeFileSync(
        path.join(dir, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries) {
        copyFileSync(
            path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
            path.join(dir, `${entry.tag}.sql`),
        );
    }
    return dir;
}

describeWithDatabase("rebrand source values migration", () => {
    let database: TestPostgresDatabase | null = null;
    let partialFolder: string | null = null;

    beforeAll(async () => {
        database = await createTestDatabase(
            testDatabaseUrl ?? "",
            "rebrand_source",
        );
        partialFolder = migrationsUpTo(LAST_BEFORE_REBRAND);
        await migrate(database.db, { migrationsFolder: partialFolder });
    }, 120_000);

    afterAll(async () => {
        await database?.dispose();
        if (partialFolder)
            rmSync(partialFolder, { recursive: true, force: true });
    }, 30_000);

    it("rewrites legacy source values and clears the removed Mynah pointer", async () => {
        if (!database) throw new Error("test database was not initialized");
        const { db } = database;
        const userId = "user-rebrand";

        await db.insert(users).values({
            id: userId,
            name: "Rebrand",
            email: "rebrand@example.com",
            emailVerified: false,
        });
        // Raw SQL: the schema now has columns this migration point does not.
        await database.sql`
            insert into recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version)
            values ('rec-rebrand', ${userId}, 'device-1', 'plaud-1', 'encrypted-name', 1000, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 1, 'd41d8cd98f00b204e9800998ecf8427e', 'local', 'recordings/rec-rebrand.mp3', '1')
        `;
        await db.insert(transcriptions).values({
            recordingId: "rec-rebrand",
            userId,
            text: "legacy",
            provider: "Custom",
            model: "whisper-1",
            source: "riffado",
        });
        await database.sql`
            insert into ai_enhancements (id, recording_id, user_id, summary, provider, model, source)
            values ('enh-rebrand', 'rec-rebrand', ${userId}, 'legacy summary', 'Custom', 'gpt', 'riffado')
        `;
        await database.sql`
            insert into user_settings (id, user_id, preferred_transcript_source, default_transcription_provider_id, auto_generate_title)
            values ('settings-rebrand', ${userId}, 'riffado', 'riffado-included', false)
        `;

        await migrate(database.db, { migrationsFolder: MIGRATIONS_DIR });

        const [transcript] = await database.sql<{ source: string }[]>`
            select source from transcriptions where user_id = ${userId}
        `;
        const [enhancement] = await database.sql<{ source: string }[]>`
            select source from ai_enhancements where user_id = ${userId}
        `;
        const [settings] = await database.sql<
            {
                preferred_transcript_source: string;
                default_transcription_provider_id: string | null;
                recording_title_mode: string;
            }[]
        >`
            select preferred_transcript_source, default_transcription_provider_id, recording_title_mode
            from user_settings where user_id = ${userId}
        `;

        expect(transcript.source).toBe("openaudiohub");
        expect(enhancement.source).toBe("openaudiohub");
        expect(settings.preferred_transcript_source).toBe("openaudiohub");
        expect(settings.default_transcription_provider_id).toBeNull();
        // 0046: titles turned off map to keeping the original name.
        expect(settings.recording_title_mode).toBe("original");

        // 0043: new rows default to the current source value.
        const defaults = await database.sql<
            { table_name: string; column_default: string }[]
        >`
            select table_name, column_default from information_schema.columns
            where table_schema = 'public' and column_name = 'source'
              and table_name in ('transcriptions', 'ai_enhancements')
            order by table_name
        `;
        expect(defaults).toEqual([
            {
                table_name: "ai_enhancements",
                column_default: "'openaudiohub'::character varying",
            },
            {
                table_name: "transcriptions",
                column_default: "'openaudiohub'::character varying",
            },
        ]);
    });

    it("records the latest migration in the journal", () => {
        const journal = JSON.parse(
            readFileSync(
                path.join(MIGRATIONS_DIR, "meta/_journal.json"),
                "utf8",
            ),
        ) as { entries: { tag: string }[] };
        expect(journal.entries.at(-1)?.tag).toBe(LATEST_TAG);
    });
});
