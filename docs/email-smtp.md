# Email (SMTP) setup

OpenAudioHub sends email through an SMTP mail server that you choose. Email is optional. Without it, the server sends no email, and two features are unavailable: email notifications and password reset by email.

- [What email is used for](#what-email-is-used-for)
- [Configure SMTP](#configure-smtp)
- [Examples](#examples)
- [Check the setup](#check-the-setup)
- [When SMTP is not set](#when-smtp-is-not-set)
- [Troubleshooting](#troubleshooting)

## What email is used for

| Email | Sent to | When |
|---|---|---|
| New recording synced | The notification address, or the account address | A sync adds new recordings, and the user turned on **Email notifications**. See [Notifications](notifications.md). |
| Reset your password | The account address | Someone asks for a reset on the sign-in page. The link expires in 1 hour and works once. |
| Export ready | The account address | A full backup zip is ready to download. See [Backup and restore](backup-and-restore.md). |
| Test email | The address you enter in the notification settings | You choose **Send test email**. |

If you did not ask for a password reset, the email says you can ignore it. The sign-in page answers the same way whether or not the address has an account.

## Configure SMTP

Set these variables in `.env` and in `compose.yml`. See [The compose file](self-hosting.md#the-compose-file). Email is on only when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are all set.

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | The mail server host name, for example `smtp.example.com`. |
| `SMTP_PORT` | The mail server port. Defaults to `465` when `SMTP_SECURE=true`, otherwise `587`. |
| `SMTP_SECURE` | `true` uses implicit TLS, usually on port 465. `false` uses STARTTLS, usually on port 587. Only the exact text `true` turns it on. |
| `SMTP_USER` | The login name. |
| `SMTP_PASSWORD` | The password, or the API key that your mail service gives you as the password. |
| `SMTP_FROM` | The From address, as a bare address or `Name <address>`. If you leave it empty, the server uses `SMTP_USER`. Choose an address on a domain you control. |
| `SMTP_REPLY_TO` | Optional. The Reply-To address, in the same format. |

An invalid `SMTP_PORT`, `SMTP_FROM` or `SMTP_REPLY_TO` stops the server at startup. Every variable is listed in [Environment variables](environment-variables.md#email).

Restart the server after you change these values.

## Examples

These are typical values. Your mail service gives you the exact host, port and login.

Implicit TLS on port 465:

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=apikey-or-username
SMTP_PASSWORD=YOUR_PASSWORD
SMTP_FROM="OpenAudioHub <noreply@example.com>"
```

STARTTLS on port 587:

```sh
SMTP_HOST=smtp.example.com
SMTP_SECURE=false
SMTP_USER=apikey-or-username
SMTP_PASSWORD=YOUR_PASSWORD
SMTP_FROM=noreply@example.com
SMTP_REPLY_TO=you@example.com
```

Many mail services ask you to verify the From domain first. Do that before you expect mail to arrive.

## Check the setup

1. Open **Settings**, then **Notifications**, or go to `/settings/notifications` directly. That page is not in the settings menu.
2. Choose **Send test email**. The test goes to the notification address, or to your account address if you left it empty.
3. Check the inbox and the spam folder.

If the test fails, the page shows the reason. A missing setting, a rejected login, and a connection error each get their own message.

## When SMTP is not set

- The forgot-password page says that password reset by email needs SMTP. Use the command in [Reset a password](self-hosting.md#reset-a-password).
- Email notifications, export-ready emails and the test email send nothing. The test email shows the "SMTP is not set up yet" message on the notifications page.

## Troubleshooting

- **Authentication failed.** Check `SMTP_USER` and `SMTP_PASSWORD`. Some services need an API key as the password and a fixed user name.
- **Connection or timeout errors.** Check the host and port, and the `SMTP_SECURE` setting. Port 465 needs `SMTP_SECURE=true`. Port 587 needs `SMTP_SECURE=false`.
- **Mail goes to spam or is refused.** Check that `SMTP_FROM` is on a domain you have verified with the service, and that the service allows sending to the addresses you use.
- **Nothing in the inbox, but the test says it was sent.** The mail service accepted it. Check its logs.

A failed send is written to the server log. Set `OAH_LOG` to change how much the server writes. See [Logs](self-hosting.md#logs).
