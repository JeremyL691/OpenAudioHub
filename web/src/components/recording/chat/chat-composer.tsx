import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/** The question box: a growing text field, the send or stop button, and the model chip. */
export interface ChatComposerProps {
    value: string;
    onChange(value: string): void;
    onSend(): void;
    onStop(): void;
    /** An answer is running, so the button stops it instead of sending. */
    running: boolean;
    /** A question is being sent right now. */
    sending: boolean;
    /** The field takes no input, as when there is no transcript. */
    disabled: boolean;
    /** False when the server said no question can be sent now. */
    canAsk: boolean;
    /** The model chip, shown on the left under the field. */
    picker: ReactNode;
    textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

/** The tallest the field grows before it scrolls. */
const MAX_HEIGHT = 200;

export function ChatComposer({ value, onChange, onSend, onStop, running, sending, disabled, canAsk, picker, textareaRef }: ChatComposerProps) {
    const { t } = useI18n();
    const own = useRef<HTMLTextAreaElement | null>(null);
    const ref = textareaRef ?? own;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        // A hidden panel measures 0, so the box keeps its natural one-line height.
        if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    }, [ref, value]);

    return (
        <div className="mx-auto w-full max-w-2xl rounded-2xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-4 focus-within:ring-ring/10">
            <textarea
                ref={ref}
                aria-label={t("recording.chat.inputAria")}
                placeholder={t("recording.chat.inputPlaceholder")}
                value={value}
                rows={1}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        onSend();
                    }
                }}
                className="block min-h-10 max-h-[200px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
                <div className="min-w-0">{picker}</div>
                <span className="flex-1" />
                {running ? (
                    <button
                        type="button"
                        data-testid="chat-stop"
                        aria-label={t("recording.chat.stop")}
                        title={t("recording.chat.stop")}
                        onClick={onStop}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                        <Square aria-hidden="true" className="size-3 fill-current" />
                    </button>
                ) : (
                    <button
                        type="button"
                        data-testid="chat-send"
                        aria-label={t("recording.chat.send")}
                        title={t("recording.chat.enterHint")}
                        disabled={sending || !value.trim() || !canAsk}
                        onClick={onSend}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,opacity] hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                        <ArrowUp aria-hidden="true" className="size-4 stroke-[2.4]" />
                    </button>
                )}
            </div>
        </div>
    );
}
