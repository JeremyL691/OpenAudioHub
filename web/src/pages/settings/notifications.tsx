import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BellRing, Eye, EyeOff, Mail, Megaphone, Send, Smartphone, Volume2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useSettings, type BoolSettingKey, type SettingsPatch, type UserSettings } from "./shared";

/**
 * Notification fields. Email and Bark are read and written through the same user settings endpoint as the
 * rest of the page. They are not in the shared settings record, so they are declared here.
 */
interface NotificationFields {
    emailNotifications: boolean;
    notificationEmail: string | null;
    barkNotifications: boolean;
    barkPushUrl: string | null;
    barkPushUrlSet: boolean;
    marketingEmailConsent: boolean;
}

const TEXT_SAVE_DELAY_MS = 500;

/** One switch in a card. The card is a grey box with the switch row and an optional panel under it. */
function ToggleCard({
    id,
    icon: Icon,
    label,
    hint,
    checked,
    disabled,
    onChange,
    children,
}: {
    id: string;
    icon: LucideIcon;
    label: string;
    hint: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    children?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="divide-y divide-border rounded-xl bg-muted px-4">
                <label htmlFor={id} className="block">
                    <div className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-2.5">
                        <div className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium">
                                <span className="inline-flex items-center gap-2">
                                    <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                                    {label}
                                </span>
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                        </div>
                        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="h-[22px] w-[38px]" />
                    </div>
                </label>
                {checked && children ? children : null}
            </div>
        </div>
    );
}

export function NotificationsSection() {
    const { settings, save, isSaving: isSavingField } = useSettings();
    const ids = useId();
    const fields = settings as unknown as typeof settings & NotificationFields;
    // The notification fields are outside the shared settings record, so their names are not UserSettings keys.
    const isSaving = (field: string) => isSavingField(field as keyof UserSettings);
    const flag = (field: BoolSettingKey | keyof NotificationFields) => (value: boolean) =>
        void save({ [field]: value } as unknown as SettingsPatch);

    return (
        <div className="grid gap-3">
            <ToggleCard
                id={`${ids}-browser-notifications`}
                icon={BellRing}
                label="Browser notifications"
                hint="Pop up a desktop notification whenever new recordings come in or a sync runs."
                checked={Boolean(settings.browserNotifications)}
                disabled={isSaving("browserNotifications")}
                onChange={flag("browserNotifications")}
            />
            <ToggleCard
                id="email-notifications"
                icon={Mail}
                label="Email notifications"
                hint="Send email notifications for new recordings."
                checked={Boolean(fields.emailNotifications)}
                disabled={isSaving("emailNotifications")}
                onChange={flag("emailNotifications")}
            >
                <EmailPanel
                    value={fields.notificationEmail}
                    accountEmail={settings.userEmail}
                    disabled={isSaving("notificationEmail")}
                    onSave={(next) => void save({ notificationEmail: next } as unknown as SettingsPatch)}
                />
            </ToggleCard>
            <ToggleCard
                id="bark-notifications"
                icon={Smartphone}
                label="Bark push notifications"
                hint="Push new recordings to your phone through Bark."
                checked={Boolean(fields.barkNotifications)}
                disabled={isSaving("barkNotifications")}
                onChange={flag("barkNotifications")}
            >
                <BarkPanel
                    value={fields.barkPushUrl}
                    disabled={isSaving("barkPushUrl")}
                    onSave={(next) => void save({ barkPushUrl: next } as unknown as SettingsPatch)}
                />
            </ToggleCard>
            <ToggleCard
                id="notification-sound"
                icon={Volume2}
                label="Notification sound"
                hint="Play a short chime as notifications come in."
                checked={Boolean(settings.notificationSound)}
                disabled={isSaving("notificationSound")}
                onChange={flag("notificationSound")}
            />
            <ToggleCard
                id="marketing-email-consent"
                icon={Megaphone}
                label="Product updates"
                hint="The occasional email about new features and releases. At most a few each year, and never more than one a month."
                checked={Boolean(fields.marketingEmailConsent)}
                disabled={isSaving("marketingEmailConsent")}
                onChange={flag("marketingEmailConsent")}
            />
        </div>
    );
}

