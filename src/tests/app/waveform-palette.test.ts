import { describe, expect, it } from "vitest";
import { readWaveformPalette } from "@/components/dashboard/waveform-palette";

function reader(values: Record<string, string>) {
    return (name: string) => values[name] ?? "";
}

describe("readWaveformPalette", () => {
    it("takes the waveform, playhead and muted colours from the tokens", () => {
        const palette = readWaveformPalette(
            reader({
                "--waveform-played": " oklch(0.58 0.22 262) ",
                "--waveform-unplayed": "oklch(0.5 0 0 / 0.35)",
                "--primary": "oklch(0.1 0 0)",
                "--muted-foreground": "oklch(0.5 0 0)",
            }),
        );

        expect(palette.playedStops).toEqual(["oklch(0.58 0.22 262)"]);
        expect(palette.unplayed).toBe("oklch(0.5 0 0 / 0.35)");
        expect(palette.primary).toBe("oklch(0.1 0 0)");
        expect(palette.muted).toBe("oklch(0.5 0 0)");
    });

    it("falls back to fixed values when a token is missing or blank", () => {
        const palette = readWaveformPalette(reader({ "--primary": "   " }));

        expect(palette.playedStops).toHaveLength(1);
        expect(palette.playedStops[0]).toMatch(/^oklch\(/);
        expect(palette.primary).toMatch(/^oklch\(/);
        expect(palette.muted).toBe("rgba(0,0,0,0.5)");
    });
});
