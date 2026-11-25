//! Automatic detection, settling, lossless concatenation, daily grouping, and bidirectional
//! consolidation for Plaud recordings (spec/plaud.md).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::api::{Client, Recording};
use super::import::{self, TempPath};
use super::raw_opus;
use super::sync::ItemError;
use super::v4::{self, AudioPreference};
use crate::db::now_ms;
use crate::routes::recordings::media;
use crate::routes::settings;
use crate::{AppState, config, ids};

/// Minimum duration (4h 55m) for a recording to qualify as a Plaud 5-hour split ceiling part.
pub const SPLIT_CEILING_MIN_MS: i64 = 17_700_000;
/// Maximum duration (5h 05m) for a recording to qualify as a Plaud 5-hour split ceiling part.
pub const SPLIT_CEILING_MAX_MS: i64 = 18_300_000;
/// Earliest allowed start offset of a successor relative to its predecessor's end (-15s).
pub const SPLIT_GAP_MIN_MS: i64 = -15_000;
/// Latest allowed start offset of a successor relative to its predecessor's end (+60s).
pub const SPLIT_GAP_MAX_MS: i64 = 60_000;
/// Maximum combined duration of a merged split chain (24h).
pub const MAX_CHAIN_DURATION_MS: i64 = 86_400_000;
/// Default quiet-sync settle window (4m 30s) so a 5-minute background tick flushes on the next pass.
pub const DEFAULT_SETTLE_MS: u64 = 270_000;
/// Age after which stale settle rows are opportunistically pruned (7 days).
pub const SETTLE_PRUNE_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Extra free-space headroom required on local storage before downloading or concatenating splits.
pub const DISK_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;

/// True when `duration_ms` falls within Plaud's 5-hour forced-split ceiling band.
pub(crate) fn is_split_ceiling_duration(duration_ms: i64) -> bool {
    (SPLIT_CEILING_MIN_MS..=SPLIT_CEILING_MAX_MS).contains(&duration_ms)
}

/// Configured quiet-sync settle window in milliseconds.
pub(crate) fn settle_window_ms() -> i64 {
    config::number("PLAUD_SPLIT_SETTLE_MS", DEFAULT_SETTLE_MS, 0, 3_600_000)
        .unwrap_or(DEFAULT_SETTLE_MS) as i64
}

/// Live Plaud recording in SQLite that can participate in bidirectional split consolidation
/// (receiving late appends at its tail, late prepends at its head, bridges, or pair healing).
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct DbAnchor {
    pub id: String,
    pub device_sn: String,
    pub plaud_file_id: String,
    pub duration: i64,
    pub filesize: i64,
    pub storage_type: String,
    pub storage_path: String,
    pub auto_export_path: Option<String>,
    pub auto_export_sha256: Option<String>,
    pub first_start_time: i64,
    pub first_end_time: i64,
    pub first_plaud_duration_ms: i64,
    pub last_start_time: i64,
    pub last_end_time: i64,
    pub last_plaud_duration_ms: i64,
}

/// One chronological element in a planned split consolidation chain.
#[derive(Debug, Clone)]
pub(crate) enum ChainSegment {
    Existing(DbAnchor),
    New(Recording),
}

impl ChainSegment {
    pub(crate) fn is_existing(&self) -> bool {
        matches!(self, Self::Existing(_))
    }

    pub(crate) fn lead_name(&self) -> String {
        match self {
            Self::Existing(a) => a.plaud_file_id.clone(),
            Self::New(r) => r
                .filename
                .clone()
                .filter(|f| !f.trim().is_empty())
                .unwrap_or_else(|| r.id.clone()),
        }
    }
}

/// Planned action after bidirectional cross-page grouping across live DB anchors and new items.
#[derive(Debug, Clone)]
pub(crate) enum ChainPlan {
    Single(Box<Recording>),
    NewMulti(Vec<Recording>),
    Consolidate(Vec<ChainSegment>),
}

/// Outcome of consolidating a chain that contains at least one existing DB recording.
pub(crate) enum AppendOutcome {
    Updated {
        recording_id: String,
        had_oah_work: bool,
    },
    Tombstoned,
}

/// Concatenated audio staged in a temporary `.partial` file with per-input audio durations.
pub(crate) struct ConcatOutput {
    pub temp: TempPath,
    pub ext: &'static str,
    pub byte_len: i64,
    pub file_md5: String,
    pub input_durations_ms: Vec<i64>,
}

const ANCHOR_SELECT_SQL: &str = "\
SELECT r.id, r.device_sn, r.plaud_file_id, r.duration, \
       r.filesize, r.storage_type, r.storage_path, \
       r.auto_export_path, r.auto_export_sha256, \
       COALESCE(fp.start_time, r.start_time) AS first_start_time, \
       COALESCE(fp.end_time, r.end_time) AS first_end_time, \
       COALESCE(fp.plaud_duration_ms, r.duration) AS first_plaud_duration_ms, \
       COALESCE(lp.start_time, r.start_time) AS last_start_time, \
       COALESCE(lp.end_time, r.end_time) AS last_end_time, \
       COALESCE(lp.plaud_duration_ms, r.duration) AS last_plaud_duration_ms \
FROM recordings r \
LEFT JOIN plaud_recording_parts fp \
  ON fp.recording_id = r.id \
 AND fp.part_index = (SELECT MIN(p1.part_index) FROM plaud_recording_parts p1 WHERE p1.recording_id = r.id) \
LEFT JOIN plaud_recording_parts lp \
  ON lp.recording_id = r.id \
 AND lp.part_index = (SELECT MAX(p2.part_index) FROM plaud_recording_parts p2 WHERE p2.recording_id = r.id) \
WHERE r.user_id = ? \
  AND r.deleted_at IS NULL \
  AND r.device_sn <> 'local' \
  AND r.plaud_file_id NOT LIKE 'merged-%' \
  AND r.plaud_file_id NOT LIKE 'upload-%' \
  AND r.plaud_file_id NOT LIKE 'zip-%' \
  AND r.plaud_file_id NOT LIKE 'folder-%'";

/// Loads live Plaud DB anchors whose final part ended at the 5-hour ceiling and can link forward.
pub(crate) async fn load_open_tail_anchors(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<DbAnchor>, sqlx::Error> {
    let sql = format!(
        "{ANCHOR_SELECT_SQL} \
           AND r.duration < ? \
           AND COALESCE(lp.plaud_duration_ms, r.duration) BETWEEN ? AND ?"
    );
    sqlx::query_as(&sql)
        .bind(user_id)
        .bind(MAX_CHAIN_DURATION_MS)
        .bind(SPLIT_CEILING_MIN_MS)
        .bind(SPLIT_CEILING_MAX_MS)
        .fetch_all(&state.db)
        .await
}

/// Expands `open_tail_anchors` with any live Plaud DB recordings whose start time falls inside
/// the successor gap window of a ~5h ceiling end (from `open_tail_anchors` or `ready_new`).
/// Performs zero extra SQL queries when no ~5h ceiling candidate exists.
pub(crate) async fn load_candidate_anchors(
    state: &AppState,
    user_id: &str,
    mut anchors: Vec<DbAnchor>,
    ready_new: &[Recording],
) -> Result<Vec<DbAnchor>, sqlx::Error> {
    let mut ceiling_ends: Vec<i64> = Vec::new();
    for a in &anchors {
        let end = effective_end(a.last_start_time, a.last_end_time, a.last_plaud_duration_ms);
        if end > 0 && is_split_ceiling_duration(a.last_plaud_duration_ms) {
            ceiling_ends.push(end);
        }
    }
    for r in ready_new {
        let dur = r.duration.unwrap_or(0);
        if is_split_ceiling_duration(dur) {
            let start = r.start_time.unwrap_or(0);
            let end = effective_end(start, r.end_time.unwrap_or(0), dur);
            if end > 0 {
                ceiling_ends.push(end);
            }
        }
    }
    if ceiling_ends.is_empty() {
        return Ok(anchors);
    }

    let mut seen: HashSet<String> = anchors.iter().map(|a| a.id.clone()).collect();
    let sql = format!(
        "{ANCHOR_SELECT_SQL} \
           AND r.duration < ? \
           AND r.start_time BETWEEN ? AND ?"
    );
    for end_ms in ceiling_ends {
        let lo = end_ms.saturating_add(SPLIT_GAP_MIN_MS);
        let hi = end_ms.saturating_add(SPLIT_GAP_MAX_MS);
        let rows: Vec<DbAnchor> = sqlx::query_as(&sql)
            .bind(user_id)
            .bind(MAX_CHAIN_DURATION_MS)
            .bind(lo)
            .bind(hi)
            .fetch_all(&state.db)
            .await?;
        for row in rows {
            if seen.insert(row.id.clone()) {
                anchors.push(row);
            }
        }
    }
    Ok(anchors)
}

/// Returns the server's local calendar date (`YYYY-MM-DD`) for `start_ms` in pure in-memory Rust
/// using the system timezone (zero subprocesses, DST-accurate at `start_ms`).
pub(crate) fn local_day_key(start_ms: i64) -> Option<String> {
    if start_ms <= 0 {
        return None;
    }
    let ts = jiff::Timestamp::from_millisecond(start_ms).ok()?;
    let date = ts.to_zoned(jiff::tz::TimeZone::system()).date();
    Some(format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month(),
        date.day()
    ))
}

/// Loads all live non-local Plaud DB recordings with a positive start time and duration under 24h
/// so `mergePlaudByDay` can group same-day recordings chronologically.
pub(crate) async fn load_daily_anchors(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<DbAnchor>, sqlx::Error> {
    let sql = format!(
        "{ANCHOR_SELECT_SQL} \
           AND r.start_time > 0 \
           AND r.duration < ?"
    );
    sqlx::query_as(&sql)
        .bind(user_id)
        .bind(MAX_CHAIN_DURATION_MS)
        .fetch_all(&state.db)
        .await
}

/// True when the user currently has deferred split tips waiting in `plaud_split_settle`.
pub(crate) async fn has_unsettled_rows(state: &AppState, user_id: &str) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM plaud_split_settle WHERE user_id = ?)",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false)
}

/// Returns which new recordings should be hydrated via cached 4.0 detail before chain grouping.
/// Normal accounts without any ~5h item, unknown-duration item, or live open DB anchor return all `false`.
pub(crate) fn needs_hydration_for_split(
    new_items: &[Recording],
    anchors: &[DbAnchor],
) -> Vec<bool> {
    let has_split_candidate = !anchors.is_empty()
        || new_items
            .iter()
            .any(|r| r.duration.is_none() || is_split_ceiling_duration(r.duration.unwrap_or(0)));
    if !has_split_candidate {
        return vec![false; new_items.len()];
    }
    new_items.iter().map(|r| r.is_v4).collect()
}

fn effective_end(start_time: i64, end_time: i64, duration_ms: i64) -> i64 {
    if end_time > start_time {
        end_time
    } else if start_time > 0 && duration_ms > 0 {
        start_time.saturating_add(duration_ms)
    } else {
        start_time
    }
}

#[derive(Clone, Copy)]
struct LinkMeta<'a> {
    device_sn: &'a str,
    start_time: i64,
    end_time: i64,
    duration_ms: i64,
}

fn can_link(a: LinkMeta<'_>, b: LinkMeta<'_>) -> bool {
    if !is_split_ceiling_duration(a.duration_ms) || b.duration_ms <= 0 {
        return false;
    }
    if a.start_time <= 0 || b.start_time <= a.start_time {
        return false;
    }
    let gap_ms = b.start_time.saturating_sub(a.end_time);
    if !(SPLIT_GAP_MIN_MS..=SPLIT_GAP_MAX_MS).contains(&gap_ms) {
        return false;
    }
    let sn_a = a.device_sn.trim();
    let sn_b = b.device_sn.trim();
    if sn_a == "local" || sn_b == "local" {
        return false;
    }
    match (sn_a.is_empty(), sn_b.is_empty()) {
        (false, false) => sn_a == sn_b,
        (true, true) => true,
        _ => false,
    }
}

/// Groups live DB anchors and new recordings chronologically into maximal <=24h split chains.
/// Handles all arrival orders: complete chains, late appends, late prepends, late bridges,
/// and consolidation of already-imported adjacent split recordings.
/// Enforces strict 1-to-1 predecessor/successor uniqueness across all nodes.
pub(crate) fn plan_chains(anchors: &[DbAnchor], mut new_items: Vec<Recording>) -> Vec<ChainPlan> {
    if anchors.is_empty() && new_items.is_empty() {
        return Vec::new();
    }
    let mut sorted_anchors = anchors.to_vec();
    sorted_anchors.sort_by(|a, b| {
        a.first_start_time
            .cmp(&b.first_start_time)
            .then_with(|| a.id.cmp(&b.id))
    });
    new_items.sort_by(|a, b| {
        a.start_time
            .unwrap_or(0)
            .cmp(&b.start_time.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });

    let anchor_count = sorted_anchors.len();
    let new_count = new_items.len();
    let total_nodes = anchor_count + new_count;

    let mut head_metas = Vec::with_capacity(total_nodes);
    let mut tail_metas = Vec::with_capacity(total_nodes);
    let mut node_durations = Vec::with_capacity(total_nodes);

    for a in &sorted_anchors {
        head_metas.push(LinkMeta {
            device_sn: a.device_sn.as_str(),
            start_time: a.first_start_time,
            end_time: effective_end(
                a.first_start_time,
                a.first_end_time,
                a.first_plaud_duration_ms,
            ),
            duration_ms: a.first_plaud_duration_ms,
        });
        tail_metas.push(LinkMeta {
            device_sn: a.device_sn.as_str(),
            start_time: a.last_start_time,
            end_time: effective_end(a.last_start_time, a.last_end_time, a.last_plaud_duration_ms),
            duration_ms: a.last_plaud_duration_ms,
        });
        node_durations.push(a.duration.max(0));
    }
    for r in &new_items {
        let start = r.start_time.unwrap_or(0);
        let dur = r.duration.unwrap_or(0);
        let end = effective_end(start, r.end_time.unwrap_or(0), dur);
        let meta = LinkMeta {
            device_sn: r.serial_number.as_deref().unwrap_or(""),
            start_time: start,
            end_time: end,
            duration_ms: dur,
        };
        head_metas.push(meta);
        tail_metas.push(meta);
        node_durations.push(dur.max(0));
    }

    let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); total_nodes];
    let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); total_nodes];

    for a in 0..total_nodes {
        for b in 0..total_nodes {
            if a == b {
                continue;
            }
            if can_link(tail_metas[a], head_metas[b]) {
                outgoing[a].push(b);
                incoming[b].push(a);
            }
        }
    }

    // Keep only 1-to-1 unique links so ambiguous forks or colliding empty-serial items never merge.
    let mut next_node: Vec<Option<usize>> = vec![None; total_nodes];
    let mut has_prev: Vec<bool> = vec![false; total_nodes];
    for a in 0..total_nodes {
        if outgoing[a].len() == 1 {
            let b = outgoing[a][0];
            if incoming[b].len() == 1 {
                next_node[a] = Some(b);
                has_prev[b] = true;
            }
        }
    }

    // Order chain-start inspection chronologically across both existing anchors and new items.
    let mut start_order: Vec<usize> = (0..total_nodes).collect();
    start_order.sort_by(|&a, &b| {
        head_metas[a]
            .start_time
            .cmp(&head_metas[b].start_time)
            .then_with(|| a.cmp(&b))
    });
    drop(head_metas);
    drop(tail_metas);

    let mut nodes: Vec<Option<ChainSegment>> = Vec::with_capacity(total_nodes);
    for a in sorted_anchors {
        nodes.push(Some(ChainSegment::Existing(a)));
    }
    for r in new_items {
        nodes.push(Some(ChainSegment::New(r)));
    }

    let mut visited = vec![false; total_nodes];
    let mut plans = Vec::new();

    for start_idx in start_order {
        if visited[start_idx] || has_prev[start_idx] {
            continue;
        }
        let mut total_ms = 0i64;
        let mut chain_indices = Vec::new();
        let mut cur = Some(start_idx);
        while let Some(idx) = cur {
            if visited[idx] {
                break;
            }
            let part_dur = node_durations[idx];
            if !chain_indices.is_empty()
                && total_ms.saturating_add(part_dur) > MAX_CHAIN_DURATION_MS
            {
                // Exceeding 24h closes the current chain and lets `idx` start a fresh chain.
                has_prev[idx] = false;
                break;
            }
            visited[idx] = true;
            total_ms = total_ms.saturating_add(part_dur);
            chain_indices.push(idx);
            cur = next_node[idx];
        }
        let mut segs: Vec<ChainSegment> = chain_indices
            .into_iter()
            .filter_map(|i| nodes[i].take())
            .collect();
        if segs.is_empty() {
            continue;
        }
        if segs.len() == 1 {
            if let ChainSegment::New(r) = segs.remove(0) {
                plans.push(ChainPlan::Single(Box::new(r)));
            }
        } else if segs.iter().any(ChainSegment::is_existing) {
            plans.push(ChainPlan::Consolidate(segs));
        } else {
            let parts = segs
                .into_iter()
                .filter_map(|s| match s {
                    ChainSegment::New(r) => Some(r),
                    ChainSegment::Existing(_) => None,
                })
                .collect();
            plans.push(ChainPlan::NewMulti(parts));
        }
    }

    // Defensively emit any unvisited new item as standalone.
    for (idx, seg) in nodes.into_iter().enumerate() {
        if !visited[idx]
            && let Some(ChainSegment::New(r)) = seg
        {
            plans.push(ChainPlan::Single(Box::new(r)));
        }
    }

    plans
}

fn emit_daily_chunk(
    plans: &mut Vec<ChainPlan>,
    nodes: &mut [Option<ChainSegment>],
    chunk_indices: &[usize],
) {
    let mut segs: Vec<ChainSegment> = chunk_indices
        .iter()
        .filter_map(|&i| nodes[i].take())
        .collect();
    if segs.is_empty() {
        return;
    }
    if segs.len() == 1 {
        if let ChainSegment::New(r) = segs.remove(0) {
            plans.push(ChainPlan::Single(Box::new(r)));
        }
    } else if segs.iter().any(ChainSegment::is_existing) {
        plans.push(ChainPlan::Consolidate(segs));
    } else {
        let parts = segs
            .into_iter()
            .filter_map(|s| match s {
                ChainSegment::New(r) => Some(r),
                ChainSegment::Existing(_) => None,
            })
            .collect();
        plans.push(ChainPlan::NewMulti(parts));
    }
}

