export type SummaryPreset =
    | "general"
    | "meeting-notes"
    | "interview"
    | "call"
    | "lecture"
    | "brainstorm"
    | "voice-memo"
    | "key-points"
    | "action-items";

export interface SummaryPromptConfig {
    id: SummaryPreset;
    name: string;
    description: string;
    prompt: string;
}

export interface CustomSummaryPrompt {
    id: string;
    name: string;
    prompt: string;
    createdAt: string;
}

export interface SummaryPromptConfiguration {
    /** Preset id or custom prompt id. */
    selectedPrompt: string;
    customPrompts: CustomSummaryPrompt[];
}

/**
 * Templates write Markdown. Each one names the sections it expects, so the
 * output is easy to scan and to export. The shared rules live in the system
 * message (see `generate-summary.ts`).
 */
export const SUMMARY_PRESETS: Record<SummaryPreset, SummaryPromptConfig> = {
    general: {
        id: "general",
        name: "General Summary",
        description:
            "Overview, key points, details, and follow-ups for any recording",
        prompt: `Summarize this recording as Markdown with these sections, in this order:

## Overview
Two to four sentences on what the recording is about and why it matters.

## Key Points
Five to ten bullet points, most important first. Each one is a complete sentence.

## Details
Facts, figures, names, dates, and quotes that someone would need to act on or remember. Use bullets.

## Follow-ups
Open questions and next steps, one bullet each.

If a section has nothing to report, write "None mentioned." under its heading.

Transcription:
{transcription}`,
    },
    "meeting-notes": {
        id: "meeting-notes",
        name: "Meeting Minutes",
        description:
            "Attendees, discussion, decisions, and an owner, task, and due date for each action item",
        prompt: `Write meeting minutes as Markdown with these sections, in this order:

## Meeting Overview
- **Topic:** the subject of the meeting
- **Participants:** names as spoken or labelled in the transcript
- **Purpose:** one sentence on why the meeting was held

## Summary
A short paragraph on what was discussed and where the discussion ended.

## Discussion Points
Bullets grouped by topic, with the main arguments and any disagreement.

## Decisions
Bullets. Each one states the decision and who made or agreed to it.

## Action Items
A Markdown table with the columns Owner | Task | Due date | Status. Write "Unassigned" when no owner is named, "Not set" when no date is given, and "Open" as the status unless the meeting says otherwise.

## Risks and Open Questions
Bullets.

## Next Meeting
Agenda items or plans for the follow-up meeting.

If a section has nothing to report, write "None mentioned." under its heading. Do not invent names, dates, or decisions.

Transcription:
{transcription}`,
    },
    interview: {
        id: "interview",
        name: "Interview and Research",
        description:
            "Background, questions and answers, pain points, quotes with timestamps, and insights",
        prompt: `Turn this interview or user research conversation into Markdown notes with these sections, in this order:

## Participant Background
Role, context, and relevant experience, as stated in the conversation.

## Key Questions and Answers
For each important question, a bullet with the question and a one- to three-sentence answer in the speaker's own words where possible.

## Pain Points and Needs
Bullets. Each one names the problem, how often or how badly it happens, and any workaround the person uses.

## Notable Quotes
Direct quotes that carry a strong opinion or a specific detail. Add the timestamp in the form [mm:ss] when the transcript has one.

## Insights
Patterns and implications, one sentence each. Mark anything that is a guess as a guess.

## Follow-ups
Things to verify, people to contact, and questions left open.

If a section has nothing to report, write "None mentioned." under its heading.

Transcription:
{transcription}`,
    },
    call: {
        id: "call",
        name: "Phone and Client Call",
        description:
            "Purpose, requests, commitments, agreed next steps, and open issues",
        prompt: `Summarize this phone or client call as Markdown with these sections, in this order:

## Purpose
One sentence on why the call happened.

## Requests From the Other Party
Bullets. What they asked for and any deadlines they gave.

## Our Commitments
Bullets. What was promised, by whom, and by when.

## Agreed Next Steps
A numbered list in the order the steps should happen. Give an owner and a date for each one when the call states them.

## Open Issues
Unresolved points, disagreements on price or scope, and information still missing.

## Contacts
Names, roles, and companies mentioned.

If a section has nothing to report, write "None mentioned." under its heading. Do not invent names, dates, or commitments.

Transcription:
{transcription}`,
    },
    lecture: {
        id: "lecture",
        name: "Lecture and Study Notes",
        description:
            "Outline, core concepts, examples, pitfalls, and review questions",
        prompt: `Turn this lecture into study notes in Markdown with these sections, in this order:

## Topic Outline
A nested bullet outline of the lecture, in the order it was taught.

## Core Concepts
For each concept, the term in bold followed by a one- or two-sentence definition as given in the lecture.

## Examples and Worked Problems
One bullet per example or problem, with the key steps or the result.

## Common Pitfalls
Mistakes or misconceptions the lecturer warned about.

## Review Questions
Five questions that test the main ideas. Do not include the answers.

## Assignments and Dates
Homework, readings, and deadlines mentioned.

If a section has nothing to report, write "None mentioned." under its heading.

Transcription:
{transcription}`,
    },
    brainstorm: {
        id: "brainstorm",
        name: "Brainstorm",
        description:
            "Ideas grouped by theme, trade-offs, ideas set aside, and next experiments",
        prompt: `Capture this brainstorm as Markdown with these sections, in this order:

## Problem Statement
One or two sentences on the problem or question the group explored.

## Ideas by Theme
Group the ideas into themes. Under each theme, one bullet per idea: a short phrase, then a few words of context.

## Trade-offs
For the strongest one to three ideas, one bullet each for the advantages and the drawbacks that were stated.

## Ideas Set Aside
Ideas that were rejected or parked, with the reason given.

## Next Experiments
Concrete things to try next, phrased as actions.

If a section has nothing to report, write "None mentioned." under its heading.

Transcription:
{transcription}`,
    },
    "voice-memo": {
        id: "voice-memo",
        name: "Voice Memo and Podcast",
        description:
            "Main points, ideas, quotes, resources mentioned, and to-dos",
        prompt: `Turn this voice memo or podcast into Markdown notes with these sections, in this order:

## Main Points
The main ideas in order, one bullet each.

## Ideas and Insights
Original thoughts, reflections, or observations worth keeping.

## Quotes
Memorable lines, with the timestamp in the form [mm:ss] when the transcript has one.

## Resources Mentioned
Books, articles, tools, people, or places referred to.

## To-dos
Tasks the speaker committed to or wanted to do.

If a section has nothing to report, write "None mentioned." under its heading.

Transcription:
{transcription}`,
    },
    "key-points": {
        id: "key-points",
        name: "Key Points",
        description: "A one-sentence overview and five to fifteen key points",
        prompt: `List the key points of this transcription as Markdown.

Start with one sentence that summarizes the recording.

Then give five to fifteen bullet points, most important first. Each bullet is one complete sentence that carries its concrete facts.

Transcription:
{transcription}`,
    },
    "action-items": {
        id: "action-items",
        name: "Action Items",
        description: "Owner, task, due date, and status for every action item",
        prompt: `Extract every action item from this transcription as a Markdown table with the columns Owner | Task | Due date | Status.

Write "Unassigned" when no owner is named, "Not set" when no date is given, and "Open" as the status unless the speaker says otherwise. Keep the tasks in the order they came up.

After the table, add one sentence on what the recording was about. If there are no action items, write "No action items mentioned." in place of the table.

Transcription:
{transcription}`,
    },
};

