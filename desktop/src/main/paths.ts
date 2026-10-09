import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DesktopPaths {
    userData: string;
    logs: string;
    config: string;
    secrets: string;
    userEnv: string;
    pgdata: string;
    storage: string;
    pipelineData: string;
    backups: string;
    imports: string;
}

/**
 * Resolves the data layout (PLAN §20). `OAH_USER_DATA_DIR` replaces the default
 * `~/Library/Application Support/OpenAudioHub` and moves the logs under it, which is how tests keep
 * the real data directory untouched.
 */
export function resolvePaths(
    env: NodeJS.ProcessEnv,
    home: string = homedir(),
): DesktopPaths {
    const override = env.OAH_USER_DATA_DIR?.trim();
    const userData = override
        ? resolve(override)
        : join(home, "Library", "Application Support", "OpenAudioHub");
    const logs = override
        ? join(userData, "logs")
        : join(home, "Library", "Logs", "OpenAudioHub");
    return {
        userData,
        logs,
        config: join(userData, "config.json"),
        secrets: join(userData, "secrets.json"),
        userEnv: join(userData, "openaudiohub.env"),
        pgdata: join(userData, "pgdata"),
        storage: join(userData, "storage"),
        pipelineData: join(userData, "pipeline"),
        backups: join(userData, "backups"),
        imports: join(userData, "imports"),
    };
}
