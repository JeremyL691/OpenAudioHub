//! Manual sync, the sync run (listing, dedupe, tombstones, devices), and the auto sync worker (spec/plaud.md).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use futures_util::future::{BoxFuture, FutureExt, Shared, join_all};
use serde_json::{Value, json};

use super::api::{self, Client, PlaudError, Recording};
use super::connect::{CONN_SQL, ConnRow};
use super::import;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::routes::settings;
use crate::webhooks;
use crate::{AppState, config, ids, time, transcribe};

const REJECTED: &str = "Plaud rejected the stored token. Reconnect your Plaud account.";
const BATCH: usize = 5;
const WINDOW_MS: i64 = 60_000;
/// The worker skips users synced in the last four minutes.
const WORKER_CUTOFF_MS: i64 = 4 * 60_000;
const WORKER_CLAIM: i64 = 20;
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The outcome of one sync run.
#[derive(Clone, Default)]
pub struct Report {
    pub new: u32,
    pub updated: u32,
    pub errors: Vec<String>,
    pub needs_reconnect: bool,
}

/// A failure of the whole run. Each message is the full text shown in `errors`.
pub enum Stop {
    Rejected,
    Message(String),
}

impl From<PlaudError> for Stop {
    fn from(e: PlaudError) -> Self {
        match e {
            PlaudError::Rejected { .. } => Stop::Rejected,
            other => Stop::Message(format!("Sync failed: {}", api::describe(&other))),
        }
    }
}

impl From<AppError> for Stop {
    fn from(e: AppError) -> Self {
        Stop::Message(format!("Sync failed: {}", e.message))
    }
}

impl From<sqlx::Error> for Stop {
    fn from(e: sqlx::Error) -> Self {
        Stop::from(AppError::from(e))
    }
}

/// A failure of one recording.
pub enum ItemError {
    Rejected,
    Failed(String),
}

impl From<PlaudError> for ItemError {
    fn from(e: PlaudError) -> Self {
        match e {
            PlaudError::Rejected { .. } => ItemError::Rejected,
            other => ItemError::Failed(api::describe(&other)),
        }
    }
}

impl From<AppError> for ItemError {
    fn from(e: AppError) -> Self {
        ItemError::Failed(e.message)
    }
}

impl From<sqlx::Error> for ItemError {
    fn from(e: sqlx::Error) -> Self {
        ItemError::from(AppError::from(e))
    }
}

enum Outcome {
    New(String),
    Updated(String),
    Unchanged { imported: bool },
    Skipped,
}

/// What one run shares among its recordings.
struct Ctx {
    user_id: String,
    client: Client,
    import_content: bool,
    date_titles: bool,
    /// Set when Plaud refuses the token during content import; the rest of the run skips content.
    content_stopped: AtomicBool,
    errors: Mutex<Vec<String>>,
}

type SharedRun = Shared<BoxFuture<'static, Report>>;

/// Runs in progress, by user. A second request for the same user joins the first run.
static RUNS: LazyLock<Mutex<HashMap<String, SharedRun>>> = LazyLock::new(Default::default);

