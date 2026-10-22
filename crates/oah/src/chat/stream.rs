//! Streaming provider calls, bounded (spec/recording-chat.md "Limits", "What the model receives").
//!
//! A chat answer arrives as server-sent events. This module turns those bytes into the text of the
//! answer, and stops as soon as a bound is reached: one frame, one response, or one answer. It does
//! not retry and does not follow redirects, so one call is one physical request and the request
//! budget counts what actually happened.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header;
use serde_json::{Value, json};

use crate::ai::{Provider, client, status_error, with_provider_headers};
use crate::chat::capabilities::Effort;

/// The bounds one call works within.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The most bytes one event may hold.
    pub frame_bytes: usize,
    /// The most bytes the whole response may hold, dropped fields included.
    pub response_bytes: usize,
    /// The most characters of answer text one call keeps.
    pub answer_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            frame_bytes: 64 * 1024,
            response_bytes: 4 * 1024 * 1024,
            answer_chars: 256 * 1024,
        }
    }
}

/// Why a bounded read stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum LimitError {
    Frame,
    Response,
    Answer,
}

impl LimitError {
    /// The code stored with this bound, and the message shown for it.
    pub fn as_error(&self) -> (&'static str, &'static str) {
        (
            "CHAT_LIMIT_REACHED",
            "This answer grew past the size this app accepts.",
        )
    }
}

/// One server-sent event, reduced to the field the reader needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub data: String,
}

/// Reads server-sent events out of a byte stream, whatever the packet boundaries are.
pub struct SseParser {
    limits: Limits,
    /// Bytes not yet forming a whole line.
    buffer: Vec<u8>,
    /// The `data:` lines of the event being read.
    data: Vec<String>,
    /// Bytes of the whole response read so far.
    seen: usize,
}

impl SseParser {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            buffer: Vec::new(),
            data: Vec::new(),
            seen: 0,
        }
    }

    /// Adds bytes and returns the events they completed.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, LimitError> {
        self.seen += bytes.len();
        if self.seen > self.limits.response_bytes {
            return Err(LimitError::Response);
        }
        let mut events = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.buffer);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.line(&line, &mut events)?;
                continue;
            }
            self.buffer.push(*byte);
            if self.buffer.len() > self.limits.frame_bytes {
                return Err(LimitError::Frame);
            }
        }
        Ok(events)
    }

    /// Flushes any pending line and buffered data when the stream reaches EOF.
    pub fn finish(&mut self) -> Result<Vec<Event>, LimitError> {
        let mut events = Vec::new();
        if !self.buffer.is_empty() {
            let mut line = std::mem::take(&mut self.buffer);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&line, &mut events)?;
        }
        if !self.data.is_empty() {
            let joined = std::mem::take(&mut self.data).join("\n");
            if joined.len() > self.limits.frame_bytes {
                return Err(LimitError::Frame);
            }
            events.push(Event { data: joined });
        }
        Ok(events)
    }

    /// Reads one line: a blank line ends the event, `data:` adds to it, anything else is skipped.
    fn line(&mut self, line: &[u8], events: &mut Vec<Event>) -> Result<(), LimitError> {
        if line.is_empty() {
            if !self.data.is_empty() {
                let joined = std::mem::take(&mut self.data).join("\n");
                if joined.len() > self.limits.frame_bytes {
                    return Err(LimitError::Frame);
                }
                events.push(Event { data: joined });
            }
            return Ok(());
        }
        let text = String::from_utf8_lossy(line);
        if let Some(rest) = text.strip_prefix("data:") {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            self.data.push(rest.to_owned());
            let total: usize = self.data.iter().map(|d| d.len() + 1).sum();
            if total > self.limits.frame_bytes {
                return Err(LimitError::Frame);
            }
        }
        Ok(())
    }
}

/// The output budget to send, and the effort setting when one was resolved.
pub fn openai_body_flags(effort: Option<Effort>, budget: u32) -> (Option<String>, u32) {
    (effort.map(|e| e.as_str().to_owned()), budget)
}

/// Extracted delta data from an SSE chunk.
#[derive(Debug, Clone, Default)]
pub struct ChunkData {
    pub content: Option<String>,
    pub reasoning: Option<String>,
    pub finish_reason: Option<String>,
}

