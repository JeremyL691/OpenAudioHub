//! The Plaud web API as the app calls it (spec/plaud.md, "Plaud web API used").

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use reqwest::Method;
use reqwest::header::{AUTHORIZATION, RETRY_AFTER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::v4::{self, V4FileDetail, V4RecordingItem};
use crate::ai;

const BROWSER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const API_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Waits before each of the three retries.
const BACKOFF_SECS: [u64; 3] = [1, 2, 4];
pub const PAGE_SIZE: usize = 50;
const MAX_V4_LIST_PAGES: usize = 400;
const MAX_V4_FOLDER_PAGES: usize = 10;

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

fn encode_query_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
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
    #[serde(skip)]
    pub edit_time: Option<i64>,
    #[serde(skip)]
    pub is_v4: bool,
}

struct V4Runtime {
    v4_mode: AtomicBool,
    active_token: RwLock<String>,
    remint_lock: tokio::sync::Mutex<()>,
    list_cache: tokio::sync::Mutex<Option<Vec<Recording>>>,
    detail_cache: tokio::sync::Mutex<HashMap<String, V4FileDetail>>,
}

/// A Plaud API base with the token to send. Built per call site; never logged.
#[derive(Clone)]
pub struct Client {
    base: String,
    workspace_id: Option<String>,
    account_token: Option<String>,
    runtime: Arc<V4Runtime>,
}

impl Client {
    pub fn new(base: &str, token: &str) -> Self {
        Self::with_workspace(base, token, None, None)
    }

    pub fn with_workspace(
        base: &str,
        workspace_token: &str,
        workspace_id: Option<String>,
        account_token: Option<String>,
    ) -> Self {
        Self {
            base: base.to_owned(),
            workspace_id: workspace_id.filter(|s| !s.trim().is_empty()),
            account_token: account_token.filter(|s| !s.trim().is_empty()),
            runtime: Arc::new(V4Runtime {
                v4_mode: AtomicBool::new(false),
                active_token: RwLock::new(workspace_token.to_owned()),
                remint_lock: tokio::sync::Mutex::new(()),
                list_cache: tokio::sync::Mutex::new(None),
                detail_cache: tokio::sync::Mutex::new(HashMap::new()),
            }),
        }
    }