pub async fn manual(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Value>> {
    let now = now_ms();
    let limit = config::number("PLAUD_SYNC_RATE_LIMIT_PER_MINUTE", 10, 1, 600)
        .map_err(AppError::internal)?;
    let decision = state.limiter.hit(
        &format!("plaud-sync:{}", user.id),
        limit as u32,
        WINDOW_MS,
        now,
    );
    if !decision.allowed {
        let err = crate::auth::too_many(&decision, now)
            .detail("limit", decision.limit)
            .detail("remaining", decision.remaining)
            .detail("resetAt", decision.reset_at / 1000);
        return Err(err);
    }
    let (report, joined) = run_shared(&state, &user.id).await;
    let mut out = json!({
        "success": true,
        "newRecordings": report.new,
        "updatedRecordings": report.updated,
        "errors": report.errors,
        "needsReconnect": report.needs_reconnect,
    });
    if joined {
        out["inProgress"] = json!(true);
    }
    Ok(Json(out))
}

/// Starts a run for the user, or joins the one already running. Returns the report and whether it was joined.
async fn run_shared(state: &AppState, user_id: &str) -> (Report, bool) {
    let (fut, joined) = {
        let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
        match runs.get(user_id) {
            Some(f) => (f.clone(), true),
            None => {
                let (s, uid) = (state.clone(), user_id.to_owned());
                let f = async move {
                    let report = run(&s, &uid).await;
                    RUNS.lock().unwrap_or_else(|e| e.into_inner()).remove(&uid);
                    report
                }
                .boxed()
                .shared();
                runs.insert(user_id.to_owned(), f.clone());
                (f, false)
            }
        }
    };
    (fut.await, joined)
}

async fn run(state: &AppState, user_id: &str) -> Report {
    let mut report = Report::default();
    match sync_inner(state, user_id, &mut report).await {
        Ok(()) => {}
        Err(Stop::Message(m)) => report.errors.push(m),
        Err(Stop::Rejected) => {
            let _ = sqlx::query(
                "UPDATE plaud_connections SET invalidated_at = ?, updated_at = ? WHERE user_id = ?",
            )
            .bind(now_ms())
            .bind(now_ms())
            .bind(user_id)
            .execute(&state.db)
            .await;
            report.errors.push(REJECTED.into());
        }
    }
    report.needs_reconnect = sqlx::query_scalar::<_, bool>(
        "SELECT invalidated_at IS NOT NULL FROM plaud_connections WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or(false);
    report
}

async fn sync_inner(state: &AppState, user_id: &str, report: &mut Report) -> Result<(), Stop> {
    let conn: Option<ConnRow> = sqlx::query_as(CONN_SQL)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?;
    let conn = conn.ok_or_else(|| Stop::Message("No Plaud connection found".into()))?;

    let settings = settings::effective(state, user_id).await?;
    let flag = |key: &str, default: bool| {
        settings
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(default)
    };
    let text = |key: &str, default: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    };
    let auto_transcribe = flag("autoTranscribe", false);
    let plaud_only = text("transcriptMode", "plaud_only") == "plaud_only";

    let (client, workspace) = client_for(state, &conn).await?;

    let ctx = Ctx {
        user_id: user_id.to_owned(),
        client,
        import_content: flag("importPlaudContent", false),
        date_titles: text("recordingTitleMode", "ai") == "date",
        content_stopped: AtomicBool::new(false),
        errors: Mutex::new(Vec::new()),
    };
    let mut new_ids = Vec::new();
    let mut new_titles = Vec::new();
    let pages = sync_pages(state, &ctx, report, &mut new_ids, &mut new_titles).await;
    report
        .errors
        .extend(ctx.errors.into_inner().unwrap_or_else(|e| e.into_inner()));
    if !new_titles.is_empty() {
        crate::notify::new_recordings(state, user_id, &new_titles).await;
    }
    pages?;

    if auto_transcribe {
        for id in &new_ids {
            let plaud_done: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND source = 'plaud')")
                .bind(id)
                .fetch_one(&state.db)
                .await?;
            if plaud_only && plaud_done {
                continue;
            }
            if let Err(e) = transcribe::queue_auto(state, user_id, id).await {
                tracing::warn!(error = %e.message, "queueing automatic transcription failed");
            }
        }
    }

    sqlx::query("UPDATE plaud_connections SET last_sync = ?, invalidated_at = NULL, workspace_id = COALESCE(?, workspace_id), updated_at = ? WHERE user_id = ?")
        .bind(now_ms())
        .bind(workspace)
        .bind(now_ms())
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Pages through the whole list. Stops at a short page, or after two pages in a row that add or update nothing.
async fn sync_pages(
    state: &AppState,
    ctx: &Ctx,
    report: &mut Report,
    new_ids: &mut Vec<String>,
    new_titles: &mut Vec<String>,
) -> Result<(), Stop> {
    let mut page = 0;
    let mut idle = 0;
    loop {
        let rows = ctx.client.recordings(page).await?;
        let mut changed = false;
        for chunk in rows.chunks(BATCH) {
            let results = join_all(chunk.iter().map(|r| process(state, ctx, r))).await;
            for (r, result) in chunk.iter().zip(results) {
                match result {
                    Ok(Outcome::New(id)) => {
                        report.new += 1;
                        webhooks::emit_soft(state, &ctx.user_id, &id, "recording.synced", None)
                            .await;
                        new_titles.push(title(ctx.date_titles, r));
                        new_ids.push(id);
                        changed = true;
                    }
                    Ok(Outcome::Updated(id)) => {
                        report.updated += 1;
                        webhooks::emit_soft(state, &ctx.user_id, &id, "recording.updated", None)
                            .await;
                        changed = true;
                    }
                    Ok(Outcome::Unchanged { imported }) => changed |= imported,
                    Ok(Outcome::Skipped) => {}
                    Err(ItemError::Rejected) => return Err(Stop::Rejected),
                    Err(ItemError::Failed(m)) => {
                        let name = r
                            .filename
                            .clone()
                            .filter(|f| !f.trim().is_empty())
                            .unwrap_or_else(|| r.id.clone());
                        report.errors.push(format!("Failed to sync {name}: {m}"));
                    }
                }
            }
        }
        if rows.len() < api::PAGE_SIZE {
            break;
        }
        idle = if changed { 0 } else { idle + 1 };
        if idle >= 2 {
            break;
        }
        page += 1;
    }
    Ok(())
}

/// Plaud file ids end up in file names and URL paths, so only a plain id is accepted.
fn safe_file_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

async fn process(state: &AppState, ctx: &Ctx, r: &Recording) -> Result<Outcome, ItemError> {
    if !safe_file_id(&r.id) {
        return Err(ItemError::Failed(
            "Plaud returned a recording with an invalid id".into(),
        ));
    }
    let version = r.version_ms.unwrap_or(0).to_string();
    let existing: Option<(String, Option<i64>, String, String, String)> = sqlx::query_as(
        "SELECT id, deleted_at, plaud_version, storage_type, storage_path FROM recordings WHERE user_id = ? AND plaud_file_id = ?",
    )
    .bind(&ctx.user_id)
    .bind(&r.id)
    .fetch_optional(&state.db)
    .await?;
    match existing {
        // Deleted here: never imported again, no download.
        Some((_, Some(_), _, _, _)) => Ok(Outcome::Skipped),
        Some((id, None, prev, _, _)) if prev == version => {
            let imported = import_for(state, ctx, &id, &r.id).await;
            Ok(Outcome::Unchanged { imported })
        }
        Some((id, None, _, prev_type, prev_key)) => {
            let storage = import::store_audio(state, &ctx.user_id, &ctx.client, &r.id).await?;
            match update_row(state, r, &id, &storage).await {
                Ok(true) => {}
                Ok(false) => {
                    // Deleted while downloading: the delete wins and the audio goes.
                    delete_audio(state, storage.storage_type, &storage.key).await;
                    return Ok(Outcome::Skipped);
                }
                Err(e) => {
                    delete_audio(state, storage.storage_type, &storage.key).await;
                    return Err(e);
                }
            }
            // The row points at the new audio now, so the previous version's object is unreferenced.
            if (prev_type.as_str(), prev_key.as_str())
                != (storage.storage_type, storage.key.as_str())
            {
                delete_audio(state, &prev_type, &prev_key).await;
            }
            import_for(state, ctx, &id, &r.id).await;
            Ok(Outcome::Updated(id))
        }
        None => {
            let storage = import::store_audio(state, &ctx.user_id, &ctx.client, &r.id).await?;
            let id = match insert_row(state, ctx, r, &storage).await {
                Ok(id) => id,
                Err(e) => {
                    delete_audio(state, storage.storage_type, &storage.key).await;
                    return Err(e);
                }
            };
            import_for(state, ctx, &id, &r.id).await;
            Ok(Outcome::New(id))
        }
    }
}

/// Deletes an audio object that no row points at. A failure is logged, not returned.
async fn delete_audio(state: &AppState, storage_type: &str, key: &str) {
    if let Err(e) = state.storage.delete(storage_type, key).await {
        tracing::warn!(error = %e, "deleting an unused Plaud audio file failed");
    }
}

/// The title Plaud's name gives, or a date title for new rows when the user chose dates.
fn title(date_titles: bool, r: &Recording) -> String {
    if date_titles {
        time::iso(r.start_time.unwrap_or(0))
            .get(..16)
            .unwrap_or_default()
            .replace('T', " ")
    } else {
        r.filename
            .clone()
            .filter(|f| !f.trim().is_empty())
            .unwrap_or_else(|| r.id.clone())
    }
}

async fn insert_row(
    state: &AppState,
    ctx: &Ctx,
    r: &Recording,
    storage: &import::Stored,
) -> Result<String, ItemError> {
    let id = ids::new_id();
    let now = now_ms();
    let start = r.start_time.unwrap_or(0);
    let peaks_json = storage
        .peaks
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());
    sqlx::query(
        "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, \
         storage_type, storage_path, auto_export_path, downloaded_at, plaud_version, timezone, zonemins, scene, is_trash, waveform_peaks, \
         deleted_at, starred_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)",
    )
    .bind(&id)
    .bind(&ctx.user_id)
    .bind(r.serial_number.clone().unwrap_or_default())
    .bind(&r.id)
    .bind(state.config.field_key.encrypt(&title(ctx.date_titles, r)))
    .bind(r.duration.unwrap_or(0))
    .bind(start)
    .bind(r.end_time.unwrap_or(start))
    .bind(r.filesize.unwrap_or(0))
    .bind(r.file_md5.clone().unwrap_or_default())
    .bind(storage.storage_type)
    .bind(storage.key.as_str())
    .bind(now)
    .bind(version_text(r))
    .bind(r.timezone)
    .bind(r.zonemins)
    .bind(r.scene)
    .bind(peaks_json)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(id)
}

