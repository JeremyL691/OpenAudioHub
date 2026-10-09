import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppProgress } from "@/components/app-progress";
import { ConfirmDialogProvider } from "@/components/confirm-dialog";
import { DesktopModeProvider } from "@/components/desktop-mode-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isDesktopMode } from "@/lib/desktop/mode";
import { env } from "@/lib/env";
import { themeColors } from "@/lib/notifications/email-templates/brand-colors";
import "./globals.css";

const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
});

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    // Resolves relative URLs in `openGraph.images` / `twitter.images`
    // (e.g. `/docs-og/<slug>.png` emitted by per-doc `generateMetadata`)
    // against the deployment origin. Without this, Next falls back to
    // `http://localhost:3000` in production and ships broken social
    // previews. `APP_URL` is allowed to be unset during `next build`
    // (see `src/lib/env.ts`); the fallback keeps the build green and
    // self-host deployments override it at runtime via env.
    metadataBase: new URL(env.APP_URL ?? "http://localhost:3000"),
    title: {
        default: "OpenAudioHub — Long recordings, intelligently transcribed",
        template: "%s · OpenAudioHub",
    },
    description:
        "Open-source, self-hosted AI audio workspace for long recordings. Sync your Plaud recordings or upload your own, transcribe with the AI provider you choose, and keep everything on storage you control.",
    applicationName: "OpenAudioHub",
    manifest: "/manifest.webmanifest",
    openGraph: {
        type: "website",
        siteName: "OpenAudioHub",
        title: "OpenAudioHub — Long recordings, intelligently transcribed",
        description:
            "Open-source, self-hosted AI audio workspace for long recordings. Sync your Plaud recordings or upload your own, transcribe with the AI provider you choose, and keep everything on storage you control.",
        images: [{ url: "/og.png", width: 1200, height: 630 }],
    },
    twitter: {
        card: "summary_large_image",
        title: "OpenAudioHub — Long recordings, intelligently transcribed",
        description:
            "Open-source, self-hosted AI audio workspace for long recordings. Sync your Plaud recordings or upload your own, transcribe with the AI provider you choose, and keep everything on storage you control.",
        images: ["/og.png"],
    },
    appleWebApp: {
        capable: true,
        title: "OpenAudioHub",
        statusBarStyle: "black-translucent",
    },
};

export const viewport: Viewport = {
    themeColor: [
        { media: "(prefers-color-scheme: light)", color: themeColors.light },
        { media: "(prefers-color-scheme: dark)", color: themeColors.dark },
    ],
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html
            lang="en"
            suppressHydrationWarning
            className={`${geistSans.variable} ${geistMono.variable}`}
        >
            <body className="antialiased">
                <DesktopModeProvider value={isDesktopMode()}>
                    <AppProgress>
                        <ThemeProvider
                            attribute="class"
                            defaultTheme="system"
                            enableSystem
                            disableTransitionOnChange
                        >
                            {/*
                          Tooltip provider wraps the app so any descendant
                          `<Tooltip>` works without a local provider. 200ms
                          delay is the shadcn default-ish: short enough to
                          feel responsive, long enough to avoid firing on
                          incidental mouseovers.
                        */}
                            <TooltipProvider delayDuration={200}>
                                {/*
                              App-wide imperative confirm dialog. Any
                              client component can `useConfirm()` to get
                              a Promise-returning function for destructive
                              flows (delete recording, delete webhook,
                              delete API key, delete custom prompt, etc.).
                              One instance, one dialog node, consistent
                              look + pending-state handling.
                            */}
                                <ConfirmDialogProvider>
                                    {children}
                                    <Toaster />
                                </ConfirmDialogProvider>
                            </TooltipProvider>
                        </ThemeProvider>
                    </AppProgress>
                </DesktopModeProvider>
            </body>
        </html>
    );
}
