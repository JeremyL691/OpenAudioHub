"use client";

import { Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { RecordingTitleMode } from "@/lib/recordings/filename";

const TITLE_MODE_OPTIONS: {
    value: RecordingTitleMode;
    title: string;
    description: string;
}[] = [
    {
        value: "original",
        title: "Original name",
        description: "Keep the name from Plaud or the uploaded file.",
    },
    {
        value: "date",
        title: "Date",
        description: "Name by recording date, e.g. 2026-10-12.",
    },
    {
        value: "ai",
        title: "AI title",
        description:
            "Generate a title from the transcript after transcription finishes.",
    },
];

export function NamingSection() {
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [titleMode, setTitleMode] = useState<RecordingTitleMode>("ai");
    const [syncTitleToPlaud, setSyncTitleToPlaud] = useState(false);

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const response = await fetch("/api/settings/user");
                if (response.ok) {
                    const data = await response.json();
                    setTitleMode(data.recordingTitleMode ?? "ai");
                    setSyncTitleToPlaud(data.syncTitleToPlaud ?? false);
                }
            } catch (error) {
                console.error("Failed to fetch settings:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    }, []);

    // Optimistic update: the caller applies the new value, then this PUTs it
    // and runs `revert` if the save fails.
    const persist = async (
        body: Record<string, unknown>,
        revert: () => void,
    ) => {
        setIsSaving(true);
        try {
            const response = await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                throw new Error("Failed to save settings");
            }
        } catch {
            revert();
            toast.error("Failed to save settings. Changes reverted.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleTitleModeChange = (value: RecordingTitleMode) => {
        const previous = titleMode;
        setTitleMode(value);
        persist({ recordingTitleMode: value }, () => setTitleMode(previous));
    };

    const handleSyncTitleToPlaudChange = (checked: boolean) => {
        const previous = syncTitleToPlaud;
        setSyncTitleToPlaud(checked);
        persist({ syncTitleToPlaud: checked }, () =>
            setSyncTitleToPlaud(previous),
        );
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title="Recording names"
                description="Choose how new recordings are named. Existing recordings keep their names."
                icon={Tag}
            />
            <div className="space-y-4">
                <div
                    role="radiogroup"
                    aria-label="Recording name"
                    className="divide-y divide-border rounded-xl bg-muted px-4"
                >
                    {TITLE_MODE_OPTIONS.map((option) => {
                        const inputId = `recording-title-mode-${option.value}`;
                        return (
                            <Label
                                key={option.value}
                                htmlFor={inputId}
                                className="flex cursor-pointer items-start gap-3 py-2.5 min-h-11 font-normal"
                            >
                                <input
                                    type="radio"
                                    id={inputId}
                                    name="recording-title-mode"
                                    value={option.value}
                                    data-testid={`recording-title-mode-${option.value}`}
                                    checked={titleMode === option.value}
                                    onChange={() =>
                                        handleTitleModeChange(option.value)
                                    }
                                    disabled={isSaving}
                                    className="mt-0.5 size-4 shrink-0 accent-primary"
                                />
                                <span className="min-w-0 flex-1 space-y-0.5">
                                    <span className="block text-[13px] font-medium">
                                        {option.title}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {option.description}
                                    </span>
                                </span>
                            </Label>
                        );
                    })}
                </div>

                {titleMode === "ai" && (
                    <div className="flex items-center justify-between gap-4 rounded-xl bg-muted px-4 py-2.5 min-h-11">
                        <div className="min-w-0 flex-1 space-y-0.5">
                            <Label
                                htmlFor="sync-title-plaud"
                                className="text-[13px] font-medium"
                            >
                                Sync titles to Plaud
                            </Label>
                            <p className="text-xs text-muted-foreground">
                                Update the filename in your Plaud device when
                                titles are generated
                            </p>
                        </div>
                        <Switch
                            id="sync-title-plaud"
                            checked={syncTitleToPlaud}
                            onCheckedChange={handleSyncTitleToPlaudChange}
                            disabled={isSaving}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
