import Link from "next/link";
import { SETTINGS_NAV_GROUPS } from "@/components/settings-nav-config";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/types/settings";

interface Props {
    activeSection: SettingsSection;
}

/**
 * Desktop section list. Each item is a real link to `/settings/<id>`, so the
 * section is in the address bar. Hidden below lg, where the section picker in
 * the page header takes over.
 */
export function SettingsNavSidebar({ activeSection }: Props) {
    return (
        <nav
            aria-label="Settings sections"
            data-testid="settings-nav"
            className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-sidebar p-3 lg:flex"
        >
            {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-0.5">
                    <div className="px-2.5 pb-1 text-[11px] font-semibold text-muted-foreground">
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
                                    "flex h-10 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-foreground transition-colors hover:bg-accent md:h-8",
                                    active && "bg-sidebar-accent font-semibold",
                                    item.id === "dev" && "text-destructive",
                                )}
                            >
                                <item.icon
                                    className={cn(
                                        "size-4 shrink-0",
                                        active
                                            ? "text-primary"
                                            : "text-muted-foreground",
                                    )}
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
