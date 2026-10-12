// Fixed colors that the interface cannot take from a token: the email palette,
// the mark's gradient, and the browser theme color. Mail clients do not read
// oklch(), so each value is the sRGB conversion of its token in
// src/app/globals.css. Emails declare color-scheme light, so the dark tokens are
// not used in the email palette. Re-convert a value when its token changes.
// src/tests/email/brand-colors.test.ts checks the email text pairs against WCAG AA.

export const brandColors = {
    // Surfaces: --muted (page) and --card (container). The app background is
    // white like the card, so the email page takes the muted grey instead.
    background: "#f2f2f4",
    card: "#ffffff",

    // Text: --foreground and --muted-foreground.
    foreground: "#1d1d1f",
    mutedForeground: "#636368",

    // Primary buttons and text links: --primary, the logo blue.
    primary: "#2a5dfa",
    primaryForeground: "#ffffff",

    // Brand blue (--brand-blue), the decorative top rule.
    accent: "#2a5dfa",

    // Dividers: --border.
    borderLight: "#e3e3e6",

    // Status dot: --success.
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
    light: "#ffffff",
    dark: "#1c1c1e",
} as const;

// Waveform fallbacks for when a theme token is missing. They mirror the
// tokens in src/app/globals.css. The waveform reads the tokens at draw time.
export const waveformFallback = {
    cyan: "oklch(0.72 0.15 230)",
    blue: "oklch(0.5494 0.2397 265.08)",
    violet: "oklch(0.55 0.25 290)",
    primary: "oklch(0.5494 0.2397 265.08)",
    muted: "rgba(0,0,0,0.5)",
} as const;
