import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

/** A loading indicator. The label is read by screen readers; the spin stops for reduced motion. */
export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
    return (
        <span role="status" className="inline-flex items-center">
            <LoaderCircle aria-hidden="true" className={cn("size-4 motion-safe:animate-spin", className)} />
            <span className="sr-only">{label}</span>
        </span>
    );
}
