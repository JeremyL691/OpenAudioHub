import {
    AppWindow,
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

export type NavItem = {
    name: string;
    id: SettingsSection;
    icon: typeof Bot;
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
            { name: "Providers", id: "providers", icon: Bot },
            { name: "Transcription", id: "transcription", icon: FileText },
            { name: "Summary", id: "summary", icon: ListChecks },
            { name: "Recording names", id: "naming", icon: Tag },
        ],
    },
    {
        label: "Plaud",
        items: [
            { name: "Plaud Account", id: "plaud-account", icon: Mic },
            { name: "Sync", id: "sync", icon: RefreshCw },
        ],
    },
    {
        label: "Personalize",
        items: [
            { name: "Playback", id: "playback", icon: Play },
            { name: "Display", id: "display", icon: Monitor },
            { name: "Desktop", id: "desktop", icon: AppWindow },
            // Hidden until notifications are planned; the section code is kept.
            // { name: "Notifications", id: "notifications", icon: Bell },
        ],
    },
    {
        label: "Data",
        items: [
            { name: "Storage", id: "storage", icon: HardDrive },
            { name: "Export/Backup", id: "export", icon: Download },
        ],
    },
    {
        label: "Integrations",
        items: [
            { name: "API Keys", id: "api-keys", icon: KeyRound },
            { name: "Webhooks", id: "webhooks", icon: Webhook },
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

/**
 * Nav groups and items the viewer can see. The Desktop section only exists in
 * the macOS desktop shell.
 */
export function visibleSettingsNavGroups(desktop: boolean) {
    return SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => desktop || item.id !== "desktop"),
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
