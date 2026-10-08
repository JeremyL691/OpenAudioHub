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
}

/** Picks the summary prompt preset. */
export function PromptSelect({ value, options, onChange }: PromptSelectProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
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
