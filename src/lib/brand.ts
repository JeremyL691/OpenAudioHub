/**
 * Public identity of this build. User-visible text and links that name the
 * product read from here, so a rename touches one file.
 */
export const BRAND = {
    name: "OpenAudioHub",
    slogan: "Long recordings, intelligently transcribed.",
    description:
        "Open-source, self-hosted AI audio workspace for long recordings.",
    repoUrl: "https://github.com/JeremyL691/OpenAudioHub",
    issuesUrl: "https://github.com/JeremyL691/OpenAudioHub/issues",
    docsPath: "/docs",
    copyrightHolder: "OpenAudioHub contributors",
    /** License notice for the footers and emails. The upstream credit is in NOTICE. */
    attribution: "Licensed under AGPL-3.0",
    copyright: "© OpenAudioHub contributors · Licensed under AGPL-3.0",
    noticeUrl: "https://github.com/JeremyL691/OpenAudioHub/blob/main/NOTICE",
} as const;
