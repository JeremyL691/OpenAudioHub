//! Durable, signed webhook endpoints and deliveries.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use rand::Rng;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;

use crate::{
    AppState,
    auth::CurrentUser,
    db::now_ms,
    error::{ApiResult, AppError},
    ids, time,
};

/// Recording columns read for a payload.
type RecordingTuple = (String, String, i64, i64, i64, i64, i64, Option<i64>);
/// Summary columns read for a payload.
type SummaryTuple = (
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    i64,
);

const EVENTS: [&str; 7] = [
    "recording.synced",
    "recording.updated",
    "recording.deleted",
    "transcription.completed",
    "transcription.failed",
    "summary.completed",
    "summary.failed",
];
const MAX_RESPONSE_BODY: usize = 4096;
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const LEASE_MS: i64 = 15 * 60 * 1000;
static WAKEUP: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings/webhooks", get(list).post(create))
        .route(
            "/api/settings/webhooks/{id}",
            axum::routing::patch(update).delete(remove),
        )
        .route("/api/settings/webhooks/{id}/deliveries", get(deliveries))
        .route(
            "/api/settings/webhooks/{id}/deliveries/{delivery_id}/redeliver",
            post(redeliver),
        )
}

/// Records the event envelope and its subscriber deliveries durably. The recording data is built
/// for each send, matching the documented retry and manual-redelivery semantics.
/// Like `emit`, for callers whose own work must not fail because of a webhook: errors are logged.
pub async fn emit_soft(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    event: &str,
    failure: Option<&str>,
) {
    if let Err(error) = emit(state, user_id, recording_id, event, failure).await {
        tracing::error!(%error, event, "webhook event was not recorded");
    }
}

pub async fn emit(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    event: &str,
    failure: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut tx = crate::db::begin_write(&state.db).await?;
    let wrote = record_in(&mut tx, state, user_id, recording_id, event, failure, None).await?;
    tx.commit().await?;
    if wrote {
        WAKEUP.notify_one();
    }
    Ok(())
}

/// Records an event and its subscriber deliveries inside the caller's transaction.
///
/// `dedupe_key` makes the registration repeatable: a save that runs twice for the same transcript
/// passes the same key, and a delivery that was already recorded is left alone. The key is per
/// endpoint, so a second endpoint subscribed later still gets its own delivery.
///
/// Returns whether any delivery was added, so the caller can wake the worker after it commits.
pub async fn record_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    event: &str,
    failure: Option<&str>,
    dedupe_key: Option<&str>,
) -> Result<bool, sqlx::Error> {
    if !EVENTS.contains(&event) {
        tracing::error!(event, "unknown webhook event dropped");
        return Ok(false);
    }
    let now = now_ms();
    let event_json = serde_json::to_string(&Envelope {
        event: event.to_owned(),
        delivered_at: time::iso(now),
        error: failure.map(|message| Failure {
            message: message.to_owned(),
        }),
    })
    .expect("webhook envelope serializes");
    let encrypted_payload = state.config.field_key.encrypt(&event_json);
    let endpoints: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, events FROM webhook_endpoints WHERE user_id = ? AND enabled = 1",
    )
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut wrote = false;
    for (endpoint, subscribed) in endpoints {
        let subscriptions: Vec<String> = serde_json::from_str(&subscribed).unwrap_or_default();
        if !subscriptions.iter().any(|candidate| candidate == event) {
            continue;
        }
        let key = dedupe_key.map(|key| format!("{key}:{endpoint}"));
        let inserted = sqlx::query(
            "INSERT INTO webhook_deliveries (id, endpoint_id, user_id, recording_id, event, delivered_at, payload, next_attempt_at, created_at, updated_at, dedupe_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
        )
        .bind(ids::new_id())
        .bind(endpoint)
        .bind(user_id)
        .bind(recording_id)
        .bind(event)
        .bind(now)
        .bind(&encrypted_payload)
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(key)
        .execute(&mut **tx)
        .await?;
        wrote |= inserted.rows_affected() == 1;
    }
    Ok(wrote)
}

/// Wakes the delivery worker, for a caller that recorded a delivery in its own transaction.
pub fn wake() {
    WAKEUP.notify_one();
}

