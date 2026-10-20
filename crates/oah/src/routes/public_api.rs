//! Personal read-only API keys and the public HTTP API under /api/v1.
use crate::{
    AppState,
    auth::{self, CurrentUser},
    db::now_ms,
    error::{ApiResult, AppError},
    ids,
    time::{iso, parse_iso},
};
use axum::extract::{ConnectInfo, FromRequestParts, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header, request::Parts};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::FromRow;
use std::collections::HashMap;
use std::net::SocketAddr;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings/api-keys", get(list_keys).post(create_key))
        .route("/api/settings/api-keys/{id}", delete(revoke_key))
        .route("/api/v1/recordings", get(list_recordings))
        .route("/api/v1/recordings/{id}", get(recording_detail))
        .route(
            "/api/v1/recordings/{id}/transcript",
            get(recording_transcript),
        )
        .route("/api/v1/recordings/{id}/audio", get(recording_audio))
}

#[derive(FromRow)]
struct KeyRow {
    id: String,
    name: String,
    key_prefix: String,
    source: String,
    scopes: String,
    last_used_at: Option<i64>,
    expires_at: Option<i64>,
    revoked_at: Option<i64>,
    created_at: i64,
}
impl KeyRow {
    fn json(self) -> Value {
        json!({"id":self.id,"name":self.name,"keyPrefix":self.key_prefix,"source":self.source,
        "scopes":serde_json::from_str::<Value>(&self.scopes).unwrap_or(json!(["read"])),
        "lastUsedAt":self.last_used_at.map(iso),"expiresAt":self.expires_at.map(iso),"revokedAt":self.revoked_at.map(iso),"createdAt":iso(self.created_at)})
    }
}
const KEY_COLUMNS: &str =
    "id,name,key_prefix,source,scopes,last_used_at,expires_at,revoked_at,created_at";
async fn list_keys(user: CurrentUser, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<KeyRow> = sqlx::query_as(&format!(
        "SELECT {KEY_COLUMNS} FROM api_keys WHERE user_id=? ORDER BY created_at DESC,id DESC"
    ))
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({"apiKeys":rows.into_iter().map(KeyRow::json).collect::<Vec<_>>()}),
    ))
}
fn invalid(field: &str, message: &str) -> AppError {
    AppError::bad_request("INVALID_INPUT", message).detail("field", field)
}
async fn create_key(
    user: CurrentUser,
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err(
            AppError::bad_request("MISSING_REQUIRED_FIELD", "Name is required")
                .detail("field", "name"),
        );
    }
    if name.chars().count() > 120 {
        return Err(invalid("name", "Name must be 120 characters or fewer"));
    }
    let now = now_ms();
    let expiry = match body.get("expiresAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(
            parse_iso(s)
                .filter(|t| *t > now)
                .ok_or_else(|| invalid("expiresAt", "Expiry must be a future timestamp"))?,
        ),
        _ => return Err(invalid("expiresAt", "Expiry must be a future timestamp")),
    };
    let key = new_key();
    let id = ids::new_id();
    sqlx::query("INSERT INTO api_keys (id,user_id,name,key_hash,key_prefix,source,scopes,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'manual','[\"read\"]',?,?,?)")
        .bind(&id).bind(&user.id).bind(name).bind(hash_key(&state,&key)?).bind(&key[..12]).bind(expiry).bind(now).bind(now).execute(&state.db).await?;
    let row: KeyRow = sqlx::query_as(&format!("SELECT {KEY_COLUMNS} FROM api_keys WHERE id=?"))
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"key":key,"apiKey":row.json()})),
    ))
}
async fn revoke_key(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let now = now_ms();
    let result=sqlx::query("UPDATE api_keys SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE id=? AND user_id=?")
        .bind(now).bind(now).bind(&id).bind(user.id).execute(&state.db).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found("NOT_FOUND", "API key not found").detail("id", id));
    }
    Ok(Json(json!({"success":true})))
}
fn hash_key(state: &AppState, key: &str) -> ApiResult<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(state.config.api_token_hash_secret.as_bytes())
        .map_err(AppError::internal)?;
    mac.update(key.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}
