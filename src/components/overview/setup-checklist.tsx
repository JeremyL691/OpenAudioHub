import { CheckCircle2, ChevronRight, Circle } from "lucide-react";
import Link from "next/link";

interface SetupChecklistProps {
    plaudConnected: boolean;
    hasProvider: boolean;
}

/** First-run steps. Renders nothing once Plaud is connected and a provider exists. */
export function SetupChecklist({
    plaudConnected,
    hasProvider,
}: SetupChecklistProps) {
    if (plaudConnected && hasProvider) return null;

    const steps = [
        {
            label: "Connect Plaud",
            href: "/settings/plaud-account",
            done: plaudConnected,
        },
        {
            label: "Add an AI provider",
            href: "/settings/providers",
            done: hasProvider,
        },
    ];

    return (
        <section aria-labelledby="setup-heading" className="space-y-2.5">
            <h2 id="setup-heading" className="text-[17px] font-semibold">
                Set up
            </h2>
            <ul className="divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-card">
                {steps.map((step) => (
                    <li key={step.label}>
                        {step.done ? (
                            <div className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm text-muted-foreground">
                                <CheckCircle2
                                    aria-hidden="true"
                                    className="size-4 shrink-0 text-success"
                                />
                                <span className="flex-1">{step.label}</span>
                                <span className="sr-only">Done</span>
                            </div>
                        ) : (
                            <Link
                                href={step.href}
                                className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
                            >
                                <Circle
                                    aria-hidden="true"
                                    className="size-4 shrink-0 text-muted-foreground"
                                />
                                <span className="flex-1">{step.label}</span>
                                <ChevronRight
                                    aria-hidden="true"
                                    className="size-4 shrink-0 text-muted-foreground"
                                />
                            </Link>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}
