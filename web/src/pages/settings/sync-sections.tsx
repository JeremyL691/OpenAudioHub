import { useEffect, useId, useRef, useState } from "react";
import { AudioWaveform, Keyboard } from "lucide-react";
import { setTheme, type ThemeChoice } from "@/lib/theme";
import { Group, ToggleRow, NumberField, Row, SettingSelect, useSettings, type Option, type UserSettings } from "./shared";

// ---------- sync ----------

const SYNC_INTERVALS: Option[] = [
    { value: "60000", label: "1 minute" },
    { value: "120000", label: "2 minutes" },
    { value: "300000", label: "5 minutes" },
    { value: "600000", label: "10 minutes" },
    { value: "900000", label: "15 minutes" },
    { value: "1800000", label: "30 minutes" },
];

export function SyncSection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();

    return (
        <div className="grid gap-4">
            <Group label="Auto-sync">
                <ToggleRow
                    id={`${ids}-auto-sync`}
                    field="autoSyncEnabled"
                    label="Enable auto-sync"
                    hint="Pull new recordings from your Plaud device on a fixed schedule."
                />
                <Row htmlFor={`${ids}-interval`} label="Sync interval">
                    <SettingSelect
                        id={`${ids}-interval`}
                        testId="sync-interval"
                        value={String(settings.syncInterval)}
                        disabled={isSaving("syncInterval")}
                        onValueChange={(v) => void save({ syncInterval: Number(v) })}
                        options={SYNC_INTERVALS}
                        className="w-40"
                    />
                </Row>
                <ToggleRow
                    id={`${ids}-on-mount`}
                    field="syncOnMount"
                    label="Sync on app load"
                    hint="Automatically sync when the app first loads."
                />
                <ToggleRow
                    id={`${ids}-on-visibility`}
                    field="syncOnVisibilityChange"
                    label="Sync on tab visibility"
                    hint="Sync when you return to the app tab."
                />
            </Group>

            <Group label="Notifications">
                <ToggleRow
                    id={`${ids}-sync-notifications`}
                    field="syncNotifications"
                    label="Show sync notifications"
                    hint="Display notifications when sync completes."
                />
            </Group>
        </div>
    );
}

// ---------- playback ----------

const SPEEDS: Option[] = [
    { value: "0.5", label: "0.5x" },
    { value: "0.75", label: "0.75x" },
    { value: "1", label: "1x" },
    { value: "1.25", label: "1.25x" },
    { value: "1.5", label: "1.5x" },
    { value: "2", label: "2x" },
];

const VOLUME_DELAY_MS = 500;

const SHORTCUTS: { label: string; keys: string }[] = [
    { label: "Play / pause", keys: "Space" },
    { label: "Seek backward 5s", keys: "←" },
    { label: "Seek forward 5s", keys: "→" },
    { label: "Increase volume", keys: "↑" },
    { label: "Decrease volume", keys: "↓" },
];