/// Overwrites a row with Plaud's values. False when the row was deleted meanwhile, so nothing changed.
async fn update_row(
    state: &AppState,
    r: &Recording,
    id: &str,
    storage: &import::Stored,
) -> Result<bool, ItemError> {
    let now = now_ms();
    let peaks_json = storage
        .peaks
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());
    let done = sqlx::query(
        "UPDATE recordings SET device_sn = ?, filename = ?, duration = ?, start_time = ?, end_time = ?, filesize = ?, file_md5 = ?, \
         storage_type = ?, storage_path = ?, downloaded_at = ?, plaud_version = ?, timezone = ?, zonemins = ?, scene = ?, \
         waveform_peaks = COALESCE(?, waveform_peaks), is_trash = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(r.serial_number.clone().unwrap_or_default())
    .bind(state.config.field_key.encrypt(&title(false, r)))
    .bind(r.duration.unwrap_or(0))
    .bind(r.start_time.unwrap_or(0))
    .bind(r.end_time.unwrap_or(0))
    .bind(r.filesize.unwrap_or(0))
    .bind(r.file_md5.clone().unwrap_or_default())
    .bind(storage.storage_type)
    .bind(storage.key.as_str())
    .bind(now)
    .bind(version_text(r))
    .bind(r.timezone)
    .bind(r.zonemins)
    .bind(r.scene)
    .bind(peaks_json)
    .bind(now)
    .bind(id)
    .execute(&state.db)
    .await?;
    Ok(done.rows_affected() == 1)
}

