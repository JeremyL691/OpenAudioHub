import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DesktopTitlebar } from "@/components/app-shell/desktop-titlebar";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth-server";

export const metadata: Metadata = {
    title: "Account suspended | OpenAudioHub",
    robots: { index: false, follow: false },
};

/**
 * Page shown to suspended users. We deliberately tell them their account is
 * suspended (rather than serve a generic maintenance page) -- silently
 * pretending the app is broken is dishonest and creates a worse support
 * experience. The reason text from `users.suspendedReason` is NOT displayed
 * because admins write it for internal audit, not for the user.
 */
export default async function SuspendedPage() {
    const session = await getSession();
    if (!session?.user) redirect("/login");

    const [u] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);

    // If they're not actually suspended (admin unsuspended them mid-session),
    // bounce back into the app so they're not stuck.
    if (!u?.suspendedAt) redirect("/recordings");

    return (
        <div className="flex min-h-svh flex-col bg-background text-foreground">
            <DesktopTitlebar />
            <div className="flex flex-1 items-center justify-center p-6">
                <div className="flex w-full max-w-md flex-col items-center text-center">
                    <h1 className="mb-2 text-[22px] font-bold tracking-tight">
                        Your account is suspended
                    </h1>
                    <p className="mb-3 text-[13px] text-muted-foreground">
                        Access to recordings, sync, and transcription is paused
                        while we review your account.
                    </p>
                    <p className="text-[13px] text-muted-foreground">
                        Contact the administrator of this instance if you think
                        this is a mistake.
                    </p>
                    <form
                        action="/api/auth/sign-out"
                        method="post"
                        className="mt-6"
                    >
                        <button
                            type="submit"
                            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 text-[13px] font-medium hover:bg-accent sm:h-8"
                        >
                            Sign out
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
