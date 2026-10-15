"use client";

import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { SettingsCard } from "@/components/settings/settings-card";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { DesktopBridge, DesktopPreferences } from "@/types/desktop-bridge";

const closeActionOptions: {
    label: string;
    value: DesktopPreferences["closeAction"];
}[] = [
    { label: "Keep running in the background", value: "background" },
    { label: "Quit OpenAudioHub", value: "quit" },
];

export function DesktopSection() {
    const [bridge, setBridge] = useState<DesktopBridge | null>(null);
    const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);

    // Detect the bridge after mount so server and client first renders match.
    useEffect(() => {
        const detected = window.__openaudiohubDesktop;
        if (
            detected?.version !== 1 ||
            !detected.getPreferences ||
            !detected.setPreferences
        ) {
            return;
        }
        setBridge(detected);
        detected
            .getPreferences()
            .then(setPrefs)
            .catch(() => toast.error("Couldn't load desktop settings"));
    }, []);

    if (!bridge) {
        return (
            <>
                <SettingsSectionHeader
                    title="Desktop"
                    description="Window and menu bar behavior."
                    icon={AppWindow}
                />
                <p className="text-sm text-muted-foreground">
                    Available in the OpenAudioHub desktop app.
                </p>
            </>
        );
    }

    const handleChange = async (updates: Partial<DesktopPreferences>) => {
        if (!prefs || !bridge.setPreferences) return;
        const previous = prefs;
        setPrefs({ ...prefs, ...updates });
        try {
            setPrefs(await bridge.setPreferences(updates));
        } catch {
            setPrefs(previous);
            toast.error("Failed to save settings. Changes reverted.");
        }
    };

    return (
        <>
            <SettingsSectionHeader
                title="Desktop"
                description="Window and menu bar behavior."
                icon={AppWindow}
            />
            {prefs && (
                <>
                    <SettingsCard>
                        <div className="divide-y divide-border">
                            <div className="flex items-center justify-between gap-4 py-3">
                                <Label
                                    className="text-[13px] font-medium"
                                    htmlFor="desktop-close-action"
                                >
                                    When you close the window
                                </Label>
                                <Select
                                    value={prefs.closeAction}
                                    onValueChange={(value) =>
                                        handleChange({
                                            closeAction:
                                                value as DesktopPreferences["closeAction"],
                                        })
                                    }
                                >
                                    <SelectTrigger
                                        id="desktop-close-action"
                                        data-testid="desktop-close-action"
                                        className="w-64 max-w-full"
                                    >
                                        <SelectValue>
                                            {closeActionOptions.find(
                                                (opt) =>
                                                    opt.value ===
                                                    prefs.closeAction,
                                            )?.label ??
                                                "Keep running in the background"}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                        {closeActionOptions.map((option) => (
                                            <SelectItem
                                                key={option.value}
                                                value={option.value}
                                            >
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div data-testid="desktop-show-tray">
                                <ToggleRow
                                    id="desktop-show-tray-switch"
                                    label="Show in menu bar"
                                    description="Show the OpenAudioHub icon in the macOS menu bar."
                                    checked={prefs.showTray}
                                    onCheckedChange={(checked) =>
                                        handleChange({ showTray: checked })
                                    }
                                />
                            </div>
                        </div>
                    </SettingsCard>
                    {prefs.closeAction === "background" && !prefs.showTray && (
                        <p className="px-1 text-xs text-muted-foreground">
                            The app stays in the Dock while it runs in the
                            background.
                        </p>
                    )}
                </>
            )}
        </>
    );
}