fn version_text(r: &Recording) -> String {
    r.version_ms.unwrap_or(0).to_string()
}

/// Content import for one recording. Failures are recorded, not returned. A refused token stops the pass.
async fn import_for(state: &AppState, ctx: &Ctx, row_id: &str, file_id: &str) -> bool {
    if !ctx.import_content || ctx.content_stopped.load(Ordering::Relaxed) {
        return false;
    }
    let message =
        match import::import_content(state, &ctx.user_id, &ctx.client, row_id, file_id).await {
            Ok(imported) => return imported,
            Err(ItemError::Rejected) => {
                if ctx.content_stopped.swap(true, Ordering::Relaxed) {
                    return false;
                }
                "Plaud content import stopped: access token expired".to_owned()
            }
            Err(ItemError::Failed(m)) => format!("Plaud content import failed for {file_id}: {m}"),
        };
    if let Ok(mut errors) = ctx.errors.lock() {
        errors.push(message);
    }
    false
}

/// Starts the worker. It syncs connected users on an interval; a user whose token was rejected is skipped until reconnect.
/// A client for the user's Plaud account, switched to the personal workspace token when
/// there is one. A failure to mint a workspace token falls back to the account token.
/// Also returns the workspace id, so a newly found one can be stored.
async fn client_for(state: &AppState, conn: &ConnRow) -> Result<(Client, Option<String>), Stop> {
    let token = state
        .config
        .field_key
        .decrypt(&conn.bearer_token)
        .map_err(AppError::internal)?;
    let account = Client::new(&conn.api_base, &token);
    let workspace = match &conn.workspace_id {
        Some(ws) => Some(ws.clone()),
        None => match account.personal_workspace().await {
            Ok(w) => w,
            Err(PlaudError::Rejected { .. }) => return Err(Stop::Rejected),
            Err(_) => None,
        },
    };
    let client = match &workspace {
        Some(ws) => match account.workspace_token(ws).await {
            Ok(wt) => Client::new(&conn.api_base, &wt),
            Err(_) => account,
        },
        None => account,
    };
    Ok((client, workspace))
}

