// Colors for transactional email, taken from the light-mode Chalk tokens in
// src/app/globals.css (`:root`). Mail clients do not read oklch(), so each
// value is the sRGB conversion of its token. Emails declare color-scheme
// light, so the dark tokens are not used here. Re-convert a value when its
// token changes. src/tests/email/brand-colors.test.ts checks the text pairs
// against WCAG AA.

export const brandColors = {
    // Surfaces: Chalk --background (page) and --card (container).
    background: "#f3f7fc",
    card: "#f9fcff",

    // Text: Chalk --foreground and --muted-foreground.
    foreground: "#060a12",
    mutedForeground: "#636974",

    // Primary buttons and text links: Chalk --primary. DESIGN.md makes
    // primary buttons Chalk primary, not the brand color.
    primary: "#101723",
    primaryForeground: "#fafafa",

    // Brand blue (--brand-blue) is 4.35:1 on the card surface, below the
    // 4.5:1 that small text needs, so it is only a decorative top rule.
    accent: "#286ef9",

    // Dividers: Chalk --border.
    borderLight: "#d8dfe9",

    // Status dot: Chalk --success.
    statusGreen: "#09672e",
} as const;
