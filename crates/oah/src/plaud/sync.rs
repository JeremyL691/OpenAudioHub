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
use super::connect::ConnRow;
use super::import;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::routes::settings;
use crate::webhooks;
use crate::{AppState, config, ids, transcribe};

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
#[derive(Debug)]
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
    New(String, String),
    Updated(String),
    Unchanged { imported: bool },
    Skipped,
}

/// What one run shares among its recordings.
struct Ctx {
    user_id: String,
    client: Client,
    import_content: bool,
    title_mode: String,
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
    let conn: Option<ConnRow> = sqlx::query_as(
        "SELECT bearer_token, api_base, plaud_email, workspace_id, invalidated_at, created_at, updated_at \
         FROM plaud_connections WHERE user_id = ?",
    )
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
        title_mode: text("recordingTitleMode", "ai"),
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
    let mut listed_v4 = ctx.client.is_v4_mode();
    loop {
        let rows = ctx.client.recordings(page).await?;
        if !listed_v4 && ctx.client.is_v4_mode() {
            listed_v4 = true;
            // Plaud 4.0 lists in another order, so a legacy page offset would skip recordings.
            if page > 0 {
                page = 0;
                idle = 0;
                continue;
            }
        }
        let mut changed = false;
        for chunk in rows.chunks(BATCH) {
            let results = join_all(chunk.iter().map(|r| process(state, ctx, r))).await;
            for (r, result) in chunk.iter().zip(results) {
                match result {
                    Ok(Outcome::New(id, title)) => {
                        report.new += 1;
                        webhooks::emit_soft(state, &ctx.user_id, &id, "recording.synced", None)
                            .await;
                        new_titles.push(title);
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
    let existing: Option<(String, Option<i64>, String, String, String, String)> = sqlx::query_as(
        "SELECT id, deleted_at, plaud_version, storage_type, storage_path, title_source FROM recordings WHERE user_id = ? AND plaud_file_id = ?",
    )
    .bind(&ctx.user_id)
    .bind(&r.id)
    .fetch_optional(&state.db)
    .await?;
    match existing {
        // Deleted here: never imported again, no download.
        Some((_, Some(_), _, _, _, _)) => Ok(Outcome::Skipped),
        Some((id, None, prev, _, _, _)) if r.version_ms.is_some() && prev == version => {
            let imported = import_for(state, ctx, &id, &r.id).await;
            Ok(Outcome::Unchanged { imported })
        }
        Some((id, None, prev, prev_type, prev_key, prev_source)) => {
            let hydrated = ctx.client.hydrate_recording(r).await?;
            if prev == version_text(&hydrated) {
                let imported = import_for(state, ctx, &id, &hydrated.id).await;
                return Ok(Outcome::Unchanged { imported });
            }
            // A stored file is kept: a changed Plaud version only refreshes metadata, so a rename
            // or an edit in Plaud never replaces a file the user may be playing. The exception is a
            // missing object, which would leave the recording unplayable for good.
            if audio_present(state, &prev_type, &prev_key).await {
                let follow = may_follow_plaud(&prev_source);
                match update_row(state, &hydrated, &id, follow).await {
                    Ok(true) => {}
                    Ok(false) => return Ok(Outcome::Skipped),
                    Err(e) => return Err(e),
                }
            } else {
                let storage =
                    import::store_audio(state, &ctx.user_id, &ctx.client, &hydrated.id).await?;
                match update_row_with_audio(state, &hydrated, &id, Some(&storage), true).await {
                    Ok(true) => {}
                    Ok(false) => {
                        delete_audio(state, storage.storage_type, &storage.key).await;
                        return Ok(Outcome::Skipped);
                    }
                    Err(e) => {
                        delete_audio(state, storage.storage_type, &storage.key).await;
                        return Err(e);
                    }
                }
            }
            import_for(state, ctx, &id, &hydrated.id).await;
            Ok(Outcome::Updated(id))
        }
        None => {
            let hydrated = ctx.client.hydrate_recording(r).await?;
            let storage =
                import::store_audio(state, &ctx.user_id, &ctx.client, &hydrated.id).await?;
            let (id, title) = match insert_row(state, ctx, &hydrated, &storage).await {
                Ok(pair) => pair,
                Err(e) => {
                    delete_audio(state, storage.storage_type, &storage.key).await;
                    return Err(e);
                }
            };
            import_for(state, ctx, &id, &hydrated.id).await;
            Ok(Outcome::New(id, title))
        }
    }
}

/// Whether the stored audio object still exists. A storage error that is not "not found" counts as
/// present, so a transient failure never triggers a download.
async fn audio_present(state: &AppState, storage_type: &str, key: &str) -> bool {
    !matches!(
        state.storage.head_size(storage_type, key).await,
        Err(crate::storage::StorageError::NotFound)
    )
}

/// Deletes an audio object that no row points at. A failure is logged, not returned.
async fn delete_audio(state: &AppState, storage_type: &str, key: &str) {
    if let Err(e) = state.storage.delete(storage_type, key).await {
        tracing::warn!(error = %e, "deleting an unused Plaud audio file failed");
    }
}

/// The name a new row gets, and where that name came from.
///
/// `date` gives `YYYY-MM-DD` in the server's local time, using the offset in effect at the
/// recording's own instant so a recording made before a daylight-saving change keeps its day.
/// A recording without a usable start time keeps Plaud's name, because a date title would
/// otherwise claim 1970-01-01.
async fn title_for(mode: &str, r: &Recording) -> (String, &'static str) {
    let plaud_name = || {
        r.filename
            .clone()
            .filter(|f| !f.trim().is_empty())
            .unwrap_or_else(|| r.id.clone())
    };
    match mode {
        "date" => match r.start_time.filter(|ms| *ms > 0) {
            Some(start) => {
                let offset = crate::routes::recordings::local_offset_at(start).await;
                (crate::time::local_date(start, offset), "date")
            }
            None => (plaud_name(), "original"),
        },
        _ => (plaud_name(), "original"),
    }
}

/// Whether a sync update may follow Plaud's new name. Only a title that is still the original
/// one may be replaced; a date, generated, hand-edited or unknown title is the user's.
fn may_follow_plaud(title_source: &str) -> bool {
    title_source == "original"
}

/// The `YYYY-MM-DD` a historical date-time title should become, when the title is one of the
/// shapes this app wrote for a date title on the recording's own day.
pub(crate) fn repair_candidate(
    title: &str,
    start: i64,
    offset: ::time::UtcOffset,
) -> Option<String> {
    if start <= 0 {
        return None;
    }
    let day = crate::time::local_date(start, offset);
    let rest = title.strip_prefix(day.as_str())?;
    let rest = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('T'))?;
    let ok = rest.len() >= 5
        && rest.is_char_boundary(5)
        && rest.as_bytes()[..5].iter().enumerate().all(|(i, b)| {
            if i == 2 {
                *b == b':'
            } else {
                b.is_ascii_digit()
            }
        })
        && rest[5..].chars().all(|c| c.is_ascii_digit() || c == ':');
    ok.then_some(day)
}

async fn insert_row(
    state: &AppState,
    ctx: &Ctx,
    r: &Recording,
    storage: &import::Stored,
) -> Result<(String, String), ItemError> {
    let id = ids::new_id();
    let now = now_ms();
    let start = r.start_time.unwrap_or(0);
    let (title, title_source) = title_for(&ctx.title_mode, r).await;
    let filesize = r.filesize.filter(|&n| n > 0).unwrap_or(storage.byte_len);
    let file_md5 = r
        .file_md5
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&storage.file_md5);
    let peaks_json = storage
        .peaks
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());
    sqlx::query(
        "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, \
         storage_type, storage_path, auto_export_path, downloaded_at, plaud_version, timezone, zonemins, scene, is_trash, waveform_peaks, \
         deleted_at, starred_at, created_at, updated_at, title_source, auto_export_eligible) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&ctx.user_id)
    .bind(r.serial_number.clone().unwrap_or_default())
    .bind(&r.id)
    .bind(state.config.field_key.encrypt(&title))
    .bind(r.duration.unwrap_or(0))
    .bind(start)
    .bind(r.end_time.unwrap_or(start))
    .bind(filesize)
    .bind(file_md5)
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
    .bind(title_source)
    .bind(crate::export::auto::auto_export_eligible(state, &ctx.user_id).await)
    .execute(&state.db)
    .await?;
    Ok((id, title))
}

/// Overwrites a row with Plaud's values, keeping the stored audio. False when the row was deleted
/// meanwhile, so nothing changed.
///
/// `follow_name` is false when the local title is the user's (a date, a generated title, or a
/// hand edit), and the stored name is then kept.
async fn update_row(
    state: &AppState,
    r: &Recording,
    id: &str,
    follow_name: bool,
) -> Result<bool, ItemError> {
    update_row_with_audio(state, r, id, None, follow_name).await
}

/// The same update, optionally replacing the stored audio. Used when the object was missing.
async fn update_row_with_audio(
    state: &AppState,
    r: &Recording,
    id: &str,
    storage: Option<&import::Stored>,
    follow_name: bool,
) -> Result<bool, ItemError> {
    let now = now_ms();
    // NULL leaves the stored value alone, so a title the user owns survives the update.
    let new_name = follow_name.then(|| {
        state.config.field_key.encrypt(
            &r.filename
                .clone()
                .filter(|f| !f.trim().is_empty())
                .unwrap_or_else(|| r.id.clone()),
        )
    });
    let filesize = r
        .filesize
        .filter(|&n| n > 0)
        .or_else(|| storage.map(|s| s.byte_len));
    let file_md5 = r
        .file_md5
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| storage.map(|s| s.file_md5.clone()));
    let peaks = storage
        .and_then(|s| s.peaks.as_ref())
        .and_then(|p| serde_json::to_string(p).ok());
    let device_sn = if r.is_v4 {
        r.serial_number
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    } else {
        Some(r.serial_number.as_deref().unwrap_or_default())
    };
    let sql = if r.is_v4 {
        "UPDATE recordings SET device_sn = COALESCE(?, device_sn), filename = COALESCE(?, filename), duration = ?, start_time = ?, end_time = ?, \
         filesize = COALESCE(?, filesize), file_md5 = COALESCE(?, file_md5), plaud_version = ?, timezone = COALESCE(?, timezone), \
         zonemins = COALESCE(?, zonemins), scene = COALESCE(?, scene), is_trash = 0, updated_at = ?, \
         storage_type = COALESCE(?, storage_type), storage_path = COALESCE(?, storage_path), \
         downloaded_at = COALESCE(?, downloaded_at), waveform_peaks = COALESCE(?, waveform_peaks) \
         WHERE id = ? AND deleted_at IS NULL"
    } else {
        "UPDATE recordings SET device_sn = ?, filename = COALESCE(?, filename), duration = ?, start_time = ?, end_time = ?, \
         filesize = COALESCE(?, filesize), file_md5 = COALESCE(?, file_md5), plaud_version = ?, timezone = ?, zonemins = ?, scene = ?, is_trash = 0, updated_at = ?, \
         storage_type = COALESCE(?, storage_type), storage_path = COALESCE(?, storage_path), \
         downloaded_at = COALESCE(?, downloaded_at), waveform_peaks = COALESCE(?, waveform_peaks) \
         WHERE id = ? AND deleted_at IS NULL"
    };
    let done = sqlx::query(sql)
        .bind(device_sn)
        .bind(new_name)
        .bind(r.duration.unwrap_or(0))
        .bind(r.start_time.unwrap_or(0))
        .bind(r.end_time.unwrap_or(0))
        .bind(filesize)
        .bind(file_md5)
        .bind(version_text(r))
        .bind(r.timezone)
        .bind(r.zonemins)
        .bind(r.scene)
        .bind(now)
        .bind(storage.map(|s| s.storage_type))
        .bind(storage.map(|s| s.key.as_str()))
        .bind(storage.map(|_| now))
        .bind(peaks)
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
            Ok(wt) => Client::with_workspace(&conn.api_base, &wt, Some(ws.clone()), Some(token)),
            Err(_) => Client::with_workspace(
                &conn.api_base,
                &token,
                Some(ws.clone()),
                Some(token.clone()),
            ),
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
        let conn: Option<ConnRow> = sqlx::query_as(
            "SELECT bearer_token, api_base, plaud_email, workspace_id, invalidated_at, created_at, updated_at \
             FROM plaud_connections WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        let Some(conn) = conn else { return Ok(()) };
        let (client, _) = client_for(state, &conn)
            .await
            .map_err(|_| "no usable Plaud token".to_owned())?;
        client
            .rename_file(&file_id, title)
            .await
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
         LEFT JOIN user_settings s ON s.user_id = p.user_id \
         WHERE u.suspended_at IS NULL AND p.invalidated_at IS NULL \
         AND COALESCE(json_extract(s.data, '$.plaudEnabled'), 1) != 0 \
         AND (p.last_sync IS NULL OR p.last_sync < ?) \
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

#[cfg(test)]
mod title_tests {
    use super::*;

    fn recording(filename: Option<&str>, start: Option<i64>) -> Recording {
        Recording {
            id: "rec-1".into(),
            filename: filename.map(str::to_owned),
            duration: Some(3000),
            start_time: start,
            end_time: start,
            filesize: None,
            file_md5: None,
            serial_number: None,
            version_ms: Some(1),
            timezone: None,
            zonemins: None,
            scene: None,
            edit_time: None,
            is_v4: false,
        }
    }

    #[tokio::test]
    async fn date_mode_names_by_day_only() {
        // 2026-10-18T06:30:00Z. The local day depends on the machine's zone, so the title is
        // compared with the day that same offset produces, never with a hard-coded date.
        let start = 1_792_305_000_000;
        let (title, source) = title_for("date", &recording(Some("Plaud name"), Some(start))).await;
        let offset = crate::routes::recordings::local_offset_at(start).await;
        assert_eq!(title, crate::time::local_date(start, offset));
        assert_eq!(title.len(), 10);
        assert!(!title.contains(':'), "{title}");
        assert_eq!(source, "date");
    }

    #[tokio::test]
    async fn date_mode_keeps_the_plaud_name_without_a_start_time() {
        for start in [None, Some(0), Some(-5)] {
            let (title, source) = title_for("date", &recording(Some("Plaud name"), start)).await;
            assert_eq!(title, "Plaud name");
            assert_eq!(source, "original");
        }
    }

    #[tokio::test]
    async fn original_mode_uses_the_plaud_name_then_the_id() {
        assert_eq!(
            title_for("original", &recording(Some("Team sync"), Some(0))).await,
            ("Team sync".to_owned(), "original")
        );
        assert_eq!(
            title_for("original", &recording(Some("   "), Some(0))).await,
            ("rec-1".to_owned(), "original")
        );
        assert_eq!(
            title_for("ai", &recording(None, Some(0))).await,
            ("rec-1".to_owned(), "original")
        );
    }

    #[tokio::test]
    async fn a_missing_audio_object_is_reported_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(&config.storage_root)
            .await
            .unwrap();
        let state = crate::AppState::new(config, crate::db::open_memory().await.unwrap());

        // A stored object counts as present.
        tokio::fs::create_dir_all(state.config.storage_root.join("u"))
            .await
            .unwrap();
        tokio::fs::write(state.config.storage_root.join("u/here.mp3"), b"ID3")
            .await
            .unwrap();
        assert!(audio_present(&state, "local", "u/here.mp3").await);
        // A missing one does not, so the sync downloads it again.
        assert!(!audio_present(&state, "local", "u/gone.mp3").await);
    }

    #[test]
    fn a_sync_update_only_follows_plaud_for_an_original_title() {
        assert!(may_follow_plaud("original"));
        for kept in ["date", "ai", "manual", "unknown"] {
            assert!(!may_follow_plaud(kept), "{kept}");
        }
    }

    #[test]
    fn the_repair_candidate_matches_a_date_time_shape_of_the_same_day() {
        let offset = ::time::UtcOffset::from_hms(8, 0, 0).unwrap();
        let start = 1_792_305_000_000;
        let day = crate::time::local_date(start, offset);
        assert_eq!(day, "2026-10-18");
        for shape in [
            format!("{day} 23:30"),
            format!("{day}T23:30"),
            format!("{day} 23:30:05"),
        ] {
            assert_eq!(
                repair_candidate(&shape, start, offset).as_deref(),
                Some(day.as_str()),
                "{shape}"
            );
        }
        // A plain date is already the target, and a title from another day is not this recording's.
        assert!(repair_candidate(&day, start, offset).is_none());
        assert!(repair_candidate("Team sync", start, offset).is_none());
        assert!(repair_candidate("2026-10-19 09:00", start, offset).is_none());
    }

    #[tokio::test]
    async fn v4_update_preserves_saved_metadata_when_detail_omits_it() {
        let dir = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());
        let state = crate::AppState::new(config, crate::db::open_memory().await.unwrap());
        let now = crate::db::now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, timezone, zonemins, scene, is_trash, created_at, updated_at, title_source) \
             VALUES ('r1', 'u1', 'SN-ORIG', 'legacy-1', ?, 3000, 1000, 4000, 5120, 'deadbeef', 'local', 'u1/legacy-1.mp3', '100', -8, 0, 2, 0, ?, ?, 'original')",
        )
        .bind(state.config.field_key.encrypt("Old Title"))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let mut v4_rec = recording(Some("Renamed in 4.0"), Some(1000));
        v4_rec.id = "legacy-1".into();
        v4_rec.version_ms = Some(200);
        v4_rec.is_v4 = true;
        assert!(update_row(&state, &v4_rec, "r1", true).await.unwrap());

        let row: (
            String,
            i64,
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            String,
        ) = sqlx::query_as(
            "SELECT device_sn, filesize, file_md5, timezone, zonemins, scene, plaud_version \
                 FROM recordings WHERE id = 'r1'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(row.0, "SN-ORIG");
        assert_eq!(row.1, 5120);
        assert_eq!(row.2, "deadbeef");
        assert_eq!(row.3, Some(-8));
        assert_eq!(row.4, Some(0));
        assert_eq!(row.5, Some(2));
        assert_eq!(row.6, "200");
    }

    #[tokio::test]
    async fn detail_only_v4_version_does_not_repeat_updates() {
        use axum::routing::get;
        use axum::{Json, Router};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/file-app/v4/files/detail/f_nodate",
            get(|| async {
                Json(json!({
                    "status": 0,
                    "data": {
                        "node": { "node_id": "n1", "name": "Detail Only", "version_ms": 42 },
                        "meta": { "file_id": "f_nodate", "duration": 3000, "start_time": 1000, "version_ms": 42 },
                        "objects": []
                    }
                }))
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(config.storage_root.join("u1"))
            .await
            .unwrap();
        tokio::fs::write(config.storage_root.join("u1/f_nodate.mp3"), b"ID3")
            .await
            .unwrap();
        let state = crate::AppState::new(config, crate::db::open_memory().await.unwrap());
        let now = crate::db::now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('r1', 'u1', '', 'f_nodate', ?, 3000, 1000, 4000, 3, 'abc', 'local', 'u1/f_nodate.mp3', '42', 0, ?, ?, 'original')",
        )
        .bind(state.config.field_key.encrypt("Detail Only"))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let ctx = Ctx {
            user_id: "u1".into(),
            client: Client::with_workspace(
                &format!("http://{addr}"),
                "wt",
                Some("ws".into()),
                None,
            ),
            import_content: false,
            title_mode: "original".into(),
            content_stopped: AtomicBool::new(false),
            errors: Mutex::new(Vec::new()),
        };
        let mut r = recording(Some("Detail Only"), None);
        r.id = "f_nodate".into();
        r.version_ms = None;
        r.is_v4 = true;

        let outcome = process(&state, &ctx, &r).await.unwrap();
        assert!(matches!(outcome, Outcome::Unchanged { imported: false }));
    }

    #[tokio::test]
    async fn a_switch_to_v4_mid_listing_restarts_from_the_first_v4_page() {
        use axum::Router;
        use axum::extract::Query;
        use axum::routing::get;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let failure = || async { Json(json!({ "status": -7, "msg": "not in this test" })) };
        let app = Router::new()
            .route(
                "/file/simple/web",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    if q.get("skip").map(String::as_str) != Some("0") {
                        return Json(json!({ "status": crate::plaud::v4::MIGRATED_STATUS, "msg": "migrated to 4.0" }));
                    }
                    let list: Vec<Value> = (0..api::PAGE_SIZE)
                        .map(|i| json!({ "id": format!("legacy{i}"), "filename": format!("legacy-{i}"), "version_ms": 1 }))
                        .collect();
                    Json(json!({ "status": 0, "data_file_list": list }))
                }),
            )
            .route(
                "/file-app/v4/recordings/all",
                get(|| async {
                    let items: Vec<Value> = (0..60)
                        .map(|i| json!({ "file_id": format!("f_v4n{i}"), "name": format!("v4-{i}"), "version_ms": 1000 - i }))
                        .collect();
                    Json(json!({ "status": 0, "data": { "items": items, "next_cursor": null } }))
                }),
            )
            .route("/file/temp-url/{id}", get(failure))
            .route("/file-app/v4/files/detail/{id}", get(failure));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let config = crate::Config::for_tests(dir.path());
        let state = crate::AppState::new(config, crate::db::open_memory().await.unwrap());
        let ctx = Ctx {
            user_id: "u1".into(),
            client: Client::new(&format!("http://{addr}"), "tok"),
            import_content: false,
            title_mode: "original".into(),
            content_stopped: AtomicBool::new(false),
            errors: Mutex::new(Vec::new()),
        };
        let mut report = Report::default();
        let (mut new_ids, mut new_titles) = (Vec::new(), Vec::new());
        sync_pages(&state, &ctx, &mut report, &mut new_ids, &mut new_titles)
            .await
            .map_err(|_| "sync stopped")
            .unwrap();

        for i in 0..60 {
            let name = format!("Failed to sync v4-{i}:");
            assert!(
                report.errors.iter().any(|e| e.starts_with(&name)),
                "{name} was never synced"
            );
        }
    }
}
