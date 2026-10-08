import { APP_VERSION_TAG } from "@/lib/version";

const GITHUB_NEW_ISSUE_URL =
    "https://github.com/JeremyL691/OpenAudioHub/issues/new";
const BUG_REPORT_TEMPLATE = "bug_report.yml";

export interface ReportBugOptions {
    errorId?: string;
    errorContext?: string;
    page?: string;
}

export function buildReportBugUrl(opts: ReportBugOptions): string {
    const params = new URLSearchParams({
        template: BUG_REPORT_TEMPLATE,
        version: APP_VERSION_TAG,
    });

    const description = buildDescription(opts);
    if (description) {
        params.set("description", description);
    }

    params.set("deployment", "Self-hosted");

    const additional = buildAdditional(opts);
    if (additional) {
        params.set("additional", additional);
    }

    return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}

export function buildReportBugBodyPreview(opts: ReportBugOptions): string {
    const parts = [buildDescription(opts), "", buildAdditional(opts)].filter(
        Boolean,
    );
    return parts.join("\n");
}

function buildDescription(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.errorContext) {
        lines.push(`While trying to: ${opts.errorContext}`);
    }
    if (opts.errorId) {
        if (lines.length > 0) lines.push("");
        lines.push(`Error id: \`${opts.errorId}\``);
    }
    return lines.join("\n");
}

function buildAdditional(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.page) {
        lines.push(`Page: \`${opts.page}\``);
    }
    lines.push(`Version: ${APP_VERSION_TAG}`);
    lines.push("Mode: Self-hosted");
    return lines.join("\n");
}
