# Browser extension

The browser extension reads the Plaud sign-in from the user's own browser and hands it to an OpenAudioHub connect page. It is the only sign-in path that works for Plaud accounts created with Google or Apple, because the long-lived Plaud token lives in an HttpOnly cookie that page scripts cannot read.

The extension is in `extension/`. It is built and released with the app. It runs in Chromium browsers and makes no network requests.

The connect page and the handoff endpoints are in [plaud.md](plaud.md). The desktop app that opens the page is in [desktop.md](desktop.md).

## Files and build

- `extension/package.json` holds the version. It matches the app version.
- `pnpm --dir extension build` writes the release build to `extension/dist/`. The build bundles the TypeScript sources with esbuild and copies the static files.
- `pnpm --dir extension zip` also writes `extension/dist-zip/OpenAudioHub_Extension_<version>.zip`. The manifest is at the root of the archive.
- `pnpm --dir extension build:test` writes a test build to `extension/dist-test/`. It is never released. See "Tests".
- Other scripts: `typecheck` runs `tsc --noEmit`, `test` runs the Vitest unit tests, `e2e` runs the Playwright tests.
- Each release attaches `OpenAudioHub_Extension_<version>.zip` and a copy named `OpenAudioHub_Extension.zip`. The copy is the download target on the connect page, at `https://github.com/JeremyL691/OpenAudioHub/releases/latest/download/OpenAudioHub_Extension.zip`, so it always resolves to the newest release. The extension version is the app version.

## Browser support

The extension targets Chrome, Edge and Brave, and other Chromium browsers, version 120 and later. Firefox and Safari are not supported.

## Manifest

The release manifest:

```json
{
  "manifest_version": 3,
  "name": "OpenAudioHub",
  "description": "Sends your Plaud sign-in from this browser to your OpenAudioHub server.",
  "version": "<app version>",
  "minimum_chrome_version": "120",
  "action": {
    "default_popup": "popup.html",
    "default_title": "OpenAudioHub",
    "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png" }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "background": { "service_worker": "worker.js", "type": "module" },
  "permissions": ["activeTab", "scripting", "cookies", "storage", "alarms"],
  "host_permissions": ["https://*.plaud.ai/*", "https://*.plaud.cn/*"]
}
```

The manifest has no `content_scripts`, `optional_host_permissions`, `tabs`, `webRequest`, `<all_urls>`, `externally_connectable` or `key`.

Permission purposes:

- `activeTab` and `scripting`: deliver the result to the page the user opened the popup on, and only that page.
- `cookies` with the Plaud host permissions: read the `pld_ut` cookie on the Plaud site.
- `storage`: remember the chosen Plaud site and the flow in progress.
- `alarms`: end a flow that times out.

The extension declares no static content script. It adds no object to a page's `window` and injects no script into the page's main world. It runs a small function on the page to deliver a result, and one on the Plaud page to read the local storage entry.

## Popup

The popup opens from the toolbar icon. It reads the active tab with `chrome.tabs.query({ active: true, currentWindow: true })`.

A tab is a connect page when all of these are true:

1. The URL scheme is `http:` or `https:`.
2. The pathname is exactly `/connect/plaud`.
3. The `code` query parameter is not empty.
4. The page has a `<meta name="openaudiohub-plaud-connect" content="1">` element.

The popup shows one of four states. The text below is used word for word. Test ids are in "Popup test ids".

**A. Not a connect page, and no flow in progress.** Title "OpenAudioHub". Text "To connect Plaud, open OpenAudioHub, go to Settings, then Plaud Account, and choose Sign in with Plaud. Then click this icon on the page that opens."

**B. A connect page, and no flow in progress.** Title "Connect Plaud". Text "Send your Plaud sign-in to this OpenAudioHub server?" The page origin is shown below in a monospace font. A select labelled "Plaud site" offers "Global (web.plaud.ai)" and "China (web.plaud.cn)". The default is Global. The choice is stored in `chrome.storage.local` under `plaudSite`, with value `global` or `cn`. The main button is "Connect". Supporting text: "If you are not signed in to Plaud in this browser, Plaud opens in a new tab." When the origin scheme is `http:` and the host is not `127.0.0.1`, `localhost` or `[::1]`, the popup also shows the warning "This server does not use HTTPS. Your Plaud sign-in will travel unencrypted."

