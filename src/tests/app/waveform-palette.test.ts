import { describe, expect, it } from "vitest";
import { readWaveformPalette } from "@/components/dashboard/waveform-palette";

function reader(values: Record<string, string>) {
    return (name: string) => values[name] ?? "";
}

describe("readWaveformPalette", () => {
    it("takes the brand gradient and the playhead and muted colours from the tokens", () => {
        const palette = readWaveformPalette(
            reader({
                "--brand-cyan": " oklch(0.72 0.15 230) ",
                "--brand-blue": "oklch(0.58 0.22 262)",
                "--brand-violet": "oklch(0.55 0.25 290)",
                "--primary": "oklch(0.1 0 0)",
                "--muted-foreground": "oklch(0.5 0 0)",
            }),
        );

        expect(palette.playedStops).toEqual([
            "oklch(0.72 0.15 230)",
            "oklch(0.58 0.22 262)",
            "oklch(0.55 0.25 290)",
        ]);
        expect(palette.primary).toBe("oklch(0.1 0 0)");
        expect(palette.muted).toBe("oklch(0.5 0 0)");
    });

    it("falls back to Chalk values when a token is missing or blank", () => {
        const palette = readWaveformPalette(reader({ "--primary": "   " }));

        expect(palette.playedStops).toHaveLength(3);
        expect(palette.playedStops[0]).toMatch(/^oklch\(/);
        expect(palette.primary).toMatch(/^oklch\(/);
        expect(palette.muted).toBe("rgba(0,0,0,0.5)");
    });
});
