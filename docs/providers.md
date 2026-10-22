# AI providers

OpenAudioHub uses an AI provider for two things: transcription, which turns audio into text, and summaries, which write a summary, action items, key points and a title.

Most providers offer the OpenAI API: chat completions and audio transcriptions, at a base address you can set. Google Gemini and ElevenLabs have their own APIs, and OpenAudioHub talks to them directly. You can add as many providers as you need. You can also transcribe on your own device without a provider. See [Transcribe in the browser](#transcribe-in-the-browser).

- [Add a provider](#add-a-provider)
- [Presets](#presets)
- [Which provider is used](#which-provider-is-used)
- [Which model is used](#which-model-is-used)
- [Ask AI](#ask-ai)
- [Long recordings](#long-recordings)
- [Transcribe in the browser](#transcribe-in-the-browser)
- [Local providers](#local-providers)
- [Privacy](#privacy)

## Add a provider

1. Open **Settings**, then **Providers**.
2. Choose **Add Provider**.
3. Choose a **Provider** from the list. A preset fills in the base address and the model. Choose **Custom** for any other service.
4. Enter the **API key**. The key is stored encrypted, and it is never shown again.
5. Optional: change the **Base URL**. Leave it empty to use the preset's address.
6. Optional: choose a **Default Model** from the list the preset offers, or pick **Custom (type model name)…** to type one.
7. Turn on **Use for transcription** to use this provider to transcribe audio.
8. Turn on **Use for AI enhancements** to use this provider for summaries and titles.
9. Choose **Save**.

You can turn on **Use for transcription** for only one provider at a time. The same is true for **Use for AI enhancements**.

## Presets

| Provider | Base address | Default transcription model | Transcription | Summaries |
|---|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | Yes | Yes |
| Google Gemini | Google's own API | `gemini-2.0-flash` | Yes. Audio up to 20 MB. | Yes |
| ElevenLabs | `https://api.elevenlabs.io/v1` | `scribe_v2` | Yes. Audio up to 128 MB. Speaker labels are supported. | No |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Yes | Yes |
| Together AI | `https://api.together.xyz/v1` | `openai/whisper-large-v3` | Yes | Yes |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-2.5-flash-lite` | Yes. Sends the audio in a chat request. | Yes |
| SiliconFlow (China) | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | Yes | Yes |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | none | No | Yes |
| LM Studio | `http://localhost:1234/v1` | none | Yes | Yes |
| Ollama | `http://localhost:11434/v1` | none | Yes | Yes |
| Custom | none | none | Yes | Yes |

A **Custom** provider with an empty base address uses `https://api.openai.com/v1`. Set the base address to use any other service.

OpenCode Go receives an `x-opencode-session` header. Its value is `openaudiohub` unless you set `OPENCODE_GO_SESSION_ID` on the server. See [Environment variables](environment-variables.md#transcription-and-long-recordings).

ElevenLabs can transcribe but cannot write summaries. Use another provider for summaries.

## Which provider is used

**Transcription.** The provider chosen for a transcription. If none is chosen, the provider marked **Use for transcription** is used. OpenAudioHub never falls back to another provider. If no provider can transcribe, the recording stays untranscribed and the app says that no transcription provider is set.

**Summaries and titles.** The provider marked **Use for AI enhancements**. If none is marked, the oldest provider that can write summaries is used.

To choose a summary style, open **Settings**, then **Summary**, and pick a default. The built-in styles are:

- General Summary
- Meeting Minutes
- Interview and Research
- Phone and Client Call
- Lecture and Study Notes
- Brainstorm
- Voice Memo and Podcast
- Key Points
- Action Items

You can also write your own prompt. Include the placeholder `{transcription}` where the transcript goes.

To transcribe each new recording automatically, open **Settings**, then **Transcription**, and turn on **Auto-transcribe new recordings**. To write a summary after each transcript, open **Settings**, then **Summary**, and turn on **Auto-generate summary after transcription**.

## Which model is used

If you do not enter a default model, OpenAudioHub uses these:

- **Transcription:** the preset's transcription model. For a provider with no preset, it uses `whisper-1`.
- **Summaries and titles:** the default model you entered, unless that model is a transcription model. Then it uses the preset's chat model. Then it uses a model that fits the base address. For a service it does not know, it uses `gpt-4o-mini`.

Models with `whisper`, `asr`, `sensevoice`, `telespeech`, `transcribe`, `scribe`, `parakeet` or `speech` in their names are treated as transcription models.

Set the models yourself if a provider changes its model names.

## Ask AI

Ask AI answers questions about one recording. It starts from the provider marked **Use for AI enhancements**, then keeps a provider, model and thinking level of its own for that recording, chosen at the top of its panel.

- The choice belongs to the conversation, so a recording can use a different model from summaries without changing the summary default.
- Choosing a provider lists the models it offers when it publishes a list. A provider that publishes none offers its configured model, and a model name can be typed.
- A thinking level asks the model to think for longer. The levels are minimal, low, medium, high, xhigh and max, plus **Default**, which asks for nothing.
- A level the model does not publish is never sent. The app sends the closest higher level, or the model's highest level when the choice is above all of them. When the app does not know which levels a model accepts, it sends none and says the support is unknown rather than unsupported, so a wrong guess cannot make a working provider fail.
- The app does not guess a model's context size from its name. An unlisted model gets a smaller, conservative amount of transcript, and nothing is sent twice to make up for a refusal.

See `../spec/recording-chat.md` for the requests, the bounds one question works within, and the errors a provider can cause.

## Long recordings

By default, OpenAudioHub splits each recording into parts at pauses. The split is done on the server, by the audio pipeline. Each part is about 2 minutes long, and no part is longer than about 170 seconds. Each part goes to the provider separately, and the parts are joined into one transcript. The parts are processed one after another, so a long recording takes a while.

Recordings longer than 24 hours cannot be transcribed.

When the split is turned off, the whole file is sent in one request. A file larger than the limit is first re-encoded as mono Opus audio, so that it fits. The default limit is 24 MiB. You can change these values in the server settings. See [Environment variables](environment-variables.md#transcription-and-long-recordings) for the server, or [Settings file](desktop.md#settings-file) for the Mac app.

Speaker labels are on by default. Turn them off in **Settings**, then **Transcription**.

## Transcribe in the browser

A recording can also be transcribed on your own device. Open the recording and choose **Transcribe in browser**, or use the same item in a row's menu.

- The browser downloads the audio and runs a Whisper model (`whisper-base`) on your device. The model is downloaded once from the Hugging Face hub.
- No AI provider is needed, and the audio is not sent to a provider.
- The browser sends only the text to the server, which stores it as the transcript. The transcript is recorded as made by the browser.

This option transcribes without an account with an AI service. Summaries still need a provider.

## Local providers

LM Studio and Ollama run on your own computer. Their audio and text never leave it.

- **Mac app.** Use `http://localhost:1234/v1` for LM Studio, or `http://localhost:11434/v1` for Ollama. Your Mac is the computer that runs the models, so `localhost` works.
- **Self-hosted server.** `localhost` means the server container, not your computer. On Docker Desktop for Mac, use `http://host.docker.internal:1234/v1` or `http://host.docker.internal:11434/v1`. On a server, use the address of the machine that runs the model.

Start the model server first. LM Studio needs its local server turned on. Ollama needs to be running.

## Privacy

When you transcribe or summarize with a provider, OpenAudioHub sends audio or text to the provider you chose. The provider's own terms apply to that data. Plaud sync is separate. It talks to Plaud.

Transcription in the browser keeps the audio on your device. Only the finished text is sent to your server.

To keep audio and text on your own machine or server, choose a local provider or use transcription in the browser. See [Local providers](#local-providers).