pub fn spawn(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        warn_blocked_targets(&state).await;
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! { _ = tick.tick() => {}, _ = WAKEUP.notified() => {} }
            if let Err(error) = deliver_due(&state).await {
                tracing::error!(%error, "webhook worker run failed");
            }
        }
    });
}

/// Tells the operator once, at startup, how many stored targets the strict policy will refuse.
/// The check does not resolve names, so a target that merely resolves to a private address is
/// not counted here and only fails when it is delivered.
async fn warn_blocked_targets(state: &AppState) {
    if !state.config.webhooks_strict {
        return;
    }
    let urls: Vec<String> = match sqlx::query_scalar("SELECT url FROM webhook_endpoints")
        .fetch_all(&state.db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(%error, "could not read webhook targets");
            return;
        }
    };
    let blocked = urls
        .iter()
        .filter(|raw| {
            state
                .config
                .field_key
                .decrypt(raw)
                .map(|plain| strict_blocked(&plain))
                .unwrap_or(true)
        })
        .count();
    if blocked > 0 {
        tracing::warn!(
            blocked,
            total = urls.len(),
            "webhook targets are not allowed by WEBHOOKS_REQUIRE_PUBLIC_TARGETS; set it to false to deliver to private addresses"
        );
    }
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let rows: Vec<EndpointRow> = sqlx::query_as("SELECT id,user_id,url,secret,events,description,enabled,last_delivery_at,last_delivery_status,created_at,updated_at FROM webhook_endpoints WHERE user_id = ? ORDER BY created_at DESC")
        .bind(&user.id).fetch_all(&state.db).await?;
    let values = rows
        .iter()
        .map(|row| endpoint_json(&state, row))
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(json!({"webhooks":values,"events":EVENTS})))
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> ApiResult<impl IntoResponse> {
    let url = parse_url(
        body.get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("url", "URL is required"))?,
    )?;
    validate_target(&url, state.config.webhooks_strict)
        .await
        .map_err(|_| invalid("url", "The URL is not allowed"))?;
    let events = parse_events(body.get("events"))?;
    let description = description(body.get("description"));
    let enabled = body.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let secret = new_secret();
    let now = now_ms();
    let id = ids::new_id();
    let row = EndpointRow {
        id: id.clone(),
        user_id: user.id.clone(),
        url: state.config.field_key.encrypt(url.as_str()),
        secret: state.config.field_key.encrypt(&secret),
        events: serde_json::to_string(&events).unwrap(),
        description,
        enabled,
        last_delivery_at: None,
        last_delivery_status: None,
        created_at: now,
        updated_at: now,
    };
    sqlx::query("INSERT INTO webhook_endpoints (id,user_id,url,secret,events,description,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(&row.id).bind(&row.user_id).bind(&row.url).bind(&row.secret).bind(&row.events).bind(&row.description).bind(row.enabled).bind(now).bind(now).execute(&state.db).await?;
    let view = endpoint_json(&state, &row)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"webhook":view,"secret":secret})),
    ))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut row = find_endpoint(&state, &user.id, &id)
        .await?
        .ok_or_else(not_found_endpoint)?;
    if let Some(value) = body.get("url") {
        let url = parse_url(
            value
                .as_str()
                .ok_or_else(|| invalid("url", "URL is required"))?,
        )?;
        validate_target(&url, state.config.webhooks_strict)
            .await
            .map_err(|_| invalid("url", "The URL is not allowed"))?;
        row.url = state.config.field_key.encrypt(url.as_str());
    }
    if let Some(value) = body.get("events") {
        row.events = serde_json::to_string(&parse_events(Some(value))?).unwrap();
    }
    if let Some(value) = body.get("enabled") {
        row.enabled = value
            .as_bool()
            .ok_or_else(|| invalid("enabled", "enabled must be a boolean"))?;
    }
    if let Some(value) = body.get("description") {
        row.description = description(Some(value));
    }
    row.updated_at = now_ms();
    sqlx::query("UPDATE webhook_endpoints SET url=?,events=?,description=?,enabled=?,updated_at=? WHERE id=? AND user_id=?")
        .bind(&row.url).bind(&row.events).bind(&row.description).bind(row.enabled).bind(row.updated_at).bind(&id).bind(&user.id).execute(&state.db).await?;
    Ok(Json(json!({"webhook":endpoint_json(&state,&row)?})))
}

