//! The Plaud web API as the app calls it (spec/plaud.md, "Plaud web API used").

use std::time::Duration;

use reqwest::Method;
use reqwest::header::{AUTHORIZATION, RETRY_AFTER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai;

const BROWSER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const API_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Waits before each of the three retries.
const BACKOFF_SECS: [u64; 3] = [1, 2, 4];
pub const PAGE_SIZE: usize = 50;

/// Why a Plaud call failed.
#[derive(Debug)]
pub enum PlaudError {
    /// Plaud refused the token (HTTP 401).
    Rejected { message: String },
    /// Rate limited, still after the retries.
    RateLimited { retry_after: Option<u64> },
    /// Server error or no answer, still after the retries.
    Upstream,
    /// Plaud refused the request with its own status and message.
    Api { status: i64, message: String },
}

/// Plain text for sync messages.
pub fn describe(e: &PlaudError) -> String {
    match e {
        PlaudError::Rejected { message } => message.clone(),
        PlaudError::RateLimited { .. } => {
            "Too many requests to Plaud. Please try again later.".into()
        }
        PlaudError::Upstream => "Plaud is temporarily unavailable. Please try again later.".into(),
        PlaudError::Api { message, .. } => message.clone(),
    }
}

fn unexpected(message: &str) -> PlaudError {
    PlaudError::Api {
        status: 0,
        message: message.into(),
    }
}

fn message_of(body: &Value, fallback: &str) -> String {
    body.get("msg")
        .and_then(Value::as_str)
        .filter(|m| !m.trim().is_empty())
        .map_or_else(|| fallback.to_owned(), str::to_owned)
}

/// Maps an HTTP answer to a result. The body's business `status` is left to the caller.
fn interpret(status: u16, retry_after: Option<u64>, body: Value) -> Result<Value, PlaudError> {
    match status {
        401 => Err(PlaudError::Rejected {
            message: message_of(&body, "Plaud rejected the token"),
        }),
        429 => Err(PlaudError::RateLimited { retry_after }),
        500..=599 => Err(PlaudError::Upstream),
        400..=499 => Err(PlaudError::Api {
            status: i64::from(status),
            message: message_of(&body, "Plaud refused the request"),
        }),
        _ => Ok(body),
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_i64().map(|n| n.to_string()))
}

fn field(v: &Value, key: &str) -> String {
    v.get(key).and_then(text).unwrap_or_default()
}

/// A device on the account. Serialized as returned by the verify and connect-token calls.
#[derive(Debug, Clone, Serialize)]
pub struct Device {
    pub sn: String,
    pub name: String,
    pub model: String,
    pub version_number: Option<i64>,
}

fn device_from(v: &Value) -> Option<Device> {
    Some(Device {
        sn: text(v.get("sn")?)?,
        name: field(v, "name"),
        model: field(v, "model"),
        version_number: v.get("version_number").and_then(Value::as_i64),
    })
}

/// One recording from the Plaud list. Every field may be missing or null in Plaud's answer.
#[derive(Debug, Clone, Deserialize)]
pub struct Recording {
    pub id: String,
    pub filename: Option<String>,
    pub duration: Option<i64>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub filesize: Option<i64>,
    pub file_md5: Option<String>,
    pub serial_number: Option<String>,
    pub version_ms: Option<i64>,
    pub timezone: Option<i64>,
    pub zonemins: Option<i64>,
    pub scene: Option<i64>,
}

/// A Plaud API base with the token to send. Built per call site; never logged.
#[derive(Clone)]
pub struct Client {
    base: String,
    token: String,
}

impl Client {
    pub fn new(base: &str, token: &str) -> Self {
        Self {
            base: base.to_owned(),
            token: token.to_owned(),
        }
    }

    /// An authenticated call with retries. A business `status` other than 0 becomes `Api`.
    pub async fn api(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, PlaudError> {
        let resp = self.exchange(method, path, body, true, true).await?;
        match resp.get("status").and_then(Value::as_i64) {
            None | Some(0) => Ok(resp),
            Some(code) => Err(PlaudError::Api {
                status: code,
                message: message_of(&resp, "Plaud refused the request"),
            }),
        }
    }

    /// One JSON call. `auth` sends the token; `retry` applies the retry policy.
    /// Only HTTP-level errors are mapped here.
    pub async fn exchange(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: bool,
        retry: bool,
    ) -> Result<Value, PlaudError> {
        let mut attempt = 0;
        loop {
            match self.send_once(&method, path, body.as_ref(), auth).await {
                Err(e) if retry && attempt < BACKOFF_SECS.len() => {
                    let wait = match &e {
                        PlaudError::RateLimited {
                            retry_after: Some(s),
                        } => *s,
                        PlaudError::RateLimited { .. } | PlaudError::Upstream => {
                            BACKOFF_SECS[attempt]
                        }
                        _ => return Err(e),
                    };
                    attempt += 1;
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                }
                other => return other,
            }
        }
    }

    async fn send_once(
        &self,
        method: &Method,
        path: &str,
        body: Option<&Value>,
        auth: bool,
    ) -> Result<Value, PlaudError> {
        let mut req = ai::client()
            .request(method.clone(), format!("{}{}", self.base, path))
            .timeout(API_TIMEOUT)
            .header(USER_AGENT, BROWSER_AGENT);
        if auth {
            req = req.header(AUTHORIZATION, format!("Bearer {}", self.token));
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let resp = req.send().await.map_err(|_| PlaudError::Upstream)?;
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let text = resp.text().await.map_err(|_| PlaudError::Upstream)?;
        interpret(
            status,
            retry_after,
            serde_json::from_str(&text).unwrap_or(Value::Null),
        )
    }

    /// The account email, lowercased. Best effort: any failure gives `None`.
    pub async fn user_email(&self) -> Option<String> {
        let v = self.api(Method::GET, "/user/me", None).await.ok()?;
        v.get("email")
            .or_else(|| v.pointer("/data/email"))
            .and_then(Value::as_str)
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty())
    }

    /// The personal workspace id: type "0", else the first workspace.
    pub async fn personal_workspace(&self) -> Result<Option<String>, PlaudError> {
        let v = self
            .api(
                Method::GET,
                "/team-app/workspaces/list?need_personal_workspace=true",
                None,
            )
            .await?;
        let list = v
            .pointer("/data/workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pick = list
            .iter()
            .find(|w| w.get("workspace_type").and_then(text).as_deref() == Some("0"))
            .or(list.first());
        Ok(pick.and_then(|w| w.get("workspace_id")).and_then(text))
    }

    /// Mints a workspace token (about 24 hours) for the workspace.
    pub async fn workspace_token(&self, workspace_id: &str) -> Result<String, PlaudError> {
        let v = self
            .api(
                Method::POST,
                &format!("/user-app/auth/workspace/token/{workspace_id}"),
                Some(json!({})),
            )
            .await?;
        v.pointer("/data/workspace_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| unexpected("Plaud did not issue a workspace token"))
    }

    pub async fn devices(&self) -> Result<Vec<Device>, PlaudError> {
        let v = self.api(Method::GET, "/device/list", None).await?;
        let list = v
            .get("data_devices")
            .and_then(Value::as_array)
            .ok_or_else(|| unexpected("Plaud returned no device list"))?;
        Ok(list.iter().filter_map(device_from).collect())
    }

    /// One page of the recording list, newest edits first, trashed recordings excluded.
    pub async fn recordings(&self, page: usize) -> Result<Vec<Recording>, PlaudError> {
        let path = format!(
            "/file/simple/web?skip={}&limit={PAGE_SIZE}&is_trash=0&sort_by=edit_time&is_desc=true",
            page * PAGE_SIZE
        );
        let v = self.api(Method::GET, &path, None).await?;
        let list = v
            .get("data_file_list")
            .cloned()
            .unwrap_or_else(|| json!([]));
        serde_json::from_value(list)
            .map_err(|_| unexpected("Plaud returned an unreadable recording list"))
    }

    /// Presigned link to the original audio (never Opus).
    pub async fn audio_url(&self, file_id: &str) -> Result<String, PlaudError> {
        let v = self
            .api(
                Method::GET,
                &format!("/file/temp-url/{file_id}?is_opus=0"),
                None,
            )
            .await?;
        v.get("temp_url")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| unexpected("Plaud returned no download link"))
    }

    /// The `data` object of a recording's detail, with its content list.
    pub async fn detail(&self, file_id: &str) -> Result<Value, PlaudError> {
        let v = self
            .api(Method::GET, &format!("/file/detail/{file_id}"), None)
            .await?;
        Ok(v.get("data").cloned().unwrap_or(Value::Null))
    }
}

/// Downloads a presigned link. No Plaud headers and one attempt.
pub async fn fetch(url: &str) -> Result<reqwest::Response, PlaudError> {
    let resp = ai::client()
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|_| PlaudError::Upstream)?;
    if !resp.status().is_success() {
        return Err(PlaudError::Upstream);
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_answers_map_to_errors() {
        assert!(matches!(
            interpret(401, None, json!({"msg": "x"})),
            Err(PlaudError::Rejected { .. })
        ));
        assert!(matches!(
            interpret(429, Some(3), Value::Null),
            Err(PlaudError::RateLimited {
                retry_after: Some(3)
            })
        ));
        assert!(matches!(
            interpret(503, None, Value::Null),
            Err(PlaudError::Upstream)
        ));
        match interpret(400, None, json!({"msg": "bad"})) {
            Err(PlaudError::Api {
                status: 400,
                message,
            }) => assert_eq!(message, "bad"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(interpret(200, None, json!({"status": -302})).is_ok());
    }

    #[test]
    fn devices_keep_serial_and_default_names() {
        let d = device_from(&json!({"sn": "SN1", "model": "PLAUD-NOTE", "version_number": 7}))
            .expect("device");
        assert_eq!(
            (
                d.sn.as_str(),
                d.name.as_str(),
                d.model.as_str(),
                d.version_number
            ),
            ("SN1", "", "PLAUD-NOTE", Some(7))
        );
        assert!(device_from(&json!({"name": "no serial"})).is_none());
    }
}
