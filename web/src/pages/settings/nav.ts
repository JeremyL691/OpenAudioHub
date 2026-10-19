import type { MessageKey } from "@/lib/i18n";
import {
    Bell,
    Bot,
    Download,
    FileText,
    HardDrive,
    Laptop,
    ListChecks,
    Mic,
    Monitor,
    Play,
    RefreshCw,
    Tag,
    type LucideIcon,
} from "lucide-react";

export type SectionId =
    | "providers"
    | "transcription"
    | "summary"
    | "naming"
    | "plaud-account"
    | "sync"
    | "playback"
    | "display"
    | "storage"
    | "export"
    | "notifications"
    | "desktop";

export type NavGroupId = "ai" | "plaud-sync" | "playback-display" | "data" | "desktop";

export interface SectionDef {
    id: SectionId;
    /** Translation key of the short name used in the navigation and the section picker. */
    nameKey: MessageKey;
    /** Translation key of the page title (the section's h1). */
    titleKey: MessageKey;
    /** Translation key of the one-line description. */
    descriptionKey: MessageKey;
    icon: LucideIcon;
    /** Tailwind background class for the icon tile (a design token). */
    tile: string;
    group: NavGroupId;
    /** Listed in the navigation only in the desktop app. */
    desktopOnly?: boolean;
    /** Reachable by URL but not listed in the navigation. */
    hidden?: boolean;
}

export const NAV_GROUPS: Record<NavGroupId, MessageKey> = {
    ai: "settings.nav.groupAi",
    "plaud-sync": "settings.nav.groupPlaudSync",
    "playback-display": "settings.nav.groupPlaybackDisplay",
    data: "settings.nav.groupData",
    desktop: "settings.nav.groupDesktop",
};

/** Every section the web build knows, in navigation order. Desktop and hidden sections come last. */
export const SECTIONS: SectionDef[] = [
    {
        id: "providers",
        nameKey: "settings.nav.providersName",
        titleKey: "settings.nav.providersTitle",
        descriptionKey: "settings.nav.providersDescription",
        icon: Bot,
        tile: "bg-tile-indigo",
        group: "ai",
    },
    {
        id: "transcription",
        nameKey: "settings.nav.transcriptionName",
        titleKey: "settings.nav.transcriptionName",
        descriptionKey: "settings.nav.transcriptionDescription",
        icon: FileText,
        tile: "bg-tile-blue",
        group: "ai",
    },
    {
        id: "summary",
        nameKey: "settings.nav.summaryName",
        titleKey: "settings.nav.summaryName",
        descriptionKey: "settings.nav.summaryDescription",
        icon: ListChecks,
        tile: "bg-tile-purple",
        group: "ai",
    },
    {
        id: "naming",
        nameKey: "settings.nav.namingName",
        titleKey: "settings.nav.namingName",
        descriptionKey: "settings.nav.namingDescription",
        icon: Tag,
        tile: "bg-tile-pink",
        group: "ai",
    },
    {
        id: "plaud-account",
        nameKey: "settings.nav.plaudName",
        titleKey: "settings.nav.plaudName",
        descriptionKey: "settings.nav.plaudDescription",
        icon: Mic,
        tile: "bg-tile-orange",
        group: "plaud-sync",
    },
    {
        id: "sync",
        nameKey: "settings.nav.syncName",
        titleKey: "settings.nav.syncName",
        descriptionKey: "settings.nav.syncDescription",
        icon: RefreshCw,
        tile: "bg-tile-green",
        group: "plaud-sync",
    },
    {
        id: "playback",
        nameKey: "settings.nav.playbackName",
        titleKey: "settings.nav.playbackName",
        descriptionKey: "settings.nav.playbackDescription",
        icon: Play,
        tile: "bg-tile-orange",
        group: "playback-display",
    },
    {
        id: "display",
        nameKey: "settings.nav.displayName",
        titleKey: "settings.nav.displayName",
        descriptionKey: "settings.nav.displayDescription",
        icon: Monitor,
        tile: "bg-tile-blue",
        group: "playback-display",
    },
    {
        id: "storage",
        nameKey: "settings.nav.storageName",
        titleKey: "settings.nav.storageName",
        descriptionKey: "settings.nav.storageDescription",
        icon: HardDrive,
        tile: "bg-tile-gray",
        group: "data",
    },
    {
        id: "export",
        nameKey: "settings.nav.exportName",
        titleKey: "settings.nav.exportName",
        descriptionKey: "settings.nav.exportDescription",
        icon: Download,
        tile: "bg-tile-teal",
        group: "data",
    },
    {
        id: "notifications",
        nameKey: "settings.nav.notificationsName",
        titleKey: "settings.nav.notificationsName",
        descriptionKey: "settings.nav.notificationsDescription",
        icon: Bell,
        tile: "bg-tile-pink",
        group: "plaud-sync",
        hidden: true,
    },
    {
        id: "desktop",
        nameKey: "settings.nav.desktopName",
        titleKey: "settings.nav.desktopName",
        descriptionKey: "settings.nav.desktopDescription",
        icon: Laptop,
        tile: "bg-tile-gray",
        group: "desktop",
        desktopOnly: true,
    },
];

export const DEFAULT_SECTION: SectionId = "providers";
export const LAST_SECTION_KEY = "settings-last-section";

/** True when the desktop app's bridge is present. The desktop section is shown only then. */
export function isDesktopApp(): boolean {
    return typeof window !== "undefined" && "__openaudiohubDesktop" in window;
}

export function findSection(id: string | undefined): SectionDef | undefined {
    if (!id) return undefined;
    return SECTIONS.find((s) => s.id === id);
}

/** Whether a section can be shown in this build. Hidden sections resolve by URL. Desktop only in the desktop app. */
export function isReachable(section: SectionDef, desktop: boolean): boolean {
    return !section.desktopOnly || desktop;
}

/** Sections that appear in the navigation and the picker, in order. */
export function navSections(desktop: boolean): SectionDef[] {
    return SECTIONS.filter((s) => !s.hidden && isReachable(s, desktop));
}
