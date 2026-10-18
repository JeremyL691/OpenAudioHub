//! AI provider presets, choosing a user's provider, and chat calls
//! (spec/ai.md "Provider presets", "Which provider and model are used", "Chat settings").

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{Value, json};

use crate::AppState;
use crate::error::{ApiResult, AppError};

pub const OPENAI_BASE: &str = "https://api.openai.com/v1";

pub struct Preset {
    pub name: &'static str,
    pub base_url: Option<&'static str>,
    pub model: Option<&'static str>,
    pub transcribes: bool,
    /// Transcribes through `/chat/completions` with the audio attached, not `/audio/transcriptions`.
    pub chat_transcription: bool,
    pub chat_model: Option<&'static str>,
    pub lists_chat: bool,
    pub lists_audio: bool,
}

const fn preset(
    name: &'static str,
    base_url: Option<&'static str>,
    model: Option<&'static str>,
) -> Preset {
    Preset {
        name,
        base_url,
        model,
        transcribes: true,
        chat_transcription: false,
        chat_model: None,
        lists_chat: false,
        lists_audio: false,
    }
}

pub const PRESETS: &[Preset] = &[
    Preset {
        chat_model: Some("gemini-2.0-flash"),
        lists_audio: true,
        ..preset("Google Gemini", None, Some("gemini-2.0-flash"))
    },
    Preset {
        lists_audio: true,
        ..preset(
            "ElevenLabs",
            Some("https://api.elevenlabs.io/v1"),
            Some("scribe_v2"),
        )
    },
    preset("OpenAI", None, Some("whisper-1")),
    preset(
        "Groq",
        Some("https://api.groq.com/openai/v1"),
        Some("whisper-large-v3-turbo"),
    ),
    preset(
        "Together AI",
        Some("https://api.together.xyz/v1"),
        Some("openai/whisper-large-v3"),
    ),
    Preset {
        chat_transcription: true,
        lists_audio: true,
        ..preset(
            "OpenRouter",
            Some("https://openrouter.ai/api/v1"),
            Some("google/gemini-2.5-flash-lite"),
        )
    },
    Preset {
        chat_model: Some("Qwen/Qwen2.5-7B-Instruct"),
        lists_chat: true,
        ..preset(
            "SiliconFlow (China)",
            Some("https://api.siliconflow.cn/v1"),
            Some("FunAudioLLM/SenseVoiceSmall"),
        )
    },
    Preset {
        transcribes: false,
        lists_chat: true,
        ..preset(
            "OpenCode Go",
            Some("https://opencode.ai/zen/go/v1"),
            Some("deepseek-v4.1-flash"),
        )
    },
    preset("LM Studio", Some("http://localhost:1234/v1"), None),
    preset("Ollama", Some("http://localhost:11434/v1"), None),
    preset("Custom", None, None),
];

pub fn preset_named(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

/// Unknown names can transcribe (for example a custom name on a stored row).
pub fn can_transcribe(name: &str) -> bool {
    preset_named(name).is_none_or(|p| p.transcribes)
}

pub fn can_enhance(name: &str) -> bool {
    name != "ElevenLabs"
}

pub fn is_transcription_model(model: &str) -> bool {
    const HINTS: [&str; 8] = [
        "whisper",
        "asr",
        "sensevoice",
        "telespeech",
        "transcribe",
        "scribe",
        "parakeet",
        "speech",
    ];
    let model = model.to_lowercase();
    HINTS.iter().any(|hint| model.contains(hint))
}

pub fn base_url(given: Option<String>, preset: Option<&Preset>) -> String {
    given
        .filter(|s| !s.trim().is_empty())
        .or_else(|| preset.and_then(|p| p.base_url).map(str::to_owned))
        .unwrap_or_else(|| OPENAI_BASE.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

/// The OpenCode Go gateway routes by session and answers 400 when this header is missing.
pub fn with_provider_headers(
    req: reqwest::RequestBuilder,
    name: &str,
    base_url: &str,
) -> reqwest::RequestBuilder {
    if name == "OpenCode Go" || base_url.contains("opencode.ai/zen/go") {
        req.header("x-opencode-session", opencode_session())
    } else {
        req
    }
}

fn opencode_session() -> String {
    std::env::var("OPENCODE_GO_SESSION_ID")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "openaudiohub".to_owned())
}

/// One shared client; per-request timeouts are set by the caller.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP client with fixed settings builds")
    })
}

