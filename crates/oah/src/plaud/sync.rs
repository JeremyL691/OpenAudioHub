//! Manual sync, the sync run (listing, dedupe, tombstones, devices), and the auto sync worker (spec/plaud.md).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use futures_util::future::{BoxFuture, FutureExt, Shared, join_all};
use serde::Deserialize;
use serde_json::{Value, json};

use super::api::{self, Client, PlaudError, Recording};
use super::connect::ConnRow;
use super::import::{self, ContentPart};
use super::split::{self, AppendOutcome, ChainPlan};
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{ApiResult, AppError};
use crate::jobs::{self, NewJob};
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

enum ExistingKind {
    MultiPartDeleted,
    MultiPartLive {
        recording_id: String,
        part_index: i64,
        part_version: String,
        title_source: String,
    },
    SingleDeleted,
    SingleLive {
        id: String,
        prev_version: String,
        prev_type: String,
        prev_key: String,
        prev_source: String,
    },
    New,
}

/// What one run shares among its recordings.
struct Ctx {
    user_id: String,
    client: Client,
    import_content: bool,
    title_mode: String,
    merge_splits: bool,
    merge_by_day: bool,
    allow_settle: bool,
    /// Set when Plaud refuses the token during content import; the rest of the run skips content.
    content_stopped: AtomicBool,
    /// Multi-part recordings whose content import has already been attempted in this run.
    content_checked: Mutex<HashSet<String>>,
    /// Recording ids already reported as updated in this run.
    updated_ids: Mutex<HashSet<String>>,
    errors: Mutex<Vec<String>>,
}

impl Ctx {
    fn mark_updated(&self, recording_id: &str) -> bool {
        self.updated_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(recording_id.to_owned())
    }

    fn claim_content_check(&self, recording_id: &str) -> bool {
        self.content_checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(recording_id.to_owned())
    }

