import { twMerge } from "tailwind-merge";

/** Joins class names, skipping empty values. A later Tailwind class wins over an earlier one of the same kind, so a caller's className overrides a component's default. */
export function cn(...parts: (string | false | null | undefined)[]): string {
    return twMerge(parts.filter(Boolean).join(" "));
}