    fn current_token(&self) -> String {
        self.runtime
            .active_token
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn is_v4_mode(&self) -> bool {
        self.runtime.v4_mode.load(Ordering::Acquire)
    }

    fn enable_v4_mode(&self) {
        self.runtime.v4_mode.store(true, Ordering::Release);
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

    /// Calls a Plaud 4.0 route, re-minting the workspace token once on `-419` or `-420`.
    async fn v4_api(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, PlaudError> {
        let used_token = self.current_token();
        match self.api(method.clone(), path, body.clone()).await {
            Ok(v) => Ok(v),
            Err(PlaudError::Api { status, message })
                if v4::is_token_revoked_status(status)
                    && self.workspace_id.is_some()
                    && self.account_token.is_some() =>
            {
                self.remint_workspace_token(&used_token)
                    .await
                    .map_err(|e| match e {
                        PlaudError::Rejected { message } => PlaudError::Rejected { message },
                        PlaudError::RateLimited { retry_after } => {
                            PlaudError::RateLimited { retry_after }
                        }
                        PlaudError::Upstream => PlaudError::Upstream,
                        PlaudError::Api { .. } => PlaudError::Api { status, message },
                    })?;
                self.api(method, path, body).await
            }
            Err(e) => Err(e),
        }
    }

    async fn remint_workspace_token(&self, failed_token: &str) -> Result<(), PlaudError> {
        let (Some(ws), Some(acct)) = (&self.workspace_id, &self.account_token) else {
            return Err(unexpected("Plaud workspace token cannot be refreshed"));
        };
        let _guard = self.runtime.remint_lock.lock().await;
        if self.current_token() != failed_token {
            return Ok(());
        }
        let fresh = Client::new(&self.base, acct).workspace_token(ws).await?;
        let mut active = self
            .runtime
            .active_token
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *active = fresh;
        Ok(())
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
            let token = self.current_token();
            req = req.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if path.starts_with("/file-app/v4/") {
            req = req.header("app-platform", "web").header("edit-from", "web");
            if let Some(ws) = &self.workspace_id {
                req = req
                    .header("x-scope-type", "workspace")
                    .header("x-scope-id", ws);
            }
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
        if v4::is_migrated_payload(&v) {
            return Err(PlaudError::Api {
                status: v4::MIGRATED_STATUS,
                message: message_of(&v, "Account migrated to 4.0"),
            });
        }
        let list = v
            .get("data_devices")
            .and_then(Value::as_array)
            .ok_or_else(|| unexpected("Plaud returned no device list"))?;
        Ok(list.iter().filter_map(device_from).collect())
    }

    /// Validates a 4.0 session when `/device/list` returns the migrated status.
    pub async fn validate_v4_session(&self) -> Result<(), PlaudError> {
        self.enable_v4_mode();
        self.v4_api(Method::GET, "/file-app/v4/recordings/all?page_size=1", None)
            .await?;
        Ok(())
    }

    /// One page of the recording list, newest edits first, trashed recordings excluded.
    pub async fn recordings(&self, page: usize) -> Result<Vec<Recording>, PlaudError> {
        if !self.is_v4_mode() {
            let path = format!(
                "/file/simple/web?skip={}&limit={PAGE_SIZE}&is_trash=0&sort_by=edit_time&is_desc=true",
                page * PAGE_SIZE
            );
            match self.api(Method::GET, &path, None).await {
                Ok(v) if !v4::is_migrated_payload(&v) => {
                    let list = v
                        .get("data_file_list")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    return serde_json::from_value(list)
                        .map_err(|_| unexpected("Plaud returned an unreadable recording list"));
                }
                Ok(_) => self.enable_v4_mode(),
                Err(ref e) if v4::is_migrated_error(e) => self.enable_v4_mode(),
                Err(e) => return Err(e),
            }
        }
        self.recordings_v4(page).await
    }

    async fn recordings_v4(&self, page: usize) -> Result<Vec<Recording>, PlaudError> {
        let mut cache = self.runtime.list_cache.lock().await;
        if cache.is_none() {
            let mut all = Vec::new();
            let mut cursor: Option<String> = None;
            let mut seen_cursors = HashSet::new();
            for _ in 0..MAX_V4_LIST_PAGES {
                let path = match &cursor {
                    Some(c) => format!(
                        "/file-app/v4/recordings/all?sort_by=created&sort_order=desc&page_size={PAGE_SIZE}&cursor={}",
                        encode_query_value(c)
                    ),
                    None => format!(
                        "/file-app/v4/recordings/all?sort_by=created&sort_order=desc&page_size={PAGE_SIZE}"
                    ),
                };
                let resp = self.v4_api(Method::GET, &path, None).await?;
                let data = resp.get("data").unwrap_or(&Value::Null);
                let raw_items = data.get("items").cloned().unwrap_or_else(|| json!([]));
                let items: Vec<V4RecordingItem> = serde_json::from_value(raw_items)
                    .map_err(|_| unexpected("Plaud returned an unreadable recording list"))?;
                for item in &items {
                    all.push(v4::map_list_item(item));
                }
                let next = data
                    .get("next_cursor")
                    .and_then(text)
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty());
                match next {
                    Some(c) if seen_cursors.insert(c.clone()) => cursor = Some(c),
                    _ => break,
                }
            }
            v4::sort_recordings_desc(&mut all);
            *cache = Some(all);
        }
        let list = cache.as_deref().unwrap_or(&[]);
        let start = page.saturating_mul(PAGE_SIZE);
        if start >= list.len() {
            return Ok(Vec::new());
        }
        let end = (start + PAGE_SIZE).min(list.len());
        Ok(list[start..end].to_vec())
    }

    async fn fetch_v4_detail(
        &self,
        file_id: &str,
        force_refresh: bool,
    ) -> Result<V4FileDetail, PlaudError> {
        let v4_id = v4::local_id_to_v4_file_id(file_id);
        if !force_refresh
            && let Some(cached) = self.runtime.detail_cache.lock().await.get(&v4_id).cloned()
        {
            return Ok(cached);
        }
        let resp = self
            .v4_api(
                Method::GET,
                &format!("/file-app/v4/files/detail/{v4_id}"),
                None,
            )
            .await?;
        let data = resp.get("data").cloned().unwrap_or(Value::Null);
        let detail: V4FileDetail = serde_json::from_value(data)
            .map_err(|_| unexpected("Plaud returned an unreadable file detail"))?;
        self.runtime
            .detail_cache
            .lock()
            .await
            .insert(v4_id, detail.clone());
        Ok(detail)
    }

    async fn invalidate_v4_detail(&self, file_id: &str) {
        let v4_id = v4::local_id_to_v4_file_id(file_id);
        self.runtime.detail_cache.lock().await.remove(&v4_id);
    }

    async fn resolve_content_urls(
        &self,
        content_ids: &[String],
    ) -> Result<HashMap<String, String>, PlaudError> {
        if content_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let resp = self
            .v4_api(
                Method::POST,
                "/file-app/v4/files/content/url",
                Some(json!({ "content_ids": content_ids })),
            )
            .await?;
        let map = resp
            .pointer("/data/url_map")
            .or_else(|| resp.get("url_map"))
            .and_then(Value::as_object);
        let mut out = HashMap::new();
        if let Some(map) = map {
            for (k, v) in map {
                if let Some(url) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    out.insert(k.clone(), url.to_owned());
                }
            }
        }
        Ok(out)
    }

    /// Hydrates metadata for a recording from 4.0 detail when in 4.0 mode.
    pub async fn hydrate_recording(&self, r: &Recording) -> Result<Recording, PlaudError> {
        if !r.is_v4 && !self.is_v4_mode() {
            return Ok(r.clone());
        }
        let detail = self.fetch_v4_detail(&r.id, false).await?;
        Ok(v4::apply_detail(r, &detail))
    }

    /// Presigned link to the original audio (never Opus).
    pub async fn audio_url(&self, file_id: &str) -> Result<String, PlaudError> {
        if !self.is_v4_mode() {
            match self
                .api(
                    Method::GET,
                    &format!("/file/temp-url/{file_id}?is_opus=0"),
                    None,
                )
                .await
            {
                Ok(v) if !v4::is_migrated_payload(&v) => {
                    return v
                        .get("temp_url")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| unexpected("Plaud returned no download link"));
                }
                Ok(_) => self.enable_v4_mode(),
                Err(ref e) if v4::is_migrated_error(e) => self.enable_v4_mode(),
                Err(e) => return Err(e),
            }
        }
        self.audio_url_v4(file_id).await
    }

    async fn audio_url_v4(&self, file_id: &str) -> Result<String, PlaudError> {
        let detail = self.fetch_v4_detail(file_id, false).await?;
        let candidates = v4::select_audio_candidates(&detail);
        let mut last_err = None;
        for obj in candidates {
            if let Some(url) = obj
                .content_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Ok(url.to_owned());
            }
            if let Some(cid) = obj
                .content_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                match self.resolve_content_urls(&[cid.to_owned()]).await {
                    Ok(map) => {
                        if let Some(url) = map.get(cid) {
                            return Ok(url.clone());
                        }
                    }
                    Err(e @ PlaudError::Rejected { .. }) => return Err(e),
                    Err(e) => last_err = Some(e),
                }
            }
        }
        Err(last_err.unwrap_or_else(|| unexpected("Plaud returned no download link")))
    }

    /// The `data` object of a recording's detail, with its content list.
    pub async fn detail(&self, file_id: &str) -> Result<Value, PlaudError> {
        if !self.is_v4_mode() {
            match self
                .api(Method::GET, &format!("/file/detail/{file_id}"), None)
                .await
            {
                Ok(v) if !v4::is_migrated_payload(&v) => {
                    return Ok(v.get("data").cloned().unwrap_or(Value::Null));
                }
                Ok(_) => self.enable_v4_mode(),
                Err(ref e) if v4::is_migrated_error(e) => self.enable_v4_mode(),
                Err(e) => return Err(e),
            }
        }
        self.detail_v4(file_id).await
    }

    async fn detail_v4(&self, file_id: &str) -> Result<Value, PlaudError> {
        let mut detail = self.fetch_v4_detail(file_id, false).await?;
        let mut missing_ids = Vec::new();
        let mut seen = HashSet::new();
        for obj in &detail.objects {
            if v4::is_content_object(obj)
                && v4::is_object_ready(obj)
                && !v4::has_non_empty(&obj.content_url)
                && let Some(cid) = obj
                    .content_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                && seen.insert(cid.to_owned())
            {
                missing_ids.push(cid.to_owned());
            }
        }
        if !missing_ids.is_empty() {
            let url_map = self.resolve_content_urls(&missing_ids).await?;
            for obj in &mut detail.objects {
                if !v4::has_non_empty(&obj.content_url)
                    && let Some(cid) = obj.content_id.as_deref().map(str::trim)
                    && let Some(url) = url_map.get(cid)
                {
                    obj.content_url = Some(url.clone());
                }
            }
            let v4_id = v4::local_id_to_v4_file_id(file_id);
            self.runtime
                .detail_cache
                .lock()
                .await
                .insert(v4_id, detail.clone());
        }
        Ok(v4::detail_to_legacy_content(&detail))
    }

    /// Renames a recording in Plaud, using legacy `PATCH /file/{id}` or 4.0 node rename.
    pub async fn rename_file(&self, file_id: &str, title: &str) -> Result<(), PlaudError> {
        if !self.is_v4_mode() {
            match self
                .api(
                    Method::PATCH,
                    &format!("/file/{file_id}"),
                    Some(json!({ "filename": title })),
                )
                .await
            {
                Ok(v) if !v4::is_migrated_payload(&v) => return Ok(()),
                Ok(_) => self.enable_v4_mode(),
                Err(ref e) if v4::is_migrated_error(e) => self.enable_v4_mode(),
                Err(e) => return Err(e),
            }
        }
        self.rename_file_v4(file_id, title).await
    }

    async fn rename_file_v4(&self, file_id: &str, title: &str) -> Result<(), PlaudError> {
        let mut detail = self.fetch_v4_detail(file_id, false).await?;
        let mut attempt = 0;
        let (rename_resp, previous_name) = loop {
            let node = detail
                .node
                .as_ref()
                .ok_or_else(|| unexpected("Plaud file detail has no node metadata"))?;
            let node_id = node
                .node_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| unexpected("Plaud file detail has no node id"))?;
            let previous_name = node.name.clone().unwrap_or_default();
            let origin_version = node
                .version_ms
                .or_else(|| detail.meta.as_ref().and_then(|m| m.version_ms))
                .unwrap_or(0);
            let res = self
                .v4_api(
                    Method::PATCH,
                    &format!("/file-app/v4/nodes/rename/{node_id}"),
                    Some(json!({
                        "name": title,
                        "origin_version": origin_version,
                    })),
                )
                .await;
            match res {
                Ok(v) => break (v, previous_name),
                Err(PlaudError::Api { status, .. })
                    if status == v4::VERSION_CONFLICT_STATUS && attempt == 0 =>
                {
                    attempt += 1;
                    detail = self.fetch_v4_detail(file_id, true).await?;
                }
                Err(e) => return Err(e),
            }
        };

        self.invalidate_v4_detail(file_id).await;
        self.rename_container_folder_best_effort(&detail, &rename_resp, &previous_name, title)
            .await;
        Ok(())
    }

    async fn rename_container_folder_best_effort(
        &self,
        detail: &V4FileDetail,
        rename_resp: &Value,
        previous_name: &str,
        title: &str,
    ) {
        let Some(node) = &detail.node else { return };
        let Some(folder) = &node.folder else { return };
        let folder_name = folder.name.as_deref().unwrap_or_default();
        if previous_name.is_empty() || folder_name != previous_name || folder_name == title {
            return;
        }
        let Some(folder_id) = folder
            .folder_id
            .as_deref()
            .or(node.parent_id.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let parent_folder_id = node
            .display_folder
            .as_ref()
            .and_then(|f| f.folder_id.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != folder_id)
            .or_else(|| {
                node.breadcrumbs
                    .iter()
                    .filter_map(|b| b.node_id.as_deref().map(str::trim))
                    .find(|s| !s.is_empty() && *s != folder_id)
            });

        let initial = find_node_in_items(rename_resp.pointer("/data/parent_items"), folder_id)
            .or_else(|| {
                folder
                    .version_ms
                    .map(|ver| (folder_name.to_owned(), Some(ver)))
            });
        let (mut current_name, mut origin_version) = match initial {
            Some((name, Some(ver))) => (name, ver),
            _ => match self.lookup_folder_node(parent_folder_id, folder_id).await {
                Some((name, Some(ver))) => (name, ver),
                _ => return,
            },
        };
        if current_name != previous_name || current_name == title {
            return;
        }

        for attempt in 0..2 {
            let res = self
                .v4_api(
                    Method::PATCH,
                    &format!("/file-app/v4/nodes/rename/{folder_id}"),
                    Some(json!({
                        "name": title,
                        "origin_version": origin_version,
                    })),
                )
                .await;
            match res {
                Ok(_) => return,
                Err(PlaudError::Api { status, .. })
                    if status == v4::VERSION_CONFLICT_STATUS && attempt == 0 =>
                {
                    let Some((refreshed_name, Some(refreshed_ver))) =
                        self.lookup_folder_node(parent_folder_id, folder_id).await
                    else {
                        return;
                    };
                    current_name = refreshed_name;
                    origin_version = refreshed_ver;
                    if current_name != previous_name || current_name == title {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    }

    async fn lookup_folder_node(
        &self,
        parent_folder_id: Option<&str>,
        folder_id: &str,
    ) -> Option<(String, Option<i64>)> {
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        for _ in 0..MAX_V4_FOLDER_PAGES {
            let mut path = match parent_folder_id {
                Some(pid) => format!(
                    "/file-app/v4/folders/children?node_id={}&page_size={PAGE_SIZE}",
                    encode_query_value(pid)
                ),
                None => format!("/file-app/v4/folders/children?page_size={PAGE_SIZE}"),
            };
            if let Some(c) = &cursor {
                path.push_str("&cursor=");
                path.push_str(&encode_query_value(c));
            }
            let resp = self.v4_api(Method::GET, &path, None).await.ok()?;
            let items = resp
                .pointer("/data/items")
                .or_else(|| resp.pointer("/data/children"))
                .or_else(|| resp.pointer("/data/folders"))
                .or_else(|| resp.get("data"));
            if let Some(found) = find_node_in_items(items, folder_id) {
                return Some(found);
            }
            let next = resp
                .pointer("/data/next_cursor")
                .and_then(text)
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty());
            match next {
                Some(c) if seen_cursors.insert(c.clone()) => cursor = Some(c),
                _ => break,
            }
        }
        None
    }
}

fn find_node_in_items(items: Option<&Value>, target_id: &str) -> Option<(String, Option<i64>)> {
    let list = items?.as_array()?;
    let item = list.iter().find(|entry| {
        entry
            .get("node_id")
            .or_else(|| entry.get("folder_id"))
            .or_else(|| entry.get("id"))
            .and_then(Value::as_str)
            == Some(target_id)
    })?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let version_ms = item.get("version_ms").and_then(Value::as_i64);
    Some((name, version_ms))
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
    use std::sync::atomic::AtomicUsize;

    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, patch, post};
    use axum::{Json, Router};

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

    async fn spawn_mock(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn recordings_auto_detects_v4_sends_headers_paginates_and_sorts() {
        let app = Router::new()
            .route(
                "/file/simple/web",
                get(|| async {
                    Json(json!({
                        "status": v4::MIGRATED_STATUS,
                        "msg": "Account migrated to 4.0."
                    }))
                }),
            )
            .route(
                "/file-app/v4/recordings/all",
                get(
                    |headers: HeaderMap, Query(q): Query<HashMap<String, String>>| async move {
                        assert_eq!(
                            headers.get("app-platform").and_then(|v| v.to_str().ok()),
                            Some("web")
                        );
                        assert_eq!(
                            headers.get("edit-from").and_then(|v| v.to_str().ok()),
                            Some("web")
                        );
                        assert_eq!(
                            headers.get("x-scope-type").and_then(|v| v.to_str().ok()),
                            Some("workspace")
                        );
                        assert_eq!(
                            headers.get("x-scope-id").and_then(|v| v.to_str().ok()),
                            Some("ws-1")
                        );
                        match q.get("cursor").map(String::as_str) {
                            None => Json(json!({
                                "status": 0,
                                "data": {
                                    "items": [
                                        {
                                            "file_id": "f_newer_created",
                                            "name": "Newer Created",
                                            "duration_ms": 1000,
                                            "created_at_show_ms": 2000,
                                            "updated_at_show_ms": 2000,
                                            "version_ms": 2000
                                        }
                                    ],
                                    "next_cursor": "c2"
                                }
                            })),
                            Some("c2") => Json(json!({
                                "status": 0,
                                "data": {
                                    "items": [
                                        {
                                            "file_id": "of_older_edited",
                                            "name": "Older Edited",
                                            "duration_ms": 2000,
                                            "created_at_show_ms": 1000,
                                            "updated_at_show_ms": 5000,
                                            "version_ms": 5000
                                        }
                                    ],
                                    "next_cursor": "c2"
                                }
                            })),
                            other => panic!("unexpected cursor: {other:?}"),
                        }
                    },
                ),
            );
        let base = spawn_mock(app).await;
        let client =
            Client::with_workspace(&base, "wt-1", Some("ws-1".into()), Some("acct".into()));
        let page0 = client.recordings(0).await.unwrap();
        assert_eq!(page0.len(), 2);
        assert_eq!(page0[0].id, "older_edited");
        assert_eq!(page0[1].id, "f_newer_created");
        assert!(page0[0].is_v4);
        assert!(client.recordings(1).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn v4_remints_once_across_concurrent_revoked_calls_and_maps_401_to_rejected() {
        #[derive(Clone)]
        struct MockState {
            remints: Arc<AtomicUsize>,
            reject_remint: bool,
        }
        let state = MockState {
            remints: Arc::new(AtomicUsize::new(0)),
            reject_remint: false,
        };
        let app = Router::new()
            .route(
                "/file-app/v4/recordings/all",
                get(|headers: HeaderMap| async move {
                    let auth = headers
                        .get(AUTHORIZATION)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default();
                    if auth == "Bearer stale-wt" {
                        Json(json!({ "status": -419, "msg": "workspace token revoked" }))
                    } else if auth == "Bearer fresh-wt" {
                        Json(json!({ "status": 0, "data": { "items": [], "next_cursor": null } }))
                    } else {
                        panic!("unexpected auth: {auth}");
                    }
                }),
            )
            .route(
                "/user-app/auth/workspace/token/{ws}",
                post(
                    |State(s): State<MockState>, headers: HeaderMap, Path(ws): Path<String>| async move {
                        assert_eq!(ws, "ws-9");
                        assert_eq!(
                            headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()),
                            Some("Bearer acct-tok")
                        );
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        s.remints.fetch_add(1, Ordering::SeqCst);
                        if s.reject_remint {
                            (
                                StatusCode::UNAUTHORIZED,
                                Json(json!({ "msg": "expired account token" })),
                            )
                        } else {
                            (
                                StatusCode::OK,
                                Json(json!({
                                    "status": 0,
                                    "data": { "workspace_token": "fresh-wt" }
                                })),
                            )
                        }
                    },
                ),
            )
            .with_state(state.clone());
        let base = spawn_mock(app).await;
        let client = Client::with_workspace(
            &base,
            "stale-wt",
            Some("ws-9".into()),
            Some("acct-tok".into()),
        );
        let c1 = client.clone();
        let c2 = client.clone();
        let (r1, r2) = tokio::join!(c1.validate_v4_session(), c2.validate_v4_session());
        assert!(r1.is_ok());
        assert!(r2.is_ok());
        assert_eq!(state.remints.load(Ordering::SeqCst), 1);

        let rejected_state = MockState {
            remints: Arc::new(AtomicUsize::new(0)),
            reject_remint: true,
        };
        let app2 = Router::new()
            .route(
                "/file-app/v4/recordings/all",
                get(|| async { Json(json!({ "status": -420, "msg": "revoked" })) }),
            )
            .route(
                "/user-app/auth/workspace/token/{ws}",
                post(|State(s): State<MockState>| async move {
                    s.remints.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "msg": "account token invalid" })),
                    )
                }),
            )
            .with_state(rejected_state);
        let base2 = spawn_mock(app2).await;
        let client2 = Client::with_workspace(
            &base2,
            "stale-wt",
            Some("ws-9".into()),
            Some("acct-tok".into()),
        );
        assert!(matches!(
            client2.validate_v4_session().await,
            Err(PlaudError::Rejected { .. })
        ));
    }

    #[tokio::test]
    async fn audio_url_and_detail_resolve_content_ids_in_v4() {
        let app = Router::new()
            .route(
                "/file-app/v4/files/detail/{file_id}",
                get(|Path(file_id): Path<String>| async move {
                    assert_eq!(file_id, "of_rec1");
                    Json(json!({
                        "status": 0,
                        "data": {
                            "node": { "node_id": "n1", "name": "Demo", "version_ms": 10 },
                            "meta": { "file_id": "of_rec1", "duration": 1000 },
                            "objects": [
                                {
                                    "object_id": "o_audio",
                                    "object_type": "AUDIO_TRANSCODED",
                                    "content_id": "cid_audio",
                                    "content_url": null,
                                    "task_status": 1
                                },
                                {
                                    "object_id": "o_tr",
                                    "object_type": "TRANSCRIPT",
                                    "content_id": "cid_tr",
                                    "content_url": null,
                                    "task_status": 1
                                }
                            ]
                        }
                    }))
                }),
            )
            .route(
                "/file-app/v4/files/content/url",
                post(|Json(body): Json<Value>| async move {
                    let ids = body["content_ids"].as_array().unwrap();
                    let mut map = serde_json::Map::new();
                    for id in ids {
                        let s = id.as_str().unwrap();
                        map.insert(s.to_owned(), json!(format!("https://cdn.example/{s}")));
                    }
                    Json(json!({ "status": 0, "data": { "url_map": map } }))
                }),
            );
        let base = spawn_mock(app).await;
        let client = Client::with_workspace(&base, "wt", Some("ws".into()), None);
        client.enable_v4_mode();

        let audio = client.audio_url("rec1").await.unwrap();
        assert_eq!(audio, "https://cdn.example/cid_audio");

        let detail = client.detail("rec1").await.unwrap();
        let list = detail["content_list"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["data_link"], "https://cdn.example/cid_tr");
    }

    #[tokio::test]
    async fn rename_file_v4_retries_on_conflict_and_renames_matching_folder() {
        #[derive(Clone)]
        struct RenameState {
            node_version: Arc<std::sync::Mutex<i64>>,
            folder_name: Arc<std::sync::Mutex<String>>,
            folder_version: Arc<std::sync::Mutex<i64>>,
            node_conflict_once: Arc<AtomicBool>,
            folder_conflict_once: Arc<AtomicBool>,
        }
        let st = RenameState {
            node_version: Arc::new(std::sync::Mutex::new(10)),
            folder_name: Arc::new(std::sync::Mutex::new("Old Title".into())),
            folder_version: Arc::new(std::sync::Mutex::new(20)),
            node_conflict_once: Arc::new(AtomicBool::new(true)),
            folder_conflict_once: Arc::new(AtomicBool::new(true)),
        };
        let app = Router::new()
            .route(
                "/file/{id}",
                patch(|| async {
                    Json(json!({
                        "status": v4::MIGRATED_STATUS,
                        "msg": "Account migrated to 4.0"
                    }))
                }),
            )
            .route(
                "/file-app/v4/files/detail/{file_id}",
                get(|State(s): State<RenameState>| async move {
                    let nv = *s.node_version.lock().unwrap();
                    let fnm = s.folder_name.lock().unwrap().clone();
                    Json(json!({
                        "status": 0,
                        "data": {
                            "node": {
                                "node_id": "node_1",
                                "parent_id": "wrap_1",
                                "name": "Old Title",
                                "version_ms": nv,
                                "folder": { "folder_id": "wrap_1", "name": fnm },
                                "display_folder": { "folder_id": "display_parent", "name": "Projects" },
                                "breadcrumbs": [
                                    { "node_id": "root_folder", "name": "Recordings" },
                                    { "node_id": "wrap_1", "name": fnm }
                                ]
                            },
                            "meta": { "file_id": "of_1", "version_ms": nv },
                            "objects": []
                        }
                    }))
                }),
            )
            .route(
                "/file-app/v4/folders/children",
                get(
                    |State(s): State<RenameState>, Query(q): Query<HashMap<String, String>>| async move {
                        assert_eq!(q.get("node_id").map(String::as_str), Some("display_parent"));
                        assert_eq!(
                            q.get("page_size").map(String::as_str),
                            Some(PAGE_SIZE.to_string().as_str())
                        );
                        match q.get("cursor").map(String::as_str) {
                            None => Json(json!({
                                "status": 0,
                                "data": {
                                    "items": [{
                                        "node_id": "wrap_other",
                                        "name": "Other",
                                        "version_ms": 1
                                    }],
                                    "next_cursor": "fc2"
                                }
                            })),
                            Some("fc2") => {
                                let fnm = s.folder_name.lock().unwrap().clone();
                                let fv = *s.folder_version.lock().unwrap();
                                Json(json!({
                                    "status": 0,
                                    "data": {
                                        "items": [{
                                            "node_id": "wrap_1",
                                            "name": fnm,
                                            "version_ms": fv
                                        }],
                                        "next_cursor": null
                                    }
                                }))
                            }
                            other => panic!("unexpected folder cursor: {other:?}"),
                        }
                    },
                ),
            )
            .route(
                "/file-app/v4/nodes/rename/{node_id}",
                patch(
                    |State(s): State<RenameState>,
                     Path(node_id): Path<String>,
                     Json(body): Json<Value>| async move {
                        let new_name = body["name"].as_str().unwrap().to_owned();
                        let origin = body["origin_version"].as_i64().unwrap();
                        if node_id == "node_1" {
                            if s.node_conflict_once.swap(false, Ordering::SeqCst) {
                                *s.node_version.lock().unwrap() = 11;
                                return Json(json!({
                                    "status": v4::VERSION_CONFLICT_STATUS,
                                    "msg": "Version conflict"
                                }));
                            }
                            assert_eq!(origin, 11);
                            *s.node_version.lock().unwrap() = 12;
                            let fnm = s.folder_name.lock().unwrap().clone();
                            let fv = *s.folder_version.lock().unwrap();
                            Json(json!({
                                "status": 0,
                                "data": {
                                    "items": [{ "node_id": "node_1", "name": new_name, "version_ms": 12 }],
                                    "parent_items": [{ "node_id": "wrap_1", "name": fnm, "version_ms": fv }]
                                }
                            }))
                        } else if node_id == "wrap_1" {
                            if s.folder_conflict_once.swap(false, Ordering::SeqCst) {
                                *s.folder_version.lock().unwrap() = 21;
                                return Json(json!({
                                    "status": v4::VERSION_CONFLICT_STATUS,
                                    "msg": "Version conflict"
                                }));
                            }
                            assert_eq!(origin, 21);
                            *s.folder_name.lock().unwrap() = new_name.clone();
                            *s.folder_version.lock().unwrap() = 22;
                            Json(json!({
                                "status": 0,
                                "data": { "items": [{ "node_id": "wrap_1", "name": new_name, "version_ms": 22 }] }
                            }))
                        } else {
                            panic!("unexpected node_id: {node_id}");
                        }
                    },
                ),
            )
            .with_state(st.clone());
        let base = spawn_mock(app).await;
        let client = Client::with_workspace(&base, "wt", Some("ws".into()), None);
        client.rename_file("1", "New Title").await.unwrap();
        assert_eq!(*st.node_version.lock().unwrap(), 12);
        assert_eq!(st.folder_name.lock().unwrap().as_str(), "New Title");
        assert_eq!(*st.folder_version.lock().unwrap(), 22);
    }

    #[tokio::test]
    async fn devices_surfaces_message_only_migration_payload() {
        let app = Router::new().route(
            "/device/list",
            get(|| async { Json(json!({ "msg": "Account migrated to 4.0" })) }),
        );
        let base = spawn_mock(app).await;
        let client = Client::new(&base, "wt");
        let err = client.devices().await.unwrap_err();
        assert!(v4::is_migrated_error(&err), "{err:?}");
    }
}