fn base62(mut value: u32) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(ALPHABET[(value % 62) as usize]);
        value /= 62;
        if value == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("ASCII alphabet")
}
fn new_key() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut key = String::from("oah_");
    let mut rng = rand::rng();
    while key.len() < 34 {
        let mut b = [0];
        rng.fill_bytes(&mut b);
        if b[0] < 248 {
            key.push(ALPHABET[(b[0] % 62) as usize] as char)
        }
    }
    let mut crc = u32::MAX;
    for b in key.bytes() {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb88320 } else { 0 }
        }
    }
    let encoded = base62(!crc);
    let padded = format!("{encoded:0>4}");
    key.push_str(&padded[..4]);
    key
}

struct ApiUser(CurrentUser);
#[derive(FromRow)]
struct KeyIdentity {
    id: String,
    user_id: String,
    email: String,
    name: Option<String>,
    suspended_at: Option<i64>,
}
fn api_unauthorized() -> AppError {
    AppError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized")
}
fn rate_limit(state: &AppState, bucket: &str, limit: u32) -> ApiResult<()> {
    let now = now_ms();
    let decision = state.limiter.hit(bucket, limit, 60000, now);
    if decision.allowed {
        return Ok(());
    }
    let wait = ((decision.reset_at - now + 999) / 1000).max(1);
    Err(AppError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Rate limit exceeded",
    )
    .detail("retryAfter", wait)
    .detail("limit", limit)
    .detail("remaining", 0)
    .detail("resetAt", decision.reset_at / 1000)
    .header("retry-after", wait.to_string())
    .header("x-ratelimit-limit", limit.to_string())
    .header("x-ratelimit-remaining", "0".into())
    .header("x-ratelimit-reset", (decision.reset_at / 1000).to_string()))
}
impl FromRequestParts<AppState> for ApiUser {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>();
        let ip = auth::client_ip(state, &parts.headers, peer);
        rate_limit(state, &format!("api-ip:{ip}"), 1200)?;
        let bearer = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split_once(' '))
            .filter(|(s, _)| s.eq_ignore_ascii_case("bearer"))
            .map(|(_, t)| t.trim());
        if let Some(token) = bearer.filter(|t| t.starts_with("oah_")) {
            let row:Option<KeyIdentity>=sqlx::query_as("SELECT k.id,k.user_id,u.email,u.name,u.suspended_at FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?)")
                .bind(hash_key(state,token)?).bind(now_ms()).fetch_optional(&state.db).await?;
            let row = row.ok_or_else(api_unauthorized)?;
            if row.suspended_at.is_some() {
                return Err(AppError::new(
                    StatusCode::FORBIDDEN,
                    "ACCOUNT_SUSPENDED",
                    "Account suspended",
                ));
            }
            rate_limit(state, &format!("api-key:{}", row.id), 600)?;
            sqlx::query("UPDATE api_keys SET last_used_at=? WHERE id=?")
                .bind(now_ms())
                .bind(&row.id)
                .execute(&state.db)
                .await?;
            return Ok(Self(CurrentUser {
                id: row.user_id,
                email: row.email,
                name: row.name,
                session_id: String::new(),
            }));
        }
        let user = CurrentUser::from_request_parts(parts, state)
            .await
            .map_err(|e| {
                if e.status == StatusCode::UNAUTHORIZED {
                    api_unauthorized()
                } else {
                    e
                }
            })?;
        rate_limit(state, &format!("api-user:{}", user.id), 600)?;
        Ok(Self(user))
    }
}

