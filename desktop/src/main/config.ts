import { existsSync, readFileSync, renameSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.js";

export const CONFIG_SCHEMA_VERSION = 1;

export interface DesktopPorts {
    app: number;
    pipeline: number;
    postgres: number;
}

export interface DesktopConfig {
    schemaVersion: number;
    ports: DesktopPorts;
    /** Local account the app signs in as. Unset until the first launch or import binds one. */
    boundUserId?: string;
    /** Start at login (D-305). Off until the cutover turns it on. */
    launchAtLogin?: boolean;
    /** The app version that last started successfully on this data (T13.6: backups and downgrade refusal). */
    lastVersion?: string;
}

/** Defaults from PLAN D-310. They sit next to the Docker stack's ports and avoid the test ports. */
export const DEFAULT_PORTS: Readonly<DesktopPorts> = Object.freeze({
    app: 38400,
    pipeline: 38401,
    postgres: 38402,
});

export function defaultConfig(): DesktopConfig {
    return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        ports: { ...DEFAULT_PORTS },
    };
}

function isPort(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1024 &&
        value <= 65535
    );
}

/** Returns the parsed JSON, or null when the text is not JSON. */
function readJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * True when the file was written by a newer build. Such a file must not be parsed, renamed or replaced:
 * this build would drop fields it does not know (lastVersion among them), and that would bypass the
 * downgrade guard on the next start.
 */
function isNewerSchema(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const version = (raw as { schemaVersion?: unknown }).schemaVersion;
    return (
        typeof version === "number" &&
        Number.isInteger(version) &&
        version > CONFIG_SCHEMA_VERSION
    );
}

function parseConfig(raw: unknown): DesktopConfig | null {
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw as Partial<DesktopConfig> & {
        ports?: Partial<DesktopPorts>;
    };
    if (candidate.schemaVersion !== CONFIG_SCHEMA_VERSION) return null;
    const ports = candidate.ports;
    if (
        !ports ||
        !isPort(ports.app) ||
        !isPort(ports.pipeline) ||
        !isPort(ports.postgres)
    )
        return null;
    const config: DesktopConfig = {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        ports: {
            app: ports.app,
            pipeline: ports.pipeline,
            postgres: ports.postgres,
        },
    };
    if (
        typeof candidate.boundUserId === "string" &&
        candidate.boundUserId.length > 0
    ) {
        config.boundUserId = candidate.boundUserId;
    }
    if (typeof candidate.launchAtLogin === "boolean") {
        config.launchAtLogin = candidate.launchAtLogin;
    }
    if (
        typeof candidate.lastVersion === "string" &&
        candidate.lastVersion.length > 0
    ) {
        config.lastVersion = candidate.lastVersion;
    }
    return config;
}

export interface LoadedConfig {
    config: DesktopConfig;
    /** Path the unreadable file was moved to, when the config had to be replaced. */
    replacedCorruptFile?: string;
}

/**
 * Reads config.json. A missing file yields the defaults; an unreadable one is moved aside
 * (`config.json.corrupt-<timestamp>`) and the defaults are used. The config holds no secrets.
 * A file with a newer schemaVersion throws and is left untouched (see isNewerSchema).
 */
export function loadConfig(
    path: string,
    now: () => Date = () => new Date(),
): LoadedConfig {
    if (!existsSync(path)) {
        return { config: defaultConfig() };
    }
    const raw = readJson(readFileSync(path, "utf8"));
    if (isNewerSchema(raw)) {
        throw new Error(
            "config.json was written by a newer OpenAudioHub; install the newer version",
        );
    }
    const config = parseConfig(raw);
    if (config) {
        return { config };
    }
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const moved = `${path}.corrupt-${stamp}`;
    renameSync(path, moved);
    return { config: defaultConfig(), replacedCorruptFile: moved };
}

export function saveConfig(path: string, config: DesktopConfig): void {
    writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}
