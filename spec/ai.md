# AI: providers, summaries, titles, and prompts

This file covers how a user connects AI providers, and how summaries and titles are made: the endpoints, the provider and model choice, the prompts, and the output. Transcription itself is in `transcription.md`. Every endpoint here needs a signed-in session. Error bodies use the shape described in `auth.md` (see [Error shape](auth.md#error-shape)).

## Concepts

- **Provider**: a saved connection to an AI service. It has a `provider` name (a preset name or any other name), an API key, an optional base URL, an optional default model, and two flags: transcription default and enhancement default.
- **Enhancement**: the AI step that writes a summary. Titles use the same provider.
- **Transcription default**: at most one provider per user. Transcription uses it unless a request names another provider (see `transcription.md`).
- **Enhancement default**: at most one provider per user. Summaries and titles use it when it can enhance. Otherwise they use the first provider that can enhance, oldest first.

## Provider presets

A preset is a built-in definition. A provider whose `provider` name equals a preset name gets that preset's base URL, default model and capabilities. Any other name is accepted. Such a provider can transcribe and enhance, has no default base URL, and uses the OpenAI default base URL `https://api.openai.com/v1` only where a base URL is needed and none is stored.

| Name | Default base URL | Default model | Transcription | Enhancement | Notes |
| --- | --- | --- | --- | --- | --- |
| `Google Gemini` | Google Generative Language API (fixed) | `gemini-2.0-flash` | yes, native audio | yes, native API | Stored base URL is ignored. Model list is fixed (see [Model list](#post-apisettingsaiprovidersmodels)). |
| `ElevenLabs` | `https://api.elevenlabs.io/v1` | `scribe_v2` | yes, Scribe | no | Model list is fixed: `scribe_v2`, `scribe_v1`. |
| `OpenAI` | `https://api.openai.com/v1` | `whisper-1` | yes | yes | |
| `Groq` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | yes | yes | |
| `Together AI` | `https://api.together.xyz/v1` | `openai/whisper-large-v3` | yes | yes | |
| `OpenRouter` | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash-lite` | yes, through chat completions with the audio attached | yes | Model list is filtered to audio input models. |
| `SiliconFlow (China)` | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | yes | yes | Chat model `Qwen/Qwen2.5-7B-Instruct`. Chat model list available. |
| `OpenCode Go` | `https://opencode.ai/zen/go/v1` | `deepseek-v4.1-flash` | no | yes | Chat model list available. Every request carries the header `x-opencode-session`, from `OPENCODE_GO_SESSION_ID` or the value `openaudiohub`. |
| `LM Studio` | `http://localhost:1234/v1` | none | yes | yes | |
| `Ollama` | `http://localhost:11434/v1` | none | yes | yes | |
| `Custom` | none | none | yes | yes | The base URL must be set in practice. |

"None" means the preset has no default: the caller must supply the value, or the request fails.

Other rules that apply to every provider:

- The API key is required when a provider is created, including for local providers such as Ollama.
- Only `ElevenLabs` cannot enhance. Only `OpenCode Go` cannot transcribe. Names that are not presets can do both.
- A transcription model is recognised by name, case-insensitively: the name contains `whisper`, `asr`, `sensevoice`, `telespeech`, `transcribe`, `scribe`, `parakeet`, or `speech`.

## Keys and masking

- API keys are stored encrypted. No endpoint returns a key, in full or masked. Provider objects have no key field.
- Error text from the test endpoint has the key replaced by `***` before it is returned.
- The models endpoint uses the key only for its single upstream call and does not store it. Its errors do not include provider text.

---

## Provider endpoints

### GET /api/settings/ai/providers

Auth: session.

Response: `200 OK`

```json
{
  "providers": [
    {
      "id": "prov_1",
      "provider": "Custom",
      "baseUrl": "https://ai.example.test/v1",
      "defaultModel": "chat-model",
      "isDefaultTranscription": true,
      "isDefaultEnhancement": false,
      "createdAt": "2026-10-16T10:00:00.000Z"
    }
  ]
}
```

- Lists only the caller's providers, oldest first (by creation time, then id).
- `baseUrl` and `defaultModel` are `null` when not set.

Side effects: none.

### POST /api/settings/ai/providers

Auth: session.

Request body (JSON):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | string | yes | A preset name or any other name. |
| `apiKey` | string | yes | Non-empty. Stored encrypted. |
| `baseUrl` | string | no | Empty or missing means none stored. |
| `defaultModel` | string | no | Empty or missing means none stored. |
| `isDefaultTranscription` | boolean | no | Default `false`. |
| `isDefaultEnhancement` | boolean | no | Default `false`. |

Response: `200 OK` (not `201`). The response never includes the key.

```json
{
  "provider": {
    "id": "prov_1",
    "provider": "Custom",
    "baseUrl": "https://ai.example.test/v1",
    "defaultModel": "chat-model",
    "isDefaultTranscription": true,
    "isDefaultEnhancement": true,
    "createdAt": "2026-10-16T10:00:00.000Z"
  }
}
```

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_REQUIRED_FIELD` | `provider` or `apiKey` is missing or blank. `details.field` names it. |
| 400 | `INVALID_INPUT` | `isDefaultEnhancement` is true and the provider cannot enhance (ElevenLabs). `details.field` is `isDefaultEnhancement`. |
| 400 | `INVALID_INPUT` | `isDefaultTranscription` is true and the provider is a preset that cannot transcribe (OpenCode Go). `details.field` is `isDefaultTranscription`. |
| 400 | `INVALID_INPUT` | `provider` is `ElevenLabs` and `baseUrl` is not an `http` or `https` URL without credentials. `details.field` is `baseUrl`. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects:

- One provider row is created for the caller.
- If `isDefaultTranscription` is true, the caller's previous transcription default loses the flag.
- If `isDefaultEnhancement` is true, the caller's previous enhancement default loses the flag.

### PUT /api/settings/ai/providers/{id}

Auth: session. `id` must be one of the caller's providers.

Request body (JSON): `baseUrl`, `defaultModel`, `isDefaultTranscription`, `isDefaultEnhancement`, and `apiKey`. `provider` in the body is ignored. The provider name of a stored row cannot change.

- `baseUrl`, `defaultModel` and the two flags replace the stored values. Missing `baseUrl` or `defaultModel` becomes none. Missing flags become `false`.
- A non-empty `apiKey` replaces the stored key. A missing or blank `apiKey` keeps the stored key.

Response: `200 OK` with `{ "success": true }`.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 404 | `NOT_FOUND` | No provider with this id for the caller. Message `Provider not found`. |
| 400 | `INVALID_INPUT` | The same `details.field` cases as create, judged on the stored provider name. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects:

- The row is updated. Its `createdAt` does not change.
- If `isDefaultTranscription` is true, the row becomes the transcription default and the previous default loses the flag.
- If `isDefaultEnhancement` is true, the row becomes the enhancement default and the previous default loses the flag.

### DELETE /api/settings/ai/providers/{id}

Auth: session.

Response: `200 OK` with `{ "success": true }`.

- Deletes only the caller's row. An unknown id, or an id of another user, also answers `200` and changes nothing.
- If the deleted row was the transcription default, the caller has no transcription default afterwards.
- Summaries keep the provider name they were made with.

### PUT /api/settings/ai/providers/default-transcription

Auth: session.

Request body (JSON): `{ "providerId": "prov_1" }`. `providerId` must be a non-empty string.

Response: `200 OK` with `{ "success": true }`. The provider becomes the caller's transcription default, and the previous default loses the flag.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | `providerId` is missing or empty. `details.issues` lists the problem. Message `Invalid request body`. |
| 404 | `NOT_FOUND` | No provider with this id for the caller. |
| 400 | `INVALID_INPUT` | The provider cannot transcribe (OpenCode Go). `details.field` is `isDefaultTranscription`. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

### POST /api/settings/ai/providers/test

Tests a connection with one small upstream call. Nothing is saved.

Auth: session.

Request body (JSON):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | A saved provider of the caller. Its stored values are the defaults for the other fields. |
| `provider` | string | Preset or other name. Taken from the saved row when empty. |
| `apiKey` | string | Required unless `id` is given. Used instead of the stored key when non-empty. |
| `baseUrl` | string | Taken from the saved row, then the preset, when empty. |
| `model` | string | Taken from the saved row, then the preset, when empty. |

Behaviour:

- With `id`, the stored key is used unless `apiKey` is non-empty. Non-empty body values override the stored ones.
- If no model is found, the answer is `{ "ok": false, "kind": "chat", "error": "No model is set." }`.
- The kind is `transcription` when the provider cannot enhance, when the model is a transcription model, or when the model is in the Google Gemini audio list. Otherwise it is `chat`.
- A transcription probe sends one second of silent MP3 (38 frames of 417 bytes). A chat probe sends `Reply with OK.` with a 16-token output limit.
- Upstream routes: Google Gemini uses its native `generateContent` API. ElevenLabs uses `POST {base}/speech-to-text`. Other transcription models use `POST {base}/audio/transcriptions`. Other chat models use `POST {base}/chat/completions`.
- The upstream call has a 20-second timeout.

Response: `200 OK` in every case where the request itself was valid. Upstream failures are reported in the body.

```json
{ "ok": true, "kind": "chat", "latencyMs": 412 }
```

```json
{ "ok": false, "kind": "chat", "error": "Connection error." }
```

`error` is one of these texts, with the key removed and at most 300 characters:

| Situation | Text |
| --- | --- |
| Timeout | `The provider did not answer in time.` |
| Network failure | `Connection error.` |
| HTTP 401 or 403 | `The provider rejected the API key.` |
| Any other HTTP error | `The provider answered with HTTP <code>.` |

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_REQUIRED_FIELD` | Neither `apiKey` nor `id` is given (`details.field` is `apiKey`), or no provider name is found (`details.field` is `provider`). |
| 400 | `INVALID_INPUT` | The base URL for ElevenLabs is invalid. |
| 404 | `NOT_FOUND` | `id` is not one of the caller's providers. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: none.

### POST /api/settings/ai/providers/models

Lists models for a picker. Nothing is saved.

Auth: session.

Request body (JSON):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | string | yes | |
| `apiKey` | string | yes | Used for one upstream call. |
| `baseUrl` | string | no | Defaults to the preset base URL, then `https://api.openai.com/v1`. |
| `kind` | `"audio"` or `"chat"` | no | Any value other than `"chat"` means `"audio"`. |

Response: `200 OK` with `{ "models": [ { "id": "model-id", "name": "Model name" } ] }`.

Rules:

- `audio` on `Google Gemini` returns the fixed list `gemini-2.0-flash`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-1.5-flash`, `gemini-1.5-pro`. No upstream call.
- `audio` on `ElevenLabs` returns the fixed list `scribe_v2`, `scribe_v1`. No upstream call.
- `chat` on `Google Gemini` returns an empty list. No upstream call.
- `audio` on `OpenRouter` lists `{baseUrl}/models`, keeps the models whose `architecture.input_modalities` includes `audio`, and sorts them by name, then id. `name` is the model name, or the id when there is none.
- `chat` on a preset that lists chat models (`SiliconFlow (China)`, `OpenCode Go`) lists `{baseUrl}/models`, removes ids containing `embed`, `rerank` or `tts` (case-insensitive), sorts by id, and sets `name` to the id.
- Other combinations, including any custom provider name, return `{ "models": [] }` without an upstream call.
- The upstream call has a 10-second timeout.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_REQUIRED_FIELD` | `provider` or `apiKey` is missing or blank. |
| 400 | `INVALID_INPUT` | The base URL for ElevenLabs is invalid. |
| 401 | `AI_PROVIDER_API_ERROR` | The provider answers HTTP 401 or 403. Message `The provider rejected the API key.` |
| 502 | `AI_PROVIDER_API_ERROR` | The provider answers another error, or cannot be reached (`The provider returned an error.` / `The provider could not be reached.`). |
| 502 | `AI_PROVIDER_API_ERROR` | The provider's reply cannot be read (`The provider sent an unreadable reply.`). |
| 504 | `AI_PROVIDER_API_ERROR` | The call times out. Message `The provider did not answer in time.` |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: none.

---

## Summaries

A summary is one record per recording and user. It holds the summary text, key points, action items, and the provider, model, prompt and language used. A new summary replaces the old record. Summary text, key points and action items are stored encrypted.

### GET /api/recordings/{id}/summary

Auth: session.

Response: `200 OK`. When no summary exists:

```json
{ "summary": null, "generating": false }
```

When a summary exists:

```json
{
  "summary": "Markdown or plain text",
  "keyPoints": ["First point"],
  "actionItems": ["Follow up"],
  "provider": "Custom",
  "model": "chat-model",
  "promptId": "general",
  "language": "auto",
  "createdAt": "2026-10-16T10:00:00.000Z",
  "generating": false
}
```

- `generating` is true while a manual summary job for this recording, started by the caller, is queued or running. Clients can poll this field to follow a run started by POST.
- `keyPoints` and `actionItems` are arrays of strings. They can be empty.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 404 | `RECORDING_NOT_FOUND` | The recording does not exist, is deleted, or belongs to another user. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: none.

### POST /api/recordings/{id}/summary

Creates or replaces the summary. The request waits until the run finishes, so the answer is the new summary, not `202`.

Auth: session.

Request body (JSON). The body is optional. An empty body is allowed. A body that is not a JSON object is refused with `400 INVALID_INPUT`, message `Request body must be a JSON object`.

| Field | Type | Notes |
| --- | --- | --- |
| `preset` | string | A built-in summary prompt id, or the id of a saved custom prompt. Overrides the saved default. |
| `language` | string | One of `auto`, `zh`, `en`, `ja`, `ko`. Any other value is ignored. |
| `source` | string | Name of the transcript to use. Only the first 20 characters are kept. |

Response: `200 OK`

```json
{
  "summary": "text",
  "keyPoints": ["First point"],
  "actionItems": ["Follow up"],
  "provider": "Custom",
  "model": "chat-model",
  "promptId": "general",
  "language": "auto",
  "createdAt": "2026-10-16T10:00:00.000Z",
  "promptFallback": false
}
```

- `promptId` is the prompt actually used.
- `promptFallback` is true when the requested or saved prompt id is unknown and `general` was used instead.
- `language` is the language used. An ignored request value falls back to the saved output language setting (`aiOutputLanguage`), then to `auto`.

Checks, in this order:

1. The recording exists, is not deleted, and belongs to the caller. Otherwise `404 RECORDING_NOT_FOUND`.
2. The recording has a non-blank transcript. Otherwise `400 INVALID_INPUT`, message `Transcribe the recording first`.
3. The caller has a provider that can enhance. Otherwise `400 AI_PROVIDER_NOT_CONFIGURED`, message `No AI provider can make summaries.`

Errors from the run (the request fails with the code stored for the run):

| Status | Code | When |
| --- | --- | --- |
| 502 | `AI_PROVIDER_API_ERROR` | The provider failed: timeout, unreachable, rejected key (`The provider rejected the API key.`), rate limit (`The provider is rate limiting requests.`), or another HTTP error (`The provider answered with HTTP <code>.`). |
| 502 | `UPSTREAM_BAD_RESPONSE` | The model returned no text, including a reply that used its whole output budget before writing anything. Message `The provider returned an empty answer.` |
| 410 | `NOT_FOUND` | The recording was deleted while the run was going. Message `Recording was deleted while the summary was being made. Nothing was saved.` Nothing is saved. |
| 400 | `INVALID_INPUT` | A run found no transcript (the transcript was removed after the check). |
| 500 | `INTERNAL_ERROR` | Any other failure. |
| 401 | `AUTH_SESSION_MISSING` | No session. |

Side effects: the summary record for the recording and user is created or replaced. The recording's `updatedAt` is not changed.

### Concurrent requests

- A manual summary run is a queued job, at most one per recording. While it is queued or running, a further POST for that recording waits for that run and returns its result. No second model call is made, and the options of the second request are ignored.
- The waiting POST gets the same error as the run if the run fails.

### Which transcript is used

- If `source` is given and a transcript with that source name exists, it is used.
- Otherwise the transcript written by the caller is used, if there is one. Otherwise the earliest transcript on the recording is used.
- A transcript whose text is blank does not count.

### Which provider and model are used

- Provider: the enhancement default, when it can enhance. Otherwise the oldest provider that can enhance. Transcription-only providers are never used. See [Concepts](#concepts).
- Model: the provider's stored default model, unless its name is a transcription model. Then the first of these is used:
  - the preset's chat model, when the preset has one (`Google Gemini`: `gemini-2.0-flash`; `SiliconFlow (China)`: `Qwen/Qwen2.5-7B-Instruct`);
  - a fallback chosen from the base URL: a URL containing `groq` gives `llama-3.1-8b-instant`; `together` gives `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo`; `openrouter` gives `openai/gpt-4o-mini`; any other URL gives `gpt-4o-mini`.
- An empty stored model uses the same rules.
- The model name is stored with the summary.

### Prompt and language

- The prompt is the chosen template. Its `{transcription}` placeholder is replaced by the transcript text, every occurrence, and the text is inserted as written. A template without the placeholder gets the transcript after it, separated by a blank line.
- Prompt choice: the request `preset` if given, else the saved default (`summaryPrompt.selectedPrompt` in the user's settings), else `general`. If the requested id is unknown, `general` is used and `promptFallback` is true. If only the saved default is unknown, `general` is used, also with `promptFallback` true.
- Built-in ids are checked before saved custom prompts.
- Language: the request `language` if valid, else the saved output language (`aiOutputLanguage`), else `auto`. `auto` means the same language as the transcript.
- The system message says what the model may use and which language to write in. It asks for facts from the transcript only, no filler words or false starts, and it treats the transcript as data. It keeps JSON keys in English.

### Output read back

- A Markdown code fence at the start and end of the reply is removed. The fence may be labelled `json`, `markdown`, `md`, or have no label.
- If the reply is a JSON object with a non-empty string `summary`:
  - `summary` is that string;
  - `keyPoints` and `actionItems` are taken from their arrays. Entries that are not strings, or are blank, are dropped.
- Otherwise the whole reply is the summary, and both lists are empty.
- The built-in templates ask for Markdown, not JSON. Their `keyPoints` and `actionItems` are therefore usually empty.

### Reasoning models

- If a reply is empty and its finish reason is `length` (the output budget ran out), the same request is sent once more with `reasoning_effort: "low"` and the same budget.
- If the retry fails or is also empty, the run fails with `UPSTREAM_BAD_RESPONSE`.
- Google Gemini is not retried.

### Long transcripts

- A transcript of 40,000 characters or less is sent in one request.
- A longer transcript is split into ordered parts of at most 40,000 characters. Splits happen at line ends first, then at sentence ends (`.`, `!`, `?`, and their full-width forms). A sentence longer than the limit is cut.
- Each part gets its own notes, using the same system message and output budget. Up to three parts run at once. The results keep their order.
- Each part's time range is estimated by spreading the recording's duration evenly over the characters of the transcript. The notes are joined with a heading for each part: `Part N (about <start> to <end>)`, with times as `m:ss`, or `h:mm:ss` from one hour on.
- The template then runs once on the joined notes.
- If a part returns no text, the run fails with `UPSTREAM_BAD_RESPONSE`.

### DELETE /api/recordings/{id}/summary

Auth: session.

Response: `200 OK` with `{ "success": true }`. Deleting when there is no summary also answers `200`.

- Only the caller's summary is removed.
- When a summary was removed, the recording's `updatedAt` is set to the current time.

Errors: `401 AUTH_SESSION_MISSING` without a session.

### Automatic summaries

Automatic work starts when a transcript is saved (see `transcription.md`):

1. A `transcription.completed` webhook event is emitted (see `webhooks.md`).
2. If the user's `autoGenerateTitle` setting is true (the default), a title is generated (see [Title generation](#title-generation)).
3. If the user's `autoSummarize` setting is true and the recording has no summary with content, a summary job is queued. It uses the `autoSummarizePreset` setting as the prompt when that is set, else the saved prompt default. The save step does not wait for it.

An automatic run is a `summary` job, so it appears in the recording's status and a request made while it runs waits for it.

Limits and results of the summary step:

- Automatic runs are limited to `AUTO_SUMMARY_RATE_LIMIT_PER_HOUR` per user per hour (default `60`, valid range 1 to 4,294,967,295), counted when a run starts. The count is kept in memory of the server process. Attempts count, including failed ones.
- When the limit is reached, no summary is made and a `summary.failed` webhook event is sent with the message `Automatic summary limit reached`.
- On success a `summary.completed` event is sent. On failure a `summary.failed` event is sent with the failure message.
- A failed automatic step never removes the transcript, and never fails the transcription.
- Manual summaries are not limited.

Settings are read and written with `PUT /api/settings/user` (see `settings.md`): `autoSummarize` (boolean), `autoSummarizePreset` (string or null), `autoGenerateTitle` (boolean).

### Summary fields

| Field | Type | Meaning |
| --- | --- | --- |
| `summary` | string | The summary. Markdown for the built-in templates. |
| `keyPoints` | string[] | Key points, when the model returned them. |
| `actionItems` | string[] | Action items, when the model returned them. |
| `provider` | string | Name of the provider that made the summary. |
| `model` | string | Model id used. |
| `promptId` | string | Prompt id used. |
| `language` | string | Language code used. |
| `createdAt` | ISO timestamp | When the summary was saved. |

### Run status

`GET /api/recordings/{id}/summary` also returns `status`, the state of the newest `summary` job for the recording, and `error` when that job failed:

| `status` | Meaning |
| --- | --- |
| `idle` | No run, and no summary with content. |
| `queued`, `running` | A run is queued or going. `generating` is true for both. |
| `completed` | The newest run finished, or the recording has a summary with content. |
| `failed` | The newest run failed and there is no summary with content. `error` holds its message. A failed re-run that kept a previous valid summary reports `completed`. |

A summary counts as present only when it has text, key points or action items. An empty answer from the model is a failed run and saves nothing, so the recording never shows as ready with an empty pane.

---

## Summary prompts

### Built-in prompts

Built-in summary prompts have fixed ids. Each is a template with one `{transcription}` placeholder:

| Id | Output |
| --- | --- |
| `general` | Markdown with the sections Overview, Main Points, Decisions, Next Steps. Sections the recording does not cover are left out. This is the default. |
| `meeting-notes` | Minutes in Markdown: Attendees (only names said in the recording), Agenda, Discussion, Decisions, Action Items. |
| `interview` | Markdown: Background, Key Answers, Quotes Worth Keeping, Open Questions. |
| `call` | Markdown: Purpose, What Was Discussed, Commitments, Follow-up. |
| `lecture` | Study notes in Markdown: Topic, Core Concepts (each with a short definition), Examples, Review Questions. |
| `brainstorm` | Markdown: Idea Themes, Ideas (one bullet each), Promising Next Steps. |
| `voice-memo` | Markdown: Gist, Highlights, Things to Remember. |
| `key-points` | Key points as Markdown bullets, most important first, one sentence each. |
| `action-items` | Action items as Markdown bullets (who, what, when), then a table with the columns Owner, Action, Due. Writes only `No action items mentioned.` when there are none. |

### Custom summary prompts

- Custom prompts are saved in the user's settings as `summaryPrompt`, through `PUT /api/settings/user`: `{ "selectedPrompt": "<id>", "customPrompts": [ { "id", "name", "prompt", "createdAt" } ] }`. Every field inside is a string. `selectedPrompt` is optional.
- A malformed value is refused with `400 INVALID_INPUT`, `details.field` set to `summaryPrompt`.
- A custom prompt is used by its id, as `preset` in a summary request, or as `selectedPrompt`.
- A custom prompt does not need the placeholder. Without it, the transcript is added after the prompt text.
- A saved custom prompt that has been deleted falls back to `general` with `promptFallback` true.

---

## Title generation

- Title styles have fixed ids: `default`, `meetings`, `lectures`, `phone-calls`, `audio-blog`, `idea-stormer`. The saved choice is the string setting `titleGenerationPrompt`, which is `null` by default and means `default`. An unknown id also means `default`.
- The style sets the instruction for the title. For example, `lectures` asks for a subject-style title such as `Linear Algebra: Eigenvalues`, and `meetings` asks for the main topic or decision.
- A title is generated from the first 2,000 characters of the transcript, followed by `...` when cut. It uses the enhancement provider and model (see [Which provider and model are used](#which-provider-and-model-are-used)), the output language setting, and temperature 0.7. The model is asked for a JSON object `{"title": "..."}` with one line under 60 characters.
- Clean-up: a JSON reply contributes its `title` field. Otherwise the first non-blank line is used. Surrounding quotes and markdown emphasis characters are removed, a leading `Title:` label is removed, colons and semicolons (including full-width forms) are removed, and runs of spaces are collapsed. A title longer than 60 characters is cut to 57 characters plus `...`. A reply with no usable title saves nothing.
- The title is saved as the recording's title, encrypted. When the user's `syncTitleToPlaud` setting is true and the recording came from Plaud, the title is also sent to Plaud (see `plaud.md`).
- When the user has no provider that can enhance, or the transcript is missing, nothing is generated and nothing is returned. A failed title call is logged and does not affect the summary step.
- No endpoint returns a generated title on its own. It appears in the recording's title.

---

## Chat settings

Ask AI uses its own streaming call and its own settings; see `recording-chat.md`. The table below
covers summaries and titles only.

| Use | Temperature | Output budget | Timeout |
| --- | --- | --- | --- |
| Summary, and the notes for each long-transcript part | 0.5 | 16,384 tokens | 300 s |
| Title | 0.7 | 2,048 tokens | 60 s |
| Provider test, chat probe | none set | 16 tokens (`max_tokens`) | 20 s |
| Model listing | none | none | 10 s |

- For OpenAI-compatible providers, the output budget is sent as `max_completion_tokens` when the model name starts with `gpt-5`, `o1`, `o3` or `o4` (case-insensitive). Otherwise it is sent as `max_tokens`.
- Google Gemini uses `generationConfig.maxOutputTokens`.
- The reasoning-effort setting is sent only on the retry described in [Reasoning models](#reasoning-models).

---

## Native provider calls

- **Google Gemini** uses the Generative Language API (`generateContent`) with the `x-goog-api-key` header. Chat messages become `contents`, system messages become `systemInstruction`, and the assistant role maps to `model`. Transcription sends the audio as base64 `inlineData`. The stored base URL is ignored.
- **ElevenLabs** is transcription-only. It cannot be the enhancement default, and it is skipped when a provider is chosen for summaries or titles.
- **OpenRouter** transcribes through chat completions with the audio attached, not through `/audio/transcriptions`.

---

## Summary export

Export runs in the browser from the loaded summary. No endpoint writes the file.

- Formats: Markdown (`.md`, `text/markdown`) and plain text (`.txt`, `text/plain`).
- The file name is the recording title plus ` summary`, cleaned for file names (characters `/ \ : * ? " < > |` become `-`, runs of whitespace become one space, at most 120 characters). Without a title the name is `Summary`.
- The document title line is the recording title plus ` summary`.
- A meta line joins the template name, the language label and the model with ` · `. Parts that are missing are left out.
- Markdown: `# <title>`, the meta line in italics, the summary, then `## Key Points` and `## Action Items` as bullets when they are not empty.
- Plain text: the title, the meta line, the summary with Markdown removed (headings lose their `#`, bold, italic, code and link markup is removed, a link becomes `text (url)`, table separator rows are dropped and table cells are joined with ` | `), then `Key Points` and `Action Items` as plain headings with `- ` bullets.
- Each file ends with one newline.

---

## Errors

| Code | Status | Where |
| --- | --- | --- |
| `AUTH_SESSION_MISSING` | 401 | Every endpoint, without a session. |
| `MISSING_REQUIRED_FIELD` | 400 | Provider create, provider test. |
| `INVALID_INPUT` | 400 | Provider capability refusals, invalid ElevenLabs base URL, default transcription body, summary body and transcript checks, invalid `summaryPrompt`. |
| `NOT_FOUND` | 404 | Unknown or other user's provider. |
| `RECORDING_NOT_FOUND` | 404 | Summary endpoints. |
| `AI_PROVIDER_NOT_CONFIGURED` | 400 | Summary without a provider that can enhance. |
| `AI_PROVIDER_API_ERROR` | 401, 502, 504 | Model listing; summary provider failures (502). |
| `UPSTREAM_BAD_RESPONSE` | 502 | Summary with no text from the model, or an unusable part reply. |
| `NOT_FOUND` | 410 | Summary whose recording was deleted during the run. |
| `INTERNAL_ERROR` | 500 | Unexpected failures. |
</content>
