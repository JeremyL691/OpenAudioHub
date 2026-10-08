"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/onboarding-dialog-base";
import {
    OnboardingStepAiProvider,
    OnboardingStepComplete,
    OnboardingStepPlaud,
    OnboardingStepWelcome,
} from "@/components/onboarding-steps";
import { Button } from "@/components/ui/button";

type OnboardingStep = "welcome" | "plaud" | "ai-provider" | "complete";

const STEP_ORDER: OnboardingStep[] = [
    "welcome",
    "plaud",
    "ai-provider",
    "complete",
];

const STEP_LABELS: Record<OnboardingStep, string> = {
    welcome: "Welcome",
    plaud: "Plaud",
    "ai-provider": "AI provider",
    complete: "Finish",
};

interface OnboardingDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onComplete: () => void;
    /**
     * True when the user has not finished onboarding yet -- makes the
     * dialog non-dismissible (no close button, Escape and outside-click
     * are suppressed) so the flow can't be abandoned partway. False for
     * the voluntary "Re-run Onboarding" re-entry from Settings, which
     * stays dismissible like before.
     */
    mandatory?: boolean;
}

/**
 * Four steps, shown as a brand-gradient bar above the step content. Filled
 * segments are the steps reached so far, including the current one.
 */
function OnboardingProgress({
    labels,
    currentIndex,
}: {
    labels: string[];
    currentIndex: number;
}) {
    const label = `Step ${currentIndex + 1} of ${labels.length}`;
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <span>{labels[currentIndex]}</span>
            </div>
            <div
                role="progressbar"
                aria-label="Onboarding progress"
                aria-valuemin={1}
                aria-valuemax={labels.length}
                aria-valuenow={currentIndex + 1}
                aria-valuetext={label}
                className="flex gap-1.5"
            >
                {labels.map((stepLabel, index) => (
                    <span
                        key={stepLabel}
                        className={`h-1.5 flex-1 rounded-full transition-colors ${
                            index <= currentIndex
                                ? "bg-brand-gradient"
                                : "bg-muted"
                        }`}
                    />
                ))}
            </div>
        </div>
    );
}

export function OnboardingDialog({
    open,
    onOpenChange,
    onComplete,
    mandatory = false,
}: OnboardingDialogProps) {
    const { refresh } = useRouter();
    const [step, setStep] = useState<OnboardingStep>("welcome");
    const [hasPlaudConnection, setHasPlaudConnection] = useState(false);
    const [hasOwnProvider, setHasOwnProvider] = useState(false);

    // Probe whether the user already finished the Plaud connection in
    // a previous session, so re-entering the flow doesn't make them
    // re-paste a token. Same for the AI provider step below. Each runs
    // only while its step is active to avoid an unnecessary request on
    // mount.
    useEffect(() => {
        if (open && step === "plaud") {
            fetch("/api/plaud/connection")
                .then((res) => res.json())
                .then((data) => {
                    if (data.connected) {
                        setHasPlaudConnection(true);
                    }
                })
                .catch(() => {});
        }
    }, [open, step]);

    useEffect(() => {
        if (open && step === "ai-provider") {
            fetch("/api/settings/ai/providers")
                .then((res) => res.json())
                .then((data: { providers?: unknown[] }) => {
                    setHasOwnProvider((data.providers ?? []).length > 0);
                })
                .catch(() => {});
        }
    }, [open, step]);

    // Reset on dialog close so re-opening starts at the welcome step
    // and the cached "has X" flags get re-fetched.
    useEffect(() => {
        if (!open) {
            setStep("welcome");
            setHasPlaudConnection(false);
            setHasOwnProvider(false);
        }
    }, [open]);

    const stepIndex = STEP_ORDER.indexOf(step);
    const prevStep: OnboardingStep | null =
        stepIndex > 0 ? STEP_ORDER[stepIndex - 1] : null;
    const nextStep: OnboardingStep | null =
        stepIndex < STEP_ORDER.length - 1 ? STEP_ORDER[stepIndex + 1] : null;
    const canSkip = step === "plaud" || step === "ai-provider";

    const handleComplete = async () => {
        try {
            await fetch("/api/settings/user", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ onboardingCompleted: true }),
            });
            onComplete();
            onOpenChange(false);
            refresh();
        } catch {
            toast.error("Failed to complete onboarding");
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="max-w-2xl max-h-[90vh] overflow-y-auto sm:max-w-[600px]"
                data-testid="onboarding-dialog"
                hideCloseButton={mandatory}
                onEscapeKeyDown={(e) => {
                    if (mandatory) e.preventDefault();
                }}
                onPointerDownOutside={(e) => {
                    if (mandatory) e.preventDefault();
                }}
                onInteractOutside={(e) => {
                    if (mandatory) e.preventDefault();
                }}
            >
                <DialogHeader>
                    <DialogTitle className="text-2xl" hidden>
                        Welcome to OpenAudioHub
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    <OnboardingProgress
                        labels={STEP_ORDER.map((name) => STEP_LABELS[name])}
                        currentIndex={stepIndex}
                    />

                    {step === "welcome" && <OnboardingStepWelcome />}
                    {step === "plaud" && (
                        <OnboardingStepPlaud
                            hasPlaudConnection={hasPlaudConnection}
                            onReconnect={() => setHasPlaudConnection(false)}
                            onConnected={() => setHasPlaudConnection(true)}
                        />
                    )}
                    {step === "ai-provider" && (
                        <OnboardingStepAiProvider
                            hasOwnProvider={hasOwnProvider}
                            onGoToSettings={() => {
                                onOpenChange(false);
                                window.location.href = "/settings/providers";
                            }}
                        />
                    )}
                    {step === "complete" && <OnboardingStepComplete />}

                    <DialogFooter className="gap-2 sm:gap-3">
                        <div className="flex flex-1 gap-2">
                            {prevStep && (
                                <Button
                                    variant="outline"
                                    onClick={() => setStep(prevStep)}
                                >
                                    <ArrowLeft className="size-4 mr-2" />
                                    Previous
                                </Button>
                            )}
                        </div>

                        <div className="flex flex-1 justify-end gap-2">
                            {canSkip && nextStep && (
                                <Button
                                    variant="ghost"
                                    onClick={() => setStep(nextStep)}
                                >
                                    Skip
                                </Button>
                            )}
                            {step === "complete" ? (
                                <Button onClick={handleComplete}>
                                    Get Started
                                    <ArrowRight className="size-4 ml-2" />
                                </Button>
                            ) : (
                                nextStep && (
                                    <Button onClick={() => setStep(nextStep)}>
                                        Next
                                        <ArrowRight className="size-4 ml-2" />
                                    </Button>
                                )
                            )}
                        </div>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
