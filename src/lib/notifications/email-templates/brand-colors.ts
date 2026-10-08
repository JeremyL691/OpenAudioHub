// Fixed colors that the interface cannot take from a token: the email palette,
// the mark's gradient, and the browser theme color. Mail clients do not read
// oklch(), so each value is the sRGB conversion of its Chalk token in
// src/app/globals.css. Emails declare color-scheme light, so the dark tokens are
// not used in the email palette. Re-convert a value when its token changes.
// src/tests/email/brand-colors.test.ts checks the email text pairs against WCAG AA.

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

// The mark's gradient, with the stops of public/brand/mark.svg. It is artwork,
// not a theme token, so it stays a fixed value.
export const brandGradient = {
    stops: [
        { offset: 0, color: "#01ADFB" },
        { offset: 0.5, color: "#2A5DFA" },
        { offset: 1, color: "#6B14FB" },
    ],
} as const;

// Browser theme color for the light and dark page backgrounds (--background).
export const themeColors = {
    light: "#f3f7fc",
    dark: "#141d2b",
} as const;

// Waveform fallbacks for when a theme token is missing. They mirror the Chalk
// tokens in src/app/globals.css. The waveform reads the tokens at draw time.
export const waveformFallback = {
    cyan: "oklch(0.72 0.15 230)",
    blue: "oklch(0.58 0.22 262)",
    violet: "oklch(0.55 0.25 290)",
    primary: "oklch(0.2038 0.0264 260.9332)",
    muted: "rgba(0,0,0,0.5)",
} as const;
