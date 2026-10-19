# S3-compatible storage

By default, audio files are stored in a folder on the server's disk. You can store them in an S3-compatible bucket instead. This works with AWS S3 and with other services and servers that speak the S3 API, such as Cloudflare R2, MinIO, Backblaze B2 and DigitalOcean Spaces.

The Mac app always stores audio on disk. This page is for the self-hosted server.

- [Configure S3](#configure-s3)
- [Examples](#examples)
- [Which recordings use S3](#which-recordings-use-s3)
- [How audio is read](#how-audio-is-read)
- [Encryption](#encryption)
- [Moving from local storage](#moving-from-local-storage)

## Configure S3

Set these variables in `.env` and in `compose.yml`. See [The compose file](self-hosting.md#the-compose-file).

| Variable | Required | Meaning |
|---|---|---|
| `DEFAULT_STORAGE_TYPE` | Yes | Set to `s3`. New audio goes to the bucket. |
| `S3_BUCKET` | Yes | The bucket name. Create the bucket first. The server does not create it. |
| `S3_REGION` | Yes | The region name that your service expects. Some services use a fixed value, such as `auto`. |
| `S3_ACCESS_KEY_ID` | Yes | The access key ID for the bucket. |
| `S3_SECRET_ACCESS_KEY` | Yes | The secret access key for the bucket. |
| `S3_ENDPOINT` | For non-AWS services | The API address of the service, for example `https://s3.example.com`. Leave it empty for AWS S3. |

Use a key that can read, write and delete objects in that one bucket. You do not need account-wide rights.

The server uses path-style addresses, so the bucket name goes in the path, not in the host name. Most S3-compatible services work with that.

Restart the server after you change these values. A wrong `DEFAULT_STORAGE_TYPE` stops the server at startup. The server does not test the bucket when it starts, so check it with one recording: upload a file, or sync a recording, then play it.

## Examples

These are typical values. Check your provider's documentation for the exact endpoint and region.

**AWS S3**

```sh
DEFAULT_STORAGE_TYPE=s3
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=YOUR_KEY
S3_SECRET_ACCESS_KEY=YOUR_SECRET
```

Leave `S3_ENDPOINT` empty for AWS.

**Cloudflare R2**

```sh
DEFAULT_STORAGE_TYPE=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=openaudiohub
S3_REGION=auto
S3_ACCESS_KEY_ID=YOUR_KEY
S3_SECRET_ACCESS_KEY=YOUR_SECRET
```

**MinIO** (running on the same Docker network)

```sh
DEFAULT_STORAGE_TYPE=s3
S3_ENDPOINT=http://minio:9000
S3_BUCKET=openaudiohub
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=YOUR_KEY
S3_SECRET_ACCESS_KEY=YOUR_SECRET
```

**Backblaze B2**

```sh
DEFAULT_STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.<region>.backblazeb2.com
S3_BUCKET=your-bucket-name
S3_REGION=<region>
S3_ACCESS_KEY_ID=YOUR_KEY
S3_SECRET_ACCESS_KEY=YOUR_SECRET
```

## Which recordings use S3

Each recording remembers where its audio was saved. The setting changes only where new audio goes:

- New uploads and newly synced recordings go to the bucket.
- Recordings saved on disk stay on disk, and they keep working.
- Recordings saved in the bucket keep working as long as the S3 settings are present.

If you switch back to `local`, keep the S3 settings in place while any recording is still stored in the bucket.

## How audio is read

- **In the app.** Audio streams through the server, so the player can seek. The server asks the bucket only for the part you need.
- **Through the public API.** The audio route answers with a redirect to a link that the bucket signs. The link works for 5 minutes. See [Public API](public-api.md#recording-audio).
- **Processing and zip files.** When a step needs a local file, such as the audio pipeline or a bulk download zip, the server copies the object to a temporary file on its disk and removes the copy afterwards. Make sure the server disk has room for the longest recording.

Deleting a recording in OpenAudioHub deletes its audio object in the bucket.

## Encryption

OpenAudioHub does not encrypt audio files, on disk or in the bucket. If you need encryption at rest for audio, turn on the encryption your service offers for the bucket. See [Encryption at rest](encryption-at-rest.md).

## Moving from local storage

There is no tool that moves existing audio into the bucket. Recordings saved on disk stay on disk. Turning on S3 only affects new audio. If you need the old files in the bucket, copy them yourself, but the server will keep reading those recordings from disk, because each recording's storage is recorded in the database.