export function PlaybackSection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();
    const [volume, setVolume] = useState(settings.defaultVolume);
    const timer = useRef<number | undefined>(undefined);

    // Follow the stored value when it changes (after a save or a revert).
    useEffect(() => {
        setVolume(settings.defaultVolume);
    }, [settings.defaultVolume]);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    return (
        <div className="grid gap-4">
            <Group label="Audio defaults">
                <Row htmlFor={`${ids}-speed`} label="Default playback speed">
                    <SettingSelect
                        id={`${ids}-speed`}
                        testId="playback-speed"
                        value={String(settings.defaultPlaybackSpeed)}
                        disabled={isSaving("defaultPlaybackSpeed")}
                        onValueChange={(v) => void save({ defaultPlaybackSpeed: Number(v) })}
                        options={SPEEDS}
                        className="w-28"
                    />
                </Row>
                <div className="grid gap-2 px-4 py-3">
                    <div className="flex items-center justify-between">
                        <label htmlFor={`${ids}-volume`} className="text-[13px] font-medium">
                            Default volume
                        </label>
                        <output aria-live="polite" className="font-mono text-xs tabular-nums text-muted-foreground">
                            {volume}%
                        </output>
                    </div>
                    <input
                        id={`${ids}-volume`}
                        data-testid="default-volume"
                        aria-label="Default volume"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={volume}
                        disabled={isSaving("defaultVolume")}
                        onChange={(e) => {
                            const next = Number(e.target.value);
                            setVolume(next);
                            window.clearTimeout(timer.current);
                            timer.current = window.setTimeout(() => {
                                if (next !== settings.defaultVolume) void save({ defaultVolume: next });
                            }, VOLUME_DELAY_MS);
                        }}
                        className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    />
                </div>
            </Group>

            <Group label="Behavior">
                <ToggleRow
                    id={`${ids}-autoplay`}
                    field="autoPlayNext"
                    label="Auto-play next recording"
                    hint="Start the next recording as soon as the current one ends."
                />
            </Group>

            <Group label="Appearance">
                <Row
                    htmlFor={`${ids}-scrubber`}
                    label={
                        <span className="inline-flex items-center gap-2">
                            <AudioWaveform className="size-4 text-muted-foreground" aria-hidden="true" />
                            Scrubber style
                        </span>
                    }
                    hint="Waveform draws the audio amplitude and decodes in the browser on the first listen. Progress bar is a plain slider that needs no decoding."
                >
                    <SettingSelect
                        id={`${ids}-scrubber`}
                        testId="player-scrubber"
                        value={settings.playerScrubber}
                        disabled={isSaving("playerScrubber")}
                        onValueChange={(v) => void save({ playerScrubber: v as UserSettings["playerScrubber"] })}
                        options={[
                            { value: "waveform", label: "Waveform (default)" },
                            { value: "slider", label: "Progress bar" },
                        ]}
                        className="w-44"
                    />
                </Row>
            </Group>

            <section className="grid gap-1.5">
                <div className="px-1">
                    <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                        <Keyboard className="size-4 text-muted-foreground" aria-hidden="true" />
                        Keyboard shortcuts
                    </h2>
                    <p className="text-xs text-muted-foreground">Available when the player has focus.</p>
                </div>
                <ul className="divide-y divide-border overflow-hidden rounded-xl bg-muted px-4">
                    {SHORTCUTS.map((shortcut) => (
                        <li key={shortcut.label} className="flex items-center justify-between py-3 text-[13px]">
                            <span>{shortcut.label}</span>
                            <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-background px-1.5 font-mono text-xs">
                                {shortcut.keys}
                            </kbd>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

// ---------- display ----------

export function DisplaySection() {
    const { settings, save, isSaving } = useSettings();
    const ids = useId();

    // The account save is best effort: a failure is silent and the page keeps the chosen theme.
    const chooseTheme = (choice: ThemeChoice) => {
        setTheme(choice);
        void save({ theme: choice }, null, true);
    };

    return (
        <div className="divide-y divide-border">
            <Row htmlFor={`${ids}-date-format`} label="Date/time format" className="px-0">
                <SettingSelect
                    id={`${ids}-date-format`}
                    testId="date-time-format"
                    value={settings.dateTimeFormat}
                    disabled={isSaving("dateTimeFormat")}
                    onValueChange={(v) => void save({ dateTimeFormat: v as UserSettings["dateTimeFormat"] })}
                    options={[
                        { value: "relative", label: "Relative" },
                        { value: "absolute", label: "Absolute" },
                        { value: "iso", label: "ISO" },
                    ]}
                    className="w-44"
                />
            </Row>
            <Row htmlFor={`${ids}-sort`} label="Recording list sort order" className="px-0">
                <SettingSelect
                    id={`${ids}-sort`}
                    testId="sort-order"
                    value={settings.recordingListSortOrder}
                    disabled={isSaving("recordingListSortOrder")}
                    onValueChange={(v) => void save({ recordingListSortOrder: v as UserSettings["recordingListSortOrder"] })}
                    options={[
                        { value: "newest", label: "Newest first" },
                        { value: "oldest", label: "Oldest first" },
                        { value: "name", label: "By name" },
                    ]}
                    className="w-44"
                />
            </Row>
            <div className="grid gap-2 py-3">
                <label htmlFor={`${ids}-items`} className="text-[13px] font-medium">
                    Items per page
                </label>
                <div className="[&>input]:w-full">
                    <NumberField
                        id={`${ids}-items`}
                        testId="items-per-page"
                        value={settings.itemsPerPage}
                        min={10}
                        max={100}
                        disabled={isSaving("itemsPerPage")}
                        onCommit={(v) => {
                            if (v !== null) void save({ itemsPerPage: v });
                        }}
                    />
                </div>
                <p className="text-xs text-muted-foreground">How many recordings to show on each page (10-100)</p>
            </div>
            <Row htmlFor={`${ids}-theme`} label="Theme" className="px-0">
                <SettingSelect
                    id={`${ids}-theme`}
                    testId="theme"
                    value={settings.theme}
                    disabled={isSaving("theme")}
                    onValueChange={(v) => void chooseTheme(v as ThemeChoice)}
                    options={[
                        { value: "light", label: "Light" },
                        { value: "dark", label: "Dark" },
                        { value: "system", label: "System" },
                    ]}
                    className="w-44"
                />
            </Row>
        </div>
    );
}