/// Sends an AI-generated title back to Plaud when the user turned that on and the
/// recording came from Plaud. Failures are logged only; the local title stays.
pub async fn push_title(state: &AppState, user_id: &str, recording_id: &str, title: &str) {
    let result: Result<(), String> = async {
        let settings = settings::effective(state, user_id)
            .await
            .map_err(|e| e.message)?;
        if settings.get("syncTitleToPlaud").and_then(Value::as_bool) != Some(true) {
            return Ok(());
        }
        let file: Option<(String, String)> = sqlx::query_as(
            "SELECT device_sn, plaud_file_id FROM recordings WHERE id = ? AND user_id = ?",
        )
        .bind(recording_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        // Uploads and merges have no Plaud file to rename.
        let Some((_, file_id)) = file.filter(|(device, id)| device != "local" && safe_file_id(id))
        else {
            return Ok(());
        };
        let conn: Option<ConnRow> = sqlx::query_as(CONN_SQL)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        let Some(conn) = conn else { return Ok(()) };
        let (client, _) = client_for(state, &conn)
            .await
            .map_err(|_| "no usable Plaud token".to_owned())?;
        client
            .api(
                reqwest::Method::PATCH,
                &format!("/file/{file_id}"),
                Some(serde_json::json!({ "filename": title })),
            )
            .await
            .map(|_| ())
            .map_err(|e| super::api::describe(&e))
    }
    .await;
    if let Err(e) = result {
        tracing::warn!(recording = recording_id, error = %e, "could not send the title to Plaud");
    }
}

pub fn spawn_worker(state: &AppState) {
    let enabled = config::boolean("BACKGROUND_SYNC_ENABLED", true).unwrap_or(true);
    if !enabled {
        return;
    }
    let every = config::number("BACKGROUND_SYNC_INTERVAL_MS", 300_000, 60_000, 3_600_000)
        .unwrap_or(300_000);
    let state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            tick(&state).await;
            tokio::time::sleep(Duration::from_millis(every)).await;
        }
    });
}

async fn tick(state: &AppState) {
    let cutoff = now_ms() - WORKER_CUTOFF_MS;
    let users: Vec<String> = match sqlx::query_scalar(
        "SELECT p.user_id FROM plaud_connections p JOIN users u ON u.id = p.user_id \
         WHERE u.suspended_at IS NULL AND p.invalidated_at IS NULL AND (p.last_sync IS NULL OR p.last_sync < ?) \
         ORDER BY p.last_sync IS NOT NULL, p.last_sync LIMIT ?",
    )
    .bind(cutoff)
    .bind(WORKER_CLAIM)
    .fetch_all(&state.db)
    .await
    {
        Ok(users) => users,
        Err(e) => {
            tracing::warn!(error = %e, "plaud worker could not list users");
            return;
        }
    };
    for user_id in users {
        match tokio::time::timeout(RUN_TIMEOUT, run_shared(state, &user_id)).await {
            Ok((report, _)) => {
                for e in report.errors {
                    tracing::warn!(user = %user_id, error = %e, "plaud sync");
                }
            }
            Err(_) => tracing::warn!(user = %user_id, "plaud sync timed out"),
        }
    }
}

#[cfg(test)]
mod file_id_tests {
    #[test]
    fn only_plain_ids_are_safe() {
        assert!(super::safe_file_id("a1b2_C3-d4"));
        for bad in ["", "../etc", "a/b", "a\\b", "x.y", &"a".repeat(129)] {
            assert!(!super::safe_file_id(bad), "{bad}");
        }
    }
}
