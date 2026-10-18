import { Marked, type Token } from "marked";

export interface Section {
    depth: number;
    /** The anchor id given to the heading in the rendered HTML. */
    id: string;
    heading: string;
    /** Plain text of the section body, for search snippets. */
    text: string;
}

export interface RenderedDoc {
    html: string;
    sections: Section[];
}

/** GitHub-style anchor for a heading. */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/\s+/g, "-");
}

function plainText(tokens: Token[] | undefined): string {
    if (!tokens) return "";
    return tokens
        .map((t) => {
            const node = t as { tokens?: Token[]; text?: string };
            return node.tokens ? plainText(node.tokens) : (node.text ?? "");
        })
        .join("");
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the href if it is relative, a fragment, or an http, https or mailto link. Anything else
 * (javascript:, data:, and so on) returns null. Control characters and spaces are removed first,
 * the way browsers do, so "java\tscript:" cannot slip through.
 */
export function safeHref(href: string): string | null {
    const cleaned = href.replace(/[\u0000- \u007f]/g, "");
    let protocol: string;
    try {
        protocol = new URL(cleaned, "https://docs.invalid/").protocol;
    } catch {
        return null;
    }
    // A relative href resolves against the placeholder base, so it reports https: even though it stays local.
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(cleaned);
    return relative || ALLOWED_PROTOCOLS.has(protocol) ? href : null;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders a docs Markdown file to HTML. Headings get anchor ids, and every link goes through
 * `resolveHref`. The sections list feeds the on-page outline and the search index.
 */
export function renderDoc(source: string, resolveHref: (href: string) => string): RenderedDoc {
    const md = new Marked();
    const tokens = md.lexer(source);

    const sections: Section[] = [];
    const seen = new Map<string, number>();
    const headingIds: string[] = [];
    let current: Section | null = null;

    for (const token of tokens) {
        if (token.type === "heading") {
            const heading = plainText(token.tokens);
            const base = slugify(heading) || "section";
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            const id = count ? `${base}-${count}` : base;
            headingIds.push(id);
            current = { depth: token.depth, id, heading, text: "" };
            sections.push(current);
        } else if (current) {
            current.text += ` ${token.raw}`;
        }
    }

    let nextHeading = 0;
    md.use({
        renderer: {
            heading({ tokens: inner, depth }) {
                const id = headingIds[nextHeading++] ?? "";
                return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(inner)}</h${depth}>\n`;
            },
            link({ href, title, tokens: inner }) {
                const target = safeHref(resolveHref(href));
                // A link with a disallowed scheme keeps its text and drops the link.
                if (target === null) return this.parser.parseInline(inner);
                const external = /^https?:\/\//.test(target);
                const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
                const externalAttr = external ? ' target="_blank" rel="noopener noreferrer"' : "";
                return `<a href="${escapeHtml(target)}"${titleAttr}${externalAttr}>${this.parser.parseInline(inner)}</a>`;
            },
        },
    });

    return { html: md.parser(tokens), sections };
}