/// A configured provider with its key decrypted, ready to call.
#[derive(Clone)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// The stored default model, if any.
    pub model: Option<String>,
}

impl Provider {
    pub fn preset(&self) -> Option<&'static Preset> {
        preset_named(&self.name)
    }

    /// The model for chat: the stored one unless it is a transcription model, else the preset's
    /// chat model, else a fallback picked from the base URL.
    pub fn chat_model(&self) -> String {
        if let Some(model) = self
            .model
            .as_deref()
            .filter(|m| !m.is_empty() && !is_transcription_model(m))
        {
            return model.to_owned();
        }
        if let Some(model) = self.preset().and_then(|p| p.chat_model) {
            return model.to_owned();
        }
        let url = self.base_url.to_lowercase();
        let fallback = if url.contains("groq") {
            "llama-3.1-8b-instant"
        } else if url.contains("together") {
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
        } else if url.contains("openrouter") {
            "openai/gpt-4o-mini"
        } else {
            "gpt-4o-mini"
        };
        fallback.to_owned()
    }

    /// The model for transcription: the stored one, else the preset's, else `whisper-1`.
    pub fn transcription_model(&self) -> String {
        self.model
            .clone()
            .filter(|m| !m.is_empty())
            .or_else(|| self.preset().and_then(|p| p.model).map(str::to_owned))
            .unwrap_or_else(|| "whisper-1".into())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    provider: String,
    api_key: String,
    base_url: Option<String>,
    default_model: Option<String>,
}

fn open(state: &AppState, row: Row) -> ApiResult<Provider> {
    let preset = preset_named(&row.provider);
    Ok(Provider {
        base_url: base_url(row.base_url, preset),
        api_key: state
            .config
            .field_key
            .decrypt(&row.api_key)
            .map_err(AppError::internal)?,
        id: row.id,
        name: row.provider,
        model: row.default_model,
    })
}

const COLUMNS: &str = "id, provider, api_key, base_url, default_model";

fn no_transcription_provider() -> AppError {
    AppError::bad_request(
        "NO_TRANSCRIPTION_PROVIDER",
        "No transcription provider is configured",
    )
}

/// The provider for a transcription run: the one asked for, else the user's
/// transcription default. Never falls back to another provider.
pub async fn transcription_provider(
    state: &AppState,
    user_id: &str,
    provider_id: Option<&str>,
) -> ApiResult<Provider> {
    let row: Option<Row> = match provider_id {
        Some(id) => {
            sqlx::query_as(&format!("SELECT {COLUMNS} FROM api_credentials WHERE id = ? AND user_id = ?"))
                .bind(id)
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?
        }
        None => {
            sqlx::query_as(&format!("SELECT {COLUMNS} FROM api_credentials WHERE user_id = ? AND is_default_transcription = 1 LIMIT 1"))
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?
        }
    };
    let row = row
        .filter(|r| can_transcribe(&r.provider))
        .ok_or_else(no_transcription_provider)?;
    open(state, row)
}

/// The provider for summaries and titles: the enhancement default if it can
/// enhance, else the oldest provider that can. `None` when there is none.
pub async fn enhancement_provider(state: &AppState, user_id: &str) -> ApiResult<Option<Provider>> {
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM api_credentials WHERE user_id = ? ORDER BY is_default_enhancement DESC, created_at, id"
    ))
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    rows.into_iter()
        .find(|r| can_enhance(&r.provider))
        .map(|r| open(state, r))
        .transpose()
}

