import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export interface KeyHintProps {
    /** Key names in press order, such as ["⌘", "K"]. */
    keys: string[];
    /** Text shown before the keys, such as "Search". */
    label?: string;
    className?: string;
}

/** A keyboard shortcut next to the control it triggers. */
export function KeyHint({ keys, label, className }: KeyHintProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-2 text-xs text-muted-foreground",
                className,
            )}
        >
            {label ? <span>{label}</span> : null}
            <KbdGroup>
                {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                ))}
            </KbdGroup>
        </span>
    );
}