async fn remove(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let result = sqlx::query("DELETE FROM webhook_endpoints WHERE id=? AND user_id=?")
        .bind(id)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(not_found_endpoint());
    }
    Ok(Json(json!({"success":true})))
}

async fn deliveries(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if find_endpoint(&state, &user.id, &id).await?.is_none() {
        return Err(not_found_endpoint());
    }
    let rows: Vec<DeliveryRow> = sqlx::query_as("SELECT id,endpoint_id,user_id,recording_id,event,delivered_at,payload,status,attempts,next_attempt_at,claimed_at,last_attempt_at,last_response_status,last_response_body,last_error,created_at,updated_at FROM webhook_deliveries WHERE endpoint_id=? AND user_id=? ORDER BY created_at DESC LIMIT 100")
        .bind(&id).bind(&user.id).fetch_all(&state.db).await?;
    let values = rows.iter().map(delivery_json).collect::<Vec<_>>();
    Ok(Json(json!({"deliveries":values})))
}

async fn redeliver(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((id, delivery_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let endpoint = find_endpoint(&state, &user.id, &id)
        .await?
        .ok_or_else(not_found_endpoint)?;
    if !endpoint.enabled {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "Webhook is disabled",
        ));
    }
    let status: Option<String> = sqlx::query_scalar(
        "SELECT status FROM webhook_deliveries WHERE id=? AND endpoint_id=? AND user_id=?",
    )
    .bind(&delivery_id)
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.db)
    .await?;
    let status = status.ok_or_else(not_found_delivery)?;
    if status == "processing" {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "Delivery is already processing",
        ));
    }
    let now = now_ms();
    sqlx::query("UPDATE webhook_deliveries SET status='pending',next_attempt_at=?,claimed_at=NULL,updated_at=? WHERE id=? AND endpoint_id=? AND user_id=? AND status!='processing'")
        .bind(now).bind(now).bind(&delivery_id).bind(&id).bind(&user.id).execute(&state.db).await?;
    deliver_one(&state, &delivery_id).await;
    Ok(Json(json!({"success":true})))
}

#[derive(Clone, sqlx::FromRow)]
struct EndpointRow {
    id: String,
    user_id: String,
    url: String,
    secret: String,
    events: String,
    description: Option<String>,
    enabled: bool,
    last_delivery_at: Option<i64>,
    last_delivery_status: Option<String>,
    created_at: i64,
    updated_at: i64,
}
#[derive(Clone, sqlx::FromRow)]
struct DeliveryRow {
    id: String,
    event: String,
    status: String,
    attempts: i64,
    next_attempt_at: i64,
    last_attempt_at: Option<i64>,
    last_response_status: Option<i64>,
    last_response_body: Option<String>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

async fn find_endpoint(state: &AppState, user: &str, id: &str) -> ApiResult<Option<EndpointRow>> {
    Ok(sqlx::query_as("SELECT id,user_id,url,secret,events,description,enabled,last_delivery_at,last_delivery_status,created_at,updated_at FROM webhook_endpoints WHERE id=? AND user_id=?")
        .bind(id).bind(user).fetch_optional(&state.db).await?)
}
fn endpoint_json(state: &AppState, row: &EndpointRow) -> ApiResult<Value> {
    let secret = state
        .config
        .field_key
        .decrypt(&row.secret)
        .map_err(AppError::internal)?;
    let masked = format!(
        "whsec_****{}",
        secret
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    );
    Ok(
        json!({"id":row.id,"url":state.config.field_key.decrypt(&row.url).map_err(AppError::internal)?,"secret":masked,"events":serde_json::from_str::<Value>(&row.events).unwrap_or(json!([])),"description":row.description,"enabled":row.enabled,"lastDeliveryAt":row.last_delivery_at.map(time::iso),"lastDeliveryStatus":row.last_delivery_status,"createdAt":time::iso(row.created_at),"updatedAt":time::iso(row.updated_at)}),
    )
}
fn delivery_json(row: &DeliveryRow) -> Value {
    json!({"id":row.id,"event":row.event,"status":row.status,"attempts":row.attempts,"lastAttemptAt":row.last_attempt_at.map(time::iso),"nextAttemptAt":time::iso(row.next_attempt_at),"lastResponseStatus":row.last_response_status,"lastResponseBody":row.last_response_body,"lastError":row.last_error,"createdAt":time::iso(row.created_at),"updatedAt":time::iso(row.updated_at)})
}

fn parse_url(raw: &str) -> ApiResult<reqwest::Url> {
    let value = raw.trim();
    let url = reqwest::Url::parse(value).map_err(|_| invalid("url", "URL must be absolute"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid(
            "url",
            "URL must use HTTP or HTTPS and contain no credentials",
        ));
    }
    Ok(url)
}
/// Whether the strict policy refuses a stored target without resolving its host. Used by the
/// startup audit, which must not do DNS lookups.
fn strict_blocked(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        return true;
    };
    if url.scheme() != "https" {
        return true;
    }
    let Ok((host, literal)) = split_host(&url) else {
        return true;
    };
    if blocked_name(&host) {
        return true;
    }
    literal.is_some_and(|ip| !public_ip(ip))
}

