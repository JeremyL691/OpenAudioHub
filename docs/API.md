# API reference

This page summarizes the public API. The complete reference, with request and response examples, is in [content/docs/reference/public-api.mdx](../content/docs/reference/public-api.mdx). The same page is served in the app at `/docs/reference/public-api`.

## Base URL

```
https://<your-openaudiohub-host>/api/v1
```

The host is the `APP_URL` you configured.

## Authentication

Send a personal API key as a Bearer token:

```http
Authorization: Bearer oah_...
```

Keys start with `oah_` and are 38 characters long. Keys created before 1.0.0 start with `op_` and still work. Keys are read-only. Create them under **Settings → Integrations → API Keys**. The key is shown once, and the database stores only its HMAC-SHA256 hash, keyed by `API_TOKEN_HASH_SECRET`, or by `BETTER_AUTH_SECRET` when that is unset.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /v1/recordings` | List recordings with cursor pagination. Filters: `limit`, `cursor`, `created_since`, `updated_since`, `has_transcription`. |
| `GET /v1/recordings/{id}` | One recording, with `transcript` and `summary` inline when they exist |
| `GET /v1/recordings/{id}/transcript` | The transcript text and provider metadata. `404` when there is no transcript yet. |
| `GET /v1/recordings/{id}/audio` | The audio. A `302` redirect to a pre-signed URL on S3, or streamed bytes with range support on local storage. |

There are no write endpoints.

Internal routes under `/api/*` serve the web interface. They are not a stable contract.

## Rate limits

- 1,200 requests per minute per client IP.
- 600 requests per minute per API key or signed-in session.

A limited request returns `429` with `Retry-After` and `X-RateLimit-*` headers. Forwarding headers are ignored unless `RATE_LIMIT_TRUST_PROXY_HEADERS=true`. Enable that only behind a proxy that overwrites them.

## Errors

Errors use the envelope `{ "error", "code", "details" }`. Branch on `code`. The full list is in [error-codes.md](error-codes.md).

## Webhooks

Webhooks are configured under **Settings → Integrations → Webhooks**. Each delivery is a `POST` with these headers:

```http
X-OpenAudioHub-Event: transcription.completed
X-OpenAudioHub-Delivery: <delivery-id>
X-OpenAudioHub-Timestamp: 1778078610
X-OpenAudioHub-Signature: t=1778078610,v1=<hex hmac>
User-Agent: OpenAudioHub-Webhooks/1
```

The signature is HMAC-SHA256 over `<timestamp>.<raw body>`, using the endpoint's `whsec_` secret. Reject deliveries whose timestamp is more than five minutes off, and compare signatures in constant time.

Events: `recording.synced`, `recording.updated`, `recording.deleted`, `transcription.completed`, `transcription.failed`, `summary.completed`, and `summary.failed`.

A delivery that fails is retried after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours. After six failed attempts it is marked dead.

Target validation is controlled by `WEBHOOKS_REQUIRE_PUBLIC_TARGETS`. When it is `true`, URLs must use HTTPS, must not embed credentials, and must resolve to public addresses. The [automation guide](../content/docs/guides/automation-and-webhooks.mdx) has a verification example.
