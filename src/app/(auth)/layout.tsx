export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Every auth page renders SelfHostAuthChrome (components/auth/auth-chrome.tsx),
    // which owns the layout, the brand panel, and the background.
    return <div className="min-h-screen bg-background">{children}</div>;
}