fn parse_events(value: Option<&Value>) -> ApiResult<Vec<String>> {
    let Some(items) = value.and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return Err(invalid("events", "Choose at least one event"));
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut unknown = Vec::new();
    for item in items {
        let Some(event) = item.as_str() else {
            unknown.push("(invalid value)".to_owned());
            continue;
        };
        if !EVENTS.contains(&event) {
            unknown.push(event.into());
        } else if seen.insert(event) {
            out.push(event.to_owned());
        }
    }
    if !unknown.is_empty() {
        return Err(invalid(
            "events",
            format!("Unknown webhook events: {}", unknown.join(", ")),
        ));
    }
    Ok(out)
}
fn description(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(200).collect())
}
fn new_secret() -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let mut rng = rand::rng();
    let mut out = String::from("whsec_");
    for _ in 0..32 {
        out.push(alphabet[rng.random_range(0..alphabet.len())] as char);
    }
    out
}
fn invalid(field: &'static str, message: impl Into<String>) -> AppError {
    AppError::bad_request("INVALID_INPUT", message).detail("field", field)
}
fn not_found_endpoint() -> AppError {
    AppError::not_found("NOT_FOUND", "Webhook not found")
}
fn not_found_delivery() -> AppError {
    AppError::not_found("NOT_FOUND", "Delivery not found")
}

#[derive(Serialize, serde::Deserialize)]
struct Failure {
    message: String,
}
#[derive(Serialize, serde::Deserialize)]
struct Envelope {
    event: String,
    delivered_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
}
#[derive(Serialize)]
struct Payload<'a> {
    event: &'a str,
    delivered_at: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a Failure>,
    data: RecordingData,
}
#[derive(Serialize)]
struct Links {
    #[serde(rename = "self")]
    self_url: String,
    transcript: String,
    audio: String,
}
#[derive(Serialize)]
struct Device {
    serial_number: String,
    name: Option<String>,
    model: Option<String>,
}
#[derive(Serialize)]
struct TranscriptData {
    source: String,
    preview: String,
    truncated: bool,
    length: usize,
    language: Option<String>,
    provider: String,
    model: String,
    created_at: String,
}
#[derive(Serialize)]
struct SummaryData {
    text: String,
    action_items: Value,
    key_points: Value,
    provider: String,
    model: String,
    created_at: String,
}
#[derive(Serialize)]
struct RecordingData {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    recorded_at: String,
    duration_ms: i64,
    filesize_bytes: i64,
    device: Option<Device>,
    has_transcription: bool,
    has_summary: bool,
    links: Links,
    transcript: Option<TranscriptData>,
    summary: Option<SummaryData>,
    api_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<String>,
}

