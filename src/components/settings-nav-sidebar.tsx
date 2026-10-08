import Link from "next/link";
import { SETTINGS_NAV_GROUPS } from "@/components/settings-nav-config";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
}

/**
 * Desktop section list. Each item is a real link to `/settings/<id>`, so the
 * section is in the address bar. Hidden below md, where the section picker in
 * the page header takes over.
 */
export function SettingsNavSidebar({ activeSection }: Props) {
    return (
        <nav
            aria-label="Settings sections"
            data-testid="settings-nav"
            className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3 md:flex"
        >
            {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-1">
                    <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                        {group.label}
                    </div>
                    {group.items.map((item) => {
                        const active = activeSection === item.id;
                        return (
                            <Link
                                key={item.id}
                                href={`/settings/${item.id}`}
                                aria-label={`${item.name} settings`}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                                    active &&
                                        "bg-accent font-medium text-accent-foreground",
                                    item.id === "dev" &&
                                        "text-red-600 dark:text-red-400",
                                )}
                            >
                                <item.icon
                                    className="size-4"
                                    aria-hidden="true"
                                />
                                <span>{item.name}</span>
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}
