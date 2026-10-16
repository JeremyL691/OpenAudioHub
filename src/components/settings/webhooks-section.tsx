"use client";

import { Pencil, Plus, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm-dialog";
import { SettingsSectionHeader } from "@/components/settings/section-header";
import { Button } from "@/components/ui/button";
import { WebhookDeliveriesDialog } from "./webhook-deliveries-dialog";
import { WebhookEditorDialog } from "./webhook-editor-dialog";
import {
    DEFAULT_WEBHOOK_EVENTS,
    formatWebhookDate,
    type WebhookEndpoint,
} from "./webhook-types";

export function WebhooksSection() {
    const confirm = useConfirm();
    const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
    const [events, setEvents] = useState<string[]>(DEFAULT_WEBHOOK_EVENTS);
    const [isLoading, setIsLoading] = useState(true);
    const [isEditorOpen, setIsEditorOpen] = useState(false);
    const [editingWebhook, setEditingWebhook] =
        useState<WebhookEndpoint | null>(null);
    const [deliveryWebhook, setDeliveryWebhook] =
        useState<WebhookEndpoint | null>(null);

    const refreshWebhooks = useCallback(async () => {
        try {
            const response = await fetch("/api/settings/webhooks");
            if (!response.ok) throw new Error("Failed to fetch webhooks");
            const data = (await response.json()) as {
                webhooks: WebhookEndpoint[];
                events: string[];
            };
            setWebhooks(data.webhooks);
            setEvents(data.events);
        } catch {
            toast.error("Failed to load webhooks");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshWebhooks();
    }, [refreshWebhooks]);

    const openEditor = (webhook: WebhookEndpoint | null) => {
        setEditingWebhook(webhook);
        setIsEditorOpen(true);
    };

    const handleDelete = (webhookId: string) => {
        void confirm({
            title: "Delete this webhook?",
            description:
                "Deliveries will stop immediately. You'll have to recreate the endpoint and re-share its signing secret with any consumers.",
            confirmLabel: "Delete",
            pendingLabel: "Deleting…",
            destructive: true,
            onConfirm: async () => {
                const response = await fetch(
                    `/api/settings/webhooks/${webhookId}`,
                    { method: "DELETE" },
                );
                if (!response.ok) throw new Error("Failed to delete webhook");
                toast.success("Webhook deleted");
                await refreshWebhooks();
            },
            errorMessage: "Failed to delete webhook",
        });
    };

    return (
        <div className="space-y-6">
            <SettingsSectionHeader
                title="Webhooks"
                description="Outbound HTTP notifications for recording, transcript, and summary events."
                icon={Webhook}
                action={
                    <Button
                        size="sm"
                        className="h-10 sm:h-8"
                        data-testid="webhook-create"
                        onClick={() => openEditor(null)}
                    >
                        <Plus className="size-4" />
                        Add Webhook
                    </Button>
                }
            />

            {isLoading ? (
                <div className="flex items-center justify-center py-8">
                    <div className="animate-spin size-6 border-2 border-primary border-t-transparent rounded-full" />
                </div>
            ) : webhooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                    <Webhook className="size-12 text-muted-foreground" />
                    <h3 className="text-[13px] font-semibold">No webhooks</h3>
                    <Button
                        size="sm"
                        className="h-10 sm:h-8"
                        data-testid="webhook-create"
                        onClick={() => openEditor(null)}
                    >
                        <Plus className="size-4" />
                        Add Webhook
                    </Button>
                </div>
            ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl bg-muted">
                    {webhooks.map((webhook) => (
                        <WebhookRow
                            key={webhook.id}
                            webhook={webhook}
                            onEdit={openEditor}
                            onDelete={handleDelete}
                            onShowDeliveries={setDeliveryWebhook}
                        />
                    ))}
                </div>
            )}

            <WebhookEditorDialog
                open={isEditorOpen}
                onOpenChange={setIsEditorOpen}
                editingWebhook={editingWebhook}
                events={events}
                onSaved={refreshWebhooks}
            />

            <WebhookDeliveriesDialog
                webhook={deliveryWebhook}
                onClose={() => setDeliveryWebhook(null)}
            />
        </div>
    );
}

function deliveryStatusClass(status: string): string {
    if (status === "success" || status === "delivered") {
        return "bg-success text-success-foreground";
    }
    if (status === "failed") return "bg-destructive text-destructive-foreground";
    return "bg-muted text-muted-foreground";
}

/**
 * One row in the webhook list. Pure presentation -- all mutation goes
 * through the callbacks the parent owns.
 */
function WebhookRow({
    webhook,
    onEdit,
    onDelete,
    onShowDeliveries,
}: {
    webhook: WebhookEndpoint;
    onEdit: (webhook: WebhookEndpoint) => void;
    onDelete: (webhookId: string) => void;
    onShowDeliveries: (webhook: WebhookEndpoint) => void;
}) {
    return (
        <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate text-[13px] font-medium">
                        {webhook.description || webhook.url}
                    </h3>
                    <span
                        className={`rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium ${
                            webhook.enabled
                                ? "text-link"
                                : "text-muted-foreground"
                        }`}
                    >
                        {webhook.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {webhook.lastDeliveryStatus && (
                        <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${deliveryStatusClass(webhook.lastDeliveryStatus)}`}
                        >
                            {webhook.lastDeliveryStatus}
                        </span>
                    )}
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">
                    {webhook.url}
                </p>
                <div className="flex flex-wrap gap-1">
                    {webhook.events.map((event) => (
                        <span
                            key={event}
                            className="rounded-md bg-background px-2 py-0.5 text-xs"
                        >
                            {event}
                        </span>
                    ))}
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                    Last delivery: {formatWebhookDate(webhook.lastDeliveryAt)}
                </p>
            </div>
            <div className="flex items-center gap-1 sm:justify-end">
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onShowDeliveries(webhook)}
                >
                    Deliveries
                </Button>
                <Button
                    variant="secondary"
                    size="icon"
                    onClick={() => onEdit(webhook)}
                    aria-label="Edit webhook"
                >
                    <Pencil className="size-4" />
                </Button>
                <Button
                    variant="secondary"
                    size="icon"
                    onClick={() => onDelete(webhook.id)}
                    aria-label="Delete webhook"
                >
                    <Trash2 className="size-4 text-destructive" />
                </Button>
            </div>
        </div>
    );
}
