import type { ReactNode } from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { fieldBase } from "./input";
import { useFieldContext } from "./field";

export interface SelectOption {
    /** Must not be an empty string (Radix reserves it). Use a sentinel such as "auto" for "none". */
    value: string;
    label: ReactNode;
    disabled?: boolean;
}

export interface SelectProps {
    id?: string;
    value: string;
    onValueChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
}

/** Single choice from a list. Inside a Field it takes the Field's id and error state. */
export function Select({ id, value, onValueChange, options, placeholder, disabled, className, ...aria }: SelectProps) {
    const field = useFieldContext();
    return (
        <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
            <S.Trigger
                id={id ?? field?.id}
                aria-describedby={field?.describedBy}
                aria-invalid={field?.invalid || undefined}
                aria-label={aria["aria-label"]}
                aria-labelledby={aria["aria-labelledby"]}
                className={cn(
                    fieldBase,
                    // Radix drops `className` on Select.Value, so the selected text is clamped on the
                    // trigger instead: it shrinks and ends in an ellipsis inside the box.
                    "flex items-center justify-between gap-2 text-left [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:truncate [&>svg]:shrink-0",
                    className,
                )}
            >
                <S.Value placeholder={placeholder} />
                <S.Icon asChild>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </S.Icon>
            </S.Trigger>
            <S.Portal>
                <S.Content
                    position="popper"
                    sideOffset={6}
                    className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground shadow-card"
                >
                    <S.Viewport>
                        {options.map((option) => (
                            <S.Item
                                key={option.value}
                                value={option.value}
                                disabled={option.disabled}
                                className="relative flex min-h-10 cursor-default select-none items-center rounded-md py-1 pl-8 pr-2 text-sm text-foreground outline-none sm:min-h-8 data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                            >
                                <span className="absolute left-2 flex size-4 items-center justify-center">
                                    <S.ItemIndicator>
                                        <Check className="size-4" aria-hidden="true" />
                                    </S.ItemIndicator>
                                </span>
                                <S.ItemText>{option.label}</S.ItemText>
                            </S.Item>
                        ))}
                    </S.Viewport>
                </S.Content>
            </S.Portal>
        </S.Root>
    );
}
