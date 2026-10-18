import readme from "../../../../docs/README.md?raw";
import usingTheLibrary from "../../../../docs/using-the-library.md?raw";
import connectPlaud from "../../../../docs/connect-plaud-account.md?raw";
import browserExtension from "../../../../docs/browser-extension.md?raw";
import providers from "../../../../docs/providers.md?raw";
import notifications from "../../../../docs/notifications.md?raw";
import automation from "../../../../docs/automation-and-webhooks.md?raw";
import backup from "../../../../docs/backup-and-restore.md?raw";
import selfHosting from "../../../../docs/self-hosting.md?raw";
import desktop from "../../../../docs/desktop.md?raw";
import environmentVariables from "../../../../docs/environment-variables.md?raw";
import storageS3 from "../../../../docs/storage-s3.md?raw";
import emailSmtp from "../../../../docs/email-smtp.md?raw";
import publicApi from "../../../../docs/public-api.md?raw";
import architecture from "../../../../docs/architecture.md?raw";
import securityModel from "../../../../docs/security-model.md?raw";
import encryptionAtRest from "../../../../docs/encryption-at-rest.md?raw";
import { renderDoc } from "./markdown";

/** Repository location of the user docs. Links that leave the docs go here. */
export const DOCS_SOURCE_URL = "https://github.com/JeremyL691/OpenAudioHub/blob/main/docs";
const REPO_BLOB_ROOT = "https://github.com/JeremyL691/OpenAudioHub/blob/main";

export type DocGroup = "Guides" | "Self Hosting" | "Reference";
export const DOC_GROUPS: DocGroup[] = ["Guides", "Self Hosting", "Reference"];

export interface DocPage {
    /** Public URL path under /docs. */
    url: string;
    title: string;
    group?: DocGroup;
    /** File name in the repository's docs folder that holds the content. */
    file: string;
    /** Routable, but left out of the sidebar and the previous and next links. */
    hidden?: boolean;
}

/** Every docs page, in sidebar order. Each one is built from a Markdown file in the docs folder. */
export const DOC_PAGES: DocPage[] = [
    { url: "/docs", title: "OpenAudioHub Docs", file: "README.md" },
    { url: "/docs/guides/using-the-library", title: "Using the library", group: "Guides", file: "using-the-library.md" },
    { url: "/docs/guides/connect-plaud-account", title: "Connect your Plaud account", group: "Guides", file: "connect-plaud-account.md" },
    { url: "/docs/guides/browser-extension", title: "Browser extension", group: "Guides", file: "browser-extension.md" },
    { url: "/docs/guides/ai-providers", title: "AI providers", group: "Guides", file: "providers.md" },
    { url: "/docs/guides/notifications", title: "Notifications", group: "Guides", file: "notifications.md" },
    { url: "/docs/guides/automation-and-webhooks", title: "Automation API and webhooks", group: "Guides", file: "automation-and-webhooks.md" },
    { url: "/docs/guides/backup-and-restore", title: "Backup and restore", group: "Guides", file: "backup-and-restore.md" },
    { url: "/docs/self-hosting/install", title: "Install", group: "Self Hosting", file: "self-hosting.md" },
    { url: "/docs/self-hosting/desktop", title: "Mac app (beta)", group: "Self Hosting", file: "desktop.md" },
    { url: "/docs/self-hosting/environment-variables", title: "Environment variables", group: "Self Hosting", file: "environment-variables.md" },
    { url: "/docs/self-hosting/storage-s3", title: "S3-compatible storage", group: "Self Hosting", file: "storage-s3.md" },
    { url: "/docs/self-hosting/email-smtp", title: "Email (SMTP) setup", group: "Self Hosting", file: "email-smtp.md" },
    { url: "/docs/reference/public-api", title: "Public API", group: "Reference", file: "public-api.md" },
    { url: "/docs/reference/architecture", title: "Architecture", group: "Reference", file: "architecture.md" },
    { url: "/docs/reference/security-model", title: "Security model", group: "Reference", file: "security-model.md" },
    { url: "/docs/reference/encryption-at-rest", title: "Encryption at rest", group: "Reference", file: "encryption-at-rest.md" },
    // Routable, but not in the sidebar. It shows the install page, so the self-hosting entry point keeps working.
    { url: "/docs/self-hosting", title: "Self-hosting", file: "self-hosting.md", hidden: true },
];

const SOURCES: Record<string, string> = {
    "README.md": readme,
    "using-the-library.md": usingTheLibrary,
    "connect-plaud-account.md": connectPlaud,
    "browser-extension.md": browserExtension,
    "providers.md": providers,
    "notifications.md": notifications,
    "automation-and-webhooks.md": automation,
    "backup-and-restore.md": backup,
    "self-hosting.md": selfHosting,
    "desktop.md": desktop,
    "environment-variables.md": environmentVariables,
    "storage-s3.md": storageS3,
    "email-smtp.md": emailSmtp,
    "public-api.md": publicApi,
    "architecture.md": architecture,
    "security-model.md": securityModel,
    "encryption-at-rest.md": encryptionAtRest,
};

/** Docs file name to the public URL it is served at, for links between docs pages. */
const FILE_URLS: Record<string, string> = Object.fromEntries(
    DOC_PAGES.filter((p) => !p.hidden).map((p) => [p.file, p.url]),
);

/** Maps a link written in a docs file. Links between docs pages stay inside /docs. */
export function resolveDocHref(href: string): string {
    if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    const hashAt = href.indexOf("#");
    const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const hash = hashAt >= 0 ? href.slice(hashAt) : "";
    if (path.startsWith("/")) return href;
    const file = path.replace(/^\.\//, "");
    const page = FILE_URLS[file];
    if (page) return page + hash;
    // Paths that climb out of the docs folder point at the repository root; anything else is a sibling in the docs folder.
    if (path.startsWith("../")) return `${REPO_BLOB_ROOT}/${path.replace(/^(\.\.\/)+/, "")}${hash}`;
    return `${DOCS_SOURCE_URL}/${file}${hash}`;
}

const rendered = new Map<string, ReturnType<typeof renderDoc>>();

/** The rendered HTML and sections of a page. Computed once per page. */
export function renderPage(page: DocPage): ReturnType<typeof renderDoc> {
    let out = rendered.get(page.file);
    if (!out) {
        out = renderDoc(SOURCES[page.file] ?? "", resolveDocHref);
        rendered.set(page.file, out);
    }
    return out;
}

/** The page at a URL path, or undefined for paths that are not docs pages. Trailing slashes are ignored. */
export function findDocPage(pathname: string): DocPage | undefined {
    const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return DOC_PAGES.find((p) => p.url === clean);
}

/** Pages in sidebar and previous/next order. */
export const NAV_PAGES: DocPage[] = DOC_PAGES.filter((p) => !p.hidden);

export function editUrl(page: DocPage): string {
    return `${DOCS_SOURCE_URL}/${page.file}`;
}

export interface SearchEntry {
    url: string;
    pageTitle: string;
    heading: string;
    text: string;
}

let searchCache: SearchEntry[] | null = null;

/** One entry per section of every page, for the search dialog. Built on first use. */
export function searchIndex(): SearchEntry[] {
    if (searchCache) return searchCache;
    const entries: SearchEntry[] = [];
    for (const page of NAV_PAGES) {
        const { sections } = renderPage(page);
        for (const section of sections) {
            entries.push({
                url: `${page.url}#${section.id}`,
                pageTitle: page.title,
                heading: section.heading,
                text: section.text,
            });
        }
    }
    searchCache = entries;
    return entries;
}
