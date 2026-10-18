# Notifications

OpenAudioHub can tell you when a sync adds new recordings. Two channels send the message: email, and Bark push to an iPhone. You can turn on either or both.

- [When notifications are sent](#when-notifications-are-sent)
- [Email](#email)
- [Bark (iPhone push)](#bark-iphone-push)
- [Browser notifications](#browser-notifications)
- [When a notification fails](#when-a-notification-fails)

## When notifications are sent

A notification is sent only when a sync adds one or more new recordings. A sync can start in the background, from the dashboard, or from **Sync now**. Each sync that adds recordings sends one message that covers all of them.

Updates to a recording, finished transcripts and finished summaries do not send a notification.

Settings are in **Settings**, then **Notifications**. The page is not in the settings menu. Open it directly at `/settings/notifications`.

## Email

Email needs an SMTP mail server on the server. The server admin sets it up. See [Email (SMTP) setup](email-smtp.md). If SMTP is not set up, the email switch saves, but no email is sent. The test button shows the reason.

1. Open the notifications page and turn on **Email notifications**.
2. Enter an address in **Email address**. Leave it empty to use your account's email address.
3. Choose **Send test email** to check the setup. The test email is sent to the address above.

The email has a short summary. The subject is "New recording synced" for one recording, or the number of recordings for more. The body lists the new titles.

## Bark (iPhone push)

Bark is a free iPhone app that delivers push notifications.

1. Install Bark on your iPhone and copy the push URL it shows. It looks like `https://api.day.app/your_key`.
2. Open the notifications page, turn on **Bark push notifications**, and paste the full URL into **Bark push URL**. The field saves when you stop typing or leave it. Clear the field to remove the URL.

The URL is stored encrypted for your account only. A notification shows the count, the first few titles, and opens the dashboard when you tap it.

## Browser notifications

The **Browser notifications** switch is saved with your settings, but browser notifications are not available yet. Use email or Bark for alerts.

## When a notification fails

Notifications never hold up a sync. Each channel has a time limit: 3 seconds for Bark, and 30 seconds for the mail server. A notification that fails is logged and is not retried. If a push does not arrive, check the server log. See [Logs](self-hosting.md#logs).
