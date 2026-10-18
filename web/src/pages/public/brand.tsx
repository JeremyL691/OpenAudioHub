import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";

export const REPO_URL = "https://github.com/JeremyL691/OpenAudioHub";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
export const CURRENT_YEAR = new Date().getFullYear();

/** The mark and the two-tone wordmark used by the public pages. */
export function Brand({ className, markClassName }: { className?: string; markClassName?: string }) {
    return (
        <span className={cn("inline-flex items-center gap-[0.35em]", className)}>
            <img src="/icon.svg" alt="" aria-hidden="true" className={cn("shrink-0 size-[1.2em]", markClassName)} />
            <span className="font-semibold tracking-tight text-foreground">
                Open
                <span
                    className="bg-clip-text text-transparent"
                    style={{ backgroundImage: "linear-gradient(135deg, #01ADFB 0%, #2A5DFA 50%, #6B14FB 100%)" }}
                >
                    Audio
                </span>
                Hub
            </span>
        </span>
    );
}

/** GitHub mark, drawn in currentColor. */
export function GitHubIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="currentColor"
            aria-hidden="true"
            className={cn("size-4", className)}
        >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
    );
}

/** Sets the document title and the description and robots meta tags for a public page. */
export function useDocumentMeta(title: string, description?: string, robots?: string): void {
    useEffect(() => {
        document.title = title;
        const restore: (() => void)[] = [];
        const setMeta = (name: string, content: string) => {
            let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
            if (!el) {
                el = document.createElement("meta");
                el.name = name;
                document.head.appendChild(el);
                restore.push(() => el?.remove());
            }
            el.content = content;
        };
        if (description) setMeta("description", description);
        if (robots) setMeta("robots", robots);
        return () => restore.forEach((fn) => fn());
    }, [title, description, robots]);
}

/** Small link-styled text inside the public footers. */
export function FooterLink({ to, href, children }: { to?: string; href?: string; children: ReactNode }) {
    const cls = "transition-colors hover:text-foreground";
    if (to) return <Link to={to} className={cls}>{children}</Link>;
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
            {children}
        </a>
    );
}