async fn build_payload(
    state: &AppState,
    user: &str,
    recording: &str,
    envelope: &Envelope,
) -> Result<Option<String>, String> {
    let row: Option<RecordingTuple> = sqlx::query_as("SELECT device_sn,filename,created_at,updated_at,start_time,duration,filesize,deleted_at FROM recordings WHERE id=? AND user_id=?")
        .bind(recording).bind(user).fetch_optional(&state.db).await.map_err(|e|e.to_string())?;
    let Some((device_sn, filename, created, updated, recorded, duration, filesize, deleted)) = row
    else {
        return Ok(None);
    };
    let title = state
        .config
        .field_key
        .decrypt(&filename)
        .map_err(|e| e.to_string())?;
    let is_deleted = envelope.event == "recording.deleted";
    let device_row: Option<(String, String)> =
        sqlx::query_as("SELECT name,model FROM plaud_devices WHERE user_id=? AND serial_number=?")
            .bind(user)
            .bind(&device_sn)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let device = device_row
        .map(|(name, model)| Device {
            serial_number: device_sn.clone(),
            name: Some(name),
            model: Some(model),
        })
        .or(Some(Device {
            serial_number: device_sn,
            name: None,
            model: None,
        }));
    let transcript = if is_deleted {
        None
    } else {
        let t:Option<(String,Option<String>,String,String,i64)>=sqlx::query_as("SELECT text,detected_language,provider,model,created_at FROM transcriptions WHERE recording_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1")
            .bind(recording).bind(user).fetch_optional(&state.db).await.map_err(|e|e.to_string())?;
        if let Some((text, language, provider, model, at)) = t {
            let text = state
                .config
                .field_key
                .decrypt(&text)
                .map_err(|e| e.to_string())?;
            let length = text.chars().count();
            let preview = text.chars().take(500).collect::<String>();
            Some(TranscriptData {
                source: "openaudiohub".into(),
                preview,
                truncated: length > 500,
                length,
                language,
                provider,
                model,
                created_at: time::iso(at),
            })
        } else {
            None
        }
    };
    let summary = if is_deleted {
        None
    } else {
        let s: Option<SummaryTuple> = sqlx::query_as("SELECT summary,action_items,key_points,provider,model,created_at FROM ai_enhancements WHERE recording_id=? AND user_id=? AND summary IS NOT NULL")
            .bind(recording).bind(user).fetch_optional(&state.db).await.map_err(|e|e.to_string())?;
        if let Some((text, actions, points, provider, model, at)) = s {
            let text = state
                .config
                .field_key
                .decrypt(text.as_deref().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            let decode = |v: Option<String>| -> Result<Value, String> {
                match v {
                    // Stored as a `{"c": ...}` envelope, or as plain JSON from older rows.
                    Some(raw) => {
                        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                        state
                            .config
                            .field_key
                            .decrypt_json(&value)
                            .map_err(|e| e.to_string())
                    }
                    None => Ok(json!([])),
                }
            };
            Some(SummaryData {
                text,
                action_items: decode(actions)?,
                key_points: decode(points)?,
                provider,
                model,
                created_at: time::iso(at),
            })
        } else {
            None
        }
    };
    let self_url = format!(
        "{}/api/v1/recordings/{recording}",
        state.config.app_url.trim_end_matches('/')
    );
    let data = RecordingData {
        id: recording.to_owned(),
        title,
        created_at: time::iso(created),
        updated_at: time::iso(updated),
        recorded_at: time::iso(recorded),
        duration_ms: duration,
        filesize_bytes: filesize,
        has_transcription: transcript.is_some(),
        has_summary: summary.is_some(),
        device,
        links: Links {
            self_url: self_url.clone(),
            transcript: format!("{self_url}/transcript"),
            audio: format!("{self_url}/audio"),
        },
        transcript,
        summary,
        api_url: self_url,
        deleted_at: if is_deleted {
            Some(time::iso(deleted.unwrap_or(updated)))
        } else {
            None
        },
    };
    let payload = Payload {
        event: &envelope.event,
        delivered_at: &envelope.delivered_at,
        error: envelope.error.as_ref(),
        data,
    };
    serde_json::to_string(&payload)
        .map(Some)
        .map_err(|e| e.to_string())
}

async fn deliver_due(state: &AppState) -> Result<(), sqlx::Error> {
    let now = now_ms();
    let candidates:Vec<(String,String)>=sqlx::query_as("SELECT id,user_id FROM webhook_deliveries WHERE (status='pending' AND next_attempt_at<=?) OR (status='processing' AND claimed_at<?) ORDER BY next_attempt_at,created_at LIMIT 250")
        .bind(now).bind(now-LEASE_MS).fetch_all(&state.db).await?;
    let mut user_counts = HashMap::<String, usize>::new();
    let mut processed = 0;
    for (id, user) in candidates {
        if processed >= 50 {
            break;
        }
        let count = user_counts.get(&user).copied().unwrap_or(0);
        if count >= 10 {
            continue;
        }
        let changed=sqlx::query("UPDATE webhook_deliveries SET status='processing',claimed_at=?,updated_at=? WHERE id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='processing' AND claimed_at<?))")
            .bind(now).bind(now).bind(&id).bind(now).bind(now-LEASE_MS).execute(&state.db).await?.rows_affected();
        if changed == 1 {
            *user_counts.entry(user).or_default() += 1;
            processed += 1;
            deliver_claimed(state, &id).await;
        }
    }
    Ok(())
}

async fn deliver_one(state: &AppState, id: &str) {
    let now = now_ms();
    let changed=sqlx::query("UPDATE webhook_deliveries SET status='processing',claimed_at=?,updated_at=? WHERE id=? AND status='pending'")
        .bind(now).bind(now).bind(id).execute(&state.db).await.map(|r|r.rows_affected()).unwrap_or(0);
    if changed == 1 {
        deliver_claimed(state, id).await;
    }
}

async fn deliver_claimed(state: &AppState, id: &str) {
    let row:Option<(String,String,String,String,String,i64)>=sqlx::query_as("SELECT d.endpoint_id,d.user_id,d.recording_id,d.event,d.payload,d.attempts FROM webhook_deliveries d WHERE d.id=? AND d.status='processing'")
        .bind(id).fetch_optional(&state.db).await.unwrap_or(None);
    let Some((endpoint_id, user, recording, event, encrypted_envelope, attempts)) = row else {
        return;
    };
    let endpoint:Option<EndpointRow>=sqlx::query_as("SELECT id,user_id,url,secret,events,description,enabled,last_delivery_at,last_delivery_status,created_at,updated_at FROM webhook_endpoints WHERE id=? AND user_id=?")
        .bind(&endpoint_id).bind(&user).fetch_optional(&state.db).await.unwrap_or(None);
    let Some(endpoint) = endpoint else { return };
    if !endpoint.enabled {
        let _=sqlx::query("UPDATE webhook_deliveries SET status='pending',claimed_at=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND status='processing'").bind(now_ms()).bind(now_ms()).bind(id).execute(&state.db).await;
        return;
    }
    let envelope = match state
        .config
        .field_key
        .decrypt(&encrypted_envelope)
        .ok()
        .and_then(|s| serde_json::from_str::<Envelope>(&s).ok())
    {
        Some(e) => e,
        None => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some("Stored webhook payload is unreadable"),
                true,
            )
            .await;
            return;
        }
    };
    let payload = match build_payload(state, &user, &recording, &envelope).await {
        Ok(Some(payload)) => payload,
        Ok(None) => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some("Recording is no longer available"),
                true,
            )
            .await;
            return;
        }
        Err(error) => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some(&error),
                true,
            )
            .await;
            return;
        }
    };
    let url = match state
        .config
        .field_key
        .decrypt(&endpoint.url)
        .ok()
        .and_then(|s| reqwest::Url::parse(&s).ok())
    {
        Some(url) => url,
        None => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some("Webhook URL is invalid"),
                true,
            )
            .await;
            return;
        }
    };
    let checked = match validate_target(&url, state.config.webhooks_strict).await {
        Ok(x) => x,
        Err(e) => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some(&e),
                true,
            )
            .await;
            return;
        }
    };
    let secret = match state.config.field_key.decrypt(&endpoint.secret) {
        Ok(s) => s,
        Err(_) => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some("Webhook secret is unreadable"),
                true,
            )
            .await;
            return;
        }
    };
    let timestamp = (now_ms() / 1000).to_string();
    let signed = format!("{timestamp}.{payload}");
    let signature = signature(&secret, signed.as_bytes());
    // Response text is kept only for targets the strict policy proved public, so a delivery
    // to an internal address cannot be used to read that address back through the API.
    let keep_body = checked.is_some();
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some((host, addresses)) = checked {
        // The address was checked, so the request must go there directly: a proxy taken from the
        // environment would resolve the host again and could reach a different address.
        builder = builder.no_proxy().resolve_to_addrs(&host, &addresses);
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(e) => {
            finish_delivery(
                state,
                id,
                &endpoint_id,
                attempts + 1,
                None,
                None,
                Some(&e.to_string()),
                false,
            )
            .await;
            return;
        }
    };
    let mut headers = HeaderMap::new();
    for (name, value) in [
        ("content-type", "application/json"),
        ("user-agent", "OpenAudioHub-Webhooks/1"),
        ("x-openaudiohub-event", &event),
        ("x-openaudiohub-delivery", id),
        ("x-openaudiohub-timestamp", &timestamp),
        ("x-openaudiohub-signature", &signature),
    ] {
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.insert(n, v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(&payload.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, v);
    }
    let response = client
        .post(url)
        .headers(headers)
        .body(payload)
        .timeout(DELIVERY_TIMEOUT)
        .send()
        .await;
    let (status, body, error) = match response {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let body = if keep_body {
                Some(read_limited(&mut response).await.unwrap_or_default())
            } else {
                None
            };
            if (200..300).contains(&status) {
                (Some(status), body, None)
            } else {
                (Some(status), body, Some(format!("HTTP {status}")))
            }
        }
        Err(error) => {
            let message = if error.is_timeout() {
                "Webhook delivery timed out".to_owned()
            } else {
                error.to_string()
            };
            (None, None, Some(message))
        }
    };
    finish_delivery(
        state,
        id,
        &endpoint_id,
        attempts + 1,
        status,
        body.as_deref(),
        error.as_deref(),
        false,
    )
    .await;
}