export function getSummaryPromptForPreset(preset: SummaryPreset): string {
    return SUMMARY_PRESETS[preset].prompt;
}

export function getDefaultSummaryPromptConfig(): SummaryPromptConfiguration {
    return {
        selectedPrompt: "general",
        customPrompts: [],
    };
}

export function getAllSummaryPrompts(
    config: SummaryPromptConfiguration,
): Array<{
    id: string;
    name: string;
    description: string;
    prompt: string;
    isPreset: boolean;
}> {
    const presets = Object.values(SUMMARY_PRESETS).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        prompt: p.prompt,
        isPreset: true,
    }));

    const customs = config.customPrompts.map((p) => ({
        id: p.id,
        name: p.name,
        description: "Custom prompt",
        prompt: p.prompt,
        isPreset: false,
    }));

    return [...presets, ...customs];
}

export interface AiOutputLanguageOption {
    code: string;
    label: string;
}

/** Output languages offered in this release. Stored values outside this list read as `auto`. */
export const AI_OUTPUT_LANGUAGES: readonly AiOutputLanguageOption[] = [
    { code: "auto", label: "Auto (match transcript)" },
    { code: "zh", label: "Chinese (Simplified)" },
    { code: "en", label: "English" },
    { code: "ja", label: "Japanese" },
    { code: "ko", label: "Korean" },
] as const;

const LANGUAGE_CODES = new Set(AI_OUTPUT_LANGUAGES.map((l) => l.code));

/** Validate against `AI_OUTPUT_LANGUAGES`; returns the code or null. */
export function normalizeAiOutputLanguage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return LANGUAGE_CODES.has(value) ? value : null;
}

const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
    auto: "Write all natural-language output, including headings, in the same language as the transcription.",
    zh: "Write all natural-language output, including headings, in Simplified Chinese.",
    en: "Write all natural-language output, including headings, in English.",
    ja: "Write all natural-language output, including headings, in Japanese.",
    ko: "Write all natural-language output, including headings, in Korean.",
};

/**
 * Directive sentence for the model. Missing and unknown codes follow the
 * transcription, the same as `auto`.
 */
export function getAiOutputLanguageDirective(
    code: string | null | undefined,
): string {
    const normalized = normalizeAiOutputLanguage(code) ?? "auto";
    return `IMPORTANT: ${LANGUAGE_INSTRUCTIONS[normalized]} Keep any JSON keys in English exactly as specified.`;
}

export function getSummaryPromptById(
    id: string,
    config: SummaryPromptConfiguration,
): string | null {
    if (id in SUMMARY_PRESETS) {
        return SUMMARY_PRESETS[id as SummaryPreset].prompt;
    }

    const custom = config.customPrompts.find((p) => p.id === id);
    return custom?.prompt || null;
}

/**
 * Validate an untrusted `summaryPrompt` payload before it's encrypted and
 * stored. Only shape is checked (strings where expected, array of
 * well-formed custom-prompt entries) -- this is user-owned settings data,
 * not a cross-user boundary, but a malformed value would otherwise be
 * silently encrypted and only surface as a broken dropdown or a crash in
 * `getAllSummaryPrompts` on the next read.
 */
export function isValidSummaryPromptConfig(
    value: unknown,
): value is SummaryPromptConfiguration {
    if (typeof value !== "object" || value === null) return false;
    const config = value as Record<string, unknown>;
    if (typeof config.selectedPrompt !== "string") return false;
    if (!Array.isArray(config.customPrompts)) return false;
    return config.customPrompts.every(
        (p) =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as Record<string, unknown>).id === "string" &&
            typeof (p as Record<string, unknown>).name === "string" &&
            typeof (p as Record<string, unknown>).prompt === "string" &&
            typeof (p as Record<string, unknown>).createdAt === "string",
    );
}