**C. A flow in progress, whatever the current tab is.** Title "Waiting for Plaud". Text "Sign in to Plaud in the Plaud tab. OpenAudioHub gets your sign-in as soon as it is ready." The target origin is shown. The button is "Cancel".

**D. The result of the last flow.** The popup shows the result once, then removes it from storage. On success: "Sent to OpenAudioHub. Check the OpenAudioHub page for the result." On failure: the failure text for its reason, from "Failure messages". There is no button.

- "Connect" sends `{ "type": "start", "tabId": <id>, "origin": "<origin>", "site": "global" | "cn" }` to the service worker. The popup then closes itself.
- "Cancel" sends `{ "type": "cancel" }`.
- Changing the select saves `plaudSite` at once.

### Popup test ids

| Test id | Element | Value |
|---|---|---|
| `popup-state` | The popup container. It also carries `data-state` with this value. | `help`, `confirm`, `waiting` or `result` |
| `popup-origin` | The origin line | The page origin |
| `popup-site` | The site select | The selected site |
| `popup-connect` | The Connect button | |
| `popup-cancel` | The Cancel button | |

## Flow

A flow is one sign-in attempt for one connect page.

### Message source

The service worker accepts messages only from its own popup: `sender.id` is `chrome.runtime.id` and `sender.url` starts with `chrome.runtime.getURL("popup.html")`. It ignores every other message.

### State

The flow is kept in `chrome.storage.session` under `flow`:

```json
{ "tabId": 12, "origin": "http://127.0.0.1:38400", "site": "global", "startedAt": 1700000000000, "plaudTabId": 13 }
```

There is at most one flow at a time. `plaudTabId` is absent until the extension opens the Plaud tab.

### Start

1. If a flow exists, deliver `failed` with reason `replaced` to its page, ignore a delivery failure, and remove the flow.
2. Save the new flow. Create the `plaud-sign-in-timeout` alarm for five minutes from now.
3. Deliver `waiting` to the page. If delivery fails, end with `page-gone`.
4. Read the current cookie with `chrome.cookies.get({ url: <site URL>, name: "pld_ut" })`. If its value is acceptable, deliver `token` and end successfully. Do not open a Plaud tab.
5. Otherwise open `chrome.tabs.create({ url: <site URL>, active: true })` and store its id as `plaudTabId`.

The site URL is `https://web.plaud.ai/` for `global` and `https://web.plaud.cn/` for `cn`.

### Events

The service worker registers all listeners at the top level, so a restarted worker still receives them.

- `chrome.cookies.onChanged`: the cookie is not removed, its name is `pld_ut`, its domain belongs to the chosen site (ends in `plaud.ai` for `global`, ends in `plaud.cn` for `cn`), and a flow exists. If the value is acceptable, deliver `token` and end successfully. Otherwise keep waiting.
- `chrome.tabs.onUpdated`: when the tab is the flow's `plaudTabId` and either the status is `complete` or the URL changed, check the cookie again. Then read `localStorage.pld_tokenstr` from the Plaud page with `chrome.scripting.executeScript`. If either value is acceptable, deliver `token` and end successfully. When the tab is the flow's `tabId` and the URL changed, end with `page-gone`.
- `chrome.tabs.onRemoved`: when the flow's `tabId` closes, end with `page-gone`. When the flow's `plaudTabId` closes, remove `plaudTabId` and keep waiting.
- `chrome.alarms.onAlarm` for `plaud-sign-in-timeout`: deliver `failed` with reason `timeout` and end.
- A `cancel` message from the popup: deliver `failed` with reason `cancelled` and end.

### End

A successful end delivers the token, closes the Plaud tab when the extension opened it, focuses the connect tab with `chrome.tabs.update` and `chrome.windows.update`, removes the flow and the alarm, and stores `{ "ok": true }` under `lastResult` in `chrome.storage.session`.

A failed end removes the flow and the alarm and stores `{ "ok": false, "reason": "<reason>" }` under `lastResult`. It does not close the Plaud tab.

### Delivery

The extension delivers a message with `chrome.scripting.executeScript({ target: { tabId }, func, args: [message, origin] })`. The function runs in the page's isolated world and does this:

1. It requires `location.origin` to equal the flow's origin.
2. It requires the page's `openaudiohub-plaud-connect` meta element to have the value `1`.
3. It then calls `window.postMessage(message, origin)`.

When `executeScript` throws, the page is gone or the `activeTab` grant has expired. The end is `page-gone`.

## Token rules

The extension accepts a raw value from the `pld_ut` cookie or from `localStorage.pld_tokenstr`.

Cleaning, in order:

1. Trim the value.
2. When the value contains `%`, percent-decode it. A decoding failure makes the value unacceptable.
3. When the value is a JSON string in double quotes, parse it and take the inner string. A parse failure, or a value that is not a string, makes it unacceptable.
4. Remove a leading `bearer ` or `Bearer `, then trim again.

An acceptable token has all of these:

- Exactly three parts separated by dots. Each part contains only `A-Z`, `a-z`, `0-9`, `-` and `_`.
- The total length is more than 20 characters.
- The middle part base64url-decodes to a JSON object.
- The claims have no `ut_ref` and no `wid`. Those are workspace tokens, and the server refuses them.
- When the claims have `exp` in seconds, `exp * 1000` is later than the current time plus 60 seconds. A token without `exp` is accepted.

The API base comes from the `region` claim:

| `region` | API base |
|---|---|
| `aws:us-west-2` | `https://api.plaud.ai` |
| `aws:eu-central-1` | `https://api-euc1.plaud.ai` |
| `aws:ap-southeast-1` | `https://api-apse1.plaud.ai` |
| any other value, or none | `https://api.plaud.cn` for the China site, otherwise `https://api.plaud.ai` |

This table also appears in [desktop.md](desktop.md) section 10.3. The two copies change together.

The extension does not verify the token signature and does not call Plaud. The server validates the token during the handoff.

## Page messages

The extension sends messages to the connect page with `window.postMessage(data, origin)`:

```json
{ "app": "openaudiohub-extension", "protocol": 1, "kind": "waiting", "site": "global" }
```

```json
{ "app": "openaudiohub-extension", "protocol": 1, "kind": "token", "accessToken": "<token>", "apiBase": "https://api.plaud.ai" }
```

```json
{ "app": "openaudiohub-extension", "protocol": 1, "kind": "failed", "reason": "timeout" }
```

`reason` is `timeout`, `cancelled` or `replaced`. The page never sends a message to the extension.

### Failure messages

The popup and the connect page use these sentences. The connect page appends its retry line, described in [plaud.md](plaud.md).

| Reason | Text |
|---|---|
| `timeout` | "Plaud sign-in timed out after 5 minutes. Click the OpenAudioHub icon to try again." |
| `cancelled` | "Sign-in was cancelled. Click the OpenAudioHub icon to try again." |
| `replaced` | "Another Plaud sign-in started in this browser." |
| `page-gone` | "The OpenAudioHub page was closed or reloaded. Start again from that page." `page-gone` is shown only in the popup. |

## Privacy

- The token passes through memory only. It is never written to `chrome.storage`, a cookie, a log or `console`.
- The extension sends no `fetch` or `XMLHttpRequest` request. It reads only the Plaud cookie and local storage entry.
- The Plaud host permissions are used only for the cookie read and the local storage read. The `activeTab` grant is used only for the popup and delivery on the page the user chose.

## Tests

The extension has its own tests. They are not part of the contract suite.

- `extension/tests/unit/` holds Vitest unit tests. They cover token cleaning, shape and expiry checks, the region table, the connect page rule, the message shapes, and the release manifest permissions.
- `extension/tests/e2e/` holds Playwright tests. They load the test build in Chromium and run against a local server and the fake Plaud API.

The test build differs from the release build in three ways:

- The manifest adds `"http://127.0.0.1/*"` to `host_permissions`, so a test page on the local server has the permission that a real user click grants.
- The popup reads a `tab` query parameter and treats that tab as the active tab, so the tests can open it as an ordinary tab.
- The popup sends a `timeoutMs` value from its own query string, and a token's API base is always the test API base. The test build defines both values at compile time.

The release build has no test code. The unit tests check the release manifest, and a check of `extension/dist/` finds no test-only options or test identifiers.

## Tests of the connect page

The connect page requirements, including the meta element and the message checks, are in [plaud.md](plaud.md). The contract suite checks the page HTML and the message handling.