    fn reset_content_check(&self, recording_id: &str) {
        self.content_checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(recording_id);
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SyncBody {
    quiet: bool,
}

type SharedRun = Shared<BoxFuture<'static, Report>>;

/// Runs in progress, by user. A second request for the same user joins the first run.
static RUNS: LazyLock<Mutex<HashMap<String, SharedRun>>> = LazyLock::new(Default::default);

pub async fn manual(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let quiet = if body.is_empty() {
        false
    } else {
        serde_json::from_slice::<SyncBody>(&body)
            .map(|b| b.quiet)
            .unwrap_or(false)
    };
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
    let (report, joined) = run_shared(&state, &user.id, quiet).await;
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
/// When an explicit manual sync (`allow_settle == false`) joins an in-flight quiet run that left
/// unsettled split tips behind, it follows immediately with one non-settle pass.
async fn run_shared(state: &AppState, user_id: &str, allow_settle: bool) -> (Report, bool) {
    let (mut report, joined) = run_shared_once(state, user_id, allow_settle).await;
    if joined && !allow_settle && split::has_unsettled_rows(state, user_id).await {
        let (followup, _) = run_shared_once(state, user_id, false).await;
        report.new += followup.new;
        report.updated += followup.updated;
        report.errors.extend(followup.errors);
        report.needs_reconnect = followup.needs_reconnect;
    }
    (report, joined)
}

async fn run_shared_once(state: &AppState, user_id: &str, allow_settle: bool) -> (Report, bool) {
    let (fut, joined) = {
        let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
        match runs.get(user_id) {
            Some(f) => (f.clone(), true),
            None => {
                let (s, uid) = (state.clone(), user_id.to_owned());
                let f = async move {
                    let report = run(&s, &uid, allow_settle).await;
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

async fn run(state: &AppState, user_id: &str, allow_settle: bool) -> Report {
    let mut report = Report::default();
    match sync_inner(state, user_id, allow_settle, &mut report).await {
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

async fn sync_inner(
    state: &AppState,
    user_id: &str,
    allow_settle: bool,
    report: &mut Report,
) -> Result<(), Stop> {
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
        merge_splits: flag("mergePlaudSplitRecordings", true),
        merge_by_day: flag("mergePlaudByDay", false),
        allow_settle,
        content_stopped: AtomicBool::new(false),
        content_checked: Mutex::new(HashSet::new()),
        updated_ids: Mutex::new(HashSet::new()),
        errors: Mutex::new(Vec::new()),
    };
    let mut new_ids = Vec::new();
    let mut new_titles = Vec::new();
    let mut late_appended = Vec::new();
    let pages = sync_pages(
        state,
        &ctx,
        report,
        &mut new_ids,
        &mut new_titles,
        &mut late_appended,
    )
    .await;
    report
        .errors
        .extend(ctx.errors.into_inner().unwrap_or_else(|e| e.into_inner()));
    if !new_titles.is_empty() {
        crate::notify::new_recordings(state, user_id, &new_titles).await;
    }
    pages?;

    if auto_transcribe {
        for id in &new_ids {
            let plaud_done: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND source = 'plaud')",
            )
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

    for (id, had_oah_work) in &late_appended {
        if *had_oah_work {
            if let Err(e) = jobs::enqueue(
                &state.db,
                NewJob {
                    kind: "transcribe",
                    user_id: Some(user_id),
                    recording_id: Some(id),
                    payload: json!({}),
                },
            )
            .await
            {
                tracing::warn!(recording = %id, error = %e, "re-queueing transcription after split append failed");
            } else {
                state.wakeup.notify();
            }
        } else if auto_transcribe {
            let plaud_done: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND source = 'plaud')",
            )
            .bind(id)
            .fetch_one(&state.db)
            .await?;
            if plaud_only && plaud_done {
                continue;
            }
            if let Err(e) = transcribe::queue_auto(state, user_id, id).await {
                tracing::warn!(recording = %id, error = %e.message, "queueing automatic transcription after split append failed");
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

/// Pages through the recording list. When split or daily auto-merge is on, collects candidates
/// across pages before downloading so chains are never cut at page or batch boundaries.
async fn sync_pages(
    state: &AppState,
    ctx: &Ctx,
    report: &mut Report,
    new_ids: &mut Vec<String>,
    new_titles: &mut Vec<String>,
    late_appended: &mut Vec<(String, bool)>,
) -> Result<(), Stop> {
    if !ctx.merge_splits && !ctx.merge_by_day {
        return sync_pages_unmerged(state, ctx, report, new_ids, new_titles).await;
    }

    let open_tail_anchors = if ctx.merge_splits {
        split::load_open_tail_anchors(state, &ctx.user_id).await?
    } else {
        Vec::new()
    };
    let mut page = 0;
    let mut idle = 0;
    let mut listed_v4 = ctx.client.is_v4_mode();
    let mut seen_ids = HashSet::new();
    let mut existing_items = Vec::new();
    let mut new_items = Vec::new();
    let mut invalid_items = Vec::new();

    loop {
        let rows = ctx.client.recordings(page).await?;
        if !listed_v4 && ctx.client.is_v4_mode() {
            listed_v4 = true;
            // Plaud 4.0 lists in another order, so a legacy page offset would skip recordings.
            if page > 0 {
                seen_ids.clear();
                existing_items.clear();
                new_items.clear();
                invalid_items.clear();
                page = 0;
                idle = 0;
                continue;
            }
        }
        let mut page_active = false;
        for r in &rows {
            if !seen_ids.insert(r.id.clone()) {
                continue;
            }
            if !safe_file_id(&r.id) {
                invalid_items.push(r.clone());
                continue;
            }
            match lookup_existing(state, &ctx.user_id, &r.id).await? {
                ExistingKind::MultiPartDeleted | ExistingKind::SingleDeleted => {}
                ExistingKind::MultiPartLive { part_version, .. } => {
                    let version_same = r.version_ms.is_some() && part_version == version_text(r);
                    if !version_same || ctx.import_content {
                        page_active = true;
                    }
                    existing_items.push(r.clone());
                }
                ExistingKind::SingleLive { prev_version, .. } => {
                    let version_same = r.version_ms.is_some() && prev_version == version_text(r);
                    if !version_same || ctx.import_content {
                        page_active = true;
                    }
                    existing_items.push(r.clone());
                }
                ExistingKind::New => {
                    page_active = true;
                    new_items.push(r.clone());
                }
            }
        }
        if rows.len() < api::PAGE_SIZE {
            break;
        }
        idle = if page_active { 0 } else { idle + 1 };
        if idle >= 2 {
            let need_more = (ctx.merge_splits
                && split::has_open_split_head(&open_tail_anchors, &new_items))
                || (ctx.merge_by_day && !new_items.is_empty());
            // In 4.0 mode the entire list is already cached in memory; in legacy mode cap lookahead.
            if !need_more || (!listed_v4 && idle >= 4) {
                break;
            }
        }
        page += 1;
    }

    for r in &invalid_items {
        let name = display_name(r);
        report.errors.push(format!(
            "Failed to sync {name}: Plaud returned a recording with an invalid id"
        ));
    }

    // 1. Process existing items in batches.
    for chunk in existing_items.chunks(BATCH) {
        let results = join_all(chunk.iter().map(|r| process(state, ctx, r))).await;
        for (r, result) in chunk.iter().zip(results) {
            record_outcome(state, ctx, r, result, report, new_ids, new_titles).await?;
        }
    }

    // Reload live DB anchors after Step 1 so consolidation sees fresh storage paths and metadata.
    let daily_anchors = if ctx.merge_by_day {
        let anchors = split::load_daily_anchors(state, &ctx.user_id).await?;
        if new_items.is_empty() && anchors.len() < 2 {
            return Ok(());
        }
        Some(anchors)
    } else {
        None
    };
    let open_tail_anchors = if ctx.merge_by_day {
        Vec::new()
    } else {
        let anchors = split::load_open_tail_anchors(state, &ctx.user_id).await?;
        if new_items.is_empty() && anchors.is_empty() {
            return Ok(());
        }
        anchors
    };

    // 2. Lazy-hydrate new Plaud 4.0 items needed for grouping (all v4 new items in daily mode,
    //    or only when a ~5h recording / open anchor exists in split-only mode).
    let mut ready_new = Vec::with_capacity(new_items.len());
    if !new_items.is_empty() {
        let hydrate_mask: Vec<bool> = if ctx.merge_by_day {
            new_items.iter().map(|r| r.is_v4).collect()
        } else {
            split::needs_hydration_for_split(&new_items, &open_tail_anchors)
        };
        let mut to_hydrate_indices = Vec::new();
        let mut slots: Vec<Option<Recording>> = new_items.into_iter().map(Some).collect();
        for (idx, &need) in hydrate_mask.iter().enumerate() {
            if need {
                to_hydrate_indices.push(idx);
            }
        }
        for idx_chunk in to_hydrate_indices.chunks(BATCH) {
            let futs = idx_chunk.iter().map(|&idx| {
                let rec = slots[idx].as_ref().expect("slot present").clone();
                async move { (idx, ctx.client.hydrate_recording(&rec).await) }
            });
            for (idx, res) in join_all(futs).await {
                match res {
                    Ok(hydrated) => slots[idx] = Some(hydrated),
                    Err(PlaudError::Rejected { .. }) => return Err(Stop::Rejected),
                    Err(e) => {
                        let failed = slots[idx].take().expect("slot present");
                        report.errors.push(format!(
                            "Failed to sync {}: {}",
                            display_name(&failed),
                            api::describe(&e)
                        ));
                    }
                }
            }
        }
        for r in slots.into_iter().flatten() {
            ready_new.push(r);
        }
    }

    // 3. Group live DB anchors and new recordings chronologically into merge/consolidation plans.
    let plans = if let Some(daily) = daily_anchors {
        split::plan_daily_chains(&daily, ready_new, ctx.merge_splits, split::local_day_key)
    } else {
        let all_anchors =
            split::load_candidate_anchors(state, &ctx.user_id, open_tail_anchors, &ready_new)
                .await?;
        split::plan_chains(&all_anchors, ready_new)
    };

    // 4. Apply settle window for quiet/background runs on fresh ~5h tips.
    let settle_ms = if ctx.allow_settle {
        split::settle_window_ms()
    } else {
        0
    };
    let mut singles = Vec::new();
    let mut multi_or_consolidate = Vec::new();
    for plan in plans {
        if ctx.allow_settle
            && settle_ms > 0
            && let Some(tip_id) = split::settle_tip_id(&plan)
            && split::should_defer_tip(state, &ctx.user_id, tip_id, now_ms(), settle_ms).await?
        {
            continue;
        }
        match plan {
            ChainPlan::Single(r) => singles.push(*r),
            other => multi_or_consolidate.push(other),
        }
    }

    // 5. Process standalone new recordings in parallel batches.
    for chunk in singles.chunks(BATCH) {
        let results = join_all(chunk.iter().map(|r| async move {
            let outcome = process(state, ctx, r).await;
            if matches!(outcome, Ok(Outcome::New(_, _))) {
                split::clear_settle_for_single(state, &ctx.user_id, r).await;
            }
            outcome
        }))
        .await;
        for (r, result) in chunk.iter().zip(results) {
            record_outcome(state, ctx, r, result, report, new_ids, new_titles).await?;
        }
    }

    // 6. Execute multi-part merges and bidirectional consolidations sequentially to bound RAM and disk I/O.
    for plan in multi_or_consolidate {
        match plan {
            ChainPlan::NewMulti(parts) => {
                let lead_name = display_name(&parts[0]);
                match split::execute_new_multi(
                    state,
                    &ctx.user_id,
                    &ctx.client,
                    &ctx.title_mode,
                    &parts,
                )
                .await
                {
                    Ok((id, title)) => {
                        report.new += 1;
                        webhooks::emit_soft(state, &ctx.user_id, &id, "recording.synced", None)
                            .await;
                        new_titles.push(title);
                        new_ids.push(id.clone());
                        import_for_parts(state, ctx, &id).await;
                    }
                    Err(ItemError::Rejected) => return Err(Stop::Rejected),
                    Err(ItemError::Failed(m)) => {
                        report
                            .errors
                            .push(format!("Failed to sync {lead_name}: {m}"));
                    }
                }
            }
            ChainPlan::Consolidate(segs) => {
                let lead_name = segs[0].lead_name();
                match split::execute_consolidate(state, &ctx.user_id, &ctx.client, &segs).await {
                    Ok(AppendOutcome::Updated {
                        recording_id,
                        had_oah_work,
                    }) => {
                        if ctx.mark_updated(&recording_id) {
                            report.updated += 1;
                            webhooks::emit_soft(
                                state,
                                &ctx.user_id,
                                &recording_id,
                                "recording.updated",
                                None,
                            )
                            .await;
                        }
                        ctx.reset_content_check(&recording_id);
                        import_for_parts(state, ctx, &recording_id).await;
                        late_appended.push((recording_id, had_oah_work));
                    }
                    Ok(AppendOutcome::Tombstoned) => {}
                    Err(ItemError::Rejected) => return Err(Stop::Rejected),
                    Err(ItemError::Failed(m)) => {
                        report
                            .errors
                            .push(format!("Failed to sync {lead_name}: {m}"));
                    }
                }
            }
            ChainPlan::Single(_) => {}
        }
    }

    Ok(())
}

/// Page-by-page sync used when `mergePlaudSplitRecordings` is disabled.
/// Still honors `plaud_recording_parts` for already-merged recordings and tombstones.
async fn sync_pages_unmerged(
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
            if page > 0 {
                page = 0;
                idle = 0;
                continue;
            }
        }
        let mut changed = false;
        for chunk in rows.chunks(BATCH) {
            let results = join_all(chunk.iter().map(|r| async move {
                let outcome = process(state, ctx, r).await;
                if matches!(outcome, Ok(Outcome::New(_, _))) {
                    split::clear_settle_for_single(state, &ctx.user_id, r).await;
                }
                outcome
            }))
            .await;
            for (r, result) in chunk.iter().zip(results) {
                let item_changed =
                    record_outcome(state, ctx, r, result, report, new_ids, new_titles).await?;
                changed |= item_changed;
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

async fn record_outcome(
    state: &AppState,
    ctx: &Ctx,
    r: &Recording,
    result: Result<Outcome, ItemError>,
    report: &mut Report,
    new_ids: &mut Vec<String>,
    new_titles: &mut Vec<String>,
) -> Result<bool, Stop> {
    match result {
        Ok(Outcome::New(id, title)) => {
            report.new += 1;
            webhooks::emit_soft(state, &ctx.user_id, &id, "recording.synced", None).await;
            new_titles.push(title);
            new_ids.push(id);
            Ok(true)
        }
        Ok(Outcome::Updated(id)) => {
            if ctx.mark_updated(&id) {
                report.updated += 1;
                webhooks::emit_soft(state, &ctx.user_id, &id, "recording.updated", None).await;
            }
            Ok(true)
        }
        Ok(Outcome::Unchanged { imported }) => Ok(imported),
        Ok(Outcome::Skipped) => Ok(false),
        Err(ItemError::Rejected) => Err(Stop::Rejected),
        Err(ItemError::Failed(m)) => {
            report
                .errors
                .push(format!("Failed to sync {}: {m}", display_name(r)));
            Ok(false)
        }
    }
}

fn display_name(r: &Recording) -> String {
    r.filename
        .clone()
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| r.id.clone())
}

/// Plaud file ids end up in file names and URL paths, so only a plain id is accepted.
pub(crate) fn safe_file_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

async fn lookup_existing(
    state: &AppState,
    user_id: &str,
    plaud_file_id: &str,
) -> Result<ExistingKind, sqlx::Error> {
    let part: Option<(String, i64, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT p.recording_id, p.part_index, p.plaud_version, r.deleted_at, r.title_source \
         FROM plaud_recording_parts p \
         JOIN recordings r ON r.id = p.recording_id \
         WHERE p.user_id = ? AND p.plaud_file_id = ?",
    )
    .bind(user_id)
    .bind(plaud_file_id)
    .fetch_optional(&state.db)
    .await?;

    if let Some((recording_id, part_index, part_version, deleted_at, title_source)) = part {
        return Ok(if deleted_at.is_some() {
            ExistingKind::MultiPartDeleted
        } else {
            ExistingKind::MultiPartLive {
                recording_id,
                part_index,
                part_version,
                title_source,
            }
        });
    }

    let existing: Option<(String, Option<i64>, String, String, String, String)> = sqlx::query_as(
        "SELECT id, deleted_at, plaud_version, storage_type, storage_path, title_source \
         FROM recordings WHERE user_id = ? AND plaud_file_id = ?",
    )
    .bind(user_id)
    .bind(plaud_file_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(match existing {
        Some((_, Some(_), _, _, _, _)) => ExistingKind::SingleDeleted,
        Some((id, None, prev_version, prev_type, prev_key, prev_source)) => {
            ExistingKind::SingleLive {
                id,
                prev_version,
                prev_type,
                prev_key,
                prev_source,
            }
        }
        None => ExistingKind::New,
    })
}

async fn process(state: &AppState, ctx: &Ctx, r: &Recording) -> Result<Outcome, ItemError> {
    if !safe_file_id(&r.id) {
        return Err(ItemError::Failed(
            "Plaud returned a recording with an invalid id".into(),
        ));
    }
    let version = version_text(r);
    match lookup_existing(state, &ctx.user_id, &r.id).await? {
        // Deleted here (single or multi-part): never imported again, no download.
        ExistingKind::MultiPartDeleted | ExistingKind::SingleDeleted => Ok(Outcome::Skipped),
        ExistingKind::MultiPartLive {
            recording_id,
            part_index,
            part_version,
            title_source,
        } => {
            if r.version_ms.is_some() && part_version == version {
                let imported = import_for_parts(state, ctx, &recording_id).await;
                return Ok(Outcome::Unchanged { imported });
            }
            let hydrated = ctx.client.hydrate_recording(r).await?;
            let new_ver = version_text(&hydrated);
            if part_version == new_ver {
                let imported = import_for_parts(state, ctx, &recording_id).await;
                return Ok(Outcome::Unchanged { imported });
            }
            // Multi-part update: update the part version (and lead title only if still original),
            // never clobbering merged duration, end_time, filesize, or file_md5.
            let updated = update_part_metadata(
                state,
                &ctx.user_id,
                &recording_id,
                part_index,
                &hydrated,
                may_follow_plaud(&title_source),
            )
            .await?;
            if !updated {
                return Ok(Outcome::Skipped);
            }
            import_for_parts(state, ctx, &recording_id).await;
            Ok(Outcome::Updated(recording_id))
        }
        ExistingKind::SingleLive {
            id, prev_version, ..
        } if r.version_ms.is_some() && prev_version == version => {
            let imported = import_for(state, ctx, &id, &r.id).await;
            Ok(Outcome::Unchanged { imported })
        }
        ExistingKind::SingleLive {
            id,
            prev_version,
            prev_type,
            prev_key,
            prev_source,
        } => {
            let hydrated = ctx.client.hydrate_recording(r).await?;
            if prev_version == version_text(&hydrated) {
                let imported = import_for(state, ctx, &id, &hydrated.id).await;
                return Ok(Outcome::Unchanged { imported });
            }
            // A stored file is kept: a changed Plaud version only refreshes metadata, so a rename
            // or an edit in Plaud never replaces a file the user may be playing. The exception is a
            // missing object, which would leave the recording unplayable for good.
            if audio_present(state, &prev_type, &prev_key).await {
                let follow = may_follow_plaud(&prev_source);
                let preserve_audio_meta = prev_key.to_ascii_lowercase().ends_with(".ogg");
                match update_row(state, &hydrated, &id, follow, preserve_audio_meta).await {
                    Ok(true) => {}
                    Ok(false) => return Ok(Outcome::Skipped),
                    Err(e) => return Err(e),
                }
            } else {
                let storage =
                    import::store_audio(state, &ctx.user_id, &ctx.client, &hydrated.id).await?;
                match update_row_with_audio(state, &hydrated, &id, Some(&storage), true, false)
                    .await
                {
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
        ExistingKind::New => {
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

async fn update_part_metadata(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    part_index: i64,
    r: &Recording,
    follow_name: bool,
) -> Result<bool, ItemError> {
    let now = now_ms();
    let new_ver = version_text(r);
    let mut tx = crate::db::begin_write(&state.db).await?;
    let alive: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM recordings WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(recording_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if alive.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }

    sqlx::query(
        "UPDATE plaud_recording_parts SET plaud_version = ?, updated_at = ? \
         WHERE user_id = ? AND plaud_file_id = ?",
    )
    .bind(&new_ver)
    .bind(now)
    .bind(user_id)
    .bind(&r.id)
    .execute(&mut *tx)
    .await?;

    if part_index == 0 {
        let new_name = follow_name.then(|| {
            state.config.field_key.encrypt(
                &r.filename
                    .clone()
                    .filter(|f| !f.trim().is_empty())
                    .unwrap_or_else(|| r.id.clone()),
            )
        });
        sqlx::query(
            "UPDATE recordings SET filename = COALESCE(?, filename), plaud_version = ?, updated_at = ? \
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(new_name)
        .bind(&new_ver)
        .bind(now)
        .bind(recording_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(true)
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
pub(crate) async fn title_for(mode: &str, r: &Recording) -> (String, &'static str) {
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
    let filesize = if storage.remuxed {
        storage.byte_len
    } else {
        r.filesize.filter(|&n| n > 0).unwrap_or(storage.byte_len)
    };
    let file_md5 = if storage.remuxed {
        storage.file_md5.as_str()
    } else {
        r.file_md5
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&storage.file_md5)
    };
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
    preserve_audio_meta: bool,
) -> Result<bool, ItemError> {
    update_row_with_audio(state, r, id, None, follow_name, preserve_audio_meta).await
}

/// The same update, optionally replacing the stored audio. Used when the object was missing.
async fn update_row_with_audio(
    state: &AppState,
    r: &Recording,
    id: &str,
    storage: Option<&import::Stored>,
    follow_name: bool,
    preserve_audio_meta: bool,
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
    let filesize = if preserve_audio_meta && storage.is_none() {
        None
    } else if let Some(s) = storage.filter(|s| s.remuxed) {
        Some(s.byte_len)
    } else {
        r.filesize
            .filter(|&n| n > 0)
            .or_else(|| storage.map(|s| s.byte_len))
    };
    let file_md5 = if preserve_audio_meta && storage.is_none() {
        None
    } else if let Some(s) = storage.filter(|s| s.remuxed) {
        Some(s.file_md5.clone())
    } else {
        r.file_md5
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| storage.map(|s| s.file_md5.clone()))
    };
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

/// Content import for one single-part recording. Failures are recorded, not returned.
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

/// Content import for a multi-part merged recording, deduplicated per recording within one run.
async fn import_for_parts(state: &AppState, ctx: &Ctx, recording_id: &str) -> bool {
    if !ctx.import_content
        || ctx.content_stopped.load(Ordering::Relaxed)
        || !ctx.claim_content_check(recording_id)
    {
        return false;
    }
    let rows: Vec<(String, i64)> = match sqlx::query_as(
        "SELECT plaud_file_id, audio_duration_ms FROM plaud_recording_parts \
         WHERE recording_id = ? AND user_id = ? ORDER BY part_index ASC",
    )
    .bind(recording_id)
    .bind(&ctx.user_id)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            if let Ok(mut errors) = ctx.errors.lock() {
                errors.push(format!(
                    "Plaud content import failed for {recording_id}: {e}"
                ));
            }
            return false;
        }
    };
    let parts: Vec<ContentPart> = rows
        .into_iter()
        .map(|(plaud_file_id, audio_duration_ms)| ContentPart {
            plaud_file_id,
            audio_duration_ms,
        })
        .collect();
    let message =
        match import::import_content_parts(state, &ctx.user_id, &ctx.client, recording_id, &parts)
            .await
        {
            Ok(imported) => return imported,
            Err(ItemError::Rejected) => {
                if ctx.content_stopped.swap(true, Ordering::Relaxed) {
                    return false;
                }
                "Plaud content import stopped: access token expired".to_owned()
            }
            Err(ItemError::Failed(m)) => {
                format!("Plaud content import failed for {recording_id}: {m}")
            }
        };
    if let Ok(mut errors) = ctx.errors.lock() {
        errors.push(message);
    }
    false
}

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
/// recording came from Plaud. For multi-part merged recordings, renames each part `i`
/// to `"{title} ({i+1}/{n})"`. Failures are logged only; the local title stays.
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
        // Uploads and manual merges have no Plaud file to rename.
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

        let part_ids: Vec<String> = sqlx::query_scalar(
            "SELECT plaud_file_id FROM plaud_recording_parts \
             WHERE recording_id = ? AND user_id = ? ORDER BY part_index ASC",
        )
        .bind(recording_id)
        .bind(user_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

        if part_ids.len() >= 2 {
            let total = part_ids.len();
            for (idx, part_id) in part_ids.iter().enumerate() {
                if !safe_file_id(part_id) {
                    continue;
                }
                let part_title = format!("{title} ({}/{total})", idx + 1);
                if let Err(e) = client.rename_file(part_id, &part_title).await {
                    tracing::warn!(
                        recording = recording_id,
                        part = part_id,
                        error = %super::api::describe(&e),
                        "could not send part title to Plaud"
                    );
                }
            }
            return Ok(());
        }

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
        match tokio::time::timeout(RUN_TIMEOUT, run_shared(state, &user_id, true)).await {
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

    fn test_ctx(client: Client) -> Ctx {
        Ctx {
            user_id: "u1".into(),
            client,
            import_content: false,
            title_mode: "original".into(),
            merge_splits: true,
            merge_by_day: false,
            allow_settle: false,
            content_stopped: AtomicBool::new(false),
            content_checked: Mutex::new(HashSet::new()),
            updated_ids: Mutex::new(HashSet::new()),
            errors: Mutex::new(Vec::new()),
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
        assert!(
            update_row(&state, &v4_rec, "r1", true, false)
                .await
                .unwrap()
        );

        // Wrapped .ogg recordings keep their stored filesize and file_md5 when Plaud sends a new version.
        sqlx::query("UPDATE recordings SET storage_path = 'u1/legacy-1.ogg' WHERE id = 'r1'")
            .execute(&state.db)
            .await
            .unwrap();
        v4_rec.version_ms = Some(300);
        v4_rec.filesize = Some(999_999);
        v4_rec.file_md5 = Some("clobbermd5".into());
        assert!(update_row(&state, &v4_rec, "r1", true, true).await.unwrap());

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
        assert_eq!(row.6, "300");
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

        let ctx = test_ctx(Client::with_workspace(
            &format!("http://{addr}"),
            "wt",
            Some("ws".into()),
            None,
        ));
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
        let ctx = test_ctx(Client::new(&format!("http://{addr}"), "tok"));
        let mut report = Report::default();
        let (mut new_ids, mut new_titles, mut late) = (Vec::new(), Vec::new(), Vec::new());
        sync_pages(
            &state,
            &ctx,
            &mut report,
            &mut new_ids,
            &mut new_titles,
            &mut late,
        )
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

    #[tokio::test]
    async fn multipart_part_update_preserves_merged_audio_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-m', 'u1', 'SN1', 'f_p0', ?, 25200000, 1000, 25201000, 8888, 'mergedmd5', 'local', 'u1/f_p0.ogg', '100', 0, ?, ?, 'original')",
        )
        .bind(state.config.field_key.encrypt("Long Meeting"))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        for (idx, fid, st, en, dur) in [
            (0i64, "f_p0", 1000i64, 18_001_000i64, 18_000_000i64),
            (1i64, "f_p1", 18_002_000i64, 25_202_000i64, 7_200_000i64),
        ] {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES ('u1', ?, 'rec-m', ?, ?, ?, ?, ?, '100', ?, ?)",
            )
            .bind(fid)
            .bind(idx)
            .bind(st)
            .bind(en)
            .bind(dur)
            .bind(dur)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        }

        // Updating part 1 bumps only part 1's version; merged recording filename/duration/size stay untouched.
        let mut p1_upd = recording(Some("Part 2 Renamed"), Some(18_002_000));
        p1_upd.id = "f_p1".into();
        p1_upd.duration = Some(7_200_000);
        p1_upd.version_ms = Some(200);
        assert!(
            update_part_metadata(&state, "u1", "rec-m", 1, &p1_upd, true)
                .await
                .unwrap()
        );

        let (enc_name, dur, end_time, size, md5): (String, i64, i64, i64, String) =
            sqlx::query_as(
                "SELECT filename, duration, end_time, filesize, file_md5 FROM recordings WHERE id = 'rec-m'",
            )
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(
            state.config.field_key.decrypt(&enc_name).unwrap(),
            "Long Meeting"
        );
        assert_eq!(
            (dur, end_time, size, md5.as_str()),
            (25_200_000, 25_201_000, 8888, "mergedmd5")
        );

        // Updating part 0 with original title_source updates filename and version, still preserving merged audio stats.
        let mut p0_upd = recording(Some("Updated Lead Name"), Some(1000));
        p0_upd.id = "f_p0".into();
        p0_upd.duration = Some(18_000_000);
        p0_upd.version_ms = Some(300);
        assert!(
            update_part_metadata(&state, "u1", "rec-m", 0, &p0_upd, true)
                .await
                .unwrap()
        );
        let (enc_name, dur, size): (String, i64, i64) = sqlx::query_as(
            "SELECT filename, duration, filesize FROM recordings WHERE id = 'rec-m'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(
            state.config.field_key.decrypt(&enc_name).unwrap(),
            "Updated Lead Name"
        );
        assert_eq!((dur, size), (25_200_000, 8888));
    }

    #[tokio::test]
    async fn push_title_renames_each_part_with_index_suffix_on_multipart_recording() {
        use axum::extract::Path;
        use axum::routing::{get, patch};
        use axum::{Json, Router};
        use std::sync::Arc;

        let calls = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let calls_ref = calls.clone();
        let app = Router::new()
            .route(
                "/file/{id}",
                patch(move |Path(id): Path<String>, Json(body): Json<Value>| {
                    let calls_ref = calls_ref.clone();
                    async move {
                        let name = body["filename"].as_str().unwrap_or_default().to_owned();
                        calls_ref.lock().unwrap().push((id, name));
                        Json(json!({ "status": 0 }))
                    }
                }),
            )
            .route(
                "/team-app/workspaces/list",
                get(|| async { Json(json!({ "status": 0, "data": { "workspaces": [] } })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(json!({ "syncTitleToPlaud": true }).to_string())
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO plaud_connections (user_id, bearer_token, api_base, created_at, updated_at) VALUES ('u1', ?, ?, ?, ?)",
        )
        .bind(state.config.field_key.encrypt("tok"))
        .bind(format!("http://{addr}"))
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-m', 'u1', 'SN1', 'p0', 't', 25200000, 1000, 25201000, 10, 'abc', 'local', 'u1/p0.ogg', '1', 0, ?, ?, 'ai')",
        )
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        for (idx, fid) in [(0i64, "p0"), (1i64, "p1"), (2i64, "p2")] {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES ('u1', ?, 'rec-m', ?, 1000, 2000, 1000, 1000, '1', ?, ?)",
            )
            .bind(fid)
            .bind(idx)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        }

        push_title(&state, "u1", "rec-m", "Board Offsite").await;
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(
            recorded,
            vec![
                ("p0".into(), "Board Offsite (1/3)".into()),
                ("p1".into(), "Board Offsite (2/3)".into()),
                ("p2".into(), "Board Offsite (3/3)".into()),
            ]
        );
    }

    #[tokio::test]
    async fn late_append_concurrent_delete_records_part_tombstone_and_cleans_staged_audio() {
        use axum::routing::get;
        use axum::{Json, Router};

        // Generate a real 1-second Ogg/Opus fixture for both anchor and late part.
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();
        let anchor_path = cfg.storage_root.join("u1/f_p0.ogg");
        let part2_src = dir.path().join("part2.ogg");
        for out in [&anchor_path, &part2_src] {
            let mut cmd = tokio::process::Command::new(&cfg.ffmpeg);
            cmd.args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:a",
                "libopus",
                "-f",
                "ogg",
            ])
            .arg(out);
            assert!(crate::routes::recordings::media::run(&mut cmd).await);
        }
        let part2_bytes = tokio::fs::read(&part2_src).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        // Seed anchor recording already soft-deleted right before append commits.
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, deleted_at, created_at, updated_at, title_source) \
             VALUES ('rec-del', 'u1', 'SN1', 'f_p0', 't', 18000000, 1000, 18001000, 1000, 'abc', 'local', 'u1/f_p0.ogg', '1', 0, ?, ?, ?, 'original')",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let dl_url = format!("{base}/dl/p1");
        let app = Router::new()
            .route(
                "/file/temp-url/f_p1",
                get({
                    let dl_url = dl_url.clone();
                    move || async move { Json(json!({ "status": 0, "temp_url": dl_url })) }
                }),
            )
            .route(
                "/dl/p1",
                get({
                    let bytes = part2_bytes.clone();
                    move || async move { bytes }
                }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let open = split::DbAnchor {
            id: "rec-del".into(),
            device_sn: "SN1".into(),
            plaud_file_id: "f_p0".into(),
            duration: 18_000_000,
            filesize: 1000,
            storage_type: "local".into(),
            storage_path: "u1/f_p0.ogg".into(),
            auto_export_path: None,
            first_start_time: 1000,
            first_end_time: 18_001_000,
            first_plaud_duration_ms: 18_000_000,
            last_start_time: 1000,
            last_end_time: 18_001_000,
            last_plaud_duration_ms: 18_000_000,
        };
        let mut p1 = recording(Some("Part 2"), Some(18_002_000));
        p1.id = "f_p1".into();
        p1.duration = Some(7_200_000);
        p1.end_time = Some(25_202_000);
        p1.serial_number = Some("SN1".into());

        let client = Client::new(&base, "tok");
        let outcome = split::execute_consolidate(
            &state,
            "u1",
            &client,
            &[
                split::ChainSegment::Existing(open),
                split::ChainSegment::New(p1),
            ],
        )
        .await
        .unwrap();
        assert!(matches!(outcome, AppendOutcome::Tombstoned));

        // Part 1 is recorded under the deleted recording so subsequent syncs skip it.
        assert!(matches!(
            lookup_existing(&state, "u1", "f_p1").await.unwrap(),
            ExistingKind::MultiPartDeleted
        ));
        // No staged duplicate `.ogg` file was left behind in storage_root/u1.
        let mut entries = tokio::fs::read_dir(state.config.storage_root.join("u1"))
            .await
            .unwrap();
        let mut names = Vec::new();
        while let Some(e) = entries.next_entry().await.unwrap() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec!["f_p0.ogg"]);
    }

    #[tokio::test]
    async fn late_append_onto_multipart_anchor_reimports_stitched_plaud_transcript() {
        use axum::extract::Path;
        use axum::routing::get;
        use axum::{Json, Router};

        const FIVE_HOURS: i64 = 18_000_000;
        const TWO_HOURS: i64 = 7_200_000;
        const BASE: i64 = 1_768_000_000_000;

        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        let anchor_ogg = cfg.storage_root.join("u1/f_m0.ogg");
        let part2_ogg = dir.path().join("part2.ogg");
        for (out, freq) in [(&anchor_ogg, 440), (&part2_ogg, 660)] {
            let mut cmd = tokio::process::Command::new(&cfg.ffmpeg);
            cmd.args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={freq}:duration=1"),
                "-c:a",
                "libopus",
                "-f",
                "ogg",
            ])
            .arg(out);
            assert!(crate::routes::recordings::media::run(&mut cmd).await);
        }
        let part2_bytes = tokio::fs::read(&part2_ogg).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        // Existing 2-part anchor (5h + 5h) that already has a stale 2-part Plaud transcript.
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-mp', 'u1', 'SN1', 'f_m0', ?, ?, ?, ?, 1000, 'abc', 'local', 'u1/f_m0.ogg', '1', 0, ?, ?, 'original')",
        )
        .bind(state.config.field_key.encrypt("Long Day"))
        .bind(2 * FIVE_HOURS)
        .bind(BASE)
        .bind(BASE + 2 * FIVE_HOURS + 2_000)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        for (idx, fid, st, en) in [
            (0i64, "f_m0", BASE, BASE + FIVE_HOURS),
            (
                1i64,
                "f_m1",
                BASE + FIVE_HOURS + 2_000,
                BASE + 2 * FIVE_HOURS + 2_000,
            ),
        ] {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES ('u1', ?, 'rec-mp', ?, ?, ?, ?, 1000, '1', ?, ?)",
            )
            .bind(fid)
            .bind(idx)
            .bind(st)
            .bind(en)
            .bind(FIVE_HOURS)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at) \
             VALUES ('t-old', 'rec-mp', 'u1', ?, 'server', 'plaud', 'plaud-native', 'plaud', ?)",
        )
        .bind(state.config.field_key.encrypt("Old two-part text"))
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let base_for_routes = base.clone();
        let app = Router::new()
            .route(
                "/file/simple/web",
                get(|| async {
                    Json(json!({
                        "status": 0,
                        "data_file_list": [
                            {
                                "id": "f_m2",
                                "filename": "Long Day (3)",
                                "duration": TWO_HOURS,
                                "start_time": BASE + 2 * FIVE_HOURS + 5_000,
                                "end_time": BASE + 2 * FIVE_HOURS + 5_000 + TWO_HOURS,
                                "serial_number": "SN1",
                                "version_ms": 1
                            },
                            {
                                "id": "f_m1",
                                "filename": "Long Day (2)",
                                "duration": FIVE_HOURS,
                                "start_time": BASE + FIVE_HOURS + 2_000,
                                "end_time": BASE + 2 * FIVE_HOURS + 2_000,
                                "serial_number": "SN1",
                                "version_ms": 1
                            },
                            {
                                "id": "f_m0",
                                "filename": "Long Day",
                                "duration": FIVE_HOURS,
                                "start_time": BASE,
                                "end_time": BASE + FIVE_HOURS,
                                "serial_number": "SN1",
                                "version_ms": 1
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/file/temp-url/f_m2",
                get({
                    let base = base_for_routes.clone();
                    move || async move {
                        Json(json!({ "status": 0, "temp_url": format!("{base}/dl/m2") }))
                    }
                }),
            )
            .route(
                "/dl/m2",
                get({
                    let bytes = part2_bytes.clone();
                    move || async move { bytes }
                }),
            )
            .route(
                "/file/detail/{id}",
                get({
                    let base = base_for_routes.clone();
                    move |Path(id): Path<String>| async move {
                        Json(json!({
                            "status": 0,
                            "data": {
                                "content_list": [{
                                    "data_id": format!("source_transaction:{id}"),
                                    "data_type": "transaction",
                                    "task_status": 1,
                                    "data_link": format!("{base}/tr/{id}")
                                }],
                                "pre_download_content_list": []
                            }
                        }))
                    }
                }),
            )
            .route(
                "/tr/{id}",
                get(|Path(id): Path<String>| async move {
                    Json(json!([{ "start_time": 100, "end_time": 500, "speaker": 1, "content": format!("Text {id}") }]))
                }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut ctx = test_ctx(Client::new(&base, "tok"));
        ctx.import_content = true;
        let mut report = Report::default();
        let (mut new_ids, mut new_titles, mut late) = (Vec::new(), Vec::new(), Vec::new());
        sync_pages(
            &state,
            &ctx,
            &mut report,
            &mut new_ids,
            &mut new_titles,
            &mut late,
        )
        .await
        .map_err(|_| "sync failed")
        .unwrap();

        assert_eq!(report.updated, 1);
        assert_eq!(report.errors, Vec::<String>::new());
        let enc_text: String = sqlx::query_scalar(
            "SELECT text FROM transcriptions WHERE recording_id = 'rec-mp' AND source = 'plaud'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        let text = state.config.field_key.decrypt(&enc_text).unwrap();
        assert_eq!(
            text,
            "Speaker 1: Text f_m0\n\nSpeaker 1: Text f_m1\n\nSpeaker 1: Text f_m2"
        );
    }
}