async fn read_limited(response: &mut reqwest::Response) -> Result<String, String> {
    let mut bytes = Vec::new();
    while bytes.len() < MAX_RESPONSE_BODY * 4 {
        let chunk = response.chunk().await.map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        let remaining = MAX_RESPONSE_BODY * 4 - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if bytes.len() >= MAX_RESPONSE_BODY * 4 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.chars().take(MAX_RESPONSE_BODY).collect())
}

#[allow(clippy::too_many_arguments)]
async fn finish_delivery(
    state: &AppState,
    id: &str,
    endpoint: &str,
    attempt: i64,
    status: Option<u16>,
    body: Option<&str>,
    error: Option<&str>,
    permanent: bool,
) {
    let now = now_ms();
    let succeeded = status.is_some_and(|s| (200..300).contains(&s));
    let (state_name, next, error_value) = if succeeded {
        ("success", now, None)
    } else if permanent || attempt >= 6 {
        ("dead", now, error.map(str::to_owned))
    } else {
        let delay = [30, 120, 600, 3600, 21600][(attempt - 1).clamp(0, 4) as usize];
        ("pending", now + delay * 1000, error.map(str::to_owned))
    };
    let _=sqlx::query("UPDATE webhook_deliveries SET status=?,attempts=?,next_attempt_at=?,claimed_at=NULL,last_attempt_at=?,last_response_status=?,last_response_body=?,last_error=?,updated_at=? WHERE id=?")
        .bind(state_name).bind(attempt).bind(next).bind(now).bind(status.map(i64::from)).bind(body).bind(error_value).bind(now).bind(id).execute(&state.db).await;
    let _=sqlx::query("UPDATE webhook_endpoints SET last_delivery_at=?,last_delivery_status=?,updated_at=? WHERE id=?")
        .bind(now).bind(if succeeded{"success"}else{"failed"}).bind(now).bind(endpoint).execute(&state.db).await;
    if state_name == "pending" {
        WAKEUP.notify_one();
    }
}

