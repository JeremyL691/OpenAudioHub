"use client";

import { Keyboard, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { signOut } from "@/lib/auth-client";

interface UserMenuProps {
    initialTheme: "light" | "dark" | "system";
    userEmail: string | null;
    onOpenSettings: () => void;
    onOpenShortcuts: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
            {children}
        </kbd>
    );
}

function emailInitial(email: string | null): string {
    if (!email) return "?";
    const trimmed = email.trim();
    if (!trimmed) return "?";
    return trimmed[0].toUpperCase();
}

export function UserMenu({
    initialTheme,
    userEmail,
    onOpenSettings,
    onOpenShortcuts,
}: UserMenuProps) {
    const { push, refresh } = useRouter();
    const { theme, setTheme } = useTheme(initialTheme);

    const themeOptions = [
        { value: "light" as const, label: "Light", icon: Sun },
        { value: "dark" as const, label: "Dark", icon: Moon },
        { value: "system" as const, label: "Auto", icon: Monitor },
    ];

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="Account menu"
                    data-testid="user-menu"
                    className="size-10 font-semibold sm:size-9"
                >
                    {emailInitial(userEmail)}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-0">
                <div className="flex items-center gap-3 border-b p-3">
                    <div
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                        aria-hidden="true"
                    >
                        {emailInitial(userEmail)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                            {userEmail || "Signed in"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            Signed in
                        </p>
                    </div>
                </div>

                <div className="p-1">
                    <DropdownMenuItem onSelect={onOpenSettings}>
                        <Settings />
                        <span className="flex-1">Settings</span>
                        <Kbd>,</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onOpenShortcuts}>
                        <Keyboard />
                        <span className="flex-1">Keyboard shortcuts</span>
                        <Kbd>?</Kbd>
                    </DropdownMenuItem>
                </div>

                <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Theme
                </DropdownMenuLabel>
                {/* Radix radio items, so the menu owns only items and groups.
                    Picking a theme keeps the menu open, as the old segmented
                    control did. */}
                <DropdownMenuRadioGroup
                    value={theme}
                    onValueChange={(value) => setTheme(value as Theme)}
                >
                    {themeOptions.map((opt) => (
                        <DropdownMenuRadioItem
                            key={opt.value}
                            value={opt.value}
                            onSelect={(event) => event.preventDefault()}
                        >
                            <opt.icon className="size-3.5" aria-hidden="true" />
                            {opt.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator className="my-0" />

                {/* Sign out */}
                <div className="p-1">
                    <DropdownMenuItem
                        variant="destructive"
                        onSelect={async () => {
                            await signOut();
                            push("/");
                            refresh();
                        }}
                    >
                        <LogOut />
                        Log out
                    </DropdownMenuItem>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