/// Groups live Plaud DB anchors and new recordings by local calendar date in chronological
/// recording order (`start_time ASC`), capping each merged recording at 24 hours.
/// When `merge_splits` is also true, unique 1-to-1 5-hour forced splits crossing midnight join
/// the predecessor's local day without pulling unrelated recordings from the following day.
/// Days that already contain a single live recording emit no plan (zero I/O on idle syncs).
pub(crate) fn plan_daily_chains<F>(
    anchors: &[DbAnchor],
    new_items: Vec<Recording>,
    merge_splits: bool,
    day_of: F,
) -> Vec<ChainPlan>
where
    F: Fn(i64) -> Option<String>,
{
    if anchors.is_empty() && new_items.is_empty() {
        return Vec::new();
    }

    let mut dated_anchors: Vec<(DbAnchor, String)> = Vec::new();
    for a in anchors {
        if a.first_start_time > 0
            && let Some(day) = day_of(a.first_start_time)
        {
            dated_anchors.push((a.clone(), day));
        }
    }
    dated_anchors.sort_by(|(a, _), (b, _)| {
        a.first_start_time
            .cmp(&b.first_start_time)
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut dated_new: Vec<(Recording, String)> = Vec::new();
    let mut undated_new: Vec<Recording> = Vec::new();
    for r in new_items {
        if let Some(st) = r.start_time.filter(|&t| t > 0)
            && let Some(day) = day_of(st)
        {
            dated_new.push((r, day));
        } else {
            undated_new.push(r);
        }
    }
    dated_new.sort_by(|(a, _), (b, _)| {
        a.start_time
            .unwrap_or(0)
            .cmp(&b.start_time.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });

    let anchor_count = dated_anchors.len();
    let total_nodes = anchor_count + dated_new.len();

    let mut head_metas = Vec::with_capacity(total_nodes);
    let mut tail_metas = Vec::with_capacity(total_nodes);
    let mut node_durations = Vec::with_capacity(total_nodes);
    let mut is_multipart = Vec::with_capacity(total_nodes);
    let mut bucket_days: Vec<String> = Vec::with_capacity(total_nodes);
    let mut sort_keys: Vec<(i64, bool, String)> = Vec::with_capacity(total_nodes);

    for (a, day) in &dated_anchors {
        head_metas.push(LinkMeta {
            device_sn: a.device_sn.as_str(),
            start_time: a.first_start_time,
            end_time: effective_end(
                a.first_start_time,
                a.first_end_time,
                a.first_plaud_duration_ms,
            ),
            duration_ms: a.first_plaud_duration_ms,
        });
        tail_metas.push(LinkMeta {
            device_sn: a.device_sn.as_str(),
            start_time: a.last_start_time,
            end_time: effective_end(a.last_start_time, a.last_end_time, a.last_plaud_duration_ms),
            duration_ms: a.last_plaud_duration_ms,
        });
        node_durations.push(a.duration.max(0));
        is_multipart.push(a.last_start_time > a.first_start_time);
        bucket_days.push(day.clone());
        sort_keys.push((a.first_start_time, false, a.id.clone()));
    }
    for (r, day) in &dated_new {
        let start = r.start_time.unwrap_or(0);
        let dur = r.duration.unwrap_or(0);
        let end = effective_end(start, r.end_time.unwrap_or(0), dur);
        let meta = LinkMeta {
            device_sn: r.serial_number.as_deref().unwrap_or(""),
            start_time: start,
            end_time: end,
            duration_ms: dur,
        };
        head_metas.push(meta);
        tail_metas.push(meta);
        node_durations.push(dur.max(0));
        is_multipart.push(false);
        bucket_days.push(day.clone());
        sort_keys.push((start, true, r.id.clone()));
    }

    // Preserve midnight-crossing 5-hour forced splits in the predecessor's local day bucket.
    // Never pull an already-merged multi-part recording from another day into the previous day,
    // because it may contain unrelated later clips from that next day.
    if merge_splits && total_nodes >= 2 {
        let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); total_nodes];
        let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); total_nodes];
        for a in 0..total_nodes {
            for b in 0..total_nodes {
                if a != b && can_link(tail_metas[a], head_metas[b]) {
                    outgoing[a].push(b);
                    incoming[b].push(a);
                }
            }
        }
        let mut next_node: Vec<Option<usize>> = vec![None; total_nodes];
        let mut has_prev: Vec<bool> = vec![false; total_nodes];
        for a in 0..total_nodes {
            if outgoing[a].len() == 1 {
                let b = outgoing[a][0];
                if incoming[b].len() == 1 {
                    next_node[a] = Some(b);
                    has_prev[b] = true;
                }
            }
        }
        let mut visited = vec![false; total_nodes];
        for start in 0..total_nodes {
            if visited[start] || has_prev[start] {
                continue;
            }
            let lead_day = bucket_days[start].clone();
            let mut chain_ms = node_durations[start];
            visited[start] = true;
            let mut cur = next_node[start];
            while let Some(idx) = cur {
                if visited[idx] {
                    break;
                }
                if bucket_days[idx] != lead_day && is_multipart[idx] {
                    break;
                }
                let next_ms = chain_ms.saturating_add(node_durations[idx]);
                if next_ms > MAX_CHAIN_DURATION_MS {
                    break;
                }
                visited[idx] = true;
                bucket_days[idx] = lead_day.clone();
                chain_ms = next_ms;
                cur = next_node[idx];
            }
        }
    }

    drop(head_metas);
    drop(tail_metas);

    let mut nodes: Vec<Option<ChainSegment>> = Vec::with_capacity(total_nodes);
    for (a, _) in dated_anchors {
        nodes.push(Some(ChainSegment::Existing(a)));
    }
    for (r, _) in dated_new {
        nodes.push(Some(ChainSegment::New(r)));
    }

    let mut by_day: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (idx, day) in bucket_days.into_iter().enumerate() {
        by_day.entry(day).or_default().push(idx);
    }

    let mut plans = Vec::new();
    for (_, mut indices) in by_day {
        indices.sort_by(|&a, &b| sort_keys[a].cmp(&sort_keys[b]));
        let mut chunk_indices = Vec::new();
        let mut chunk_ms = 0i64;
        for idx in indices {
            let dur = node_durations[idx];
            if !chunk_indices.is_empty() && chunk_ms.saturating_add(dur) > MAX_CHAIN_DURATION_MS {
                emit_daily_chunk(&mut plans, &mut nodes, &chunk_indices);
                chunk_indices.clear();
                chunk_ms = 0;
            }
            chunk_indices.push(idx);
            chunk_ms = chunk_ms.saturating_add(dur);
        }
        if !chunk_indices.is_empty() {
            emit_daily_chunk(&mut plans, &mut nodes, &chunk_indices);
        }
    }

    for r in undated_new {
        plans.push(ChainPlan::Single(Box::new(r)));
    }

    plans
}

/// Returns the settle-tip `plaud_file_id` when a chain ends on a *new* ~5h ceiling part under 24h.
/// Chains ending on an existing DB recording or a `<4h55m` tail consolidate/merge immediately.
pub(crate) fn settle_tip_id(plan: &ChainPlan) -> Option<&str> {
    match plan {
        ChainPlan::Single(r) => {
            let dur = r.duration.unwrap_or(0);
            if is_split_ceiling_duration(dur) && dur < MAX_CHAIN_DURATION_MS {
                Some(r.id.as_str())
            } else {
                None
            }
        }
        ChainPlan::NewMulti(parts) => {
            let last = parts.last()?;
            let total: i64 = parts
                .iter()
                .map(|p| p.duration.unwrap_or(0).max(0))
                .fold(0i64, i64::saturating_add);
            if is_split_ceiling_duration(last.duration.unwrap_or(0))
                && total < MAX_CHAIN_DURATION_MS
            {
                Some(last.id.as_str())
            } else {
                None
            }
        }
        ChainPlan::Consolidate(segs) => {
            // Only defer if the final chronological segment is a brand-new ~5h ceiling part.
            // If the final segment is already in DB (e.g. Late Prepend or existing pair healing),
            // consolidate immediately without waiting.
            let ChainSegment::New(last) = segs.last()? else {
                return None;
            };
            let total: i64 = segs
                .iter()
                .map(|s| match s {
                    ChainSegment::Existing(a) => a.duration.max(0),
                    ChainSegment::New(r) => r.duration.unwrap_or(0).max(0),
                })
                .fold(0i64, i64::saturating_add);
            if is_split_ceiling_duration(last.duration.unwrap_or(0))
                && total < MAX_CHAIN_DURATION_MS
            {
                Some(last.id.as_str())
            } else {
                None
            }
        }
    }
}

/// Records or reads `first_seen_at` for a fresh ~5h tip and returns whether it should be deferred.
/// Opportunistically prunes settle rows older than 7 days only when touching the table.
pub(crate) async fn should_defer_tip(
    state: &AppState,
    user_id: &str,
    tip_file_id: &str,
    now: i64,
    settle_ms: i64,
) -> Result<bool, sqlx::Error> {
    if settle_ms <= 0 {
        return Ok(false);
    }
    let mut tx = crate::db::begin_write(&state.db).await?;
    sqlx::query("DELETE FROM plaud_split_settle WHERE first_seen_at < ?")
        .bind(now.saturating_sub(SETTLE_PRUNE_AGE_MS))
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO plaud_split_settle (user_id, plaud_file_id, first_seen_at) VALUES (?, ?, ?)",
    )
    .bind(user_id)
    .bind(tip_file_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let first_seen: i64 = sqlx::query_scalar(
        "SELECT first_seen_at FROM plaud_split_settle WHERE user_id = ? AND plaud_file_id = ?",
    )
    .bind(user_id)
    .bind(tip_file_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(now.saturating_sub(first_seen) < settle_ms)
}

async fn clear_settle_ids_in<'e, E>(
    exec: &mut E,
    user_id: &str,
    file_ids: &[&str],
    now: i64,
) -> Result<(), sqlx::Error>
where
    for<'c> &'c mut E: sqlx::Executor<'c, Database = sqlx::Sqlite>,
{
    if file_ids.is_empty() {
        return Ok(());
    }
    sqlx::query("DELETE FROM plaud_split_settle WHERE first_seen_at < ?")
        .bind(now.saturating_sub(SETTLE_PRUNE_AGE_MS))
        .execute(&mut *exec)
        .await?;
    for file_id in file_ids {
        sqlx::query("DELETE FROM plaud_split_settle WHERE user_id = ? AND plaud_file_id = ?")
            .bind(user_id)
            .bind(file_id)
            .execute(&mut *exec)
            .await?;
    }
    Ok(())
}

/// Clears a single recording's settle entry after it is imported. Only writes when the recording
/// is a ~5h ceiling candidate so idle/normal syncs perform zero writes to `plaud_split_settle`.
pub(crate) async fn clear_settle_for_single(state: &AppState, user_id: &str, r: &Recording) {
    if !is_split_ceiling_duration(r.duration.unwrap_or(0)) {
        return;
    }
    if let Ok(mut tx) = crate::db::begin_write(&state.db).await {
        let ids = [r.id.as_str()];
        if clear_settle_ids_in(&mut *tx, user_id, &ids, now_ms())
            .await
            .is_ok()
        {
            let _ = tx.commit().await;
        }
    }
}

/// Checks available local disk space before downloading or concatenating a split chain.
pub(crate) fn ensure_disk_space(
    state: &AppState,
    existing_bytes: u64,
    working_bytes: u64,
) -> Result<(), ItemError> {
    let Some(free) = state.storage.disk_free_bytes() else {
        return Ok(());
    };
    let required = existing_bytes
        .saturating_add(working_bytes)
        .saturating_mul(2)
        .saturating_add(DISK_HEADROOM_BYTES);
    if free < required {
        return Err(ItemError::Failed(
            "not enough free disk space to merge split recording".into(),
        ));
    }
    Ok(())
}

fn estimate_download_bytes(parts: &[Recording]) -> u64 {
    parts
        .iter()
        .map(|p| {
            p.filesize
                .filter(|&n| n > 0)
                .map(|n| n as u64)
                .unwrap_or_else(|| {
                    let secs = (p.duration.unwrap_or(0).max(0) as u64) / 1000;
                    secs.saturating_mul(8_000)
                })
        })
        .fold(0u64, u64::saturating_add)
}

fn detail_has_opus_raw_audio(detail: &v4::V4FileDetail) -> bool {
    detail.objects.iter().any(|obj| {
        obj.object_type
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case("AUDIO"))
            && (v4::has_non_empty(&obj.content_url) || v4::has_non_empty(&obj.content_id))
            && matches!(obj.task_status, Some(1) | None)
            && obj
                .mime_type
                .as_deref()
                .is_some_and(|m| m.to_ascii_lowercase().contains("opus"))
    })
}

/// Picks a single consistent Plaud 4.0 audio object preference across all parts of a chain.
/// Prefers raw `AUDIO` across the whole chain if any part lacks ready `AUDIO_TRANSCODED`, if all
/// parts provide `audio/opus` raw audio, or when appending onto an existing `.ogg`/`.opus` anchor.
pub(crate) async fn choose_audio_preference(
    client: &Client,
    parts: &[Recording],
    anchor_is_ogg_or_opus: bool,
) -> Result<AudioPreference, ItemError> {
    let ids: Vec<&str> = parts.iter().map(|p| p.id.as_str()).collect();
    let any_v4 = parts.iter().any(|p| p.is_v4);
    choose_audio_preference_for_ids(client, &ids, any_v4, anchor_is_ogg_or_opus).await
}

async fn choose_audio_preference_for_ids(
    client: &Client,
    file_ids: &[&str],
    any_v4: bool,
    anchor_is_ogg_or_opus: bool,
) -> Result<AudioPreference, ItemError> {
    if (!client.is_v4_mode() && !any_v4) || file_ids.is_empty() {
        return Ok(AudioPreference::Default);
    }
    let mut details = Vec::with_capacity(file_ids.len());
    for &file_id in file_ids {
        if let Some(detail) = client.peek_v4_detail(file_id).await? {
            details.push(detail);
        }
    }
    if details.is_empty() {
        return Ok(AudioPreference::Default);
    }
    if anchor_is_ogg_or_opus && details.iter().all(v4::has_ready_raw_audio) {
        return Ok(AudioPreference::PreferRawAudio);
    }
    let all_have_transcoded = details.iter().all(v4::has_ready_transcoded_audio);
    if !all_have_transcoded {
        return Ok(AudioPreference::PreferRawAudio);
    }
    if details.iter().all(detail_has_opus_raw_audio) {
        return Ok(AudioPreference::PreferRawAudio);
    }
    Ok(AudioPreference::Default)
}

fn stream_copy_target(codec: &str) -> Option<(&'static str, &'static str)> {
    match codec {
        "opus" | "vorbis" => Some(("ogg", "ogg")),
        "mp3" => Some(("mp3", "mp3")),
        "aac" => Some(("m4a", "mp4")),
        "flac" => Some(("flac", "flac")),
        "pcm_s16le" | "pcm_s24le" | "pcm_f32le" => Some(("wav", "wav")),
        _ => None,
    }
}

/// Concatenates audio inputs using the 3-tier lossless pipeline:
/// 1. Pure-Rust `raw_opus::wrap_many_if_raw_opus` when all inputs are compatible raw Opus streams.
/// 2. `ffmpeg -f concat -safe 0 -vn -c copy` when all normalized inputs share `(codec, format)`.
/// 3. Fallback `ffmpeg -filter_complex concat -c:a libopus -b:a 64k -f ogg` on codec mismatch.
pub(crate) async fn concat_audio_files(
    state: &AppState,
    user_id: &str,
    inputs: &[PathBuf],
    allow_raw_opus_tier1: bool,
) -> Result<ConcatOutput, ItemError> {
    if inputs.len() < 2 {
        return Err(ItemError::Failed(
            "at least two audio inputs are required for split concatenation".into(),
        ));
    }
    let dir = state.config.storage_root.join(user_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ItemError::Failed("could not create the storage folder".into()))?;

    // Tier 1: pure-Rust streaming single-BOS Ogg/Opus mux directly from raw Opus parts.
    if allow_raw_opus_tier1 {
        let dst =
            TempPath::new(dir.join(format!(".plaud-merge-{}.ogg.partial", ids::token_hex(8))));
        match raw_opus::wrap_many_if_raw_opus(&state.config.ffprobe, inputs, dst.path()).await {
            Ok(Some(muxed)) => {
                return Ok(ConcatOutput {
                    temp: dst,
                    ext: "ogg",
                    byte_len: muxed.byte_len,
                    file_md5: muxed.file_md5,
                    input_durations_ms: muxed.part_durations_ms,
                });
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "multi-part raw Opus mux failed, falling back to ffmpeg");
            }
        }
    }

    // Wrap any individual headerless raw Opus part before probing/ffmpeg (mixed chains or late append).
    let mut normalized_paths = Vec::with_capacity(inputs.len());
    let mut scratch_temps: Vec<TempPath> = Vec::new();
    for src in inputs {
        let head = import::read_head(src).await?;
        if !raw_opus::is_known_container(&head) {
            let wrapped =
                TempPath::new(dir.join(format!(".plaud-wrap-{}.ogg.partial", ids::token_hex(8))));
            match raw_opus::wrap_if_raw_opus(&state.config.ffprobe, src, wrapped.path()).await {
                Ok(Some(_)) => {
                    normalized_paths.push(wrapped.path().to_path_buf());
                    scratch_temps.push(wrapped);
                    continue;
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(error = %e, "wrapping raw Opus split part before concat failed");
                }
            }
        }
        normalized_paths.push(src.clone());
    }

    let mut probes = Vec::with_capacity(normalized_paths.len());
    for path in &normalized_paths {
        let probe = media::probe(&state.config.ffprobe, path)
            .await
            .ok_or_else(|| {
                ItemError::Failed("split recording part has no readable audio".into())
            })?;
        probes.push(probe);
    }
    let input_durations_ms: Vec<i64> = probes.iter().map(|p| p.duration_ms).collect();

    // Tier 2: lossless stream copy when all inputs share the same codec and format.
    let all_same = probes
        .iter()
        .all(|p| p.codec == probes[0].codec && p.format == probes[0].format);
    if all_same && let Some((ext, muxer)) = stream_copy_target(&probes[0].codec) {
        let list_temp =
            TempPath::new(dir.join(format!(".plaud-concat-{}.list", ids::token_hex(8))));
        let mut list_text = String::new();
        for p in &normalized_paths {
            let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            list_text.push_str(&format!(
                "file '{}'\n",
                abs.display().to_string().replace('\'', r"'\''")
            ));
        }
        tokio::fs::write(list_temp.path(), list_text)
            .await
            .map_err(|_| ItemError::Failed("could not write concat input list".into()))?;

        let dst =
            TempPath::new(dir.join(format!(".plaud-merge-{}.{ext}.partial", ids::token_hex(8))));
        let mut cmd = Command::new(&state.config.ffmpeg);
        cmd.args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(list_temp.path())
            .args(["-vn", "-c", "copy"]);
        if muxer == "mp4" {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.args(["-f", muxer]).arg(dst.path());

        if media::run(&mut cmd).await
            && media::probe(&state.config.ffprobe, dst.path())
                .await
                .is_some()
        {
            let byte_len = tokio::fs::metadata(dst.path())
                .await
                .map_err(|_| ItemError::Failed("could not inspect merged audio".into()))?
                .len() as i64;
            let file_md5 = media::file_md5(dst.path())
                .await
                .map_err(|_| ItemError::Failed("could not hash merged audio".into()))?;
            drop(list_temp);
            drop(scratch_temps);
            return Ok(ConcatOutput {
                temp: dst,
                ext,
                byte_len,
                file_md5,
                input_durations_ms,
            });
        }
    }

    // Tier 3: re-encode to Ogg/Opus on genuine codec, sample rate, or channel mismatch.
    let dst = TempPath::new(dir.join(format!(".plaud-merge-{}.ogg.partial", ids::token_hex(8))));
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-v", "error", "-y"]);
    let mut filter = String::new();
    for (i, path) in normalized_paths.iter().enumerate() {
        cmd.arg("-i").arg(path);
        filter.push_str(&format!("[{i}:a:0]"));
    }
    filter.push_str(&format!("concat=n={}:v=0:a=1[out]", normalized_paths.len()));
    cmd.args([
        "-filter_complex",
        filter.as_str(),
        "-map",
        "[out]",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-f",
        "ogg",
    ])
    .arg(dst.path());

    if !media::run(&mut cmd).await
        || media::probe(&state.config.ffprobe, dst.path())
            .await
            .is_none()
    {
        return Err(ItemError::Failed(
            "could not concatenate split recording audio".into(),
        ));
    }

    let byte_len = tokio::fs::metadata(dst.path())
        .await
        .map_err(|_| ItemError::Failed("could not inspect merged audio".into()))?
        .len() as i64;
    let file_md5 = media::file_md5(dst.path())
        .await
        .map_err(|_| ItemError::Failed("could not hash merged audio".into()))?;
    drop(scratch_temps);
    Ok(ConcatOutput {
        temp: dst,
        ext: "ogg",
        byte_len,
        file_md5,
        input_durations_ms,
    })
}

