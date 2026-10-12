import { DesktopTitlebar } from "@/components/app-shell/desktop-titlebar";

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Every auth page renders SelfHostAuthChrome (components/auth/auth-chrome.tsx),
    // which owns the layout, the brand panel, and the background.
    return (
        <div className="flex min-h-svh flex-col bg-muted/50 dark:bg-background">
            <DesktopTitlebar />
            {children}
        </div>
    );
}
