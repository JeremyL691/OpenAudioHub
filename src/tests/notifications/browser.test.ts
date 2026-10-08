// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    requestNotificationPermission,
    showBrowserNotification,
    showNewRecordingNotification,
} from "@/lib/notifications/browser";

// Browser notifications (F15): permission, the granted-only rule, and the wording.
class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn(
        async (): Promise<NotificationPermission> => "granted",
    );
    static shown: Array<{ title: string; options?: NotificationOptions }> = [];

    constructor(title: string, options?: NotificationOptions) {
        FakeNotification.shown.push({ title, options });
    }
}

function setPermission(permission: NotificationPermission) {
    FakeNotification.permission = permission;
}

describe("browser notifications", () => {
    beforeEach(() => {
        FakeNotification.permission = "default";
        FakeNotification.requestPermission.mockClear();
        FakeNotification.requestPermission.mockImplementation(
            async () => "granted",
        );
        FakeNotification.shown = [];
        Object.defineProperty(window, "Notification", {
            configurable: true,
            writable: true,
            value: FakeNotification,
        });
    });

    afterEach(() => {
        Reflect.deleteProperty(window, "Notification");
        vi.restoreAllMocks();
    });

    it("reports a browser without notifications as not granted", async () => {
        Reflect.deleteProperty(window, "Notification");
        await expect(requestNotificationPermission()).resolves.toBe(false);
    });

    it("returns true without prompting when already granted", async () => {
        setPermission("granted");
        await expect(requestNotificationPermission()).resolves.toBe(true);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("asks once when the permission is undecided", async () => {
        setPermission("default");
        await expect(requestNotificationPermission()).resolves.toBe(true);
        expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    });

    it("returns false when the user declines the prompt", async () => {
        setPermission("default");
        FakeNotification.requestPermission.mockImplementation(
            async () => "denied",
        );
        await expect(requestNotificationPermission()).resolves.toBe(false);
    });

    it("does not prompt again after a denial", async () => {
        setPermission("denied");
        await expect(requestNotificationPermission()).resolves.toBe(false);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("shows a notification only when permission is granted", () => {
        setPermission("default");
        showBrowserNotification("Hello", { body: "b" });
        expect(FakeNotification.shown).toHaveLength(0);

        setPermission("granted");
        showBrowserNotification("Hello", { body: "b" });
        expect(FakeNotification.shown).toEqual([
            {
                title: "Hello",
                options: {
                    icon: "/favicon.ico",
                    badge: "/favicon.ico",
                    body: "b",
                },
            },
        ]);
    });

    it("words a single new recording and several new recordings", () => {
        setPermission("granted");

        showNewRecordingNotification(1);
        expect(FakeNotification.shown[0]).toMatchObject({
            title: "New recording synced",
            options: {
                tag: "new-recording",
                body: "A new recording has been synced from your Plaud device",
            },
        });

        showNewRecordingNotification(3);
        expect(FakeNotification.shown[1]).toMatchObject({
            title: "3 new recordings synced",
            options: {
                body: "3 new recordings have been synced from your Plaud device",
            },
        });
    });
});
