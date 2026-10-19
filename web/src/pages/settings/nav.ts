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
    /** Short name used in the navigation and the section picker. */
    name: string;
    /** Page title (the section's h1). */
    title: string;
    description: string;
    /** Extra words the search field matches. */
    keywords: string[];
    icon: LucideIcon;
    /** Tailwind background class for the icon tile (a design token). */
    tile: string;
    group: NavGroupId;
    /** Listed in the navigation only in the desktop app. */
    desktopOnly?: boolean;
    /** Reachable by URL but not listed in the navigation. */
    hidden?: boolean;
}

export const NAV_GROUPS: Record<NavGroupId, string> = {
    ai: "AI",
    "plaud-sync": "Plaud & Sync",
    "playback-display": "Playback & Display",
    data: "Data",
    desktop: "Desktop",
};

/** Every section the web build knows, in navigation order. Desktop and hidden sections come last. */
export const SECTIONS: SectionDef[] = [
    {
        id: "providers",
        name: "Providers",
        title: "AI Providers",
        description: "Connect transcription and summary providers. Anything OpenAI-compatible works.",
        keywords: ["ai", "api", "key", "openai", "groq", "ollama", "model", "provider"],
        icon: Bot,
        tile: "bg-tile-indigo",
        group: "ai",
    },
    {
        id: "transcription",
        name: "Transcription",
        title: "Transcription",
        description: "Provider choice and default options for turning audio into text.",
        keywords: ["transcribe", "language", "speaker", "diarization", "quality", "plaud", "transcript"],
        icon: FileText,
        tile: "bg-tile-blue",
        group: "ai",
    },
    {
        id: "summary",
        name: "Summary",
        title: "Summary",
        description: "Which provider writes summaries, and the prompt presets it uses.",
        keywords: ["summary", "summarize", "prompt", "preset", "output", "language"],
        icon: ListChecks,
        tile: "bg-tile-purple",
        group: "ai",
    },
    {
        id: "naming",
        name: "Recording names",
        title: "Recording names",
        description: "Choose how new recordings are named. Existing recordings keep their names.",
        keywords: ["title", "name", "date", "file", "rename"],
        icon: Tag,
        tile: "bg-tile-pink",
        group: "ai",
    },
    {
        id: "plaud-account",
        name: "Plaud Account",
        title: "Plaud Account",
        description: "The Plaud cloud account OpenAudioHub pulls recordings from.",
        keywords: ["plaud", "account", "sign in", "login", "connect", "token", "reconnect"],
        icon: Mic,
        tile: "bg-tile-orange",
        group: "plaud-sync",
    },
    {
        id: "sync",
        name: "Sync",
        title: "Sync",
        description: "When and how OpenAudioHub pulls new recordings from your Plaud device.",
        keywords: ["sync", "interval", "auto", "plaud", "notifications", "refresh"],
        icon: RefreshCw,
        tile: "bg-tile-green",
        group: "plaud-sync",
    },
    {
        id: "playback",
        name: "Playback",
        title: "Playback",
        description: "Start-up settings the player applies to every recording.",
        keywords: ["play", "speed", "volume", "audio", "scrubber", "waveform"],
        icon: Play,
        tile: "bg-tile-orange",
        group: "playback-display",
    },
    {
        id: "display",
        name: "Display",
        title: "Display",
        description: "Date and time format, list order, theme, and other interface choices.",
        keywords: ["theme", "dark", "light", "date", "time", "sort", "order", "list", "page"],
        icon: Monitor,
        tile: "bg-tile-blue",
        group: "playback-display",
    },
    {
        id: "storage",
        name: "Storage",
        title: "Storage",
        description: "Where OpenAudioHub keeps the audio files behind your recordings.",
        keywords: ["storage", "disk", "space", "retention", "delete", "usage"],
        icon: HardDrive,
        tile: "bg-tile-gray",
        group: "data",
    },
    {
        id: "export",
        name: "Export",
        title: "Export",
        description: "Take your data with you: recordings, transcripts, and summaries.",
        keywords: ["export", "download", "json", "srt", "vtt", "txt", "onboarding"],
        icon: Download,
        tile: "bg-tile-teal",
        group: "data",
    },
    {
        id: "notifications",
        name: "Notifications",
        title: "Notifications",
        description: "Choose how and when OpenAudioHub lets you know about new recordings and sync events.",
        keywords: ["notification", "sound", "browser", "alert", "email", "bark", "push"],
        icon: Bell,
        tile: "bg-tile-pink",
        group: "plaud-sync",
        hidden: true,
    },
    {
        id: "desktop",
        name: "Desktop",
        title: "Desktop",
        description: "Options that only the desktop app has.",
        keywords: ["desktop", "tray", "menu bar", "close", "window"],
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
