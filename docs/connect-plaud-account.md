# Connect your Plaud account

OpenAudioHub pulls your recordings from one Plaud account. You connect the account once, and the server then syncs new recordings in the background.

- [Where to connect](#where-to-connect)
- [Sign in with the browser extension](#sign-in-with-the-browser-extension)
- [Email code](#email-code)
- [Paste a token](#paste-a-token)
- [Regions](#regions)
- [How sync works](#how-sync-works)
- [Tokens and sign-in expiry](#tokens-and-sign-in-expiry)
- [Switch or disconnect](#switch-or-disconnect)

## Where to connect

Open **Settings**, then **Plaud Account**, and choose **Connect Plaud**. The sign-in panel has these tabs:

- **Sign in with Plaud**: the browser extension hands the session to OpenAudioHub. Use this if you signed up to Plaud with Google or Apple.
- **Email code**: Plaud emails you a code.
- **Paste token**: you copy a token from the Plaud web app.

If you signed up to Plaud with Google or Apple, the browser extension is the easiest option. It works the same way for every sign-in method Plaud offers.

## Sign in with the browser extension

1. Install the browser extension that the sign-in panel describes.
2. Open **Settings**, then **Plaud Account**, then **Connect Plaud**. Stay on the **Sign in with Plaud** tab.
3. Choose **Sign in with Plaud**. A sign-in window opens.
4. Sign in to Plaud as usual. The extension passes the session to the sign-in window, which connects your account. The panel shows **Waiting for Plaud sign-in** until it does.

You copy nothing. A sign-in lasts ten minutes. If it expires, start again.

## Email code

1. Open the **Email code** tab and enter the email address of your Plaud account.
2. Plaud sends a code to that address.
3. Enter the code in **Verification code**, and connect.

The first request goes to the global Plaud server. If Plaud says the account is in another region, the server repeats the request there, up to three times. The region is saved with the connection.

## Paste a token

Use this only when the other methods do not work.

1. Sign in to the Plaud web app in your browser.
2. Copy your **account** token from the Plaud web app. Use the account token, not a workspace token.
3. Open the **Paste token** tab, paste the token into **Account token**, and connect.

The paste form sends no region, so it connects to the global Plaud server. If your account is on the China server, use the browser extension or the Mac app instead. OpenAudioHub refuses workspace tokens, because they cannot be renewed, and it refuses tokens that have already expired.

## Regions

Plaud runs separate servers for different regions. The server supports these:

| Region | Plaud server |
|---|---|
| Global | `https://api.plaud.ai` |
| EU (Frankfurt) | `https://api-euc1.plaud.ai` |
| Asia Pacific (Singapore) | `https://api-apse1.plaud.ai` |
| China mainland | `https://api.plaud.cn` |

The email-code flow finds the region by itself.

## How sync works

A sync asks Plaud for your recording list, and saves each new recording and any change to an existing one. The server does this:

- **In the background.** Every 5 minutes by default, for each connected account that has not synced in the last 4 minutes. This needs no open browser. The server admin can change the interval. See [Environment variables](environment-variables.md#plaud-sync).
- **While the dashboard is open.** The dashboard syncs when it loads, when its tab becomes visible again, and at the interval you choose. You can change these in **Settings**, then **Sync**.
- **On demand.** Choose **Sync now**. The server allows 10 manual syncs per minute for each account by default.

Recordings you delete in OpenAudioHub are not sent back to Plaud, and the Plaud copy is not changed.

If a sync adds new recordings, the server sends the notifications you turned on. See [Notifications](notifications.md). Transcription runs for new recordings only if you turned on **Auto-transcribe new recordings**.

## Tokens and sign-in expiry

OpenAudioHub stores your Plaud token encrypted in the database. The token is never shown again, and it is never written to the log.

- Plaud tokens expire after 24 hours. When yours expires, syncs stop until you connect again with any of the three sign-in methods.
- When Plaud rejects the token anyway, the connection shows **Sign-in expired**, and syncs stop until you connect again. Your recordings stay in the library.
- To fix it, connect again with any method. The existing recordings are kept.

## Switch or disconnect

Open **Settings**, then **Plaud Account**.

- **Switch account** connects a different Plaud account. Recordings you already synced stay in your library. Only future syncs use the new account.
- **Disconnect** deletes the stored token and the device list. Recordings stay in your library. OpenAudioHub does not revoke the token with Plaud, so sign out of the Plaud web app if you want to end that session.
