# Performance

This page records how long the server takes to process a long recording, what memory it uses,
and how to measure the same numbers on your own machine. Measured numbers depend on the
machine, so treat them as a reference point rather than a promise.

- [How to measure](#how-to-measure)
- [Reference numbers](#reference-numbers)
- [What the numbers mean](#what-the-numbers-mean)
- [Cost](#cost)

## How to measure

`tools/bench/pipeline.sh` builds a speech recording, runs it through the whole pipeline
against a local provider, and prints one row per length:

```sh
tools/bench/pipeline.sh 1 6
```

It needs `ffmpeg`, `espeak-ng`, `openssl` and `curl`. Everything it creates stays in
`.dev-artifacts/bench/` and it uses ports 3290 and 3291, so it never touches the data of the
app you are running.

The provider is a local fake that answers at once. That is deliberate: the measurement is
the server's own work, which is decoding, speech detection, splitting, merging and saving.
The network and the provider's own time are on top of that, and depend entirely on the
provider you configure.

Rows are:

| Column | What it measures |
|---|---|
| Decode and speech detection | Reading the upload, decoding it to 16 kHz mono, and running the speech detection model. |
| Transcribe and merge | Sending every chunk, waiting for the answers, merging them and saving the transcript. |
| Total | Wall time from starting the run to the transcript being stored. |
| Peak memory | The highest resident memory the server process reached, from the moment the server started. |
| Work folder | The largest size the job's work folder reached, sampled while it ran. It is removed when the job finishes. |

Memory and disk are sampled, so a spike shorter than one sampling interval (one second) can
be missed.

## Reference numbers

Apple M3 Pro, 18 GB, macOS. Opus input at 24 kbit/s, which is what a Plaud recording looks
like. The provider answered immediately.

| Length | Decode and speech detection | Transcribe and merge | Total | Peak memory | Work folder |
|---|---|---|---|---|---|
| 1 h | 12 s | 1 s | 13 s | 94 MB | 113 MB |
| 6 h | 66 s | 7 s | 73 s | 119 MB | 673 MB |

The work folder is dominated by the decoded audio: 16 kHz mono signed 16-bit is 32 kB per
second, so one hour of audio is about 113 MB and six hours about 673 MB. That is why the
pipeline checks free space before it decodes, and pauses the job with `paused_disk` instead
of running out; it wants the decoded size plus 64 MiB free before it starts, and plus 512 MiB
before it resumes ([audio pipeline](../spec/audio-pipeline.md) section 7).

A twenty-four-hour recording is the supported maximum. It needs about 2.7 GB of free disk for
the decoded audio, plus the source file and the 64 MiB the decode reserve asks for, and it
takes roughly five minutes at the speed above.

## What the numbers mean

- A long recording is processed much faster than real time even on one machine, so a queue of
  hourly recordings drains quickly. A forced re-run waits for the running job to reach its
  next cancel checkpoint, because one pipeline job runs at a time.
- Memory stays flat as the recording grows, because decoding and speech detection stream the
  audio instead of holding it. The transcript of a very long recording is held in memory to
  be merged and saved, which is the part that grows with length.
- Disk, not speed, is the limit to watch on a small server. Decide how much free space you
  want to keep and set the volume size from that.

## Library and search

`tools/bench/library.mjs` measures the two routes a large library leans on. It starts a
throwaway server, seeds it with a mix of short notes, meeting transcripts and a few long
recordings through the API, then reports the p50 and p95 of both after a warm up:

```sh
node tools/bench/library.mjs 5000
```

Rows are:

| Column | What it measures |
|---|---|
| List p50, p95 | `GET /api/recordings`, which carries every row and the status of the recordings a job is running for. |
| List KiB | The size of that answer, which is what a browser parses on every reload. |
| Search p50, p95 | `GET /api/recordings/search?q=`, one request for the whole library. |
| Status | The status that route answered, so a failing run is not read as a fast one. |
| Peak MiB | The highest resident memory the server reached. It reads this from `/proc`, so it is `n/a` on macOS. |

The transcript search decrypts each stored text for the length of the request. That is why the
cost grows with the number of transcribed recordings rather than staying flat: there is no
plaintext index, which is the trade the encryption makes. The numbers say when that trade needs
revisiting.

The list has no paging. Its answer grew with the library until the point where the response and
the browser's parse of it became the limit; the table above is where to look for that.

## Cost

Provider prices change and vary by model, so this page does not list them. To estimate the
cost of one recording, take the price per minute of audio from your provider and multiply it
by the length of the recording. Nothing in the pipeline adds a multiplier: the audio is sent
once for each chunk, and chunk boundaries overlap by at most the padding the speech detection
adds, which is 250 ms on each side of a span.
