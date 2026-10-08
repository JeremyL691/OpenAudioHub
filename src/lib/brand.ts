import { LEGACY_ATTRIBUTION } from "./brand/legacy";

/**
 * Public identity of this build. User-visible text and links that name the
 * product read from here, so a rename touches one file.
 */
export const BRAND = {
    name: "OpenAudioHub",
    slogan: "Open-source AI transcription for the recorder you already own.",
    description:
        "Self-hosted AI transcription and summaries for Plaud recordings.",
    repoUrl: "https://github.com/JeremyL691/OpenAudioHub",
    issuesUrl: "https://github.com/JeremyL691/OpenAudioHub/issues",
    docsPath: "/docs",
    copyrightHolder: "OpenAudioHub contributors",
    attribution: LEGACY_ATTRIBUTION,
    copyright: `© OpenAudioHub contributors · ${LEGACY_ATTRIBUTION}`,
} as const;