/// The text of one OpenAI-compatible delta. Reasoning text is returned separately.
pub fn parse_openai_chunk(data: &str) -> Option<ChunkData> {
    if data == "[DONE]" {
        return None;
    }
    let value: Value = serde_json::from_str(data).ok()?;
    let choice = value.get("choices")?.as_array()?.first()?;
    let delta = choice.get("delta");
    let content = delta
        .and_then(|d| d.get("content"))
        .or_else(|| choice.get("message").and_then(|m| m.get("content")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let reasoning = delta
        .and_then(|d| d.get("reasoning_content").or_else(|| d.get("reasoning")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(ChunkData {
        content,
        reasoning,
        finish_reason,
    })
}

/// The text of one Gemini delta. A part marked as a thought is returned as reasoning.
pub fn parse_gemini_chunk(data: &str) -> Option<ChunkData> {
    let value: Value = serde_json::from_str(data).ok()?;
    let candidate = value.get("candidates")?.as_array()?.first()?;
    let finish_reason = candidate
        .get("finishReason")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let parts = candidate.get("content")?.get("parts")?.as_array()?;
    let mut content = String::new();
    let mut reasoning = String::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                reasoning.push_str(text);
            } else {
                content.push_str(text);
            }
        }
    }
    Some(ChunkData {
        content: (!content.is_empty()).then_some(content),
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        finish_reason,
    })
}

pub fn openai_delta(data: &str) -> Option<String> {
    parse_openai_chunk(data).and_then(|c| c.content)
}

pub fn gemini_delta(data: &str) -> Option<String> {
    parse_gemini_chunk(data).and_then(|c| c.content)
}

/// Why a streaming call did not produce an answer.
#[derive(Debug)]
pub struct StreamError {
    pub code: &'static str,
    pub message: String,
}

impl StreamError {
    fn limit(error: LimitError) -> Self {
        let (code, message) = error.as_error();
        Self {
            code,
            message: message.to_owned(),
        }
    }

    fn from_ai(error: crate::ai::AiError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }

    fn empty() -> Self {
        Self {
            code: "AI_EMPTY_RESPONSE",
            message: "The provider returned an empty answer.".to_owned(),
        }
    }
}

/// What one call produced.
pub struct Completion {
    pub text: String,
}

/// One streaming request. `effort` is sent only when a level was resolved for this model.
#[allow(clippy::too_many_arguments)]
pub async fn complete(
    provider: &Provider,
    messages: &Value,
    effort: Option<Effort>,
    budget: u32,
    temperature: f64,
    timeout: Duration,
    limits: Limits,
    on_text: impl Fn(&str) + Send + 'static,
    on_thinking: impl Fn() + Send + 'static,
) -> Result<Completion, StreamError> {
    if provider.name == "Google Gemini" {
        return gemini(
            provider,
            messages,
            effort,
            budget,
            temperature,
            timeout,
            limits,
            on_text,
            on_thinking,
        )
        .await;
    }
    openai(
        provider,
        messages,
        effort,
        budget,
        temperature,
        timeout,
        limits,
        on_text,
        on_thinking,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn openai(
    provider: &Provider,
    messages: &Value,
    effort: Option<Effort>,
    budget: u32,
    temperature: f64,
    timeout: Duration,
    limits: Limits,
    on_text: impl Fn(&str) + Send + 'static,
    on_thinking: impl Fn() + Send + 'static,
) -> Result<Completion, StreamError> {
    let model = provider.chat_model();
    let (effort, budget) = openai_body_flags(effort, budget);
    let budget_key = if ["gpt-5", "o1", "o3", "o4"]
        .iter()
        .any(|p| model.to_lowercase().starts_with(p))
    {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": true,
    });
    body[budget_key] = budget.into();
    if let Some(effort) = effort {
        body["reasoning_effort"] = effort.into();
    }
    let req = client()
        .post(format!("{}/chat/completions", provider.base_url))
        .bearer_auth(&provider.api_key);
    let response = with_provider_headers(req, &provider.name, &provider.base_url)
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|e| StreamError::from_ai(crate::ai::upstream_error(e)))?;
    read_response(response, limits, parse_openai_chunk, on_text, on_thinking).await
}

#[allow(clippy::too_many_arguments)]
async fn gemini(
    provider: &Provider,
    messages: &Value,
    effort: Option<Effort>,
    budget: u32,
    temperature: f64,
    timeout: Duration,
    limits: Limits,
    on_text: impl Fn(&str) + Send + 'static,
    on_thinking: impl Fn() + Send + 'static,
) -> Result<Completion, StreamError> {
    let model = provider.chat_model();
    let (contents, system) = gemini_messages(messages);
    let mut generation = json!({ "temperature": temperature, "maxOutputTokens": budget });
    if let Some(effort) = effort {
        generation["thinkingConfig"] = json!({ "thinkingLevel": effort.as_str() });
    }
    let mut body = json!({ "contents": contents, "generationConfig": generation });
    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": system });
    }
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    );
    let response = client()
        .post(url)
        .header("x-goog-api-key", &provider.api_key)
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|e| StreamError::from_ai(crate::ai::upstream_error(e)))?;
    read_response(response, limits, parse_gemini_chunk, on_text, on_thinking).await
}