/** The address the email notifications go to. Empty means the account email. Saves after a pause or on blur. */
function EmailPanel({
    value,
    accountEmail,
    disabled,
    onSave,
}: {
    value: string | null;
    accountEmail: string;
    disabled: boolean;
    onSave: (next: string | null) => void;
}) {
    const ids = useId();
    const shown = value ?? accountEmail;
    const [draft, setDraft] = useState(shown);
    const [sending, setSending] = useState(false);
    const timer = useRef<number | undefined>(undefined);
    const stored = useRef(value);
    stored.current = value;

    useEffect(() => {
        setDraft(value ?? accountEmail);
    }, [value, accountEmail]);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    // Compare what the field shows against what was loaded, so a blur without edits saves nothing.
    // An empty field and the account email both mean "the account email", so they count as the same value.
    const commit = (text: string) => {
        const next = text.trim() === "" ? null : text.trim();
        if ((next ?? accountEmail) === (stored.current ?? accountEmail)) return;
        onSave(next);
    };

    const sendTest = async () => {
        setSending(true);
        try {
            await api("/api/settings/test-email", { method: "POST", json: { email: draft.trim() } });
            toast.success("Test email sent");
        } catch (error) {
            toast.error(errorMessage(error, "The test email could not be sent"));
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
            <Label htmlFor={`${ids}-email`} className="text-[13px] font-medium">
                Email address
            </Label>
            <Input
                id={`${ids}-email`}
                type="email"
                placeholder={accountEmail}
                value={draft}
                disabled={disabled}
                onChange={(event) => {
                    const text = event.target.value;
                    setDraft(text);
                    window.clearTimeout(timer.current);
                    timer.current = window.setTimeout(() => commit(text), TEXT_SAVE_DELAY_MS);
                }}
                onBlur={(event) => {
                    window.clearTimeout(timer.current);
                    commit(event.target.value);
                }}
            />
            <p className="text-xs text-muted-foreground">
                Using your account email. You can point this elsewhere if you prefer.
            </p>
            <div className="flex items-center gap-2 pt-1">
                <Button variant="secondary" disabled={sending || draft.trim() === ""} onClick={() => void sendTest()}>
                    {sending ? <Spinner label="Sending test email" /> : <Send />}
                    Send test email
                </Button>
            </div>
        </div>
    );
}

/**
 * The Bark push URL. Empty clears it. Saves after a pause or on blur. The URL holds the device key, so the
 * field is masked until the user shows it.
 */
function BarkPanel({ value, disabled, onSave }: { value: string | null; disabled: boolean; onSave: (next: string | null) => void }) {
    const ids = useId();
    const [draft, setDraft] = useState(value ?? "");
    const [revealed, setRevealed] = useState(false);
    const timer = useRef<number | undefined>(undefined);
    const stored = useRef(value);
    stored.current = value;

    useEffect(() => {
        setDraft(value ?? "");
    }, [value]);

    useEffect(() => () => window.clearTimeout(timer.current), []);

    const commit = (text: string) => {
        const next = text.trim() === "" ? null : text.trim();
        if (next === (stored.current ?? null)) return;
        onSave(next);
    };

    return (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
            <Label htmlFor={`${ids}-bark`} className="text-[13px] font-medium">
                Bark push URL
            </Label>
            <div className="flex items-center gap-2">
                <Input
                    id={`${ids}-bark`}
                    type={revealed ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://api.day.app/your_key"
                    value={draft}
                    disabled={disabled}
                    className="min-w-0 flex-1"
                    onChange={(event) => {
                        const text = event.target.value;
                        setDraft(text);
                        window.clearTimeout(timer.current);
                        timer.current = window.setTimeout(() => commit(text), TEXT_SAVE_DELAY_MS);
                    }}
                    onBlur={(event) => {
                        window.clearTimeout(timer.current);
                        commit(event.target.value);
                    }}
                />
                <Button
                    variant="secondary"
                    size="sm"
                    aria-controls={`${ids}-bark`}
                    aria-label={revealed ? "Hide Bark push URL" : "Show Bark push URL"}
                    onClick={() => setRevealed((shown) => !shown)}
                >
                    {revealed ? <EyeOff /> : <Eye />}
                    {revealed ? "Hide" : "Show"}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">Paste the full push URL from your Bark app (e.g., https://api.day.app/your_key).</p>
        </div>
    );
}