fn version_text(r: &Recording) -> String {
    r.version_ms.unwrap_or(0).to_string()
}

fn part_effective_plaud_ms(r: &Recording, audio_ms: i64) -> i64 {
    r.duration.filter(|&d| d > 0).unwrap_or(audio_ms)
}

/// Downloads, concatenates, stages, and inserts a new multi-part split recording atomically.
pub(crate) async fn execute_new_multi(
    state: &AppState,
    user_id: &str,
    client: &Client,
    title_mode: &str,
    parts: &[Recording],
) -> Result<(String, String), ItemError> {
    if parts.len() < 2 {
        return Err(ItemError::Failed(
            "multi-part split merge requires at least two parts".into(),
        ));
    }
    ensure_disk_space(state, 0, estimate_download_bytes(parts))?;
    let pref = choose_audio_preference(client, parts, false).await?;

    let mut downloaded = Vec::with_capacity(parts.len());
    let mut downloaded_bytes = 0u64;
    for part in parts {
        let dl = import::download_to_temp(state, user_id, client, &part.id, pref).await?;
        downloaded_bytes = downloaded_bytes.saturating_add(dl.byte_len.max(0) as u64);
        downloaded.push(dl);
    }
    ensure_disk_space(state, 0, downloaded_bytes)?;

    let src_paths: Vec<PathBuf> = downloaded
        .iter()
        .map(|d| d.temp.path().to_path_buf())
        .collect();
    let concat = concat_audio_files(state, user_id, &src_paths, true).await?;
    // Release raw part `.partial` files immediately after concatenation succeeds.
    drop(downloaded);

    let first = &parts[0];
    let storage = import::stage_prepared_audio(
        state,
        user_id,
        &first.id,
        concat.ext,
        concat.temp,
        concat.byte_len,
        concat.file_md5,
        true,
    )
    .await?;

    let id = ids::new_id();
    let now = now_ms();
    let (title, title_source) = super::sync::title_for(title_mode, first).await;
    let eligible = crate::export::auto::auto_export_eligible(state, user_id).await;
    let start = first.start_time.unwrap_or(0);

    let mut total_duration_ms = 0i64;
    let mut part_rows = Vec::with_capacity(parts.len());
    for (idx, (part, &audio_ms)) in parts
        .iter()
        .zip(concat.input_durations_ms.iter())
        .enumerate()
    {
        let p_dur = part_effective_plaud_ms(part, audio_ms);
        let p_start = part.start_time.unwrap_or(0);
        let p_end = effective_end(p_start, part.end_time.unwrap_or(0), p_dur);
        total_duration_ms = total_duration_ms.saturating_add(p_dur);
        part_rows.push((idx as i64, part, p_start, p_end, p_dur, audio_ms));
    }
    let end_time = part_rows.iter().map(|r| r.3).max().unwrap_or(start);
    let peaks_json = storage
        .peaks
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());

    let commit_res: Result<(), sqlx::Error> = async {
        let mut tx = crate::db::begin_write(&state.db).await?;
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, \
             storage_type, storage_path, auto_export_path, downloaded_at, plaud_version, timezone, zonemins, scene, is_trash, waveform_peaks, \
             deleted_at, starred_at, created_at, updated_at, title_source, auto_export_eligible) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(first.serial_number.clone().unwrap_or_default())
        .bind(&first.id)
        .bind(state.config.field_key.encrypt(&title))
        .bind(total_duration_ms)
        .bind(start)
        .bind(end_time)
        .bind(storage.byte_len)
        .bind(storage.file_md5.as_str())
        .bind(storage.storage_type)
        .bind(storage.key.as_str())
        .bind(now)
        .bind(version_text(first))
        .bind(first.timezone)
        .bind(first.zonemins)
        .bind(first.scene)
        .bind(peaks_json)
        .bind(now)
        .bind(now)
        .bind(title_source)
        .bind(eligible)
        .execute(&mut *tx)
        .await?;

        for (part_index, part, p_start, p_end, p_dur, audio_ms) in &part_rows {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(&part.id)
            .bind(&id)
            .bind(part_index)
            .bind(p_start)
            .bind(p_end)
            .bind(p_dur)
            .bind(audio_ms)
            .bind(version_text(part))
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }

        let settle_ids: Vec<&str> = parts.iter().map(|p| p.id.as_str()).collect();
        clear_settle_ids_in(&mut *tx, user_id, &settle_ids, now).await?;
        tx.commit().await?;
        Ok(())
    }
    .await;

    if let Err(e) = commit_res {
        let _ = state
            .storage
            .delete(storage.storage_type, &storage.key)
            .await;
        return Err(e.into());
    }
    Ok((id, title))
}

fn export_format_of(settings: &serde_json::Map<String, Value>) -> &'static str {
    match settings.get("autoExportFormat").and_then(Value::as_str) {
        Some("ogg") => "ogg",
        Some("original") => "original",
        _ => "mp3",
    }
}

fn export_ext_for(format: &str, stored_ext: &str) -> String {
    match format {
        "original" if stored_ext == "opus" => "ogg".to_owned(),
        "original" if !stored_ext.is_empty() => stored_ext.to_owned(),
        "original" => "mp3".to_owned(),
        "ogg" => "ogg".to_owned(),
        _ => "mp3".to_owned(),
    }
}

fn export_matches_format(format: &str, stored_ext: &str) -> bool {
    match format {
        "original" => true,
        "ogg" => matches!(stored_ext, "ogg" | "opus"),
        _ => stored_ext == "mp3",
    }
}

async fn unique_sibling_path(folder: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut n = 1usize;
    loop {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let candidate = folder.join(name);
        if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return candidate;
        }
        n += 1;
    }
}

struct VerifiedExport {
    anchor_id: String,
    orig_path: PathBuf,
    orig_enc_path: String,
    orig_sha256: Option<String>,
    orig_ext: String,
    orig_len: u64,
    orig_mtime: SystemTime,
}

struct PreparedExportConsolidation {
    staged: TempPath,
    staged_sha256: Option<String>,
    folder: PathBuf,
    target_ext: String,
    /// Verified exports in priority order (preferred target first, then redundant exports to unlink).
    verified: Vec<VerifiedExport>,
}

fn has_clash_number_suffix(stem: &str) -> bool {
    let Some(without_paren) = stem.strip_suffix(')') else {
        return false;
    };
    let Some((_, num)) = without_paren.rsplit_once(" (") else {
        return false;
    };
    !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit())
}

fn path_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

