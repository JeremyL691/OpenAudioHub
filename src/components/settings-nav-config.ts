import {
    AppWindow,
    Bell,
    Bot,
    Download,
    FileText,
    HardDrive,
    KeyRound,
    ListChecks,
    Mic,
    Monitor,
    Play,
    RefreshCw,
    Tag,
    Webhook,
    Wrench,
} from "lucide-react";
import type { SettingsSection } from "@/types/settings";

export type SettingsTile =
    | "bg-tile-blue"
    | "bg-tile-green"
    | "bg-tile-orange"
    | "bg-tile-gray"
    | "bg-tile-purple"
    | "bg-tile-indigo"
    | "bg-tile-pink"
    | "bg-tile-teal";

export type NavItem = {
    name: string;
    id: SettingsSection;
    icon: typeof Bot;
    tile: SettingsTile;
    description: string;
    keywords: string[];
};

/**
 * Grouped navigation. The grouping is presentational only; iteration
 * code flattens via `settingsNav` so keyboard nav, hash routing, and
 * localStorage continue to operate on a flat indexed list.
 *
 * Lives at module scope so the array reference is stable across
 * renders (would otherwise bust memoization on every dialog mount).
 */
export const SETTINGS_NAV_GROUPS: { label: string; items: NavItem[] }[] = [
    {
        label: "AI",
        items: [
            {
                name: "Providers",
                id: "providers",
                icon: Bot,
                tile: "bg-tile-indigo",
                description:
                    "Connect the AI services that transcribe and summarize.",
                keywords: ["ai", "openai", "model", "api", "llm", "provider"],
            },
            {
                name: "Transcription",
                id: "transcription",
                icon: FileText,
                tile: "bg-tile-blue",
                description: "Choose how audio is converted to text.",
                keywords: ["speech", "speech to text", "whisper", "language"],
            },
            {
                name: "Summary",
                id: "summary",
                icon: ListChecks,
                tile: "bg-tile-purple",
                description: "Set the prompts and provider used for summaries.",
                keywords: ["summarize", "prompt", "notes", "overview"],
            },
            {
                name: "Recording names",
                id: "naming",
                icon: Tag,
                tile: "bg-tile-pink",
                description: "Choose how new recordings are named.",
                keywords: ["title", "rename", "filename", "date"],
            },
        ],
    },
    {
        label: "Plaud & Sync",
        items: [
            {
                name: "Plaud Account",
                id: "plaud-account",
                icon: Mic,
                tile: "bg-tile-orange",
                description:
                    "Manage the Plaud connection used to pull recordings.",
                keywords: ["plaud", "account", "login", "sign in", "connect"],
            },
            {
                name: "Sync",
                id: "sync",
                icon: RefreshCw,
                tile: "bg-tile-green",
                description: "Control when new recordings are pulled in.",
                keywords: ["auto", "pull", "refresh", "schedule", "plaud"],
            },
        ],
    },
    {
        label: "Playback & Display",
        items: [
            {
                name: "Playback",
                id: "playback",
                icon: Play,
                tile: "bg-tile-orange",
                description: "Defaults for the player when a recording loads.",
                keywords: ["audio", "speed", "skip", "autoplay", "player"],
            },
            {
                name: "Display",
                id: "display",
                icon: Monitor,
                tile: "bg-tile-blue",
                description: "Date formats, lists and overall appearance.",
                keywords: ["theme", "dark", "light", "appearance", "date"],
            },
            {
                name: "Desktop",
                id: "desktop",
                icon: AppWindow,
                tile: "bg-tile-gray",
                description: "Window and menu bar behavior in the desktop app.",
                keywords: ["window", "menu bar", "tray", "launch", "app"],
            },
            {
                name: "Notifications",
                id: "notifications",
                icon: Bell,
                tile: "bg-tile-pink",
                description: "Alerts for new recordings and sync events.",
                keywords: ["alerts", "email", "push", "notify"],
            },
        ],
    },
    {
        label: "Data",
        items: [
            {
                name: "Storage",
                id: "storage",
                icon: HardDrive,
                tile: "bg-tile-gray",
                description:
                    "Where audio files are kept and how much they use.",
                keywords: ["disk", "space", "files", "audio", "usage"],
            },
            {
                name: "Export/Backup",
                id: "export",
                icon: Download,
                tile: "bg-tile-teal",
                description: "Export recordings, transcripts and summaries.",
                keywords: ["backup", "download", "zip", "transcripts", "data"],
            },
        ],
    },
    {
        label: "Integrations",
        items: [
            {
                name: "API Keys",
                id: "api-keys",
                icon: KeyRound,
                tile: "bg-tile-gray",
                description: "Personal access tokens for the public API.",
                keywords: ["token", "access", "developer", "key", "public api"],
            },
            {
                name: "Webhooks",
                id: "webhooks",
                icon: Webhook,
                tile: "bg-tile-purple",
                description: "Send HTTP events when recordings change.",
                keywords: ["http", "events", "callback", "url", "integration"],
            },
        ],
    },
    ...(process.env.NODE_ENV !== "production"
        ? [
              {
                  label: "Advanced",
                  items: [
                      {
                          name: "Developer Tools",
                          id: "dev" as SettingsSection,
                          icon: Wrench,
                          tile: "bg-tile-gray" as SettingsTile,
                          description:
                              "Diagnostics and developer-only controls.",
                          keywords: ["debug", "developer", "logs", "advanced"],
                      },
                  ],
              },
          ]
        : []),
];

/**
 * Flat list of every nav item. Keep this the single source of truth for
 * keyboard nav / hash routing / localStorage. Changing the group structure
 * must not break index-based iteration.
 */
export const SETTINGS_NAV: NavItem[] = SETTINGS_NAV_GROUPS.flatMap(
    (g) => g.items,
);

// Hidden until notifications are planned. The route stays, because sent
// emails link to /settings/notifications.
const HIDDEN_SECTIONS: ReadonlySet<SettingsSection> = new Set([
    "notifications",
]);

/**
 * Nav groups and items the viewer can see. The Desktop section only exists in
 * the macOS desktop shell.
 */
export function visibleSettingsNavGroups(desktop: boolean) {
    return SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(
            (item) =>
                !HIDDEN_SECTIONS.has(item.id) &&
                (desktop || item.id !== "desktop"),
        ),
    }));
}

export function visibleSettingsNav(desktop: boolean): NavItem[] {
    return visibleSettingsNavGroups(desktop).flatMap((group) => group.items);
}

export const SETTINGS_STORAGE_KEY = "settings-last-section";

/**
 * True when `value` names a section the settings pages offer. The dev section
 * is only in the nav outside production, so this also gates `/settings/dev`.
 */
export function isSettingsSection(
    value: string | null | undefined,
): value is SettingsSection {
    return SETTINGS_NAV.some((item) => item.id === value);
}