fn signature(secret: &str, message: &[u8]) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any secret length");
    mac.update(message);
    hex::encode(mac.finalize().into_bytes())
}

async fn validate_target(
    url: &reqwest::Url,
    strict: bool,
) -> Result<Option<(String, Vec<SocketAddr>)>, String> {
    if !strict {
        return Ok(None);
    }
    if url.scheme() != "https" {
        return Err("Strict webhook targets require HTTPS".into());
    }
    let (host, literal) = split_host(url)?;
    if blocked_name(&host) {
        return Err("Webhook host is not public".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or("Webhook URL has no port")?;
    let addresses: Vec<SocketAddr> = match literal {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|e| e.to_string())?
            .collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err("Webhook host does not resolve exclusively to public addresses".into());
    }
    Ok(Some((host, addresses)))
}

/// The host of a URL without brackets, plus its address when the URL holds an IP literal.
fn split_host(url: &reqwest::Url) -> Result<(String, Option<IpAddr>), String> {
    let raw = url.host_str().ok_or("Webhook URL has no host")?;
    // `host_str` keeps the brackets of an IPv6 literal.
    let host = raw
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let literal = host.parse::<IpAddr>().ok();
    Ok((host, literal))
}

/// Names that never count as public, whatever they resolve to.
fn blocked_name(host: &str) -> bool {
    host == "localhost"
        || [".localhost", ".local", ".internal", ".home.arpa", ".lan"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = ip.segments();
            // Translations and tunnels carry an IPv4 address that decides reachability.
            if let Some(v4) = embedded_v4(ip) {
                return public_v4(v4);
            }
            !(ip.is_unspecified()
                || ip.is_loopback()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xff00) == 0xff00
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || (s[0] == 0x0100 && s[1..4] == [0, 0, 0]))
        }
    }
}

