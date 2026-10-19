import { cn } from "@/lib/cn";
import { LOCALES, useI18n, type Locale } from "@/lib/i18n";

/**
 * The four interface languages, one radio item each, shown by their own names. The account menu
 * and the signed-out pages both use this list, so every page offers the same choices.
 */
export const LANGUAGE_ITEMS: { value: Locale; label: string }[] = LOCALES;

/**
 * Saves the choice and tells the desktop shell, when the page runs inside it, so the tray menu
 * follows. A shell that does not answer is not an error: the page keeps the choice itself.
 */
export function chooseLocale(locale: Locale, set: (l: Locale) => void): void {
    set(locale);
    const bridge = (window as unknown as { __openaudiohubDesktop?: { setLocale?: (l: string) => unknown } }).__openaudiohubDesktop;
    try {
        void bridge?.setLocale?.(locale);
    } catch {
        // The shell could not take the choice; the page still shows it.
    }
}

/** A compact segmented list of the four languages, for pages without a menu. */
export function LanguagePicker({ className, testIdPrefix = "language" }: { className?: string; testIdPrefix?: string }) {
    const { locale, setLocale, t } = useI18n();
    return (
        <div role="radiogroup" aria-label={t("shell.account.language")} className={cn("flex flex-wrap items-center gap-1", className)}>
            {LANGUAGE_ITEMS.map((item) => {
                const checked = item.value === locale;
                return (
                    <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-testid={`${testIdPrefix}-${item.value}`}
                        onClick={() => chooseLocale(item.value, setLocale)}
                        className={cn(
                            "inline-flex h-10 items-center rounded-md px-2.5 text-[13px] transition-colors duration-150 ease-out motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8",
                            checked ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                    >
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}