/// Why a provider call failed. The message is safe to store and show.
#[derive(Debug)]
pub struct AiError {
    pub code: &'static str,
    pub message: String,
    /// Worth trying again later (timeouts, 429, 5xx).
    pub retryable: bool,
}

pub fn upstream_error(e: reqwest::Error) -> AiError {
    let message = if e.is_timeout() {
        "The provider did not answer in time."
    } else {
        "The provider could not be reached."
    };
    AiError {
        code: "AI_PROVIDER_API_ERROR",
        message: message.into(),
        retryable: true,
    }
}

pub fn status_error(status: reqwest::StatusCode) -> AiError {
    let message = match status.as_u16() {
        401 | 403 => "The provider rejected the API key.".to_owned(),
        429 => "The provider is rate limiting requests.".to_owned(),
        code => format!("The provider answered with HTTP {code}."),
    };
    AiError {
        code: "AI_PROVIDER_API_ERROR",
        message,
        retryable: status.as_u16() == 429 || status.is_server_error(),
    }
}

pub struct ChatOptions {
    pub temperature: f64,
    /// Output token budget.
    pub budget: u32,
    pub timeout: Duration,
}

/// Sends one chat completion and returns the trimmed reply text.
/// A reasoning model that spends the whole budget thinking gets one retry with low effort.
pub async fn chat(
    provider: &Provider,
    messages: Value,
    options: &ChatOptions,
) -> Result<String, AiError> {
    let model = provider.chat_model();
    if provider.name == "Google Gemini" {
        return gemini_chat(provider, &model, messages, options).await;
    }
    let budget_key = if ["gpt-5", "o1", "o3", "o4"]
        .iter()
        .any(|p| model.to_lowercase().starts_with(p))
    {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    let mut body =
        json!({ "model": model, "messages": messages, "temperature": options.temperature });
    body[budget_key] = options.budget.into();
    let first = chat_once(provider, &body, options.timeout).await?;
    if first.text.is_empty() && first.finish_reason.as_deref() == Some("length") {
        body["reasoning_effort"] = "low".into();
        if let Ok(retry) = chat_once(provider, &body, options.timeout).await
            && !retry.text.is_empty()
        {
            return Ok(retry.text);
        }
    }
    if first.text.is_empty() {
        return Err(AiError {
            code: "AI_EMPTY_RESPONSE",
            message: "The provider returned an empty answer.".into(),
            retryable: false,
        });
    }
    Ok(first.text)
}

async fn gemini_chat(
    provider: &Provider,
    model: &str,
    messages: Value,
    options: &ChatOptions,
) -> Result<String, AiError> {
    let mut contents = Vec::new();
    let mut system = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        let role = message["role"].as_str().unwrap_or("user");
        let content = &message["content"];
        let mut parts = Vec::new();
        if let Some(text) = content.as_str() {
            parts.push(json!({"text": text}));
        }
        if let Some(items) = content.as_array() {
            for item in items {
                if let Some(text) = item["text"].as_str() {
                    parts.push(json!({"text": text}));
                }
            }
        }
        if parts.is_empty() {
            continue;
        }
        if role == "system" {
            system.extend(parts);
        } else {
            contents.push(
                json!({"role": if role == "assistant" {"model"} else {"user"}, "parts": parts}),
            );
        }
    }
    let mut body = json!({"contents": contents, "generationConfig": {
        "temperature": options.temperature, "maxOutputTokens": options.budget
    }});
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts": system});
    }
    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let res = client()
        .post(url)
        .header("x-goog-api-key", &provider.api_key)
        .timeout(options.timeout)
        .json(&body)
        .send()
        .await
        .map_err(upstream_error)?;
    if !res.status().is_success() {
        return Err(status_error(res.status()));
    }
    let value: Value = res.json().await.map_err(upstream_error)?;
    let answer = value["candidates"][0]["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_owned();
    if answer.is_empty() {
        return Err(AiError {
            code: "AI_EMPTY_RESPONSE",
            message: "The provider returned an empty answer.".into(),
            retryable: false,
        });
    }
    Ok(answer)
}