/// The IPv4 address inside a transition address: NAT64 `64:ff9b::/96` or 6to4 `2002::/16`.
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    if s[0..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return Some(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            s[6] as u8,
            (s[7] >> 8) as u8,
            s[7] as u8,
        ));
    }
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    None
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(o[0] == 0
        || o[0] == 10
        || o[0] == 127
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || o[0] >= 224)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_ipv4_addresses_use_the_ipv4_rules() {
        // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address that must be checked,
        // otherwise a private target slips past the public-address rule.
        for text in [
            "64:ff9b::a00:1",    // 10.0.0.1
            "64:ff9b::c0a8:101", // 192.168.1.1
            "64:ff9b::7f00:1",   // 127.0.0.1
            "2002:a00:1::",      // 10.0.0.1
            "2002:c0a8:101::1",  // 192.168.1.1
            "::ffff:10.0.0.1",   // IPv4-mapped
        ] {
            let ip: IpAddr = text.parse().unwrap();
            assert!(!public_ip(ip), "{text} must not count as public");
        }
        for text in ["64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111"] {
            let ip: IpAddr = text.parse().unwrap();
            assert!(public_ip(ip), "{text} must count as public");
        }
    }

    #[test]
    fn the_discard_prefix_is_not_public() {
        let ip: IpAddr = "100::1".parse().unwrap();
        assert!(!public_ip(ip));
    }

    #[test]
    fn stored_targets_are_flagged_when_strict_mode_refuses_them_without_a_lookup() {
        // The startup audit cannot resolve names, so it reports only what the URL itself shows.
        for url in [
            "http://example.com/hook",
            "https://localhost/hook",
            "https://hook.local/hook",
            "https://127.0.0.1/hook",
            "https://192.168.1.10/hook",
            "https://[::1]/hook",
        ] {
            assert!(strict_blocked(url), "{url} must be reported");
        }
        for url in [
            "https://example.com/hook",
            "https://hooks.example.org:8443/x",
        ] {
            assert!(!strict_blocked(url), "{url} must not be reported");
        }
        // A target that is not a URL can no longer be delivered either.
        assert!(strict_blocked("not a url"));
    }

    #[tokio::test]
    async fn strict_targets_refuse_plain_http_and_private_hosts() {
        for url in [
            "http://example.com/hook",
            "https://localhost/hook",
            "https://127.0.0.1/hook",
            "https://192.168.1.10/hook",
            "https://hook.lan/hook",
        ] {
            let parsed = parse_url(url).unwrap();
            assert!(
                validate_target(&parsed, true).await.is_err(),
                "{url} must be refused in strict mode"
            );
        }
        // The lenient policy keeps accepting them for local use.
        for url in ["http://example.com/hook", "https://192.168.1.10/hook"] {
            let parsed = parse_url(url).unwrap();
            assert!(validate_target(&parsed, false).await.is_ok(), "{url}");
        }
    }
}