async fn same_file_bytes(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (tokio::fs::metadata(a).await, tokio::fs::metadata(b).await) else {
        return false;
    };
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (
        tokio::fs::File::open(a).await,
        tokio::fs::File::open(b).await,
    ) else {
        return false;
    };
    let mut ba = vec![0u8; 64 * 1024];
    let mut bb = vec![0u8; 64 * 1024];
    loop {
        let Ok(na) = fa.read(&mut ba).await else {
            return false;
        };
        let Ok(nb) = fb.read(&mut bb).await else {
            return false;
        };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

async fn export_path_claimed_by_other<'e, E>(
    exec: E,
    state: &AppState,
    user_id: &str,
    excluded_ids: &HashSet<&str>,
    orig_path: &Path,
) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    #[derive(sqlx::FromRow)]
    struct OtherPathRow {
        id: String,
        storage_type: String,
        storage_path: String,
        auto_export_path: Option<String>,
        auto_export_target: Option<String>,
    }

    let rows: Vec<OtherPathRow> = sqlx::query_as(
        "SELECT id, storage_type, storage_path, auto_export_path, auto_export_target \
         FROM recordings WHERE user_id = ? AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_all(exec)
    .await?;

    let orig_raw = orig_path.to_string_lossy();
    let orig_norm = crate::local_folder::normalize_path(orig_path);
    let matches_orig = |candidate: &str| {
        !candidate.is_empty()
            && (candidate == orig_raw
                || crate::local_folder::normalize_path(Path::new(candidate)) == orig_norm)
    };

    for row in rows {
        if excluded_ids.contains(row.id.as_str()) {
            continue;
        }
        if matches_orig(&row.storage_path) {
            return Ok(true);
        }
        if let Ok(Some(local)) = state
            .storage
            .local_path(&row.storage_type, &row.storage_path)
            && matches_orig(&local.to_string_lossy())
        {
            return Ok(true);
        }
        for enc in [row.auto_export_path, row.auto_export_target]
            .into_iter()
            .flatten()
        {
            let plain = state
                .config
                .field_key
                .decrypt(&enc)
                .unwrap_or_else(|_| enc.clone());
            if matches_orig(&plain) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn verify_anchor_export(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    excluded_ids: &HashSet<&str>,
    anchor: &DbAnchor,
    existing_audio_path: &Path,
) -> Option<VerifiedExport> {
    let orig_enc = anchor.auto_export_path.as_deref()?;
    let orig_str = state.config.field_key.decrypt(orig_enc).ok()?;
    if orig_str.is_empty() {
        return None;
    }
    let orig_path = PathBuf::from(&orig_str);
    let meta = tokio::fs::metadata(&orig_path).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let orig_len = meta.len();
    let orig_mtime = meta.modified().ok()?;
    if !crate::local_folder::is_in_folder(&orig_path, folder) {
        return None;
    }
    if export_path_claimed_by_other(&state.db, state, user_id, excluded_ids, &orig_path)
        .await
        .unwrap_or(true)
    {
        return None;
    }

    // Require exact byte-for-byte proof before overwriting or unlinking any desktop auto-export:
    // lossless copies compare directly against the stored audio; transcoded exports (e.g. .ogg ->
    // .mp3) compare against the stored SHA-256 written by auto-export. Legacy transcoded exports
    // without a stored digest are left untouched so user edits are never lost.
    let orig_ext = path_ext_lower(&orig_path);
    let anchor_ext = path_ext_lower(Path::new(&anchor.storage_path));
    let is_lossless_copy = orig_ext == anchor_ext
        || (matches!(orig_ext.as_str(), "ogg" | "opus")
            && matches!(anchor_ext.as_str(), "ogg" | "opus"));
    if is_lossless_copy {
        if !same_file_bytes(&orig_path, existing_audio_path).await {
            return None;
        }
    } else {
        let expected_sha = anchor.auto_export_sha256.as_deref()?;
        let actual_sha = crate::export::auto::file_sha256(&orig_path).await?;
        if actual_sha != expected_sha {
            return None;
        }
    }

    Some(VerifiedExport {
        anchor_id: anchor.id.clone(),
        orig_path,
        orig_enc_path: orig_enc.to_owned(),
        orig_sha256: anchor.auto_export_sha256.clone(),
        orig_ext,
        orig_len,
        orig_mtime,
    })
}

async fn prepare_desktop_export_consolidation(
    state: &AppState,
    user_id: &str,
    survivor_id: &str,
    anchor_inputs: &[(&DbAnchor, &Path)],
    new_storage: &import::Stored,
    new_stored_ext: &str,
) -> Option<PreparedExportConsolidation> {
    state.config.desktop.as_ref()?;
    let user_settings = settings::effective(state, user_id).await.ok()?;
    if user_settings.get("autoExport") != Some(&Value::Bool(true)) {
        return None;
    }
    let folder_str = user_settings
        .get("autoExportFolder")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let folder = PathBuf::from(folder_str);

    let excluded_ids: HashSet<&str> = anchor_inputs.iter().map(|(a, _)| a.id.as_str()).collect();

    let mut verified = Vec::new();
    let mut seen_paths = HashSet::new();
    for &(anchor, audio_path) in anchor_inputs {
        if let Some(v) =
            verify_anchor_export(state, user_id, &folder, &excluded_ids, anchor, audio_path).await
        {
            let norm = crate::local_folder::normalize_path(&v.orig_path);
            if seen_paths.insert(norm) {
                verified.push(v);
            }
        }
    }
    if verified.is_empty() {
        return None;
    }

    // Prefer an un-numbered automatic export name (e.g. `2026-11-24.ogg` over `2026-11-24 (2).ogg`),
    // breaking ties in favor of the survivor anchor's own export path.
    verified.sort_by_key(|v| {
        let stem = v
            .orig_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        (
            has_clash_number_suffix(stem),
            v.anchor_id != survivor_id,
            v.orig_path.clone(),
        )
    });

    let format = export_format_of(&user_settings);
    let target_ext = export_ext_for(format, new_stored_ext);
    let tmp = TempPath::new(folder.join(format!(".plaud-export-{}.partial", ids::token_hex(8))));

    let ok = if export_matches_format(format, new_stored_ext) {
        state
            .storage
            .get_file(new_storage.storage_type, &new_storage.key, tmp.path())
            .await
            .is_ok()
    } else if let Ok(src) = state
        .storage
        .materialize(new_storage.storage_type, &new_storage.key)
        .await
    {
        match format {
            "ogg" => media::to_ogg_opus(&state.config.ffmpeg, src.path(), tmp.path()).await,
            _ => media::to_mp3(&state.config.ffmpeg, src.path(), tmp.path()).await,
        }
    } else {
        false
    };
    if !ok {
        tracing::warn!(
            export_path = %verified[0].orig_path.display(),
            "staging updated desktop auto-export after split consolidation failed"
        );
        return None;
    }

    let staged_sha256 = crate::export::auto::file_sha256(tmp.path()).await;
    Some(PreparedExportConsolidation {
        staged: tmp,
        staged_sha256,
        folder,
        target_ext,
        verified,
    })
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct StoredPartRow {
    plaud_file_id: String,
    start_time: i64,
    end_time: i64,
    plaud_duration_ms: i64,
    audio_duration_ms: i64,
    plaud_version: String,
}

#[derive(sqlx::FromRow)]
struct CurrentAnchorRow {
    deleted_at: Option<i64>,
    storage_path: String,
    auto_export_path: Option<String>,
    auto_export_sha256: Option<String>,
    auto_export_eligible: i64,
    filename: String,
    title_source: String,
    starred_at: Option<i64>,
    duration: i64,
    start_time: i64,
    end_time: i64,
    plaud_file_id: String,
    plaud_version: String,
}

fn seg_start_bounds(seg: &ChainSegment) -> (i64, i64) {
    match seg {
        ChainSegment::Existing(a) => (
            a.first_start_time,
            a.last_start_time.max(a.first_start_time),
        ),
        ChainSegment::New(r) => {
            let s = r.start_time.unwrap_or(0);
            (s, s)
        }
    }
}

/// True when any segment's constituent start-time span straddles a later segment's start time
/// (e.g., an existing multi-part `[09:00, 17:00]` recording with a newly arriving `13:00` clip),
/// requiring constituent-part re-assembly so the merged audio plays in strict chronological order.
fn needs_interleaved_reassembly(segs: &[ChainSegment]) -> bool {
    let mut max_last_start = i64::MIN;
    for seg in segs {
        let (first, last) = seg_start_bounds(seg);
        if max_last_start > first {
            return true;
        }
        max_last_start = max_last_start.max(last);
    }
    false
}

enum InterleavedSource {
    LocalSingleAnchor {
        pos: usize,
        part: StoredPartRow,
    },
    DownloadExisting {
        anchor_pos: usize,
        offset_ms: i64,
        part: StoredPartRow,
    },
    DownloadNew(Recording),
}

impl InterleavedSource {
    fn plaud_file_id(&self) -> &str {
        match self {
            Self::LocalSingleAnchor { part, .. } | Self::DownloadExisting { part, .. } => {
                part.plaud_file_id.as_str()
            }
            Self::DownloadNew(r) => r.id.as_str(),
        }
    }

    fn start_time(&self) -> i64 {
        match self {
            Self::LocalSingleAnchor { part, .. } | Self::DownloadExisting { part, .. } => {
                part.start_time
            }
            Self::DownloadNew(r) => r.start_time.unwrap_or(0),
        }
    }
}

/// Fallback used during interleaved re-assembly when an already-merged part is no longer
/// downloadable from Plaud (e.g., deleted in Plaud cloud): slices that part out of the local
/// merged recording at its stored `audio_duration_ms` offset.
async fn extract_local_audio_slice(
    state: &AppState,
    user_id: &str,
    src_path: &Path,
    offset_ms: i64,
    duration_ms: i64,
) -> Result<TempPath, ItemError> {
    if duration_ms <= 0 {
        return Err(ItemError::Failed(
            "existing part has no known duration for local slice fallback".into(),
        ));
    }
    let dir = state.config.storage_root.join(user_id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| ItemError::Failed("could not create the storage folder".into()))?;
    let start_sec = format!("{:.3}", (offset_ms.max(0) as f64) / 1000.0);
    let dur_sec = format!("{:.3}", (duration_ms as f64) / 1000.0);
    let src_ext = path_ext_lower(src_path);
    let (copy_ext, copy_muxer) = match src_ext.as_str() {
        "ogg" | "opus" => ("ogg", "ogg"),
        "mp3" => ("mp3", "mp3"),
        "m4a" | "mp4" => ("m4a", "mp4"),
        "flac" => ("flac", "flac"),
        "wav" => ("wav", "wav"),
        _ => ("ogg", "ogg"),
    };

    let copy_dst = TempPath::new(dir.join(format!(
        ".plaud-slice-{}.{copy_ext}.partial",
        ids::token_hex(8)
    )));
    let mut cmd = Command::new(&state.config.ffmpeg);
    cmd.args(["-v", "error", "-y", "-ss", &start_sec, "-i"])
        .arg(src_path)
        .args(["-t", &dur_sec, "-vn", "-c", "copy"]);
    if copy_muxer == "mp4" {
        cmd.args(["-movflags", "+faststart"]);
    }
    cmd.args(["-f", copy_muxer]).arg(copy_dst.path());
    if media::run(&mut cmd).await
        && media::probe(&state.config.ffprobe, copy_dst.path())
            .await
            .is_some()
    {
        return Ok(copy_dst);
    }

    let enc_dst =
        TempPath::new(dir.join(format!(".plaud-slice-{}.ogg.partial", ids::token_hex(8))));
    let mut enc = Command::new(&state.config.ffmpeg);
    enc.args(["-v", "error", "-y", "-ss", &start_sec, "-i"])
        .arg(src_path)
        .args([
            "-t", &dur_sec, "-vn", "-c:a", "libopus", "-b:a", "64k", "-f", "ogg",
        ])
        .arg(enc_dst.path());
    if media::run(&mut enc).await
        && media::probe(&state.config.ffprobe, enc_dst.path())
            .await
            .is_some()
    {
        return Ok(enc_dst);
    }
    Err(ItemError::Failed(
        "could not recover missing split part from local merged audio".into(),
    ))
}

/// Consolidates a chronological split or daily chain containing at least one existing live DB
/// recording (handling late appends, late prepends, late bridges, interleaved middle-inserts,
/// and consolidation of already-imported recordings).
/// Hard-deletes absorbed secondary recording rows inside the commit transaction after moving all
/// constituent `plaud_file_id`s onto the survivor in `plaud_recording_parts`, leaving zero
/// duplicate rows in SQLite `recordings`.
/// Holds `local_folder::lock()` BEFORE `db::begin_write()` strictly around final export rename,
/// DB commit, and obsolete export cleanup.
pub(crate) async fn execute_consolidate(
    state: &AppState,
    user_id: &str,
    client: &Client,
    segs: &[ChainSegment],
) -> Result<AppendOutcome, ItemError> {
    let existing_positions: Vec<usize> = segs
        .iter()
        .enumerate()
        .filter_map(|(idx, s)| s.is_existing().then_some(idx))
        .collect();
    if segs.len() < 2 || existing_positions.is_empty() {
        return Err(ItemError::Failed(
            "split consolidation requires at least two segments with one existing anchor".into(),
        ));
    }

    let survivor_pos = existing_positions[0];
    let ChainSegment::Existing(survivor) = &segs[survivor_pos] else {
        unreachable!("survivor position points to Existing");
    };
    let absorbed_anchors: Vec<&DbAnchor> = existing_positions[1..]
        .iter()
        .map(|&idx| match &segs[idx] {
            ChainSegment::Existing(a) => a,
            ChainSegment::New(_) => unreachable!("existing position points to Existing"),
        })
        .collect();
    let new_parts: Vec<Recording> = segs
        .iter()
        .filter_map(|s| match s {
            ChainSegment::New(r) => Some(r.clone()),
            ChainSegment::Existing(_) => None,
        })
        .collect();

    let interleaved = needs_interleaved_reassembly(segs);

    // Materialize every existing anchor's audio outside all locks (for local concat reuse and
    // authentic desktop auto-export verification).
    let mut materialized: Vec<Option<crate::storage::LocalFile>> =
        (0..segs.len()).map(|_| None).collect();
    let mut actual_existing_bytes = 0u64;
    let mut any_existing_ogg_or_opus = false;
    for &pos in &existing_positions {
        let ChainSegment::Existing(anchor) = &segs[pos] else {
            unreachable!();
        };
        let file = state
            .storage
            .materialize(&anchor.storage_type, &anchor.storage_path)
            .await
            .map_err(|_| ItemError::Failed("existing split anchor audio is unavailable".into()))?;
        let bytes = tokio::fs::metadata(file.path())
            .await
            .map(|m| m.len())
            .unwrap_or(anchor.filesize.max(0) as u64);
        actual_existing_bytes = actual_existing_bytes.saturating_add(bytes);
        let lower = anchor.storage_path.to_ascii_lowercase();
        if lower.ends_with(".ogg") || lower.ends_with(".opus") {
            any_existing_ogg_or_opus = true;
        }
        materialized[pos] = Some(file);
    }

    let mut expected_multipart_ids: HashMap<String, Vec<String>> = HashMap::new();
    let mut preassembled_parts: Option<Vec<StoredPartRow>> = None;
    let mut new_part_audio_ms: HashMap<String, i64> = HashMap::new();
    let mut leading_new_rec: Option<Recording> = None;

    let concat: ConcatOutput = if interleaved {
        // Interleaved middle-insert: expand any multi-part existing anchor into its constituent
        // Plaud parts, reuse single-part existing anchors locally, sort all parts chronologically,
        // and concatenate in true recording order. If an old part was removed from Plaud cloud,
        // recover its audio slice from the already-materialized local merged file.
        let mut sources: Vec<InterleavedSource> = Vec::new();
        let mut any_local_ogg_or_opus = false;
        for (pos, seg) in segs.iter().enumerate() {
            match seg {
                ChainSegment::Existing(anchor) => {
                    let existing_parts: Vec<StoredPartRow> = sqlx::query_as(
                        "SELECT plaud_file_id, start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version \
                         FROM plaud_recording_parts \
                         WHERE user_id = ? AND recording_id = ? \
                         ORDER BY part_index ASC",
                    )
                    .bind(user_id)
                    .bind(&anchor.id)
                    .fetch_all(&state.db)
                    .await?;
                    if existing_parts.len() >= 2 {
                        expected_multipart_ids.insert(
                            anchor.id.clone(),
                            existing_parts
                                .iter()
                                .map(|p| p.plaud_file_id.clone())
                                .collect(),
                        );
                        let mut offset_ms = 0i64;
                        for p in existing_parts {
                            let part_audio_ms = p.audio_duration_ms.max(0);
                            sources.push(InterleavedSource::DownloadExisting {
                                anchor_pos: pos,
                                offset_ms,
                                part: p,
                            });
                            offset_ms = offset_ms.saturating_add(part_audio_ms);
                        }
                    } else {
                        let lower = anchor.storage_path.to_ascii_lowercase();
                        if lower.ends_with(".ogg") || lower.ends_with(".opus") {
                            any_local_ogg_or_opus = true;
                        }
                        let single_part = if let Some(p) = existing_parts.into_iter().next() {
                            p
                        } else {
                            let plaud_ver: Option<String> = sqlx::query_scalar(
                                "SELECT plaud_version FROM recordings WHERE id = ? AND user_id = ?",
                            )
                            .bind(&anchor.id)
                            .bind(user_id)
                            .fetch_optional(&state.db)
                            .await?;
                            let p_end = effective_end(
                                anchor.first_start_time,
                                anchor.first_end_time,
                                anchor.first_plaud_duration_ms,
                            );
                            StoredPartRow {
                                plaud_file_id: anchor.plaud_file_id.clone(),
                                start_time: anchor.first_start_time,
                                end_time: p_end,
                                plaud_duration_ms: anchor.first_plaud_duration_ms,
                                audio_duration_ms: anchor.duration,
                                plaud_version: plaud_ver.unwrap_or_default(),
                            }
                        };
                        sources.push(InterleavedSource::LocalSingleAnchor {
                            pos,
                            part: single_part,
                        });
                    }
                }
                ChainSegment::New(r) => {
                    sources.push(InterleavedSource::DownloadNew(r.clone()));
                }
            }
        }

        sources.sort_by(|a, b| {
            a.start_time()
                .cmp(&b.start_time())
                .then_with(|| a.plaud_file_id().cmp(b.plaud_file_id()))
        });
        let mut deduped: Vec<InterleavedSource> = Vec::with_capacity(sources.len());
        let mut seen_fids: HashSet<String> = HashSet::new();
        for src in sources {
            if seen_fids.insert(src.plaud_file_id().to_owned()) {
                deduped.push(src);
            }
        }

        let est_dl_bytes: u64 = deduped
            .iter()
            .map(|src| match src {
                InterleavedSource::LocalSingleAnchor { .. } => 0,
                InterleavedSource::DownloadExisting { part: p, .. } => {
                    ((p.plaud_duration_ms.max(0) as u64) / 1000).saturating_mul(8_000)
                }
                InterleavedSource::DownloadNew(r) => {
                    estimate_download_bytes(std::slice::from_ref(r))
                }
            })
            .fold(0u64, u64::saturating_add);
        ensure_disk_space(state, actual_existing_bytes, est_dl_bytes)?;

        let dl_ids: Vec<&str> = deduped
            .iter()
            .filter_map(|src| match src {
                InterleavedSource::LocalSingleAnchor { .. } => None,
                InterleavedSource::DownloadExisting { part: p, .. } => {
                    Some(p.plaud_file_id.as_str())
                }
                InterleavedSource::DownloadNew(r) => Some(r.id.as_str()),
            })
            .collect();
        let any_v4 = deduped
            .iter()
            .any(|src| matches!(src, InterleavedSource::DownloadNew(r) if r.is_v4));
        let pref =
            match choose_audio_preference_for_ids(client, &dl_ids, any_v4, any_local_ogg_or_opus)
                .await
            {
                Ok(p) => p,
                Err(ItemError::Rejected) => return Err(ItemError::Rejected),
                Err(_) => AudioPreference::Default,
            };

        let mut staged_parts: Vec<Option<TempPath>> = (0..deduped.len()).map(|_| None).collect();
        let mut downloaded_bytes = 0u64;
        let mut all_downloaded = true;
        for (idx, src) in deduped.iter().enumerate() {
            match src {
                InterleavedSource::LocalSingleAnchor { .. } => {
                    all_downloaded = false;
                }
                InterleavedSource::DownloadExisting {
                    anchor_pos,
                    offset_ms,
                    part: p,
                } => match import::download_to_temp(state, user_id, client, &p.plaud_file_id, pref)
                    .await
                {
                    Ok(dl) => {
                        downloaded_bytes =
                            downloaded_bytes.saturating_add(dl.byte_len.max(0) as u64);
                        staged_parts[idx] = Some(dl.temp);
                    }
                    Err(ItemError::Rejected) => return Err(ItemError::Rejected),
                    Err(ItemError::Failed(reason)) => {
                        tracing::warn!(
                            plaud_file_id = %p.plaud_file_id,
                            error = %reason,
                            "re-downloading existing merged part failed; slicing from local merged audio"
                        );
                        let local_file = materialized[*anchor_pos].as_ref().ok_or_else(|| {
                            ItemError::Failed("missing staged audio input".into())
                        })?;
                        let sliced = extract_local_audio_slice(
                            state,
                            user_id,
                            local_file.path(),
                            *offset_ms,
                            p.audio_duration_ms,
                        )
                        .await?;
                        let slice_len = tokio::fs::metadata(sliced.path())
                            .await
                            .map(|m| m.len())
                            .unwrap_or(0);
                        downloaded_bytes = downloaded_bytes.saturating_add(slice_len);
                        all_downloaded = false;
                        staged_parts[idx] = Some(sliced);
                    }
                },
                InterleavedSource::DownloadNew(r) => {
                    let dl = import::download_to_temp(state, user_id, client, &r.id, pref).await?;
                    downloaded_bytes = downloaded_bytes.saturating_add(dl.byte_len.max(0) as u64);
                    staged_parts[idx] = Some(dl.temp);
                }
            }
        }
        ensure_disk_space(state, actual_existing_bytes, downloaded_bytes)?;

        let mut inputs = Vec::with_capacity(deduped.len());
        for (idx, src) in deduped.iter().enumerate() {
            match src {
                InterleavedSource::LocalSingleAnchor { pos, .. } => {
                    let file = materialized[*pos]
                        .as_ref()
                        .ok_or_else(|| ItemError::Failed("missing staged audio input".into()))?;
                    inputs.push(file.path().to_path_buf());
                }
                InterleavedSource::DownloadExisting { .. } | InterleavedSource::DownloadNew(_) => {
                    let temp = staged_parts[idx]
                        .as_ref()
                        .ok_or_else(|| ItemError::Failed("missing staged audio input".into()))?;
                    inputs.push(temp.path().to_path_buf());
                }
            }
        }
        let concat = concat_audio_files(state, user_id, &inputs, all_downloaded).await?;
        drop(staged_parts);

        if let Some(InterleavedSource::DownloadNew(r)) = deduped.first() {
            leading_new_rec = Some(r.clone());
        }

        let mut parts_out = Vec::with_capacity(deduped.len());
        for (idx, src) in deduped.into_iter().enumerate() {
            let audio_ms = concat.input_durations_ms[idx];
            match src {
                InterleavedSource::LocalSingleAnchor { mut part, .. }
                | InterleavedSource::DownloadExisting { mut part, .. } => {
                    part.audio_duration_ms = audio_ms;
                    parts_out.push(part);
                }
                InterleavedSource::DownloadNew(part) => {
                    let p_dur = part_effective_plaud_ms(&part, audio_ms);
                    let p_start = part.start_time.unwrap_or(0);
                    let p_end = effective_end(p_start, part.end_time.unwrap_or(0), p_dur);
                    new_part_audio_ms.insert(part.id.clone(), audio_ms);
                    parts_out.push(StoredPartRow {
                        plaud_file_id: part.id.clone(),
                        start_time: p_start,
                        end_time: p_end,
                        plaud_duration_ms: p_dur,
                        audio_duration_ms: audio_ms,
                        plaud_version: version_text(&part),
                    });
                }
            }
        }
        preassembled_parts = Some(parts_out);
        concat
    } else {
        // Non-interleaved fast path: reuse every existing anchor's local file directly with zero
        // re-downloads, downloading only newly arrived segments.
        ensure_disk_space(
            state,
            actual_existing_bytes,
            estimate_download_bytes(&new_parts),
        )?;

        let mut downloaded: Vec<Option<import::DownloadedTemp>> =
            (0..segs.len()).map(|_| None).collect();
        let mut downloaded_bytes = 0u64;
        if !new_parts.is_empty() {
            let pref =
                choose_audio_preference(client, &new_parts, any_existing_ogg_or_opus).await?;
            for (pos, seg) in segs.iter().enumerate() {
                if let ChainSegment::New(part) = seg {
                    let dl =
                        import::download_to_temp(state, user_id, client, &part.id, pref).await?;
                    downloaded_bytes = downloaded_bytes.saturating_add(dl.byte_len.max(0) as u64);
                    downloaded[pos] = Some(dl);
                }
            }
        }
        ensure_disk_space(state, actual_existing_bytes, downloaded_bytes)?;

        let mut inputs = Vec::with_capacity(segs.len());
        for pos in 0..segs.len() {
            if let Some(file) = &materialized[pos] {
                inputs.push(file.path().to_path_buf());
            } else if let Some(dl) = &downloaded[pos] {
                inputs.push(dl.temp.path().to_path_buf());
            } else {
                return Err(ItemError::Failed("missing staged audio input".into()));
            }
        }
        let concat = concat_audio_files(state, user_id, &inputs, false).await?;
        drop(downloaded);

        if let ChainSegment::New(first_new) = &segs[0] {
            leading_new_rec = Some(first_new.clone());
        }
        for (pos, seg) in segs.iter().enumerate() {
            if let ChainSegment::New(part) = seg {
                new_part_audio_ms.insert(part.id.clone(), concat.input_durations_ms[pos]);
            }
        }
        concat
    };

    let key_stem = preassembled_parts
        .as_ref()
        .and_then(|parts| parts.first().map(|p| p.plaud_file_id.as_str()))
        .unwrap_or_else(|| match &segs[0] {
            ChainSegment::Existing(a) => a.plaud_file_id.as_str(),
            ChainSegment::New(r) => r.id.as_str(),
        });
    let new_storage = import::stage_prepared_audio(
        state,
        user_id,
        key_stem,
        concat.ext,
        concat.temp,
        concat.byte_len,
        concat.file_md5,
        true,
    )
    .await?;

    // Verify authentic desktop auto-exports across all existing anchors before releasing materialized files.
    let mut anchor_export_inputs: Vec<(&DbAnchor, &Path)> =
        Vec::with_capacity(existing_positions.len());
    for &pos in &existing_positions {
        let ChainSegment::Existing(anchor) = &segs[pos] else {
            unreachable!();
        };
        let file = materialized[pos].as_ref().expect("materialized present");
        anchor_export_inputs.push((anchor, file.path()));
    }
    let mut prepared_export = prepare_desktop_export_consolidation(
        state,
        user_id,
        &survivor.id,
        &anchor_export_inputs,
        &new_storage,
        concat.ext,
    )
    .await;
    drop(materialized);

    // Compute local date title in memory outside locks in case a late prepend shifts the leading day.
    let leading_start = preassembled_parts
        .as_ref()
        .and_then(|parts| parts.first().map(|p| p.start_time))
        .unwrap_or_else(|| match &segs[0] {
            ChainSegment::Existing(a) => a.first_start_time,
            ChainSegment::New(r) => r.start_time.unwrap_or(0),
        });
    let leading_date_title = local_day_key(leading_start);

    // Inspect prior openaudiohub work and supersede active pipeline jobs across all existing anchors BEFORE locking.
    let mut had_prior_oah_pre = false;
    for &pos in &existing_positions {
        let ChainSegment::Existing(anchor) = &segs[pos] else {
            unreachable!();
        };
        let has_work: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND user_id = ? AND source = 'openaudiohub') \
             OR EXISTS (SELECT 1 FROM jobs WHERE recording_id = ? AND user_id = ? AND kind IN ('transcribe', 'pipeline') AND state IN ('queued', 'running', 'done'))",
        )
        .bind(&anchor.id)
        .bind(user_id)
        .bind(&anchor.id)
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);
        had_prior_oah_pre |= has_work;

        if let Err(e) = crate::pipeline::supersede(state, user_id, &anchor.id).await {
            tracing::warn!(recording = %anchor.id, error = %e, "superseding active pipeline job before split consolidation failed");
        }
    }

    let now = now_ms();
    let peaks_json = new_storage
        .peaks
        .as_ref()
        .and_then(|p| serde_json::to_string(p).ok());

    enum CommitAction {
        Committed {
            had_oah_work: bool,
            superseded_pipeline_ids: Vec<String>,
            old_storage_objects: Vec<(String, String)>,
        },
        SingleAnchorDeletedConcurrently,
        MissingOrDeletedAnchor,
        StorageChanged,
    }

    let existing_anchor_ids: HashSet<&str> = existing_positions
        .iter()
        .map(|&pos| match &segs[pos] {
            ChainSegment::Existing(a) => a.id.as_str(),
            ChainSegment::New(_) => unreachable!(),
        })
        .collect();

    // Strict lock order: always acquire `local_folder::lock()` BEFORE `db::begin_write()`.
    let action: Result<CommitAction, sqlx::Error> = async {
        let _folder_guard = crate::local_folder::lock().await;
        let mut tx = crate::db::begin_write(&state.db).await?;

        let mut current_rows: HashMap<String, CurrentAnchorRow> =
            HashMap::with_capacity(existing_positions.len());
        for &pos in &existing_positions {
            let ChainSegment::Existing(anchor) = &segs[pos] else {
                unreachable!();
            };
            let current: Option<CurrentAnchorRow> = sqlx::query_as(
                "SELECT deleted_at, storage_path, auto_export_path, auto_export_sha256, auto_export_eligible, \
                        filename, title_source, starred_at, duration, start_time, end_time, \
                        plaud_file_id, plaud_version \
                 FROM recordings WHERE id = ? AND user_id = ?",
            )
            .bind(&anchor.id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;

            let Some(row) = current else {
                tx.rollback().await?;
                return Ok(CommitAction::MissingOrDeletedAnchor);
            };
            if row.deleted_at.is_some() {
                tx.rollback().await?;
                if existing_positions.len() == 1 {
                    return Ok(CommitAction::SingleAnchorDeletedConcurrently);
                }
                return Ok(CommitAction::MissingOrDeletedAnchor);
            }
            if row.storage_path != anchor.storage_path {
                tx.rollback().await?;
                return Ok(CommitAction::StorageChanged);
            }
            if let Some(expected_ids) = expected_multipart_ids.get(&anchor.id) {
                let current_ids: Vec<String> = sqlx::query_scalar(
                    "SELECT plaud_file_id FROM plaud_recording_parts \
                     WHERE user_id = ? AND recording_id = ? ORDER BY part_index ASC",
                )
                .bind(user_id)
                .bind(&anchor.id)
                .fetch_all(&mut *tx)
                .await?;
                if &current_ids != expected_ids {
                    tx.rollback().await?;
                    return Ok(CommitAction::StorageChanged);
                }
            }
            current_rows.insert(anchor.id.clone(), row);
        }

        // Assemble complete chronological part rows across all segments, preserving per-part audio_duration_ms.
        let merged_parts: Vec<StoredPartRow> = if let Some(parts) = preassembled_parts.as_ref() {
            parts.clone()
        } else {
            let mut out = Vec::new();
            for (pos, seg) in segs.iter().enumerate() {
                match seg {
                    ChainSegment::Existing(anchor) => {
                        let existing_parts: Vec<StoredPartRow> = sqlx::query_as(
                            "SELECT plaud_file_id, start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version \
                             FROM plaud_recording_parts \
                             WHERE user_id = ? AND recording_id = ? \
                             ORDER BY part_index ASC",
                        )
                        .bind(user_id)
                        .bind(&anchor.id)
                        .fetch_all(&mut *tx)
                        .await?;
                        if !existing_parts.is_empty() {
                            out.extend(existing_parts);
                        } else {
                            let cur = &current_rows[&anchor.id];
                            let audio_ms = concat.input_durations_ms[pos];
                            let p_dur = if cur.duration > 0 {
                                cur.duration
                            } else {
                                audio_ms
                            };
                            let p_end = effective_end(cur.start_time, cur.end_time, p_dur);
                            out.push(StoredPartRow {
                                plaud_file_id: cur.plaud_file_id.clone(),
                                start_time: cur.start_time,
                                end_time: p_end,
                                plaud_duration_ms: p_dur,
                                audio_duration_ms: audio_ms,
                                plaud_version: cur.plaud_version.clone(),
                            });
                        }
                    }
                    ChainSegment::New(part) => {
                        let audio_ms = concat.input_durations_ms[pos];
                        let p_dur = part_effective_plaud_ms(part, audio_ms);
                        let p_start = part.start_time.unwrap_or(0);
                        let p_end = effective_end(p_start, part.end_time.unwrap_or(0), p_dur);
                        out.push(StoredPartRow {
                            plaud_file_id: part.id.clone(),
                            start_time: p_start,
                            end_time: p_end,
                            plaud_duration_ms: p_dur,
                            audio_duration_ms: audio_ms,
                            plaud_version: version_text(part),
                        });
                    }
                }
            }
            out
        };

        // Re-verify export candidates inside the lock before touching disk.
        let mut export_rename_plan: Option<(PathBuf, PathBuf)> = None;
        let mut new_export_enc: Option<String> = None;
        let mut new_export_sha256: Option<String> = None;
        let mut created_sibling_export: Option<PathBuf> = None;
        let mut paths_to_unlink_in_lock: Vec<PathBuf> = Vec::new();

        if let Some(prep) = prepared_export.as_ref() {
            let mut stable: Vec<&VerifiedExport> = Vec::new();
            for cand in &prep.verified {
                let Some(cur) = current_rows.get(&cand.anchor_id) else {
                    continue;
                };
                if cur.auto_export_path.as_deref() != Some(cand.orig_enc_path.as_str())
                    || cur.auto_export_sha256 != cand.orig_sha256
                {
                    continue;
                }
                if export_path_claimed_by_other(
                    &mut *tx,
                    state,
                    user_id,
                    &existing_anchor_ids,
                    &cand.orig_path,
                )
                .await?
                {
                    continue;
                }
                if let Ok(meta) = tokio::fs::metadata(&cand.orig_path).await
                    && meta.is_file()
                    && meta.len() == cand.orig_len
                    && meta.modified().ok() == Some(cand.orig_mtime)
                {
                    stable.push(cand);
                }
            }
            if let Some(chosen) = stable.first() {
                let dest_path = if chosen.orig_ext == prep.target_ext {
                    chosen.orig_path.clone()
                } else {
                    let stem = chosen
                        .orig_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("recording");
                    unique_sibling_path(&prep.folder, stem, &prep.target_ext).await
                };
                new_export_enc = Some(
                    state
                        .config
                        .field_key
                        .encrypt(&dest_path.to_string_lossy()),
                );
                new_export_sha256 = prep.staged_sha256.clone();
                if dest_path != chosen.orig_path {
                    created_sibling_export = Some(dest_path.clone());
                    paths_to_unlink_in_lock.push(chosen.orig_path.clone());
                }
                for extra in &stable[1..] {
                    if extra.orig_path != dest_path {
                        paths_to_unlink_in_lock.push(extra.orig_path.clone());
                    }
                }
                export_rename_plan = Some((prep.staged.path().to_path_buf(), dest_path));
            }
        }

        let mut had_oah_in_tx = false;
        for &pos in &existing_positions {
            let ChainSegment::Existing(anchor) = &segs[pos] else {
                unreachable!();
            };
            let has_work: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND user_id = ? AND source = 'openaudiohub') \
                 OR EXISTS (SELECT 1 FROM jobs WHERE recording_id = ? AND user_id = ? AND kind IN ('transcribe', 'pipeline') AND state IN ('queued', 'running', 'done'))",
            )
            .bind(&anchor.id)
            .bind(user_id)
            .bind(&anchor.id)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
            had_oah_in_tx |= has_work;
        }
        let had_oah_work = had_prior_oah_pre || had_oah_in_tx;

        let cur_survivor = &current_rows[&survivor.id];
        let new_start_time = merged_parts
            .first()
            .map(|p| p.start_time)
            .unwrap_or(cur_survivor.start_time);
        let new_end_time = merged_parts
            .iter()
            .map(|p| p.end_time)
            .max()
            .unwrap_or(cur_survivor.end_time);
        let new_total_duration: i64 = merged_parts
            .iter()
            .map(|p| p.plaud_duration_ms.max(0))
            .fold(0i64, i64::saturating_add);

        // Preserve user/AI title; adopt manual title from an absorbed anchor if survivor is auto-named;
        // refresh date/original title when a late prepend shifts the leading part.
        let mut new_filename = cur_survivor.filename.clone();
        let mut new_title_source = cur_survivor.title_source.clone();
        if !matches!(new_title_source.as_str(), "manual" | "ai") {
            if let Some(manual_row) = absorbed_anchors
                .iter()
                .map(|a| &current_rows[&a.id])
                .find(|r| r.title_source == "manual")
            {
                new_filename = manual_row.filename.clone();
                new_title_source = "manual".to_owned();
            } else if new_title_source == "date" {
                if let Some(day) = leading_date_title.as_deref() {
                    new_filename = state.config.field_key.encrypt(day);
                }
            } else if new_title_source == "original"
                && let Some(first_new) = leading_new_rec.as_ref()
            {
                let plaud_name = first_new
                    .filename
                    .clone()
                    .filter(|f| !f.trim().is_empty())
                    .unwrap_or_else(|| first_new.id.clone());
                new_filename = state.config.field_key.encrypt(&plaud_name);
            }
        }

        let merged_starred = cur_survivor.starred_at.or_else(|| {
            absorbed_anchors
                .iter()
                .filter_map(|a| current_rows[&a.id].starred_at)
                .min()
        });
        let merged_eligible = if cur_survivor.auto_export_eligible != 0
            || absorbed_anchors
                .iter()
                .any(|a| current_rows[&a.id].auto_export_eligible != 0)
        {
            1i64
        } else {
            0i64
        };

        let mut superseded_pipeline_ids: Vec<String> = Vec::new();

        // Execute all SQL mutations before renaming the staged desktop export so any DB error rolls back cleanly.
        // First capture/supersede active pipeline runs across survivor and absorbed anchors before
        // hard-deleting absorbed rows so `.pipeline/<job_id>` scratch dirs are still cleaned up.
        for &pos in &existing_positions {
            let ChainSegment::Existing(anchor) = &segs[pos] else {
                unreachable!();
            };
            sqlx::query(
                "INSERT INTO pipeline_runs (job_id, phase, updated_at) \
                 SELECT id, 'cancelled', ? FROM jobs \
                 WHERE kind = 'pipeline' AND recording_id = ? AND user_id = ? AND state IN ('queued', 'running') \
                 ON CONFLICT (job_id) DO UPDATE SET phase = 'cancelled', updated_at = excluded.updated_at \
                 WHERE pipeline_runs.phase NOT IN ('cancelled', 'completed', 'needs_alignment', 'failed')",
            )
            .bind(now)
            .bind(&anchor.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
            let ids_for_anchor: Vec<String> = sqlx::query_scalar(
                "UPDATE jobs SET \
                   state = CASE \
                     WHEN (SELECT phase FROM pipeline_runs WHERE job_id = jobs.id) IN ('completed', 'needs_alignment') THEN 'done' \
                     WHEN (SELECT phase FROM pipeline_runs WHERE job_id = jobs.id) = 'failed' THEN 'failed' \
                     ELSE 'cancelled' \
                   END, \
                   progress = CASE \
                     WHEN (SELECT phase FROM pipeline_runs WHERE job_id = jobs.id) IN ('completed', 'needs_alignment') THEN 1 \
                     ELSE progress \
                   END, \
                   finished_at = ?, lease_until = NULL, updated_at = ? \
                 WHERE kind = 'pipeline' AND recording_id = ? AND user_id = ? \
                   AND state IN ('queued', 'running') \
                 RETURNING id",
            )
            .bind(now)
            .bind(now)
            .bind(&anchor.id)
            .bind(user_id)
            .fetch_all(&mut *tx)
            .await?;
            superseded_pipeline_ids.extend(ids_for_anchor);
        }

        // Preserve Ask AI chat history from absorbed recordings before hard-deleting them.
        if !absorbed_anchors.is_empty() {
            let mut survivor_chat: Option<(String, i64)> = sqlx::query_as(
                "SELECT c.id, COALESCE((SELECT MAX(t.seq) FROM recording_chat_turns t WHERE t.chat_id = c.id), 0) \
                 FROM recording_chats c WHERE c.recording_id = ? AND c.user_id = ?",
            )
            .bind(&survivor.id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;

            for absorbed in &absorbed_anchors {
                let absorbed_chat: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM recording_chats WHERE recording_id = ? AND user_id = ?",
                )
                .bind(&absorbed.id)
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await?;
                let Some(abs_chat_id) = absorbed_chat else {
                    continue;
                };

                sqlx::query(
                    "UPDATE recording_chat_turns SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, \
                            finished_at = COALESCE(finished_at, ?), updated_at = ? \
                     WHERE chat_id = ? AND status IN ('pending', 'running')",
                )
                .bind(now)
                .bind(now)
                .bind(&abs_chat_id)
                .execute(&mut *tx)
                .await?;

                if let Some((ref surv_chat_id, ref mut max_seq)) = survivor_chat {
                    let turn_rows: Vec<(String, String)> = sqlx::query_as(
                        "SELECT id, request_id FROM recording_chat_turns WHERE chat_id = ? ORDER BY seq ASC, created_at ASC",
                    )
                    .bind(&abs_chat_id)
                    .fetch_all(&mut *tx)
                    .await?;
                    for (turn_id, req_id) in turn_rows {
                        *max_seq += 1;
                        let conflict: bool = sqlx::query_scalar(
                            "SELECT EXISTS (SELECT 1 FROM recording_chat_turns WHERE chat_id = ? AND request_id = ?)",
                        )
                        .bind(surv_chat_id)
                        .bind(&req_id)
                        .fetch_one(&mut *tx)
                        .await?;
                        let final_req_id = if conflict {
                            format!("{req_id}-merged-{}", ids::token_hex(4))
                        } else {
                            req_id
                        };
                        sqlx::query(
                            "UPDATE recording_chat_turns \
                             SET chat_id = ?, recording_id = ?, seq = ?, request_id = ?, updated_at = ? \
                             WHERE id = ?",
                        )
                        .bind(surv_chat_id)
                        .bind(&survivor.id)
                        .bind(*max_seq)
                        .bind(&final_req_id)
                        .bind(now)
                        .bind(&turn_id)
                        .execute(&mut *tx)
                        .await?;
                    }
                    sqlx::query(
                        "UPDATE OR IGNORE recording_chat_chunks SET recording_id = ? \
                         WHERE recording_id = ? AND user_id = ?",
                    )
                    .bind(&survivor.id)
                    .bind(&absorbed.id)
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "UPDATE recording_chats SET generation = generation + 1, updated_at = ? WHERE id = ?",
                    )
                    .bind(now)
                    .bind(surv_chat_id)
                    .execute(&mut *tx)
                    .await?;
                } else {
                    sqlx::query(
                        "UPDATE recording_chats SET recording_id = ?, generation = generation + 1, updated_at = ? \
                         WHERE id = ?",
                    )
                    .bind(&survivor.id)
                    .bind(now)
                    .bind(&abs_chat_id)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "UPDATE recording_chat_turns SET recording_id = ?, updated_at = ? WHERE chat_id = ?",
                    )
                    .bind(&survivor.id)
                    .bind(now)
                    .bind(&abs_chat_id)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query(
                        "UPDATE OR IGNORE recording_chat_chunks SET recording_id = ? \
                         WHERE recording_id = ? AND user_id = ?",
                    )
                    .bind(&survivor.id)
                    .bind(&absorbed.id)
                    .bind(user_id)
                    .execute(&mut *tx)
                    .await?;
                    let new_max: i64 = sqlx::query_scalar(
                        "SELECT COALESCE(MAX(seq), 0) FROM recording_chat_turns WHERE chat_id = ?",
                    )
                    .bind(&abs_chat_id)
                    .fetch_one(&mut *tx)
                    .await?;
                    survivor_chat = Some((abs_chat_id, new_max));
                }
            }
        }

        // Hard-delete absorbed secondary recording rows BEFORE updating survivor so no duplicate
        // rows remain in SQLite `recordings` and no `UNIQUE (user_id, plaud_file_id)` collision can
        // occur; foreign-key `ON DELETE CASCADE` removes their stale parts, jobs, and transcripts.
        for absorbed in &absorbed_anchors {
            sqlx::query("DELETE FROM recordings WHERE id = ? AND user_id = ?")
                .bind(&absorbed.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }

        // Clear survivor's previous parts, active transcribe/summary jobs, and stale partial content.
        sqlx::query("DELETE FROM plaud_recording_parts WHERE user_id = ? AND recording_id = ?")
            .bind(user_id)
            .bind(&survivor.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ? \
             WHERE kind = 'transcribe' AND recording_id = ? AND user_id = ? AND state IN ('queued', 'running')",
        )
        .bind(now)
        .bind(now)
        .bind(&survivor.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ? \
             WHERE kind = 'summary' AND recording_id = ? AND user_id = ? AND state = 'queued'",
        )
        .bind(now)
        .bind(now)
        .bind(&survivor.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM transcriptions WHERE recording_id = ? AND user_id = ?")
            .bind(&survivor.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ? AND user_id = ?")
            .bind(&survivor.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;

        // Align survivor.plaud_file_id with chronological part 0 whenever unoccupied.
        let (new_plaud_file_id, new_plaud_version) = match merged_parts.first() {
            Some(first_part) if first_part.plaud_file_id != cur_survivor.plaud_file_id => {
                let conflict: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM recordings WHERE user_id = ? AND plaud_file_id = ? AND id <> ?)",
                )
                .bind(user_id)
                .bind(&first_part.plaud_file_id)
                .bind(&survivor.id)
                .fetch_one(&mut *tx)
                .await?;
                if conflict {
                    (
                        cur_survivor.plaud_file_id.clone(),
                        cur_survivor.plaud_version.clone(),
                    )
                } else {
                    (
                        first_part.plaud_file_id.clone(),
                        first_part.plaud_version.clone(),
                    )
                }
            }
            _ => (
                cur_survivor.plaud_file_id.clone(),
                cur_survivor.plaud_version.clone(),
            ),
        };

        sqlx::query(
            "UPDATE recordings SET plaud_file_id = ?, plaud_version = ?, filename = ?, title_source = ?, \
             duration = ?, start_time = ?, end_time = ?, filesize = ?, file_md5 = ?, \
             storage_type = ?, storage_path = ?, downloaded_at = ?, waveform_peaks = ?, \
             starred_at = ?, auto_export_eligible = ?, \
             auto_export_path = COALESCE(?, auto_export_path), \
             auto_export_sha256 = COALESCE(?, auto_export_sha256), auto_export_target = NULL, \
             auto_export_attempts = 0, updated_at = ? \
             WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(&new_plaud_file_id)
        .bind(&new_plaud_version)
        .bind(&new_filename)
        .bind(&new_title_source)
        .bind(new_total_duration)
        .bind(new_start_time)
        .bind(new_end_time)
        .bind(new_storage.byte_len)
        .bind(new_storage.file_md5.as_str())
        .bind(new_storage.storage_type)
        .bind(new_storage.key.as_str())
        .bind(now)
        .bind(peaks_json)
        .bind(merged_starred)
        .bind(merged_eligible)
        .bind(new_export_enc)
        .bind(new_export_sha256)
        .bind(now)
        .bind(&survivor.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

        for (idx, part) in merged_parts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, \
                 start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(user_id)
            .bind(&part.plaud_file_id)
            .bind(&survivor.id)
            .bind(idx as i64)
            .bind(part.start_time)
            .bind(part.end_time)
            .bind(part.plaud_duration_ms)
            .bind(part.audio_duration_ms)
            .bind(&part.plaud_version)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }

        let settle_ids: Vec<&str> = merged_parts
            .iter()
            .map(|p| p.plaud_file_id.as_str())
            .collect();
        clear_settle_ids_in(&mut *tx, user_id, &settle_ids, now).await?;

        // Rename staged desktop export only after every SQL mutation in the transaction succeeded.
        if let Some((src, dest)) = export_rename_plan {
            if let Err(e) = tokio::fs::rename(&src, &dest).await {
                tracing::warn!(
                    recording = %survivor.id,
                    error = %e,
                    "atomic replacement of desktop auto-export failed; rolling back split consolidation"
                );
                tx.rollback().await?;
                return Err(sqlx::Error::Io(e));
            }
            if let Some(prep) = prepared_export.as_mut() {
                prep.staged.disarm();
            }
        }

        if let Err(e) = tx.commit().await {
            if let Some(sibling) = created_sibling_export {
                let _ = tokio::fs::remove_file(sibling).await;
            }
            return Err(e);
        }

        // Unlink obsolete/duplicate export paths before releasing `local_folder::lock()` so a
        // watcher sharing `autoExportFolder == localStorageFolder` cannot import them as duplicates.
        for old_export in paths_to_unlink_in_lock {
            let _ = tokio::fs::remove_file(old_export).await;
        }

        let old_storage_objects: Vec<(String, String)> = existing_positions
            .iter()
            .map(|&pos| match &segs[pos] {
                ChainSegment::Existing(a) => (a.storage_type.clone(), a.storage_path.clone()),
                ChainSegment::New(_) => unreachable!(),
            })
            .collect();

        Ok(CommitAction::Committed {
            had_oah_work,
            superseded_pipeline_ids,
            old_storage_objects,
        })
    }
    .await;

    // Ensure any unrenamed staged export temp is unlinked immediately.
    drop(prepared_export);

    match action {
        Ok(CommitAction::Committed {
            had_oah_work,
            superseded_pipeline_ids,
            old_storage_objects,
        }) => {
            for (kind, path) in old_storage_objects {
                if let Err(e) = state.storage.delete(&kind, &path).await {
                    tracing::warn!(recording = %survivor.id, error = %e, "deleting superseded split audio failed");
                }
            }
            for job_id in superseded_pipeline_ids {
                let _ = tokio::fs::remove_dir_all(
                    state.config.storage_root.join(".pipeline").join(job_id),
                )
                .await;
            }
            Ok(AppendOutcome::Updated {
                recording_id: survivor.id.clone(),
                had_oah_work,
            })
        }
        Ok(CommitAction::SingleAnchorDeletedConcurrently) => {
            let _ = state
                .storage
                .delete(new_storage.storage_type, &new_storage.key)
                .await;
            // Tombstone only genuine 5-hour forced-split continuations/predecessors of the deleted
            // anchor. Unrelated same-day recordings stay un-tombstoned so they import on the next sync.
            let survivor_head = LinkMeta {
                device_sn: survivor.device_sn.as_str(),
                start_time: survivor.first_start_time,
                end_time: effective_end(
                    survivor.first_start_time,
                    survivor.first_end_time,
                    survivor.first_plaud_duration_ms,
                ),
                duration_ms: survivor.first_plaud_duration_ms,
            };
            let survivor_tail = LinkMeta {
                device_sn: survivor.device_sn.as_str(),
                start_time: survivor.last_start_time,
                end_time: effective_end(
                    survivor.last_start_time,
                    survivor.last_end_time,
                    survivor.last_plaud_duration_ms,
                ),
                duration_ms: survivor.last_plaud_duration_ms,
            };
            let mut split_related: Vec<&Recording> = Vec::new();
            for part in &new_parts {
                let p_start = part.start_time.unwrap_or(0);
                let p_dur = part.duration.unwrap_or(0);
                let p_meta = LinkMeta {
                    device_sn: part.serial_number.as_deref().unwrap_or(""),
                    start_time: p_start,
                    end_time: effective_end(p_start, part.end_time.unwrap_or(0), p_dur),
                    duration_ms: p_dur,
                };
                if can_link(survivor_tail, p_meta) || can_link(p_meta, survivor_head) {
                    split_related.push(part);
                }
            }
            if !split_related.is_empty() {
                let mut tx = crate::db::begin_write(&state.db).await?;
                let max_idx: i64 = sqlx::query_scalar(
                    "SELECT COALESCE(MAX(part_index), 0) FROM plaud_recording_parts WHERE recording_id = ?",
                )
                .bind(&survivor.id)
                .fetch_one(&mut *tx)
                .await?;
                for (next_idx, part) in (max_idx + 1..).zip(split_related.iter()) {
                    let audio_ms = new_part_audio_ms
                        .get(&part.id)
                        .copied()
                        .unwrap_or_else(|| part.duration.unwrap_or(0));
                    let p_dur = part_effective_plaud_ms(part, audio_ms);
                    let p_start = part.start_time.unwrap_or(0);
                    let p_end = effective_end(p_start, part.end_time.unwrap_or(0), p_dur);
                    sqlx::query(
                        "INSERT OR IGNORE INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, \
                         start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(user_id)
                    .bind(&part.id)
                    .bind(&survivor.id)
                    .bind(next_idx)
                    .bind(p_start)
                    .bind(p_end)
                    .bind(p_dur)
                    .bind(audio_ms)
                    .bind(version_text(part))
                    .bind(now)
                    .bind(now)
                    .execute(&mut *tx)
                    .await?;
                }
                let settle_ids: Vec<&str> = split_related.iter().map(|p| p.id.as_str()).collect();
                clear_settle_ids_in(&mut *tx, user_id, &settle_ids, now).await?;
                tx.commit().await?;
            }
            Ok(AppendOutcome::Tombstoned)
        }
        Ok(CommitAction::MissingOrDeletedAnchor) => {
            let _ = state
                .storage
                .delete(new_storage.storage_type, &new_storage.key)
                .await;
            Ok(AppendOutcome::Tombstoned)
        }
        Ok(CommitAction::StorageChanged) => {
            let _ = state
                .storage
                .delete(new_storage.storage_type, &new_storage.key)
                .await;
            Err(ItemError::Failed(
                "recording audio changed while consolidating split parts".into(),
            ))
        }
        Err(e) => {
            let _ = state
                .storage
                .delete(new_storage.storage_type, &new_storage.key)
                .await;
            Err(e.into())
        }
    }
}

/// Checks whether a set of collected new items still has an unlinked ~5h item whose predecessor
/// could live on a subsequent page.
pub(crate) fn has_open_split_head(anchors: &[DbAnchor], new_items: &[Recording]) -> bool {
    let mut ceiling_starts = HashSet::new();
    for r in new_items {
        if is_split_ceiling_duration(r.duration.unwrap_or(0))
            && let Some(st) = r.start_time.filter(|&t| t > 0)
        {
            ceiling_starts.insert(st);
        }
    }
    if ceiling_starts.is_empty() {
        return false;
    }
    // If any ~5h item does not yet have a predecessor among collected items or anchors, keep paging.
    let plans = plan_chains(anchors, new_items.to_vec());
    plans.iter().any(|p| match p {
        ChainPlan::Single(r) => is_split_ceiling_duration(r.duration.unwrap_or(0)),
        ChainPlan::NewMulti(parts) => parts
            .first()
            .is_some_and(|r| is_split_ceiling_duration(r.duration.unwrap_or(0))),
        ChainPlan::Consolidate(segs) => matches!(
            segs.first(),
            Some(ChainSegment::New(r)) if is_split_ceiling_duration(r.duration.unwrap_or(0))
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIVE_HOURS: i64 = 18_000_000;
    const TWO_HOURS: i64 = 7_200_000;
    const BASE_START: i64 = 1_768_000_000_000;

    fn rec(id: &str, sn: Option<&str>, start: i64, dur: i64) -> Recording {
        Recording {
            id: id.into(),
            filename: Some(id.into()),
            duration: Some(dur),
            start_time: Some(start),
            end_time: Some(start + dur),
            filesize: None,
            file_md5: None,
            serial_number: sn.map(str::to_owned),
            version_ms: Some(100),
            timezone: None,
            zonemins: None,
            scene: None,
            edit_time: Some(start),
            is_v4: true,
        }
    }

    fn anchor(id: &str, plaud_id: &str, sn: &str, start: i64, dur: i64) -> DbAnchor {
        DbAnchor {
            id: id.into(),
            device_sn: sn.into(),
            plaud_file_id: plaud_id.into(),
            duration: dur,
            filesize: 1024,
            storage_type: "local".into(),
            storage_path: format!("u1/{plaud_id}.ogg"),
            auto_export_path: None,
            auto_export_sha256: None,
            first_start_time: start,
            first_end_time: start + dur,
            first_plaud_duration_ms: dur,
            last_start_time: start,
            last_end_time: start + dur,
            last_plaud_duration_ms: dur,
        }
    }

    #[test]
    fn groups_three_part_chain_in_chronological_order() {
        let p0 = rec("p0", Some("SN1"), BASE_START, FIVE_HOURS);
        let p1 = rec(
            "p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS + 2_000,
            FIVE_HOURS,
        );
        let p2 = rec(
            "p2",
            Some("SN1"),
            BASE_START + 2 * FIVE_HOURS + 5_000,
            TWO_HOURS,
        );
        // Feed in reverse order (as Plaud lists newest first).
        let plans = plan_chains(&[], vec![p2, p1, p0]);
        assert_eq!(plans.len(), 1);
        match &plans[0] {
            ChainPlan::NewMulti(parts) => {
                let ids: Vec<&str> = parts.iter().map(|p| p.id.as_str()).collect();
                assert_eq!(ids, vec!["p0", "p1", "p2"]);
            }
            other => panic!("expected NewMulti, got {other:?}"),
        }
        // Ends with a 2h tail -> no settle wait.
        assert!(settle_tip_id(&plans[0]).is_none());
    }

    #[test]
    fn enforces_ceiling_band_gap_bounds_and_device_sn() {
        // Non-ceiling predecessor (1h + 1h, 5s gap) must NOT merge.
        let short_a = rec("sa", Some("SN1"), BASE_START, 3_600_000);
        let short_b = rec("sb", Some("SN1"), BASE_START + 3_600_000 + 5_000, 3_600_000);
        assert_eq!(plan_chains(&[], vec![short_a, short_b]).len(), 2);

        // Gap > +60s must NOT merge.
        let p0 = rec("p0", Some("SN1"), BASE_START, FIVE_HOURS);
        let p1_late = rec(
            "p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS + 61_000,
            TWO_HOURS,
        );
        assert_eq!(plan_chains(&[], vec![p0.clone(), p1_late]).len(), 2);

        // Gap < -15s must NOT merge.
        let p1_early = rec(
            "p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS - 16_000,
            TWO_HOURS,
        );
        assert_eq!(plan_chains(&[], vec![p0.clone(), p1_early]).len(), 2);

        // Negative overlap within -15s..=0 DOES merge.
        let p1_overlap = rec(
            "p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS - 10_000,
            TWO_HOURS,
        );
        assert_eq!(plan_chains(&[], vec![p0.clone(), p1_overlap]).len(), 1);

        // Different serial numbers must NOT merge.
        let p1_other_sn = rec(
            "p1",
            Some("SN2"),
            BASE_START + FIVE_HOURS + 1_000,
            TWO_HOURS,
        );
        assert_eq!(plan_chains(&[], vec![p0.clone(), p1_other_sn]).len(), 2);

        // One empty serial and one non-empty serial must NOT merge.
        let p1_empty_sn = rec("p1", None, BASE_START + FIVE_HOURS + 1_000, TWO_HOURS);
        assert_eq!(plan_chains(&[], vec![p0, p1_empty_sn]).len(), 2);
    }

    #[test]
    fn empty_device_sn_merges_only_when_one_to_one_unique() {
        let p0 = rec("p0", None, BASE_START, FIVE_HOURS);
        let p1 = rec("p1", None, BASE_START + FIVE_HOURS + 3_000, TWO_HOURS);
        let unique = plan_chains(&[], vec![p0.clone(), p1.clone()]);
        assert_eq!(unique.len(), 1);
        assert!(matches!(unique[0], ChainPlan::NewMulti(_)));

        // Ambiguous fork: two candidate successors with empty serial -> neither merges.
        let p1_alt = rec("p1_alt", None, BASE_START + FIVE_HOURS + 4_000, TWO_HOURS);
        let ambiguous = plan_chains(&[], vec![p0, p1, p1_alt]);
        assert_eq!(ambiguous.len(), 3);
        assert!(ambiguous.iter().all(|p| matches!(p, ChainPlan::Single(_))));
    }

    #[test]
    fn enforces_24h_chain_cap() {
        // 5 x 5h = 25h -> first 4 parts (20h) merge; 5th part starts a new chain.
        let mut parts = Vec::new();
        for i in 0..5 {
            parts.push(rec(
                &format!("p{i}"),
                Some("SN1"),
                BASE_START + i * (FIVE_HOURS + 1_000),
                FIVE_HOURS,
            ));
        }
        let plans = plan_chains(&[], parts);
        assert_eq!(plans.len(), 2);
        match &plans[0] {
            ChainPlan::NewMulti(chain) => assert_eq!(chain.len(), 4),
            other => panic!("expected 4-part chain, got {other:?}"),
        }
        match &plans[1] {
            ChainPlan::Single(p) => assert_eq!(p.id, "p4"),
            other => panic!("expected Single(p4), got {other:?}"),
        }
    }

    #[test]
    fn links_late_part_chain_to_live_open_anchor() {
        let open = anchor("rec-1", "p0", "SN1", BASE_START, FIVE_HOURS);
        let p1 = rec(
            "p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS + 2_000,
            FIVE_HOURS,
        );
        let p2 = rec(
            "p2",
            Some("SN1"),
            BASE_START + 2 * FIVE_HOURS + 4_000,
            TWO_HOURS,
        );
        let plans = plan_chains(&[open], vec![p2, p1]);
        assert_eq!(plans.len(), 1);
        match &plans[0] {
            ChainPlan::Consolidate(segs) => {
                assert_eq!(segs.len(), 3);
                assert!(matches!(&segs[0], ChainSegment::Existing(a) if a.id == "rec-1"));
                assert!(matches!(&segs[1], ChainSegment::New(r) if r.id == "p1"));
                assert!(matches!(&segs[2], ChainSegment::New(r) if r.id == "p2"));
            }
            other => panic!("expected Consolidate, got {other:?}"),
        }
        // Ends with 2h tail -> immediate append with no settle wait.
        assert!(settle_tip_id(&plans[0]).is_none());
    }

    #[test]
    fn plans_late_prepend_late_bridge_and_existing_pair_consolidation() {
        // 1. Late Prepend: Part 2 (2h) arrived first in DB, Part 1 (5h) arrives later.
        let existing_p2 = anchor(
            "rec-p2",
            "p2",
            "SN1",
            BASE_START + FIVE_HOURS + 960,
            TWO_HOURS,
        );
        let new_p1 = rec("p1", Some("SN1"), BASE_START, FIVE_HOURS);
        let prepend = plan_chains(std::slice::from_ref(&existing_p2), vec![new_p1]);
        assert_eq!(prepend.len(), 1);
        match &prepend[0] {
            ChainPlan::Consolidate(segs) => {
                assert_eq!(segs.len(), 2);
                assert!(matches!(&segs[0], ChainSegment::New(r) if r.id == "p1"));
                assert!(matches!(&segs[1], ChainSegment::Existing(a) if a.id == "rec-p2"));
            }
            other => panic!("expected Consolidate prepend, got {other:?}"),
        }
        // Final segment is already in DB -> consolidate immediately without settle wait.
        assert!(settle_tip_id(&prepend[0]).is_none());

        // 2. Late Bridge: Part 1 (5h) and Part 3 (2h) already in DB, Part 2 (5h) arrives in between.
        let existing_p1 = anchor("rec-p1", "p1", "SN1", BASE_START, FIVE_HOURS);
        let existing_p3 = anchor(
            "rec-p3",
            "p3",
            "SN1",
            BASE_START + 2 * FIVE_HOURS + 4_000,
            TWO_HOURS,
        );
        let new_p2 = rec(
            "p2",
            Some("SN1"),
            BASE_START + FIVE_HOURS + 2_000,
            FIVE_HOURS,
        );
        let bridge = plan_chains(&[existing_p3, existing_p1.clone()], vec![new_p2]);
        assert_eq!(bridge.len(), 1);
        match &bridge[0] {
            ChainPlan::Consolidate(segs) => {
                assert_eq!(segs.len(), 3);
                assert!(matches!(&segs[0], ChainSegment::Existing(a) if a.id == "rec-p1"));
                assert!(matches!(&segs[1], ChainSegment::New(r) if r.id == "p2"));
                assert!(matches!(&segs[2], ChainSegment::Existing(a) if a.id == "rec-p3"));
            }
            other => panic!("expected Consolidate bridge, got {other:?}"),
        }
        assert!(settle_tip_id(&bridge[0]).is_none());

        // 3. Existing unmerged pair in DB with no new items -> consolidates immediately.
        let existing_pair = plan_chains(&[existing_p2, existing_p1], vec![]);
        assert_eq!(existing_pair.len(), 1);
        match &existing_pair[0] {
            ChainPlan::Consolidate(segs) => {
                assert_eq!(segs.len(), 2);
                assert!(matches!(&segs[0], ChainSegment::Existing(a) if a.id == "rec-p1"));
                assert!(matches!(&segs[1], ChainSegment::Existing(a) if a.id == "rec-p2"));
            }
            other => panic!("expected Consolidate existing pair, got {other:?}"),
        }
        assert!(settle_tip_id(&existing_pair[0]).is_none());
    }

    #[test]
    fn settle_tip_applies_only_to_ceiling_tips_below_24h() {
        let single_5h = ChainPlan::Single(Box::new(rec("p0", Some("SN1"), BASE_START, FIVE_HOURS)));
        assert_eq!(settle_tip_id(&single_5h), Some("p0"));

        let single_2h = ChainPlan::Single(Box::new(rec("p0", Some("SN1"), BASE_START, TWO_HOURS)));
        assert_eq!(settle_tip_id(&single_2h), None);

        let chain_ending_5h = ChainPlan::NewMulti(vec![
            rec("p0", Some("SN1"), BASE_START, FIVE_HOURS),
            rec(
                "p1",
                Some("SN1"),
                BASE_START + FIVE_HOURS + 1_000,
                FIVE_HOURS,
            ),
        ]);
        assert_eq!(settle_tip_id(&chain_ending_5h), Some("p1"));
    }

    #[test]
    fn lazy_hydration_skips_all_items_when_no_ceiling_or_anchor_exists() {
        let items = vec![
            rec("a", None, BASE_START, 3_000),
            rec("b", None, BASE_START + 5_000, 120_000),
        ];
        assert_eq!(needs_hydration_for_split(&items, &[]), vec![false, false]);
    }

    #[test]
    fn lazy_hydration_hydrates_all_v4_items_when_ceiling_or_missing_duration_or_anchor_exists() {
        // Ceiling item with missing start_time still triggers hydration for all v4 items.
        let mut no_start_ceiling = rec("p0", None, BASE_START, FIVE_HOURS);
        no_start_ceiling.start_time = None;
        no_start_ceiling.end_time = None;
        let skewed_succ = rec("p1", None, BASE_START - 86_400_000, TWO_HOURS);
        let mut legacy = rec("leg", None, BASE_START, 60_000);
        legacy.is_v4 = false;
        assert_eq!(
            needs_hydration_for_split(&[no_start_ceiling, skewed_succ.clone(), legacy], &[]),
            vec![true, true, false]
        );

        // Unknown duration item triggers hydration.
        let mut unknown_dur = rec("u", None, BASE_START, 0);
        unknown_dur.duration = None;
        assert_eq!(
            needs_hydration_for_split(&[unknown_dur, skewed_succ.clone()], &[]),
            vec![true, true]
        );

        // Open DB anchor triggers hydration even when new items are short tails.
        let open = anchor("rec-1", "p0", "SN1", BASE_START, FIVE_HOURS);
        assert_eq!(
            needs_hydration_for_split(&[skewed_succ], &[open]),
            vec![true]
        );
    }

    #[tokio::test]
    async fn desktop_export_update_rejects_modified_disabled_and_claimed_files_and_replaces_authentic_exports()
     {
        use axum::routing::get;
        use axum::{Json, Router};

        let dir = tempfile::tempdir().unwrap();
        let export_dir = dir.path().join("exports");
        tokio::fs::create_dir_all(&export_dir).await.unwrap();

        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        cfg.desktop = Some(crate::config::Desktop {
            launch_secret: "0123456789abcdef0123456789abcdef-launch".into(),
            user_id: None,
        });
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        let anchor_ogg = cfg.storage_root.join("u1/f_p0.ogg");
        let part2_ogg = dir.path().join("part2.ogg");
        for (out, freq) in [(&anchor_ogg, 440), (&part2_ogg, 660)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
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
            assert!(media::run(&mut cmd).await);
        }
        let orig_bytes = tokio::fs::read(&anchor_ogg).await.unwrap();
        let part2_bytes = tokio::fs::read(&part2_ogg).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let export_file = export_dir.join("meeting.ogg");
        tokio::fs::write(&export_file, b"user-edited-different-bytes")
            .await
            .unwrap();
        let enc_export = state
            .config
            .field_key
            .encrypt(&export_file.to_string_lossy());

        // Case 1: user-modified export file -> rejected (prepare returns None).
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(
                serde_json::json!({
                    "autoExport": true,
                    "autoExportFolder": export_dir.to_string_lossy(),
                    "autoExportFormat": "original",
                })
                .to_string(),
            )
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        let mut open = anchor("rec-exp", "f_p0", "SN1", BASE_START, FIVE_HOURS);
        open.storage_path = "u1/f_p0.ogg".into();
        open.auto_export_path = Some(enc_export.clone());

        let dummy_stored = import::Stored {
            storage_type: "local",
            key: "u1/f_p0.ogg".into(),
            peaks: None,
            byte_len: orig_bytes.len() as i64,
            file_md5: "abc".into(),
            remuxed: true,
        };
        assert!(
            prepare_desktop_export_consolidation(
                &state,
                "u1",
                &open.id,
                &[(&open, anchor_ogg.as_path())],
                &dummy_stored,
                "ogg"
            )
            .await
            .is_none(),
            "modified export must not be overwritten"
        );

        // Restore exact anchor bytes, then test autoExport: false -> rejected.
        tokio::fs::write(&export_file, &orig_bytes).await.unwrap();
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u1'")
            .bind(
                serde_json::json!({
                    "autoExport": false,
                    "autoExportFolder": export_dir.to_string_lossy(),
                    "autoExportFormat": "original",
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();
        assert!(
            prepare_desktop_export_consolidation(
                &state,
                "u1",
                &open.id,
                &[(&open, anchor_ogg.as_path())],
                &dummy_stored,
                "ogg"
            )
            .await
            .is_none(),
            "disabled autoExport must not replace file"
        );

        // Re-enable autoExport, but claim the same export path with another live recording -> rejected.
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u1'")
            .bind(
                serde_json::json!({
                    "autoExport": true,
                    "autoExportFolder": export_dir.to_string_lossy(),
                    "autoExportFormat": "original",
                })
                .to_string(),
            )
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-other', 'u1', 'SN2', 'other1', 't', 1000, 1000, 2000, 10, 'x', 'local', 'u1/other.ogg', ?, '1', 0, ?, ?, 'original')",
        )
        .bind(&enc_export)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        assert!(
            prepare_desktop_export_consolidation(
                &state,
                "u1",
                &open.id,
                &[(&open, anchor_ogg.as_path())],
                &dummy_stored,
                "ogg"
            )
            .await
            .is_none(),
            "export path claimed by another live recording must not be overwritten"
        );
        sqlx::query("DELETE FROM recordings WHERE id = 'rec-other'")
            .execute(&state.db)
            .await
            .unwrap();

        // Case 2: authentic lossless export + active racing pipeline & queued summary job ->
        // late append atomically replaces export, supersedes pipeline job, cancels summary job.
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-exp', 'u1', 'SN1', 'f_p0', 't', ?, ?, ?, ?, 'origmd5', 'local', 'u1/f_p0.ogg', ?, '1', 0, ?, ?, 'original')",
        )
        .bind(FIVE_HOURS)
        .bind(BASE_START)
        .bind(BASE_START + FIVE_HOURS)
        .bind(orig_bytes.len() as i64)
        .bind(&enc_export)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at) \
             VALUES ('job-sum', 'summary', 'u1', 'rec-exp', 'queued', '{}', 0, ?, ?)",
        )
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let dl_url = format!("{base}/dl/p1");
        let app =
            Router::new()
                .route(
                    "/file/temp-url/f_p1",
                    get({
                        let dl_url = dl_url.clone();
                        move || async move {
                            Json(serde_json::json!({ "status": 0, "temp_url": dl_url }))
                        }
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

        let mut p1 = rec(
            "f_p1",
            Some("SN1"),
            BASE_START + FIVE_HOURS + 3_000,
            TWO_HOURS,
        );
        p1.is_v4 = false;
        let client = Client::new(&base, "tok");
        let out = execute_consolidate(
            &state,
            "u1",
            &client,
            &[ChainSegment::Existing(open), ChainSegment::New(p1)],
        )
        .await
        .unwrap();
        assert!(matches!(out, AppendOutcome::Updated { .. }));

        // Exported file was replaced atomically with the ~2-second combined audio.
        let probed = media::probe(&state.config.ffprobe, &export_file)
            .await
            .unwrap();
        assert!(probed.duration_ms >= 1800, "got {}ms", probed.duration_ms);
        let sum_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = 'job-sum'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(sum_state, "cancelled");
    }

    #[tokio::test]
    async fn existing_pair_consolidation_heals_dual_exports_in_shared_local_storage_folder() {
        let dir = tempfile::tempdir().unwrap();
        let shared_dir = dir.path().join("Lifelog");
        tokio::fs::create_dir_all(&shared_dir).await.unwrap();

        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        cfg.desktop = Some(crate::config::Desktop {
            launch_secret: "0123456789abcdef0123456789abcdef-launch".into(),
            user_id: None,
        });
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        let p1_stored = cfg.storage_root.join("u1/f_part1.ogg");
        let p2_stored = cfg.storage_root.join("u1/f_part2.ogg");
        for (out, freq) in [(&p1_stored, 440), (&p2_stored, 660)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
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
            assert!(media::run(&mut cmd).await);
        }
        let p1_bytes = tokio::fs::read(&p1_stored).await.unwrap();
        let p2_bytes = tokio::fs::read(&p2_stored).await.unwrap();

        // Simulate out-of-order upload: Part 2 arrived first -> exported as `2026-11-24.ogg`;
        // Part 1 arrived 10 min later -> exported as `2026-11-24 (2).ogg`.
        let p2_export = shared_dir.join("2026-11-24.ogg");
        let p1_export = shared_dir.join("2026-11-24 (2).ogg");
        tokio::fs::write(&p2_export, &p2_bytes).await.unwrap();
        tokio::fs::write(&p1_export, &p1_bytes).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(
                serde_json::json!({
                    "autoExport": true,
                    "autoExportFolder": shared_dir.to_string_lossy(),
                    "autoExportFormat": "original",
                    "localStorageFolder": shared_dir.to_string_lossy(),
                })
                .to_string(),
            )
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let enc_p1_exp = state.config.field_key.encrypt(&p1_export.to_string_lossy());
        let enc_p2_exp = state.config.field_key.encrypt(&p2_export.to_string_lossy());
        let enc_date = state.config.field_key.encrypt("2026-11-24");

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-p1', 'u1', 'SN-PIN', 'f_part1', ?, ?, ?, ?, ?, 'md51', 'local', 'u1/f_part1.ogg', ?, '10', 0, ?, ?, 'date')",
        )
        .bind(&enc_date)
        .bind(FIVE_HOURS)
        .bind(BASE_START)
        .bind(BASE_START + FIVE_HOURS)
        .bind(p1_bytes.len() as i64)
        .bind(&enc_p1_exp)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-p2', 'u1', 'SN-PIN', 'f_part2', ?, ?, ?, ?, ?, 'md52', 'local', 'u1/f_part2.ogg', ?, '11', 0, ?, ?, 'date')",
        )
        .bind(&enc_date)
        .bind(TWO_HOURS)
        .bind(BASE_START + FIVE_HOURS + 960)
        .bind(BASE_START + FIVE_HOURS + 960 + TWO_HOURS)
        .bind(p2_bytes.len() as i64)
        .bind(&enc_p2_exp)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let open_tails = load_open_tail_anchors(&state, "u1").await.unwrap();
        assert_eq!(open_tails.len(), 1);
        assert_eq!(open_tails[0].id, "rec-p1");

        let all_anchors = load_candidate_anchors(&state, "u1", open_tails, &[])
            .await
            .unwrap();
        assert_eq!(all_anchors.len(), 2);

        let plans = plan_chains(&all_anchors, vec![]);
        assert_eq!(plans.len(), 1);
        let ChainPlan::Consolidate(segs) = &plans[0] else {
            panic!("expected Consolidate plan");
        };

        let client = Client::new("http://127.0.0.1:1", "unused");
        let out = execute_consolidate(&state, "u1", &client, segs)
            .await
            .unwrap();
        assert!(matches!(
            out,
            AppendOutcome::Updated { ref recording_id, .. } if recording_id == "rec-p1"
        ));

        // Only 1 row total remains in SQLite `recordings` (absorbed row is hard-deleted, not
        // left behind as a soft-deleted duplicate), with combined duration and both parts registered.
        let total_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE user_id = 'u1'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            total_rows, 1,
            "absorbed secondary row must be hard-deleted from recordings"
        );
        let live_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM recordings WHERE user_id = 'u1' AND deleted_at IS NULL",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(live_count, 1);

        let part_ids: Vec<String> = sqlx::query_scalar(
            "SELECT plaud_file_id FROM plaud_recording_parts WHERE recording_id = 'rec-p1' ORDER BY part_index ASC",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(part_ids, vec!["f_part1", "f_part2"]);

        // Clean un-numbered `2026-11-24.ogg` holds the ~2s merged audio; `2026-11-24 (2).ogg` is removed;
        // both superseded internal storage files are cleaned up.
        assert!(p2_export.exists());
        assert!(
            !p1_export.exists(),
            "duplicate numbered export must be removed"
        );
        assert!(!p1_stored.exists(), "old part1 storage must be removed");
        assert!(!p2_stored.exists(), "old part2 storage must be removed");
        let probed = media::probe(&state.config.ffprobe, &p2_export)
            .await
            .unwrap();
        assert!(probed.duration_ms >= 1800, "got {}ms", probed.duration_ms);

        // Local folder sync over the shared folder must NOT import any duplicate recording.
        let user_settings = settings::effective(&state, "u1").await.unwrap();
        let report =
            crate::local_folder::sync_user(&state, "u1", &shared_dir, &user_settings, true)
                .await
                .unwrap();
        assert_eq!(report.synced, 0, "no duplicate import in shared folder");
        assert_eq!(report.removed, 0);
    }

    #[tokio::test]
    async fn settle_window_defers_until_elapsed_and_prunes_expired_rows() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            crate::Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        let t0 = 1_768_000_000_000i64;
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(t0)
            .bind(t0)
            .execute(&state.db)
            .await
            .unwrap();
        // Seed an expired row (>7d old) to verify opportunistic pruning.
        sqlx::query("INSERT INTO plaud_split_settle (user_id, plaud_file_id, first_seen_at) VALUES ('u1', 'old_tip', ?)")
            .bind(t0 - SETTLE_PRUNE_AGE_MS - 1_000)
            .execute(&state.db)
            .await
            .unwrap();

        assert!(
            should_defer_tip(&state, "u1", "p0", t0, 270_000)
                .await
                .unwrap()
        );
        let old_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM plaud_split_settle WHERE plaud_file_id = 'old_tip'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(old_count, 0, "expired settle row pruned");

        assert!(
            should_defer_tip(&state, "u1", "p0", t0 + 269_999, 270_000)
                .await
                .unwrap()
        );
        assert!(
            !should_defer_tip(&state, "u1", "p0", t0 + 270_000, 270_000)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn concat_three_tiers_produce_playable_audio_with_combined_duration() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(&cfg.storage_root).await.unwrap();
        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());

        // Generate two 1-second Ogg/Opus files and one 1-second MP3 file using ffmpeg.
        let ogg1 = dir.path().join("a.ogg");
        let ogg2 = dir.path().join("b.ogg");
        let mp3 = dir.path().join("c.mp3");
        for (out, codec, fmt, freq) in [
            (&ogg1, "libopus", "ogg", 440),
            (&ogg2, "libopus", "ogg", 880),
            (&mp3, "libmp3lame", "mp3", 660),
        ] {
            let mut cmd = Command::new(&state.config.ffmpeg);
            cmd.args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={freq}:duration=1"),
                "-c:a",
                codec,
                "-f",
                fmt,
            ])
            .arg(out);
            assert!(
                media::run(&mut cmd).await,
                "ffmpeg generated {}",
                out.display()
            );
        }

        // Tier 2: stream-copy concat of two Ogg/Opus containers.
        let t2 = concat_audio_files(&state, "u1", &[ogg1.clone(), ogg2.clone()], false)
            .await
            .unwrap();
        assert_eq!(t2.ext, "ogg");
        let p2 = media::probe(&state.config.ffprobe, t2.temp.path())
            .await
            .unwrap();
        assert!(p2.duration_ms >= 1800, "got {}ms", p2.duration_ms);
        assert_eq!(t2.input_durations_ms.len(), 2);

        // Tier 3: mixed MP3 + Ogg/Opus falls back to libopus Ogg.
        let t3 = concat_audio_files(&state, "u1", &[mp3, ogg1], false)
            .await
            .unwrap();
        assert_eq!(t3.ext, "ogg");
        let p3 = media::probe(&state.config.ffprobe, t3.temp.path())
            .await
            .unwrap();
        assert!(p3.duration_ms >= 1800, "got {}ms", p3.duration_ms);
        assert_eq!(p3.codec, "opus");
    }

    #[test]
    fn plan_daily_chains_groups_same_day_chronologically_handles_midnight_splits_and_24h_cap() {
        const HOUR: i64 = 3_600_000;
        const DAY1_09: i64 = 1_785_661_200_000; // 2026-08-02T09:00:00Z
        const DAY1_15: i64 = DAY1_09 + 6 * HOUR; // 2026-08-02T15:00:00Z
        const DAY1_21: i64 = DAY1_09 + 12 * HOUR; // 2026-08-02T21:00:00Z
        const DAY2_02: i64 = DAY1_21 + FIVE_HOURS + 1_000; // 2026-08-03T02:00:01Z (midnight-crossing 5h split)
        const DAY2_14: i64 = DAY1_09 + 29 * HOUR; // 2026-08-03T14:00:00Z

        let utc_day = |ms: i64| -> Option<String> {
            (ms > 0).then(|| crate::time::local_date(ms, ::time::UtcOffset::UTC))
        };

        // 1. Same-day multi-gap recordings + midnight-crossing 5h split + next day's afternoon recording.
        let r_morning = rec("morning", Some("SN1"), DAY1_09, 2 * HOUR);
        let r_afternoon = rec("afternoon", Some("SN1"), DAY1_15, HOUR);
        let r_night_5h = rec("night_5h", Some("SN1"), DAY1_21, FIVE_HOURS);
        let r_after_mid = rec("after_mid", Some("SN1"), DAY2_02, TWO_HOURS);
        let r_day2_pm = rec("day2_pm", Some("SN1"), DAY2_14, HOUR);
        let mut r_undated = rec("undated", Some("SN1"), 0, HOUR);
        r_undated.start_time = None;

        // Feed out of order.
        let plans = plan_daily_chains(
            &[],
            vec![
                r_day2_pm,
                r_after_mid,
                r_afternoon,
                r_undated,
                r_night_5h,
                r_morning,
            ],
            true,
            utc_day,
        );
        assert_eq!(plans.len(), 3);
        match &plans[0] {
            ChainPlan::NewMulti(parts) => {
                let ids: Vec<&str> = parts.iter().map(|p| p.id.as_str()).collect();
                assert_eq!(ids, vec!["morning", "afternoon", "night_5h", "after_mid"]);
            }
            other => panic!("expected Day 1 NewMulti, got {other:?}"),
        }
        match &plans[1] {
            ChainPlan::Single(r) => assert_eq!(r.id, "day2_pm"),
            other => panic!("expected Day 2 Single, got {other:?}"),
        }
        match &plans[2] {
            ChainPlan::Single(r) => assert_eq!(r.id, "undated"),
            other => panic!("expected undated Single, got {other:?}"),
        }

        // 2. Idle check: one existing recording per day emits ZERO plans.
        let a1 = anchor("a1", "p1", "SN1", DAY1_09, 2 * HOUR);
        let a2 = anchor("a2", "p2", "SN1", DAY2_14, HOUR);
        assert!(plan_daily_chains(&[a1, a2], vec![], true, utc_day).is_empty());

        // 3. 24h cap inside a single day splits cleanly into two chunks.
        let c1 = rec("c1", Some("SN1"), DAY1_09, 15 * HOUR);
        let c2 = rec("c2", Some("SN1"), DAY1_09 + 10 * HOUR, 10 * HOUR);
        let capped = plan_daily_chains(&[], vec![c2, c1], false, utc_day);
        assert_eq!(capped.len(), 2);
        assert!(matches!(&capped[0], ChainPlan::Single(r) if r.id == "c1"));
        assert!(matches!(&capped[1], ChainPlan::Single(r) if r.id == "c2"));

        // 4. Midnight split does NOT pull an already-merged multi-part next-day recording
        //    (containing unrelated Day 2 clips) into Day 1.
        let mut tue_merged = anchor("rec-tue", "after_mid", "SN1", DAY2_02, TWO_HOURS + HOUR);
        tue_merged.first_start_time = DAY2_02;
        tue_merged.first_end_time = DAY2_02 + TWO_HOURS;
        tue_merged.first_plaud_duration_ms = TWO_HOURS;
        tue_merged.last_start_time = DAY2_14;
        tue_merged.last_end_time = DAY2_14 + HOUR;
        tue_merged.last_plaud_duration_ms = HOUR;
        let mon_night = rec("mon_night", Some("SN1"), DAY1_21, FIVE_HOURS);
        let kept_separate = plan_daily_chains(&[tue_merged], vec![mon_night], true, utc_day);
        assert_eq!(kept_separate.len(), 1);
        assert!(matches!(&kept_separate[0], ChainPlan::Single(r) if r.id == "mon_night"));
    }

    #[tokio::test]
    async fn consolidation_preserves_ask_ai_chat_history_uses_max_end_time_and_skips_unrelated_daily_tombstones()
     {
        use axum::routing::get;
        use axum::{Json, Router};

        const HOUR: i64 = 3_600_000;
        const DAY_START: i64 = 1_785_661_200_000; // 2026-08-02T09:00:00Z
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        let a_ogg = cfg.storage_root.join("u1/f_a.ogg");
        let b_ogg = cfg.storage_root.join("u1/f_b.ogg");
        let c_ogg = dir.path().join("c.ogg");
        for (out, freq) in [(&a_ogg, 440), (&b_ogg, 660), (&c_ogg, 880)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
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
            assert!(media::run(&mut cmd).await);
        }
        let a_len = tokio::fs::metadata(&a_ogg).await.unwrap().len() as i64;
        let b_len = tokio::fs::metadata(&b_ogg).await.unwrap().len() as i64;
        let c_bytes = tokio::fs::read(&c_ogg).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        // Overlapping clips: rec-a (09:00-11:00, 2h) and rec-b (10:00-10:10, 10m).
        // Both have Ask AI chats; rec-b's chat must survive consolidation into rec-a.
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-a', 'u1', 'SN1', 'f_a', 't', ?, ?, ?, ?, 'm1', 'local', 'u1/f_a.ogg', '1', 0, ?, ?, 'original')",
        )
        .bind(2 * HOUR)
        .bind(DAY_START)
        .bind(DAY_START + 2 * HOUR)
        .bind(a_len)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-b', 'u1', 'SN2', 'f_b', 't', 600000, ?, ?, ?, 'm2', 'local', 'u1/f_b.ogg', '1', 0, ?, ?, 'original')",
        )
        .bind(DAY_START + HOUR)
        .bind(DAY_START + HOUR + 600_000)
        .bind(b_len)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        sqlx::query("INSERT INTO recording_chats (id, recording_id, user_id, generation, created_at, updated_at) VALUES ('chat-a', 'rec-a', 'u1', 1, ?, ?), ('chat-b', 'rec-b', 'u1', 1, ?, ?)")
            .bind(now)
            .bind(now)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO recording_chat_turns (id, chat_id, recording_id, user_id, request_id, seq, status, generation, question, answer, revision, created_at, updated_at) \
             VALUES ('t-a', 'chat-a', 'rec-a', 'u1', 'req-same', 1, 'completed', 1, 'q1', 'a1', 'rev-a', ?, ?), \
                    ('t-b', 'chat-b', 'rec-b', 'u1', 'req-same', 1, 'completed', 1, 'q2', 'a2', 'rev-b', ?, ?)",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let anchors = load_daily_anchors(&state, "u1").await.unwrap();
        let plans = plan_daily_chains(&anchors, vec![], false, |ms| {
            (ms > 0).then(|| crate::time::local_date(ms, ::time::UtcOffset::UTC))
        });
        assert_eq!(plans.len(), 1);
        let ChainPlan::Consolidate(segs) = &plans[0] else {
            panic!("expected Consolidate");
        };
        let client = Client::new("http://127.0.0.1:1", "unused");
        execute_consolidate(&state, "u1", &client, segs)
            .await
            .unwrap();

        // 1. max(end_time) is 11:00 (from rec-a), not 10:10 (from rec-b).
        let end_time: i64 =
            sqlx::query_scalar("SELECT end_time FROM recordings WHERE id = 'rec-a'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(end_time, DAY_START + 2 * HOUR);

        // 2. Both Ask AI turns survive on rec-a in order even with colliding request_ids.
        let turns: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id, seq FROM recording_chat_turns WHERE recording_id = 'rec-a' ORDER BY seq ASC",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(turns, vec![("t-a".into(), 1), ("t-b".into(), 2)]);

        // 3. Concurrent delete of a non-split morning anchor during daily consolidation does NOT
        //    tombstone an unrelated afternoon recording.
        sqlx::query("UPDATE recordings SET deleted_at = ? WHERE id = 'rec-a'")
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        let new_path: String =
            sqlx::query_scalar("SELECT storage_path FROM recordings WHERE id = 'rec-a'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let mut deleted_anchor = anchor("rec-a", "f_a", "SN1", DAY_START, 2 * HOUR);
        deleted_anchor.storage_path = new_path;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let dl_url = format!("{base}/dl/c");
        let app =
            Router::new()
                .route(
                    "/file/temp-url/f_afternoon",
                    get({
                        let dl_url = dl_url.clone();
                        move || async move {
                            Json(serde_json::json!({ "status": 0, "temp_url": dl_url }))
                        }
                    }),
                )
                .route(
                    "/dl/c",
                    get({
                        let c_bytes = c_bytes.clone();
                        move || async move { c_bytes }
                    }),
                );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut afternoon = rec("f_afternoon", Some("SN1"), DAY_START + 6 * HOUR, HOUR);
        afternoon.is_v4 = false;
        let client2 = Client::new(&base, "tok");
        let out = execute_consolidate(
            &state,
            "u1",
            &client2,
            &[
                ChainSegment::Existing(deleted_anchor),
                ChainSegment::New(afternoon),
            ],
        )
        .await
        .unwrap();
        assert!(matches!(out, AppendOutcome::Tombstoned));
        let tomb_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM plaud_recording_parts WHERE user_id = 'u1' AND plaud_file_id = 'f_afternoon'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(
            tomb_count, 0,
            "unrelated daily recording must NOT be tombstoned when morning anchor was deleted"
        );
    }

    #[tokio::test]
    async fn interleaved_middle_insert_recovers_missing_cloud_part_from_local_merged_audio() {
        use axum::extract::Path;
        use axum::http::StatusCode;
        use axum::routing::get;
        use axum::{Json, Router};

        const HOUR: i64 = 3_600_000;
        const DAY_START: i64 = 1_785_661_200_000; // 2026-08-02T09:00:00Z
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        // Create local already-merged [P1 (1s) + P3 (1s)] = 2s Ogg/Opus, plus P2 (2s) on cloud.
        // Plaud cloud returns 404 for P1 (deleted from Plaud cloud), so local slice fallback runs.
        let p1_path = dir.path().join("p1.ogg");
        let p2_path = dir.path().join("p2.ogg");
        let p3_path = dir.path().join("p3.ogg");
        for (out, freq, secs) in [(&p1_path, 440, 1), (&p2_path, 660, 2), (&p3_path, 880, 1)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
            cmd.args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={freq}:duration={secs}"),
                "-c:a",
                "libopus",
                "-f",
                "ogg",
            ])
            .arg(out);
            assert!(media::run(&mut cmd).await);
        }
        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let merged_13 = concat_audio_files(&state, "u1", &[p1_path, p3_path.clone()], false)
            .await
            .unwrap();
        let existing_13 = state.config.storage_root.join("u1/f_p1.ogg");
        tokio::fs::copy(merged_13.temp.path(), &existing_13)
            .await
            .unwrap();
        let existing_len = tokio::fs::metadata(&existing_13).await.unwrap().len() as i64;
        let p2_bytes = tokio::fs::read(&p2_path).await.unwrap();
        let p3_bytes = tokio::fs::read(&p3_path).await.unwrap();

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
             VALUES ('rec-13', 'u1', 'SN1', 'f_p1', ?, ?, ?, ?, ?, 'md513', 'local', 'u1/f_p1.ogg', '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("2026-08-02"))
        .bind(2 * HOUR)
        .bind(DAY_START)
        .bind(DAY_START + 9 * HOUR)
        .bind(existing_len)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        for (idx, fid, st, en, aud_ms) in [
            (
                0i64,
                "f_p1",
                DAY_START,
                DAY_START + HOUR,
                merged_13.input_durations_ms[0],
            ),
            (
                1i64,
                "f_p3",
                DAY_START + 8 * HOUR,
                DAY_START + 9 * HOUR,
                merged_13.input_durations_ms[1],
            ),
        ] {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES ('u1', ?, 'rec-13', ?, ?, ?, ?, ?, '1', ?, ?)",
            )
            .bind(fid)
            .bind(idx)
            .bind(st)
            .bind(en)
            .bind(HOUR)
            .bind(aud_ms)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let base_dl = base.clone();
        let app = Router::new()
            .route(
                "/file/temp-url/{id}",
                get(move |Path(id): Path<String>| {
                    let base_dl = base_dl.clone();
                    async move {
                        if id == "f_p1" {
                            return (
                                StatusCode::NOT_FOUND,
                                Json(
                                    serde_json::json!({ "status": -1, "msg": "deleted on Plaud" }),
                                ),
                            );
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "status": 0,
                                "temp_url": format!("{base_dl}/dl/{id}")
                            })),
                        )
                    }
                }),
            )
            .route(
                "/dl/{id}",
                get(move |Path(id): Path<String>| {
                    let b2 = p2_bytes.clone();
                    let b3 = p3_bytes.clone();
                    async move {
                        match id.as_str() {
                            "f_p2" => b2,
                            "f_p3" => b3,
                            _ => Vec::new(),
                        }
                    }
                }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let anchors = load_daily_anchors(&state, "u1").await.unwrap();
        let mut p2 = rec("f_p2", Some("SN1"), DAY_START + 4 * HOUR, 2 * HOUR);
        p2.is_v4 = false;
        let plans = plan_daily_chains(&anchors, vec![p2], false, |ms| {
            (ms > 0).then(|| crate::time::local_date(ms, ::time::UtcOffset::UTC))
        });
        let ChainPlan::Consolidate(segs) = &plans[0] else {
            panic!("expected Consolidate");
        };
        let client = Client::new(&base, "tok");
        execute_consolidate(&state, "u1", &client, segs)
            .await
            .unwrap();

        let part_ids: Vec<String> = sqlx::query_scalar(
            "SELECT plaud_file_id FROM plaud_recording_parts WHERE recording_id = 'rec-13' ORDER BY part_index ASC",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        assert_eq!(part_ids, vec!["f_p1", "f_p2", "f_p3"]);
        let stored_path: String =
            sqlx::query_scalar("SELECT storage_path FROM recordings WHERE id = 'rec-13'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let probed = media::probe(
            &state.config.ffprobe,
            &state.config.storage_root.join(stored_path),
        )
        .await
        .unwrap();
        assert!(probed.duration_ms >= 3500, "got {}ms", probed.duration_ms);
    }

    #[tokio::test]
    async fn interleaved_middle_insert_reassembles_audio_in_true_chronological_order() {
        use axum::extract::Path;
        use axum::routing::get;
        use axum::{Json, Router};

        const HOUR: i64 = 3_600_000;
        const DAY_START: i64 = 1_785_661_200_000; // 2026-08-02T09:00:00Z
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        // Create 3 distinct-duration Ogg/Opus clips: P1 (1s), P2 (2s), P3 (1s) and an existing
        // already-merged [P1 + P3] (~2s) file on disk.
        let p1_path = dir.path().join("p1.ogg");
        let p2_path = dir.path().join("p2.ogg");
        let p3_path = dir.path().join("p3.ogg");
        for (out, freq, secs) in [(&p1_path, 440, 1), (&p2_path, 660, 2), (&p3_path, 880, 1)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
            cmd.args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("sine=frequency={freq}:duration={secs}"),
                "-c:a",
                "libopus",
                "-f",
                "ogg",
            ])
            .arg(out);
            assert!(media::run(&mut cmd).await);
        }
        let p1_bytes = tokio::fs::read(&p1_path).await.unwrap();
        let p2_bytes = tokio::fs::read(&p2_path).await.unwrap();
        let p3_bytes = tokio::fs::read(&p3_path).await.unwrap();

        let existing_13 = cfg.storage_root.join("u1/f_p1.ogg");
        tokio::fs::write(&existing_13, &p1_bytes).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
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
             VALUES ('rec-13', 'u1', 'SN1', 'f_p1', ?, ?, ?, ?, ?, 'md513', 'local', 'u1/f_p1.ogg', '1', 0, ?, ?, 'date')",
        )
        .bind(state.config.field_key.encrypt("2026-08-02"))
        .bind(2 * HOUR)
        .bind(DAY_START)
        .bind(DAY_START + 9 * HOUR)
        .bind(p1_bytes.len() as i64)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();
        for (idx, fid, st, en) in [
            (0i64, "f_p1", DAY_START, DAY_START + HOUR),
            (1i64, "f_p3", DAY_START + 8 * HOUR, DAY_START + 9 * HOUR),
        ] {
            sqlx::query(
                "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, start_time, end_time, \
                 plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                 VALUES ('u1', ?, 'rec-13', ?, ?, ?, ?, 1000, '1', ?, ?)",
            )
            .bind(fid)
            .bind(idx)
            .bind(st)
            .bind(en)
            .bind(HOUR)
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let base_dl = base.clone();
        let app = Router::new()
            .route(
                "/file/temp-url/{id}",
                get(move |Path(id): Path<String>| {
                    let base_dl = base_dl.clone();
                    async move {
                        Json(serde_json::json!({
                            "status": 0,
                            "temp_url": format!("{base_dl}/dl/{id}")
                        }))
                    }
                }),
            )
            .route(
                "/dl/{id}",
                get(move |Path(id): Path<String>| {
                    let b1 = p1_bytes.clone();
                    let b2 = p2_bytes.clone();
                    let b3 = p3_bytes.clone();
                    async move {
                        match id.as_str() {
                            "f_p1" => b1,
                            "f_p2" => b2,
                            "f_p3" => b3,
                            _ => Vec::new(),
                        }
                    }
                }),
            );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let anchors = load_daily_anchors(&state, "u1").await.unwrap();
        assert_eq!(anchors.len(), 1);
        assert_eq!(anchors[0].first_start_time, DAY_START);
        assert_eq!(anchors[0].last_start_time, DAY_START + 8 * HOUR);

        let mut p2 = rec("f_p2", Some("SN1"), DAY_START + 4 * HOUR, 2 * HOUR);
        p2.is_v4 = false;
        let plans = plan_daily_chains(&anchors, vec![p2], false, |ms| {
            (ms > 0).then(|| crate::time::local_date(ms, ::time::UtcOffset::UTC))
        });
        assert_eq!(plans.len(), 1);
        let ChainPlan::Consolidate(segs) = &plans[0] else {
            panic!("expected Consolidate");
        };
        assert!(needs_interleaved_reassembly(segs));

        let client = Client::new(&base, "tok");
        let out = execute_consolidate(&state, "u1", &client, segs)
            .await
            .unwrap();
        assert!(matches!(
            out,
            AppendOutcome::Updated { ref recording_id, .. } if recording_id == "rec-13"
        ));

        let total_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE user_id = 'u1'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(total_rows, 1);

        let part_rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT plaud_file_id, audio_duration_ms FROM plaud_recording_parts \
             WHERE recording_id = 'rec-13' ORDER BY part_index ASC",
        )
        .fetch_all(&state.db)
        .await
        .unwrap();
        let part_ids: Vec<&str> = part_rows.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(part_ids, vec!["f_p1", "f_p2", "f_p3"]);
        // Verify P2 (2s clip) sits strictly in the middle (index 1) between P1 (~1s) and P3 (~1s).
        assert!(
            part_rows[1].1 >= 1800,
            "middle part audio_ms={}",
            part_rows[1].1
        );

        let stored_path: String =
            sqlx::query_scalar("SELECT storage_path FROM recordings WHERE id = 'rec-13'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        let probed = media::probe(
            &state.config.ffprobe,
            &state.config.storage_root.join(stored_path),
        )
        .await
        .unwrap();
        // Combined duration = 1s + 2s + 1s = ~4s.
        assert!(probed.duration_ms >= 3600, "got {}ms", probed.duration_ms);
    }

    #[tokio::test]
    async fn transcoded_mp3_export_requires_matching_sha256_and_protects_edited_or_legacy_files() {
        let dir = tempfile::tempdir().unwrap();
        let export_dir = dir.path().join("exports");
        tokio::fs::create_dir_all(&export_dir).await.unwrap();

        let mut cfg = crate::Config::for_tests(dir.path());
        cfg.storage_root = dir.path().join("storage");
        cfg.desktop = Some(crate::config::Desktop {
            launch_secret: "0123456789abcdef0123456789abcdef-launch".into(),
            user_id: None,
        });
        tokio::fs::create_dir_all(cfg.storage_root.join("u1"))
            .await
            .unwrap();

        let p1_ogg = cfg.storage_root.join("u1/f_p1.ogg");
        let p2_ogg = cfg.storage_root.join("u1/f_p2.ogg");
        for (out, freq) in [(&p1_ogg, 440), (&p2_ogg, 660)] {
            let mut cmd = Command::new(&cfg.ffmpeg);
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
            assert!(media::run(&mut cmd).await);
        }

        // Produce authentic transcoded MP3 exports for p1 and p2.
        let exp1 = export_dir.join("2026-11-25.mp3");
        let exp2 = export_dir.join("2026-11-25 (2).mp3");
        assert!(media::to_mp3(&cfg.ffmpeg, &p1_ogg, &exp1).await);
        assert!(media::to_mp3(&cfg.ffmpeg, &p2_ogg, &exp2).await);
        let sha1 = crate::export::auto::file_sha256(&exp1).await.unwrap();
        let sha2_orig = crate::export::auto::file_sha256(&exp2).await.unwrap();

        let state = AppState::new(cfg, crate::db::open_memory().await.unwrap());
        let now = now_ms();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u1', ?, ?)")
            .bind(
                serde_json::json!({
                    "autoExport": true,
                    "autoExportFolder": export_dir.to_string_lossy(),
                    "autoExportFormat": "mp3",
                })
                .to_string(),
            )
            .bind(now)
            .execute(&state.db)
            .await
            .unwrap();

        let enc1 = state.config.field_key.encrypt(&exp1.to_string_lossy());
        let enc2 = state.config.field_key.encrypt(&exp2.to_string_lossy());
        let p1_len = tokio::fs::metadata(&p1_ogg).await.unwrap().len() as i64;
        let p2_len = tokio::fs::metadata(&p2_ogg).await.unwrap().len() as i64;

        // 1. Legacy transcoded MP3 with NULL auto_export_sha256 -> rejected (kept untouched).
        let mut legacy_anchor = anchor("rec-1", "f_p1", "SN1", BASE_START, FIVE_HOURS);
        legacy_anchor.storage_path = "u1/f_p1.ogg".into();
        legacy_anchor.auto_export_path = Some(enc1.clone());
        legacy_anchor.auto_export_sha256 = None;
        let dummy = import::Stored {
            storage_type: "local",
            key: "u1/f_p1.ogg".into(),
            peaks: None,
            byte_len: p1_len,
            file_md5: "x".into(),
            remuxed: true,
        };
        assert!(
            prepare_desktop_export_consolidation(
                &state,
                "u1",
                "rec-1",
                &[(&legacy_anchor, p1_ogg.as_path())],
                &dummy,
                "ogg"
            )
            .await
            .is_none(),
            "legacy transcoded export without SHA-256 must not be touched"
        );

        // 2. Seed rec-1 (authentic MP3 matching sha1) and rec-2 (user-edited MP3 -> sha mismatch).
        let mut edited_bytes = tokio::fs::read(&exp2).await.unwrap();
        edited_bytes.push(0u8);
        tokio::fs::write(&exp2, &edited_bytes).await.unwrap();

        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, auto_export_path, auto_export_sha256, plaud_version, is_trash, created_at, updated_at, title_source) \
             VALUES ('rec-1', 'u1', 'SN1', 'f_p1', 't', ?, ?, ?, ?, 'm1', 'local', 'u1/f_p1.ogg', ?, ?, '1', 0, ?, ?, 'date'), \
                    ('rec-2', 'u1', 'SN1', 'f_p2', 't', ?, ?, ?, ?, 'm2', 'local', 'u1/f_p2.ogg', ?, ?, '2', 0, ?, ?, 'date')",
        )
        .bind(FIVE_HOURS)
        .bind(BASE_START)
        .bind(BASE_START + FIVE_HOURS)
        .bind(p1_len)
        .bind(&enc1)
        .bind(&sha1)
        .bind(now)
        .bind(now)
        .bind(TWO_HOURS)
        .bind(BASE_START + FIVE_HOURS + 1_000)
        .bind(BASE_START + FIVE_HOURS + 1_000 + TWO_HOURS)
        .bind(p2_len)
        .bind(&enc2)
        .bind(&sha2_orig)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .unwrap();

        let open_tails = load_open_tail_anchors(&state, "u1").await.unwrap();
        let all_anchors = load_candidate_anchors(&state, "u1", open_tails, &[])
            .await
            .unwrap();
        let plans = plan_chains(&all_anchors, vec![]);
        let ChainPlan::Consolidate(segs) = &plans[0] else {
            panic!("expected Consolidate");
        };
        let client = Client::new("http://127.0.0.1:1", "unused");
        execute_consolidate(&state, "u1", &client, segs)
            .await
            .unwrap();

        // exp1 (authentic sha1) was updated to ~2s merged MP3 with fresh SHA-256 in DB.
        let probed = media::probe(&state.config.ffprobe, &exp1).await.unwrap();
        assert!(probed.duration_ms >= 1800, "got {}ms", probed.duration_ms);
        let new_sha: Option<String> =
            sqlx::query_scalar("SELECT auto_export_sha256 FROM recordings WHERE id = 'rec-1'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(new_sha, crate::export::auto::file_sha256(&exp1).await);

        // exp2 (user-edited MP3 whose SHA-256 mismatched) was preserved untouched on disk.
        assert!(
            exp2.exists(),
            "user-edited transcoded MP3 must NOT be deleted"
        );
        assert_eq!(tokio::fs::read(&exp2).await.unwrap(), edited_bytes);
    }
}
