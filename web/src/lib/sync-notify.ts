// What the page does when a sync adds recordings (spec/workers.md section 12): an in-app toast,
// a system notification when the user allowed them, and a short chime.
import { toast } from "sonner";

type NotifySettings = {
    syncNotifications?: boolean;
    browserNotifications?: boolean;
    notificationSound?: boolean;
};

function chime() {
    try {
        const context = new AudioContext();
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
        tone.connect(gain).connect(context.destination);
        tone.start();
        tone.stop(context.currentTime + 0.4);
        tone.onended = () => void context.close();
    } catch {
        // Audio can be blocked until the user interacts with the page; the chime is optional.
    }
}

async function systemNotification(count: number, userInitiated: boolean) {
    if (!("Notification" in window)) return;
    let permission = Notification.permission;
    // Asking needs a user gesture, so only a manual sync may prompt; background syncs use an existing grant.
    if (permission === "default" && userInitiated) permission = await Notification.requestPermission().catch(() => "denied" as const);
    if (permission !== "granted") return;
    const one = count === 1;
    new Notification(one ? "New recording synced" : `${count} new recordings synced`, {
        body: one ? "A recording just arrived from your Plaud device" : `${count} recordings just arrived from your Plaud device`,
        tag: "new-recording",
        icon: "/icon.svg",
    });
}

/** Called after a sync that added `count` recordings. `userInitiated` is true only for a manual sync (a user gesture). */
export function notifyNewRecordings(count: number, settings: NotifySettings | null, userInitiated: boolean) {
    if (count <= 0) return;
    if (settings?.syncNotifications !== false) {
        toast.success(count === 1 ? "1 new recording synced" : `${count} new recordings synced`);
    }
    if (settings?.browserNotifications !== false) void systemNotification(count, userInitiated);
    if (settings?.notificationSound !== false) chime();
}
