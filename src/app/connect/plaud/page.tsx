import type { Metadata } from "next";
import { PlaudBrowserHandoff } from "@/components/plaud-browser-handoff";

export const metadata: Metadata = {
    title: "Connect Plaud",
    robots: { index: false, follow: false },
};

interface ConnectPlaudPageProps {
    searchParams: Promise<{ code?: string | string[] }>;
}

/** Public page opened in the user's browser to finish a Plaud sign-in started in the desktop app. */
export default async function ConnectPlaudPage({
    searchParams,
}: ConnectPlaudPageProps) {
    const { code } = await searchParams;
    const handoffCode =
        typeof code === "string" && code.length > 0 ? code : null;

    return (
        <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12">
            <PlaudBrowserHandoff code={handoffCode} />
        </main>
    );
}
