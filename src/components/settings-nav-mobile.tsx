"use client";

import { useDesktopMode } from "@/components/desktop-mode-provider";
import {
    visibleSettingsNav,
    visibleSettingsNavGroups,
} from "@/components/settings-nav-config";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
    onSectionChange: (section: SettingsSection) => void;
}

/**
 * Section picker shown in the dialog header below md. Replaces the
 * sidebar (hidden at that breakpoint) so users on small screens
 * still have a way to switch sections without a separate route.
 */
export function SettingsNavMobile({ activeSection, onSectionChange }: Props) {
    const desktop = useDesktopMode();
    const settingsNav = visibleSettingsNav(desktop);
    const activeNavItem = settingsNav.find((item) => item.id === activeSection);
    const groups = visibleSettingsNavGroups(desktop);

    return (
        <div className="md:hidden">
            <Select
                value={activeSection}
                onValueChange={(value) =>
                    onSectionChange(value as SettingsSection)
                }
            >
                <SelectTrigger
                    className="h-10 w-[180px] rounded-md border-transparent bg-muted text-[13px] font-medium shadow-none sm:h-8 dark:bg-muted"
                    aria-label="Select settings section"
                >
                    <SelectValue>
                        {activeNavItem?.name || "Settings"}
                    </SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {groups.map((group, index) => (
                        <SelectGroup key={group.label}>
                            {index > 0 && <SelectSeparator />}
                            {group.items.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={cn(
                                                "flex size-[22px] shrink-0 items-center justify-center rounded-md",
                                                item.tile,
                                            )}
                                            aria-hidden="true"
                                        >
                                            <item.icon className="size-3.5 text-primary-foreground" />
                                        </span>
                                        <span>{item.name}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectGroup>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
