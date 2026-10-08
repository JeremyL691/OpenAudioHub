import { useId } from "react";
import { cn } from "@/lib/utils";

interface LogoProps {
    className?: string;
}

const BRAND_GRADIENT_STOPS = [
    { offset: 0, color: "#01ADFB" },
    { offset: 0.5, color: "#2A5DFA" },
    { offset: 1, color: "#6B14FB" },
];

const BRAND_GRADIENT_CSS = `linear-gradient(135deg, ${BRAND_GRADIENT_STOPS.map(
    (stop) => `${stop.color} ${stop.offset * 100}%`,
).join(", ")})`;

/**
 * Ring, nodes, and waveform bars, drawn in the mark's own 64-unit grid. The
 * geometry matches public/brand/mark.svg, and the two must change together.
 */
function MarkShapes({ fill }: { fill: string }) {
    return (
        <>
            <g fill={fill}>
                <circle cx="19.5" cy="17.1" r="5.2" />
                <circle cx="21.2" cy="49.4" r="5.2" />
                <circle cx="52.3" cy="33.1" r="5.2" />
                <rect x="18.6" y="29.65" width="4.2" height="6.9" rx="2.1" />
                <rect x="24" y="25.85" width="4.2" height="14.5" rx="2.1" />
                <rect x="29.9" y="21.3" width="4.2" height="23.6" rx="2.1" />
                <rect x="35.7" y="25.85" width="4.2" height="14.5" rx="2.1" />
                <rect x="41" y="29.65" width="4.2" height="6.9" rx="2.1" />
            </g>
            <g
                fill="none"
                stroke={fill}
                strokeWidth={3.8}
                strokeLinecap="round"
            >
                <path d="M26.24 14.16 A19.7 19.7 0 0 1 50.74 26.91" />
                <path d="M16.48 45.13 A19.7 19.7 0 0 1 15.48 22.27" />
                <path d="M50.74 39.09 A19.7 19.7 0 0 1 27.23 52.11" />
            </g>
        </>
    );
}

/** The mark alone, in the brand gradient. */
export function LogoMark({ className }: LogoProps) {
    const gradientId = `oah-mark-${useId().replace(/:/g, "")}`;
    return (
        <svg
            viewBox="0 0 64 64"
            role="img"
            aria-label="OpenAudioHub"
            className={cn("shrink-0", className)}
        >
            <defs>
                <linearGradient
                    id={gradientId}
                    x1="0"
                    y1="0"
                    x2="64"
                    y2="64"
                    gradientUnits="userSpaceOnUse"
                >
                    {BRAND_GRADIENT_STOPS.map((stop) => (
                        <stop
                            key={stop.offset}
                            offset={stop.offset}
                            stopColor={stop.color}
                        />
                    ))}
                </linearGradient>
            </defs>
            <MarkShapes fill={`url(#${gradientId})`} />
        </svg>
    );
}

/** The wordmark. "Audio" carries the brand gradient. */
function Wordmark() {
    return (
        <span className="font-semibold tracking-tight text-foreground">
            Open
            <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: BRAND_GRADIENT_CSS }}
            >
                Audio
            </span>
            Hub
        </span>
    );
}

/** The mark beside the wordmark. Size it with a font-size class, such as text-xl. */
export function Logo({ className }: LogoProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-[0.35em] text-base leading-none",
                className,
            )}
        >
            <LogoMark className="size-[1.2em]" />
            <Wordmark />
        </span>
    );
}

/** The mark above the wordmark, for centered headers. */
export function LogoStacked({ className }: LogoProps) {
    return (
        <span
            className={cn(
                "inline-flex flex-col items-center gap-[0.5em] text-base leading-none",
                className,
            )}
        >
            <LogoMark className="size-[3em]" />
            <Wordmark />
        </span>
    );
}
