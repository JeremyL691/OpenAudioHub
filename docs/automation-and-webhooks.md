# Automation API and webhooks

Two features let other tools work with your library:

- **Personal API keys** give a script or app read access to your recordings through the [public API](public-api.md).
- **Webhooks** send a signed message to a URL you choose when something happens, such as a new recording or a finished transcript.

Both are managed through the server API. The examples below use `curl` with a signed-in session cookie.

- [Personal API keys](#personal-api-keys)
- [Webhooks](#webhooks)
- [Events](#events)
- [The payload](#the-payload)
- [Delivery headers](#delivery-headers)
- [Verify a signature](#verify-a-signature)
- [Retries and redelivery](#retries-and-redelivery)
- [Allowed URLs](#allowed-urls)

## Personal API keys

Key management uses the session cookie from a normal sign-in. Sign in once and save the cookie to a file:

```sh
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}' \
  "https://audio.example.com/api/auth/sign-in/email"
```

Create a key with `POST`. `name` is required and can be up to 120 characters, for example the tool that will use it. `expiresAt` is optional: give an ISO 8601 timestamp in the future, or leave it out (or send `null`) for no expiry.

```sh
curl -b cookies.txt -H "Content-Type: application/json" \
  -d '{"name":"Standup script","expiresAt":"2027-01-01T00:00:00.000Z"}' \
  "https://audio.example.com/api/settings/api-keys"
```

The response has status `201`. The full key is in the `key` field, and the key's details are in `apiKey`. The key starts with `oah_` and appears only in this response. The server keeps only a keyed hash, so copy it now. If you lose it, create a new key.

List your keys with `GET`. Revoked keys stay in the list:

```sh
curl -b cookies.txt "https://audio.example.com/api/settings/api-keys"
```

Revoke a key with `DELETE`, using its `id` from the list:

```sh
curl -b cookies.txt -X DELETE "https://audio.example.com/api/settings/api-keys/<id>"
```

Send the key as a Bearer token:

```sh
curl -H "Authorization: Bearer oah_..." \
  "https://audio.example.com/api/v1/recordings?limit=20"
```

Each key is read-only. It can list and read recordings, transcripts and audio, and nothing else. Every item in the key list response shows the key's `keyPrefix` (its first 12 characters), `lastUsedAt`, `expiresAt` and `revokedAt`. A key revoked with `DELETE` stops working at once, and it cannot be used again. Its entry stays in the list with `revokedAt` set.

## Webhooks

Endpoints live under `/api/settings/webhooks`. Every call uses the session cookie from the sign-in above. API keys are not accepted on these routes.

Create an endpoint with `POST`:

- `url` (required) must use `http` or `https`, and must not contain a user name or password.
- `events` (required) is a list of one or more event names from the [Events](#events) table below.
- `description` (optional) can be up to 200 characters.
- `enabled` (optional) defaults to `true`.

```sh
curl -b cookies.txt -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.example.com/openaudiohub","events":["recording.updated","transcription.completed"],"description":"Automation"}' \
  "https://audio.example.com/api/settings/webhooks"
```

The response has status `201`. The signing secret is in the top-level `secret` field, and it starts with `whsec_`. The server returns it only in this response. Copy it into your receiving tool now. Later reads show only the masked form, `whsec_****` followed by the last four characters.

List your endpoints with `GET`. Each one shows its masked secret, `lastDeliveryAt` and `lastDeliveryStatus`. The response also lists every event name the server supports.

```sh
curl -b cookies.txt "https://audio.example.com/api/settings/webhooks"
```

Update an endpoint with `PATCH`. You can send any of `url`, `events`, `description` and `enabled`. Fields you leave out stay as they are. A new `events` list replaces the old one. The secret cannot be changed. To rotate it, delete the endpoint and create a new one.

```sh
curl -b cookies.txt -X PATCH -H "Content-Type: application/json" \
  -d '{"enabled":false}' \
  "https://audio.example.com/api/settings/webhooks/<id>"
```

Delete an endpoint with `DELETE`:

```sh
curl -b cookies.txt -X DELETE "https://audio.example.com/api/settings/webhooks/<id>"
```

Setting `enabled` to `false` pauses an endpoint. Its deliveries wait until you set it back to `true`. Deleting an endpoint stops everything, and its delivery history is removed with it.

## Events

| Event | When it fires |
|---|---|
| `recording.synced` | A sync from Plaud adds a new recording. |
| `recording.updated` | A recording is renamed, or a sync changes an existing recording. |
| `recording.deleted` | You delete a recording. |
| `transcription.completed` | A transcript is saved. |
| `transcription.failed` | A transcription gives up after its attempts. |
| `summary.completed` | An automatic or requested summary is saved. |
| `summary.failed` | A summary fails. For example, the automatic summary limit for the hour was reached. The transcript is kept. |

Each endpoint receives only the events it subscribed to. Events are sent only for the account that owns the recording.

## The payload

Each delivery is a `POST` with a JSON body. The body has the event name, the delivery time, and the recording:

```json
{
  "event": "transcription.completed",
  "delivered_at": "2026-10-16T18:55:40.451Z",
  "data": {
    "id": "rec_123",
    "title": "Team standup",
    "created_at": "2026-10-16T18:00:00.000Z",
    "updated_at": "2026-10-16T18:55:40.000Z",
    "recorded_at": "2026-10-16T17:30:00.000Z",
    "duration_ms": 1820000,
    "filesize_bytes": 1234567,
    "device": { "serial_number": "ABC123", "name": "My recorder", "model": "Plaud Note" },
    "has_transcription": true,
    "has_summary": false,
    "links": {
      "self": "https://audio.example.com/api/v1/recordings/rec_123",
      "transcript": "https://audio.example.com/api/v1/recordings/rec_123/transcript",
      "audio": "https://audio.example.com/api/v1/recordings/rec_123/audio"
    },
    "transcript": {
      "source": "openaudiohub",
      "preview": "The first 500 characters of the transcript.",
      "truncated": true,
      "length": 9120,
      "language": "en",
      "provider": "OpenAI",
      "model": "whisper-1",
      "created_at": "2026-10-16T18:55:40.000Z"
    },
    "summary": null,
    "api_url": "https://audio.example.com/api/v1/recordings/rec_123"
  }
}
```

Notes on the body:

- `transcript` holds a preview of up to 500 characters. Use `links.transcript` to get the full text, with your API key.
- `summary` holds the summary text, action items and key points, or `null`.
- A failed event adds an `error` object with a `message`.
- A `recording.deleted` payload has no transcript or summary, and it has a `deleted_at` time.
- `data` is built when each delivery is sent. A retry sends the recording as it is at that time.

## Delivery headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `OpenAudioHub-Webhooks/1` |
| `X-OpenAudioHub-Event` | The event name, for example `recording.synced`. |
| `X-OpenAudioHub-Delivery` | The delivery ID. The same ID is used for every retry of one delivery, so use it to ignore duplicates. |
| `X-OpenAudioHub-Timestamp` | The send time in Unix seconds. |
| `X-OpenAudioHub-Signature` | A hex HMAC-SHA256 of the timestamp, a dot, and the raw body, made with the webhook secret. |

The signature header holds only the hex digest. It has no `sha256=` prefix.

## Verify a signature

Check the signature before you trust a delivery. Use the raw request body, not a parsed copy of it. Node.js example:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, timestamp, signature, rawBody, toleranceSeconds = 300) {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Call it with the `X-OpenAudioHub-Timestamp` and `X-OpenAudioHub-Signature` headers. The five-minute window stops replays of old deliveries.

## Retries and redelivery

A delivery counts as successful when your server answers with a `2xx` status. Redirects are not followed, so a `3xx` answer counts as a failure. The server waits up to 10 seconds for an answer. When the server runs with `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true`, it also keeps the first 4096 characters of the response body for the log.

A failed delivery is retried. The waits are:

| After attempt | Next try in |
|---|---|
| 1 | 30 seconds |
| 2 | 2 minutes |
| 3 | 10 minutes |
| 4 | 1 hour |
| 5 | 6 hours |

After six failed attempts the delivery is marked as failed and is not tried again. A delivery also fails at once when its recording no longer exists.

List an endpoint's most recent 100 deliveries, newest first:

```sh
curl -b cookies.txt "https://audio.example.com/api/settings/webhooks/<id>/deliveries"
```

Each delivery shows its `status` (`pending`, `processing`, `success` or `dead`), its `attempts`, `lastResponseStatus` and `lastError`.

To send a delivery again right away, use its `id` from that list. This works for any delivery except one that is being sent at the moment. The request returns `409` if the endpoint is disabled or the delivery is already processing.

```sh
curl -b cookies.txt -X POST \
  "https://audio.example.com/api/settings/webhooks/<id>/deliveries/<deliveryId>/redeliver"
```

## Allowed URLs

By default, the server accepts any `http` or `https` URL with no credentials. The receiving host can be on your private network, which is useful for tools running at home.

If you run a server that other people can use, turn on `WEBHOOKS_REQUIRE_PUBLIC_TARGETS=true`. The server then accepts only `https` URLs whose host resolves only to public IP addresses. It refuses `localhost`, names ending in `.local`, `.internal`, `.home.arpa` and `.lan`, and private or loopback addresses. The server connects to the address it checked, so the answer cannot change between the check and the send. See [Environment variables](environment-variables.md#webhooks).
