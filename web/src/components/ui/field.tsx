import { createContext, useContext, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./label";

interface FieldContextValue {
    id: string;
    describedBy?: string;
    invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Read by Input, Textarea and Select so they get the id, aria-describedby and aria-invalid of their Field. */
export function useFieldContext(): FieldContextValue | null {
    return useContext(FieldContext);
}

export interface FieldProps {
    /** Id for the control. Generated when omitted. The label points at it. */
    id?: string;
    label: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    className?: string;
    children: ReactNode;
}

/** A label, the control, an optional hint and an optional error, wired for assistive technology. */
export function Field({ id: idProp, label, hint, error, className, children }: FieldProps) {
    const generated = useId();
    const id = idProp ?? generated;
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

    return (
        <FieldContext value={{ id, describedBy, invalid: Boolean(error) }}>
            <div className={cn("grid gap-1.5", className)}>
                <Label htmlFor={id}>{label}</Label>
                {children}
                {hint ? (
                    <p id={hintId} className="text-xs text-muted-foreground">
                        {hint}
                    </p>
                ) : null}
                {error ? (
                    <p id={errorId} className="text-xs text-destructive">
                        {error}
                    </p>
                ) : null}
            </div>
        </FieldContext>
    );
}