struct Reply {
    text: String,
    finish_reason: Option<String>,
}

async fn chat_once(provider: &Provider, body: &Value, timeout: Duration) -> Result<Reply, AiError> {
    let req = client()
        .post(format!("{}/chat/completions", provider.base_url))
        .bearer_auth(&provider.api_key);
    let res = with_provider_headers(req, &provider.name, &provider.base_url)
        .timeout(timeout)
        .json(body)
        .send()
        .await
        .map_err(upstream_error)?;
    if !res.status().is_success() {
        return Err(status_error(res.status()));
    }
    let value: Value = res.json().await.map_err(upstream_error)?;
    let choice = &value["choices"][0];
    Ok(Reply {
        text: choice["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned(),
        finish_reason: choice["finish_reason"].as_str().map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(name: &str, base: &str, model: Option<&str>) -> Provider {
        Provider {
            id: "p".into(),
            name: name.into(),
            base_url: base.into(),
            api_key: "k".into(),
            model: model.map(Into::into),
        }
    }

    #[test]
    fn chat_model_skips_transcription_models() {
        assert_eq!(
            provider("Custom", "https://x/v1", Some("my-chat")).chat_model(),
            "my-chat"
        );
        assert_eq!(
            provider(
                "Groq",
                "https://api.groq.com/openai/v1",
                Some("whisper-large-v3")
            )
            .chat_model(),
            "llama-3.1-8b-instant"
        );
        assert_eq!(
            provider("SiliconFlow (China)", "https://api.siliconflow.cn/v1", None).chat_model(),
            "Qwen/Qwen2.5-7B-Instruct"
        );
        assert_eq!(
            provider("OpenAI", OPENAI_BASE, Some("whisper-1")).chat_model(),
            "gpt-4o-mini"
        );
    }

    #[test]
    fn transcription_model_falls_back() {
        assert_eq!(
            provider("Groq", "", None).transcription_model(),
            "whisper-large-v3-turbo"
        );
        assert_eq!(
            provider("Custom", "", None).transcription_model(),
            "whisper-1"
        );
        assert_eq!(provider("Custom", "", Some("m")).transcription_model(), "m");
    }

    #[test]
    fn opencode_go_requests_carry_a_session() {
        let build = |name: &str, base: &str| {
            with_provider_headers(client().get(format!("{base}/models")), name, base)
                .build()
                .unwrap()
        };
        let go = build("OpenCode Go", "https://opencode.ai/zen/go/v1");
        assert!(go.headers().contains_key("x-opencode-session"));
        let custom = build("Custom", "https://opencode.ai/zen/go/v1");
        assert!(custom.headers().contains_key("x-opencode-session"));
        let other = build("OpenAI", OPENAI_BASE);
        assert!(!other.headers().contains_key("x-opencode-session"));
    }

    #[test]
    fn capabilities() {
        assert!(!can_transcribe("OpenCode Go"));
        assert!(can_transcribe("Some self-hosted thing"));
        assert!(can_transcribe("ElevenLabs"));
        assert!(can_enhance("Google Gemini"));
        assert!(!can_enhance("ElevenLabs"));
    }

    #[test]
    fn gemini_default_chat_model_is_native_and_enhance_capable() {
        let p = provider(
            "Google Gemini",
            "https://unused.invalid",
            Some("gemini-2.0-flash"),
        );
        assert_eq!(p.chat_model(), "gemini-2.0-flash");
        assert!(can_enhance("Google Gemini"));
        assert!(preset_named("Google Gemini").unwrap().transcribes);
    }
}
