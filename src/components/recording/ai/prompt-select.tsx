"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

interface PromptSelectProps {
    value: string;
    options: { id: string; name: string }[];
    onChange: (id: string) => void;
    /** Accessible name of the trigger. */
    label?: string;
}

/** Picks a summary template or output language. */
export function PromptSelect({
    value,
    options,
    onChange,
    label = "Summary prompt",
}: PromptSelectProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-[160px] h-8 text-xs" aria-label={label}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