#[derive(FromRow)]
struct RecordingRow {
    id: String,
    filename: String,
    created_at: i64,
    updated_at: i64,
    start_time: i64,
    duration: i64,
    filesize: i64,
    device_sn: String,
    device_name: Option<String>,
    device_model: Option<String>,
    has_transcription: bool,
    has_summary: bool,
}
const RECORD_SELECT: &str = "SELECT r.id,r.filename,r.created_at,r.updated_at,r.start_time,r.duration,r.filesize,r.device_sn,d.name AS device_name,d.model AS device_model,EXISTS(SELECT 1 FROM transcriptions t WHERE t.recording_id=r.id AND t.user_id=r.user_id) AS has_transcription,EXISTS(SELECT 1 FROM ai_enhancements a WHERE a.recording_id=r.id AND a.user_id=r.user_id AND a.has_content=1) AS has_summary FROM recordings r LEFT JOIN plaud_devices d ON d.user_id=r.user_id AND d.serial_number=r.device_sn";
fn recording_json(state: &AppState, row: &RecordingRow) -> ApiResult<Value> {
    let device = if row.device_name.is_some() || row.device_model.is_some() {
        json!({"serial_number":row.device_sn,"name":row.device_name,"model":row.device_model})
    } else {
        Value::Null
    };
    Ok(
        json!({"id":row.id,"title":state.config.field_key.decrypt(&row.filename).map_err(AppError::internal)?,"created_at":iso(row.created_at),"updated_at":iso(row.updated_at),"recorded_at":iso(row.start_time),"duration_ms":row.duration,"filesize_bytes":row.filesize,"device":device,"has_transcription":row.has_transcription,"has_summary":row.has_summary,
        "links":{"self":format!("/api/v1/recordings/{}",row.id),"transcript":format!("/api/v1/recordings/{}/transcript",row.id),"audio":format!("/api/v1/recordings/{}/audio",row.id)}}),
    )
}
async fn find(state: &AppState, user: &str, id: &str) -> ApiResult<RecordingRow> {
    sqlx::query_as(&format!(
        "{RECORD_SELECT} WHERE r.user_id=? AND r.id=? AND r.deleted_at IS NULL"
    ))
    .bind(user)
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::not_found("RECORDING_NOT_FOUND", "Recording not found").detail("id", id)
    })
}
async fn list_recordings(
    ApiUser(user): ApiUser,
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let limit = match query.get("limit") {
        None => 50,
        Some(s) => s
            .parse::<i64>()
            .ok()
            .filter(|n| (1..=100).contains(n))
            .ok_or_else(|| invalid("limit", "Limit must be from 1 to 100"))?,
    };
    let date = |name: &str| -> ApiResult<Option<i64>> {
        query
            .get(name)
            .map(|s| parse_iso(s).ok_or_else(|| invalid(name, "Invalid timestamp")))
            .transpose()
    };
    let created = date("created_since")?;
    let updated = date("updated_since")?;
    let transcribed = match query.get("has_transcription").map(String::as_str) {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => return Err(invalid("has_transcription", "Expected true or false")),
    };
    let cursor: Option<(i64, String)> = query
        .get("cursor")
        .map(|s| {
            if s.len() > 2048 {
                return Err(invalid("cursor", "Invalid cursor"));
            }
            let bytes = hex::decode(s).map_err(|_| invalid("cursor", "Invalid cursor"))?;
            let pair: (i64, String) =
                serde_json::from_slice(&bytes).map_err(|_| invalid("cursor", "Invalid cursor"))?;
            if pair.1.is_empty() {
                return Err(invalid("cursor", "Invalid cursor"));
            }
            Ok(pair)
        })
        .transpose()?;
    let (cursor_time, cursor_id) = cursor.unwrap_or((i64::MAX, String::new()));
    let rows:Vec<RecordingRow>=sqlx::query_as(&format!("{RECORD_SELECT} WHERE r.user_id=? AND r.deleted_at IS NULL AND (? IS NULL OR r.created_at>=?) AND (? IS NULL OR r.updated_at>=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM transcriptions t WHERE t.recording_id=r.id AND t.user_id=r.user_id)=?) AND (r.updated_at<? OR (r.updated_at=? AND r.id<?)) ORDER BY r.updated_at DESC,r.id DESC LIMIT ?"))
        .bind(user.id).bind(created).bind(created).bind(updated).bind(updated).bind(transcribed).bind(transcribed).bind(cursor_time).bind(cursor_time).bind(cursor_id).bind(limit+1).fetch_all(&state.db).await?;
    let has_more = rows.len() > limit as usize;
    let rows = &rows[..rows.len().min(limit as usize)];
    let next = if has_more {
        rows.last().map(|r| {
            hex::encode(serde_json::to_vec(&(r.updated_at, &r.id)).expect("primitive tuple"))
        })
    } else {
        None
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|r| recording_json(&state, r))
        .collect::<ApiResult<_>>()?;
    Ok(Json(
        json!({"data":data,"next_cursor":next,"has_more":has_more}),
    ))
}
#[derive(FromRow)]
struct TranscriptRow {
    source: String,
    detected_language: Option<String>,
    text: String,
    provider: String,
    model: String,
    created_at: i64,
}
async fn transcripts(
    state: &AppState,
    user: &str,
    id: &str,
) -> ApiResult<(Vec<Value>, Option<Value>)> {
    let rows:Vec<TranscriptRow>=sqlx::query_as("SELECT source,detected_language,text,provider,model,created_at FROM transcriptions WHERE user_id=? AND recording_id=? ORDER BY created_at DESC,id DESC").bind(user).bind(id).fetch_all(&state.db).await?;
    let mut values = Vec::new();
    for t in rows {
        values.push(json!({"source":t.source,"language":t.detected_language,"text":state.config.field_key.decrypt(&t.text).map_err(AppError::internal)?,"provider":t.provider,"model":t.model,"created_at":iso(t.created_at)}))
    }
    let settings: Option<String> =
        sqlx::query_scalar("SELECT data FROM user_settings WHERE user_id=?")
            .bind(user)
            .fetch_optional(&state.db)
            .await?;
    let settings = settings
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_default();
    // Same default as the settings record (routes/settings.rs), so an unset value means "plaud".
    let preferred = settings["preferredTranscriptSource"]
        .as_str()
        .unwrap_or("plaud");
    let primary = values
        .iter()
        .find(|t| t["source"] == preferred)
        .or_else(|| values.iter().find(|t| t["source"] == "openaudiohub"))
        .or_else(|| values.first())
        .cloned();
    Ok((values, primary))
}
#[derive(FromRow)]
struct SummaryRow {
    summary: Option<String>,
    action_items: Option<String>,
    key_points: Option<String>,
    provider: String,
    model: String,
    created_at: i64,
}
fn open_json(state: &AppState, value: Option<String>) -> ApiResult<Value> {
    value
        .map(|s| {
            let value: Value = serde_json::from_str(&s).map_err(AppError::internal)?;
            state
                .config
                .field_key
                .decrypt_json(&value)
                .map_err(AppError::internal)
        })
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}
async fn recording_detail(
    ApiUser(user): ApiUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = find(&state, &user.id, &id).await?;
    let mut value = recording_json(&state, &row)?;
    let (all, primary) = transcripts(&state, &user.id, &id).await?;
    let summary:Option<SummaryRow>=sqlx::query_as("SELECT summary,action_items,key_points,provider,model,created_at FROM ai_enhancements WHERE user_id=? AND recording_id=?").bind(&user.id).bind(&id).fetch_optional(&state.db).await?;
    let summary=summary.map(|s|->ApiResult<Value>{Ok(json!({"text":s.summary.map(|v|state.config.field_key.decrypt(&v).map_err(AppError::internal)).transpose()?,"action_items":open_json(&state,s.action_items)?,"key_points":open_json(&state,s.key_points)?,"provider":s.provider,"model":s.model,"created_at":iso(s.created_at)}))}).transpose()?;
    value["transcript"] = primary.unwrap_or(Value::Null);
    value["transcripts"] = json!(all);
    value["summary"] = summary.unwrap_or(Value::Null);
    Ok(Json(value))
}
async fn recording_transcript(
    ApiUser(user): ApiUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    find(&state, &user.id, &id).await?;
    let (_, primary) = transcripts(&state, &user.id, &id).await?;
    primary
        .map(Json)
        .ok_or_else(|| AppError::not_found("NOT_FOUND", "Transcript not found").detail("id", id))
}
async fn recording_audio(
    ApiUser(user): ApiUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    find(&state, &user.id, &id).await?;
    let (storage_type, storage_path): (String, String) = sqlx::query_as(
        "SELECT storage_type, storage_path FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_one(&state.db)
    .await?;
    // Object storage: a 302 to a 300-second pre-signed GET. Local storage streams the bytes.
    if let Some(url) = state
        .storage
        .presigned_get(&storage_type, &storage_path)
        .await?
    {
        return Ok((
            StatusCode::FOUND,
            [
                (header::LOCATION, url),
                (header::CACHE_CONTROL, "private, max-age=300".to_owned()),
            ],
        )
            .into_response());
    }
    let mut response = super::recordings::audio(
        State(state),
        user,
        Path(id),
        Query(HashMap::new()),
        headers.clone(),
    )
    .await?;
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
        let size = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("bytes */"))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        return Ok(AppError::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "INVALID_INPUT",
            "Invalid range",
        )
        .detail(
            "range",
            headers
                .get(header::RANGE)
                .and_then(|h| h.to_str().ok())
                .unwrap_or(""),
        )
        .detail("fileSize", size)
        .header("content-range", format!("bytes */{size}"))
        .into_response());
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, max-age=300"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_keys_have_uniform_alphabet_and_checksum_shape() {
        for _ in 0..100 {
            let key = super::new_key();
            assert_eq!(key.len(), 38);
            assert!(key.starts_with("oah_"));
            assert!(key[4..].bytes().all(|c| c.is_ascii_alphanumeric()));
        }
    }
}
