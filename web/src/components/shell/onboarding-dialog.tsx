import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Dialog as D } from "radix-ui";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useShellData } from "./shell-data";

/** Dispatched by the Export settings page to open the onboarding again. Then the dialog can be dismissed. */
export const OPEN_ONBOARDING_EVENT = "oah:open-onboarding";

const STEPS: MessageKey[] = ["shell.onboarding.stepWelcome", "shell.onboarding.stepPlaud", "shell.onboarding.stepProvider", "shell.onboarding.stepFinish"];

/**
 * The first-run dialog (spec/ui-app.md 5). While onboarding is not completed it cannot be
 * dismissed. Get Started sends onboardingCompleted: true.
 */
export function OnboardingDialog() {
    const { settings, connection, providerCount, updateSettings, reload } = useShellData();
    const { t } = useI18n();
    const required = settings?.onboardingCompleted === false;
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(1);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (required) setOpen(true);
    }, [required]);

    useEffect(() => {
        const reopen = () => {
            setStep(1);
            setOpen(true);
        };
        window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
        return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
    }, []);

    if (!open) return null;

    const plaudDone = Boolean(connection?.connected);
    const providerDone = (providerCount ?? 0) > 0;

    const finish = async () => {
        setSaving(true);
        try {
            await updateSettings({ onboardingCompleted: true });
            setOpen(false);
            await reload();
        } catch (err) {
            toast.error(errorMessage(err, t("shell.onboarding.completeFailed")));
        } finally {
            setSaving(false);
        }
    };

    return (
        <D.Root
            open={open}
            onOpenChange={(next) => {
                // Mandatory until completed: Escape and outside clicks do nothing.
                if (!next && !required) setOpen(false);
            }}
        >
            <DialogPortal>
                <DialogOverlay />
                <D.Content
                    data-testid="onboarding-dialog"
                    onInteractOutside={(event) => {
                        if (required) event.preventDefault();
                    }}
                    onEscapeKeyDown={(event) => {
                        if (required) event.preventDefault();
                    }}
                    className="fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-5 rounded-2xl bg-popover p-6 text-popover-foreground shadow-card focus:outline-none"
                >
                    <div className="grid gap-2">
                        <div
                            role="progressbar"
                            aria-label={t("shell.onboarding.progress")}
                            aria-valuemin={1}
                            aria-valuemax={STEPS.length}
                            aria-valuenow={step}
                            aria-valuetext={t("shell.onboarding.stepOf", { step, total: STEPS.length })}
                            className="h-1.5 w-full overflow-hidden rounded-full bg-secondary"
                        >
                            <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none" style={{ width: `${(step / STEPS.length) * 100}%` }} />
                        </div>
                        <ol className="flex flex-wrap gap-x-3 text-xs text-muted-foreground" aria-hidden="true">
                            {STEPS.map((label, i) => (
                                <li key={label} className={cn(i + 1 === step && "font-semibold text-foreground")}>
                                    {t(label)}
                                </li>
                            ))}
                        </ol>
                    </div>

                    {step === 1 ? (
                        <StepBody title={t("shell.onboarding.welcomeTitle")}>
                            {t("shell.onboarding.welcomeBody")}
                        </StepBody>
                    ) : null}
                    {step === 2 ? (
                        <StepBody title={t("shell.onboarding.plaudTitle")}>
                            {t("shell.onboarding.plaudBody")}
                            <StepStatus done={plaudDone} doneText={t("shell.onboarding.plaudDone")} todoText={t("shell.onboarding.plaudTodo")} />
                            <Link to="/settings/plaud-account" className="text-sm font-medium text-link hover:underline">
                                {t("shell.onboarding.openPlaud")}
                            </Link>
                        </StepBody>
                    ) : null}
                    {step === 3 ? (
                        <StepBody title={t("shell.onboarding.providerTitle")}>
                            {t("shell.onboarding.providerBody")}
                            <StepStatus done={providerDone} doneText={t("shell.onboarding.providerDone")} todoText={t("shell.onboarding.providerTodo")} />
                            <Link to="/settings/providers" className="text-sm font-medium text-link hover:underline">
                                {t("shell.onboarding.openProviders")}
                            </Link>
                        </StepBody>
                    ) : null}
                    {step === 4 ? (
                        <StepBody title={t("shell.onboarding.finishTitle")}>
                            {t("shell.onboarding.finishBody")}
                        </StepBody>
                    ) : null}

                    <div className="flex items-center justify-between gap-2">
                        <div>
                            {step > 1 ? (
                                <Button variant="secondary" disabled={saving} onClick={() => setStep((s) => s - 1)}>
                                    {t("common.action.back")}
                                </Button>
                            ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                            {step === 2 || step === 3 ? (
                                <Button variant="ghost" disabled={saving} onClick={() => setStep((s) => s + 1)}>
                                    {t("common.action.skip")}
                                </Button>
                            ) : null}
                            {step < STEPS.length ? (
                                <Button variant="primary" disabled={saving} onClick={() => setStep((s) => s + 1)}>
                                    {t("common.action.next")}
                                </Button>
                            ) : (
                                <Button variant="primary" disabled={saving} onClick={() => void finish()}>
                                    {t("shell.onboarding.getStarted")}
                                </Button>
                            )}
                        </div>
                    </div>
                </D.Content>
            </DialogPortal>
        </D.Root>
    );
}

function StepBody({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="grid gap-3">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
                <div className="grid gap-3 text-sm text-muted-foreground">{children}</div>
            </DialogDescription>
        </div>
    );
}

function StepStatus({ done, doneText, todoText }: { done: boolean; doneText: string; todoText: string }) {
    return (
        <p className={cn("flex items-center gap-2 text-sm", done ? "text-success" : "text-muted-foreground")}>
            {done ? <Check aria-hidden="true" className="size-4" /> : null}
            {done ? doneText : todoText}
        </p>
    );
}
