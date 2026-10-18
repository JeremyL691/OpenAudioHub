# Encryption at rest

OpenAudioHub encrypts the sensitive text it keeps in its database, using one key that you control. This page lists what is encrypted, what is not, and how to keep the key safe.

- [The key](#the-key)
- [What is encrypted](#what-is-encrypted)
- [What is not encrypted](#what-is-not-encrypted)
- [How values are stored](#how-values-are-stored)
- [Passwords and tokens](#passwords-and-tokens)
- [What this protects against](#what-this-protects-against)
- [What this does not protect against](#what-this-does-not-protect-against)

## The key

The key is `ENCRYPTION_KEY`. It is 32 random bytes, written as 64 hex characters. Create one with:

```sh
openssl rand -hex 32
```

- On a self-hosted server, the key is in `.env`. Keep a copy somewhere safe, apart from the backups.
- On the Mac app, the key is in `secrets.json` in the data folder. Use **Export Keys…** in the menu bar to save a copy. See [Keep a copy of your keys](desktop.md#keep-a-copy-of-your-keys).

Do not change the key after you have data. Values written with one key cannot be read with another. There is no tool to change the key or to re-encrypt existing data. If the key is lost, the encrypted fields cannot be recovered.

## What is encrypted

| Data | Where it is kept |
|---|---|
| Recording titles, including titles from Plaud | The recording row |
| Transcripts, including Plaud transcripts you import | The transcript rows |
| Summaries, action items and key points | The summary row |
| AI provider API keys | The provider rows |
| The Plaud account token | The Plaud connection |
| Summary prompts and the title prompt you wrote | Your settings |
| The Bark push URL | Your settings |
| Webhook URLs and signing secrets | The webhook rows |
| Webhook delivery payloads | The delivery rows |

Each value is encrypted on its own. The API returns decrypted values when you are signed in, and to requests that use your API keys.

## What is not encrypted

- **Audio files.** They are plain files on disk, or plain objects in your bucket. Protect the folder or the bucket. See [S3-compatible storage](storage-s3.md#encryption).
- **Other fields.** Recording IDs, dates, durations, file sizes, device serial numbers and models, the names of the events, your email address and your name.
- **Your settings that are not listed above**, such as theme, sync interval and list density.
- **Full backup zips.** A zip has the decrypted titles, transcripts and summaries. See [Backup and restore](backup-and-restore.md#full-backup-zip).
- **Transcript exports.** They are plain text too.

## How values are stored

Each encrypted value uses AES-256-GCM with the key. The stored form is:

```
v1:<16-byte IV, hex>:<authentication tag, hex>:<ciphertext, hex>
```

A new random IV is made for every value. Structured values, such as action items and key points, are stored as a small JSON wrapper that holds one encrypted string.

Values without the `v1:` prefix are read as they are, so plain values still load. A value that starts with `v1:` but does not match the format is an error.

## Passwords and tokens

These are not encrypted with the key. They are stored in a form that cannot be turned back into the original:

- **Account passwords** are hashed with Argon2id.
- **Sign-in sessions** are stored as SHA-256 hashes. The cookie holds the secret.
- **Password reset links** are stored as SHA-256 hashes, and they expire after 1 hour.
- **Personal API keys** are stored as HMAC-SHA256 hashes, keyed with `API_TOKEN_HASH_SECRET`. That secret is derived from `ENCRYPTION_KEY` unless you set it. See [Environment variables](environment-variables.md#required-and-common).

## What this protects against

Encryption of the fields helps when the database is copied or read without the key:

- A stolen copy of the database file or of a database backup.
- Read access to the database, without access to the server that holds the key.
- A bug or an attacker that can read the database, but cannot run code on the server.
- An operator who can query the database but does not have the key.

## What this does not protect against

- **Someone who has the key and the database.** Keep the key apart from the data.
- **Someone who controls the running server.** The server must decrypt values to use them, so anyone who can run code on it can read them.
- **Audio, metadata and plain zip files.** See [What is not encrypted](#what-is-not-encrypted).
- **Losing the key.** There is no recovery. Keep a copy of `ENCRYPTION_KEY`.