/// Turns chat messages into Gemini contents, as the non-streaming path does.
fn gemini_messages(messages: &Value) -> (Vec<Value>, Vec<Value>) {
    let mut contents = Vec::new();
    let mut system = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        let role = message["role"].as_str().unwrap_or("user");
        let Some(text) = message["content"].as_str() else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let part = json!({ "text": text });
        if role == "system" {
            system.push(part);
        } else {
            contents.push(json!({
                "role": if role == "assistant" { "model" } else { "user" },
                "parts": [part],
            }));
        }
    }
    (contents, system)
}

/// Reads the events of a response, keeping the answer text they carry.
async fn read_response(
    response: reqwest::Response,
    limits: Limits,
    parse_chunk: fn(&str) -> Option<ChunkData>,
    on_text: impl Fn(&str) + Send + 'static,
    on_thinking: impl Fn() + Send + 'static,
) -> Result<Completion, StreamError> {
    if !response.status().is_success() {
        return Err(StreamError::from_ai(status_error(response.status())));
    }

    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("application/json") && !ct.contains("event-stream"));

    if is_json {
        let bytes = response
            .bytes()
            .await
            .map_err(|e| StreamError::from_ai(crate::ai::upstream_error(e)))?;
        if bytes.len() > limits.response_bytes {
            return Err(StreamError::limit(LimitError::Response));
        }
        let text = String::from_utf8_lossy(&bytes);
        if let Some(chunk) = parse_chunk(&text) {
            if let Some(content) = chunk.content {
                on_text(&content);
                return Ok(Completion { text: content });
            }
            if chunk.finish_reason.as_deref() == Some("length") {
                return Err(StreamError {
                    code: "AI_REASONING_EXHAUSTED",
                    message: "The model exhausted its output budget during thinking. Try asking with a lower thinking level or a shorter question.".to_owned(),
                });
            }
        }
        return Err(StreamError::empty());
    }

    let mut parser = SseParser::new(limits);
    let mut text = String::new();
    let mut saw_reasoning = false;
    let mut last_finish_reason = None;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| StreamError::from_ai(crate::ai::upstream_error(e)))?;
        let events = parser.push(&chunk).map_err(StreamError::limit)?;
        for event in events {
            if let Some(chunk_data) = parse_chunk(&event.data) {
                if chunk_data.reasoning.is_some() {
                    saw_reasoning = true;
                    on_thinking();
                }
                if let Some(ref fr) = chunk_data.finish_reason {
                    last_finish_reason = Some(fr.clone());
                }
                if let Some(piece) = chunk_data.content {
                    on_text(&piece);
                    text.push_str(&piece);
                    if text.chars().count() > limits.answer_chars {
                        return Err(StreamError::limit(LimitError::Answer));
                    }
                }
            }
        }
    }

    // Flush any leftover event at EOF
    let final_events = parser.finish().map_err(StreamError::limit)?;
    for event in final_events {
        if let Some(chunk_data) = parse_chunk(&event.data) {
            if chunk_data.reasoning.is_some() {
                saw_reasoning = true;
                on_thinking();
            }
            if let Some(ref fr) = chunk_data.finish_reason {
                last_finish_reason = Some(fr.clone());
            }
            if let Some(piece) = chunk_data.content {
                on_text(&piece);
                text.push_str(&piece);
                if text.chars().count() > limits.answer_chars {
                    return Err(StreamError::limit(LimitError::Answer));
                }
            }
        }
    }

    if text.trim().is_empty() {
        if last_finish_reason.as_deref() == Some("length") && saw_reasoning {
            return Err(StreamError {
                code: "AI_REASONING_EXHAUSTED",
                message: "The model exhausted its output budget during thinking. Try asking with a lower thinking level or a shorter question.".to_owned(),
            });
        }
        return Err(StreamError::empty());
    }
    Ok(Completion { text })
}
