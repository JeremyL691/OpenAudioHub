# Browser extension

The OpenAudioHub browser extension sends your Plaud sign-in from your own browser to OpenAudioHub. It is the sign-in option for Plaud accounts created with Google or Apple, and it works for email accounts too.

The extension runs in Chrome, Edge, Brave and other Chromium browsers, version 120 or later. Firefox and Safari are not supported.

## Install

1. Download the [latest browser extension](https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip). The link always downloads the newest release.
2. Unzip the file. Keep the folder.
3. Open `chrome://extensions` (or `edge://extensions`, or `brave://extensions`).
4. Turn on **Developer mode**.
5. Choose **Load unpacked** and select the unzipped folder.
6. Pin **OpenAudioHub** to the toolbar from the extensions menu.

The extension is not in the Chrome Web Store. Loading it unpacked is the supported install method.

## Sign in with Plaud

1. In OpenAudioHub, open **Settings**, then **Plaud Account**, and choose **Sign in with Plaud**.
2. Choose **Open Plaud sign-in**. A connect page opens in your browser.
3. Click the **OpenAudioHub** icon in the toolbar.
4. Choose your Plaud site: **Global (web.plaud.ai)** or **China (web.plaud.cn)**. Then choose **Connect**.
5. Sign in to Plaud if the Plaud tab asks you to. The connect page shows when OpenAudioHub has your sign-in.

If you are already signed in to Plaud in this browser, the extension sends the sign-in without opening a new tab.

The whole exchange takes under a minute. A sign-in that is still open after five minutes ends with a timeout. Choose **Connect** again to retry.

## Permissions

The extension asks for these permissions:

| Permission | Why |
|---|---|
| `activeTab` and `scripting` | Send the result to the connect page you chose. The access is temporary and covers only that tab. |
| `cookies` and the Plaud host permissions | Read the Plaud sign-in cookie on the Plaud site. |
| `storage` | Remember your chosen Plaud site and the sign-in in progress. |
| `alarms` | End a sign-in that times out. |

The extension has no content script on ordinary pages. It does not run on sites you visit and it does not read their content.

## Privacy

- The Plaud sign-in value passes through memory only. It is never written to browser storage, a cookie, a log or the console.
- The extension makes no network request. It reads the Plaud cookie and local storage entry, and sends the value to the connect page with a page message.
- OpenAudioHub validates the sign-in and stores it encrypted. See [Connect your Plaud account](connect-plaud-account.md).

## Update

1. Download the new `OpenAudioHub_Extension_<version>.zip` from the latest release.
2. Unzip it and replace the contents of the folder you loaded.
3. Open `chrome://extensions` and choose **Reload** on the OpenAudioHub card.

The extension version matches the OpenAudioHub version. A new app release can need a new extension zip when the sign-in flow changes.

## If something does not work

- **The icon is not on the toolbar.** Open the extensions menu, the puzzle piece icon, and pin OpenAudioHub. You can also open the popup from the extensions menu.
- **The popup says the page is not a connect page.** Start again from **Settings**, then **Plaud Account**, and use **Open Plaud sign-in**. The popup only works on the page that opens.
- **The sign-in timed out.** Choose **Open Plaud sign-in** again, then **Connect** in the popup.
- **Your account is on the China server.** Choose **China (web.plaud.cn)** in the popup. The global site does not have your account.
- **The popup warns about HTTPS.** The warning appears for a server that uses plain `http` and a host other than `127.0.0.1` or `localhost`. Use an HTTPS address to protect your Plaud sign-in in transit.
