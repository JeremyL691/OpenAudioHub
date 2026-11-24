//! Automatic detection, settling, lossless concatenation, and incremental append for
//! Plaud 5-hour split recordings (spec/plaud.md).

use std::collections::HashSet;
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

/// Live recording in SQLite whose final part ended at the 5-hour ceiling and can accept late parts.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct OpenAnchor {
    pub id: String,
    pub device_sn: String,
    pub plaud_file_id: String,
    pub duration: i64,
    pub filesize: i64,
    pub storage_type: String,
    pub storage_path: String,
    pub auto_export_path: Option<String>,
    pub last_part_index: i64,
    pub last_start_time: i64,
    pub last_end_time: i64,
    pub last_plaud_duration_ms: i64,
    pub has_parts: bool,
}

/// Planned action for new Plaud items after cross-page grouping.
#[derive(Debug, Clone)]
pub(crate) enum ChainPlan {
    Single(Recording),
    NewMulti(Vec<Recording>),
    Append {
        anchor: OpenAnchor,
        parts: Vec<Recording>,
    },
}

/// Outcome of an incremental late-part append.
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

/// Loads live open DB anchors that could receive late-arriving split parts.
pub(crate) async fn load_open_anchors(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<OpenAnchor>, sqlx::Error> {
    sqlx::query_as(
        "SELECT r.id, r.device_sn, r.plaud_file_id, r.duration, \
                r.filesize, r.storage_type, r.storage_path, \
                r.auto_export_path, \
                COALESCE(lp.part_index, 0) AS last_part_index, \
                COALESCE(lp.start_time, r.start_time) AS last_start_time, \
                COALESCE(lp.end_time, r.end_time) AS last_end_time, \
                COALESCE(lp.plaud_duration_ms, r.duration) AS last_plaud_duration_ms, \
                CASE WHEN lp.recording_id IS NOT NULL THEN 1 ELSE 0 END AS has_parts \
         FROM recordings r \
         LEFT JOIN plaud_recording_parts lp \
           ON lp.recording_id = r.id \
          AND lp.part_index = (SELECT MAX(p2.part_index) FROM plaud_recording_parts p2 WHERE p2.recording_id = r.id) \
         WHERE r.user_id = ? \
           AND r.deleted_at IS NULL \
           AND r.device_sn <> 'local' \
           AND r.duration < ? \
           AND COALESCE(lp.plaud_duration_ms, r.duration) BETWEEN ? AND ?",
    )
    .bind(user_id)
    .bind(MAX_CHAIN_DURATION_MS)
    .bind(SPLIT_CEILING_MIN_MS)
    .bind(SPLIT_CEILING_MAX_MS)
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
    anchors: &[OpenAnchor],
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

/// Groups new recordings chronologically into maximal <=24h split chains and matches chain heads
/// against live open DB anchors. Enforces strict 1-to-1 predecessor/successor uniqueness.
pub(crate) fn plan_chains(anchors: &[OpenAnchor], mut new_items: Vec<Recording>) -> Vec<ChainPlan> {
    if new_items.is_empty() {
        return Vec::new();
    }
    new_items.sort_by(|a, b| {
        a.start_time
            .unwrap_or(0)
            .cmp(&b.start_time.unwrap_or(0))
            .then_with(|| a.id.cmp(&b.id))
    });

    let anchor_count = anchors.len();
    let new_count = new_items.len();
    let total_nodes = anchor_count + new_count;

    let mut metas = Vec::with_capacity(total_nodes);
    for a in anchors {
        metas.push(LinkMeta {
            device_sn: a.device_sn.as_str(),
            start_time: a.last_start_time,
            end_time: effective_end(a.last_start_time, a.last_end_time, a.last_plaud_duration_ms),
            duration_ms: a.last_plaud_duration_ms,
        });
    }
    for r in &new_items {
        let start = r.start_time.unwrap_or(0);
        let dur = r.duration.unwrap_or(0);
        let end = effective_end(start, r.end_time.unwrap_or(0), dur);
        metas.push(LinkMeta {
            device_sn: r.serial_number.as_deref().unwrap_or(""),
            start_time: start,
            end_time: end,
            duration_ms: dur,
        });
    }

    let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); total_nodes];
    let mut incoming: Vec<Vec<usize>> = vec![Vec::new(); new_count];

    for (a, out) in outgoing.iter_mut().enumerate() {
        for (b_rel, inc) in incoming.iter_mut().enumerate() {
            let b = anchor_count + b_rel;
            if a == b {
                continue;
            }
            if can_link(metas[a], metas[b]) {
                out.push(b_rel);
                inc.push(a);
            }
        }
    }

    // Keep only 1-to-1 unique links so ambiguous forks or colliding empty-serial items never merge.
    let mut next_new: Vec<Option<usize>> = vec![None; total_nodes];
    let mut has_prev: Vec<bool> = vec![false; new_count];
    for a in 0..total_nodes {
        if outgoing[a].len() == 1 {
            let b_rel = outgoing[a][0];
            if incoming[b_rel].len() == 1 {
                next_new[a] = Some(b_rel);
                has_prev[b_rel] = true;
            }
        }
    }

    let new_durations: Vec<i64> = new_items
        .iter()
        .map(|r| r.duration.unwrap_or(0).max(0))
        .collect();
    drop(metas);

    let mut items_opt: Vec<Option<Recording>> = new_items.into_iter().map(Some).collect();
    let mut visited = vec![false; new_count];
    let mut plans = Vec::new();

    // 1. Walk late-append chains anchored on existing live DB recordings.
    for (a_idx, anchor) in anchors.iter().enumerate() {
        let Some(first_rel) = next_new[a_idx] else {
            continue;
        };
        let mut total_ms = anchor.duration.max(0);
        let mut chain_indices = Vec::new();
        let mut cur = Some(first_rel);
        while let Some(rel) = cur {
            if visited[rel] {
                break;
            }
            let part_dur = new_durations[rel];
            if total_ms.saturating_add(part_dur) > MAX_CHAIN_DURATION_MS {
                // Exceeding 24h closes the anchor append; `rel` starts a new standalone chain.
                has_prev[rel] = false;
                break;
            }
            visited[rel] = true;
            total_ms = total_ms.saturating_add(part_dur);
            chain_indices.push(rel);
            cur = next_new[anchor_count + rel];
        }
        if !chain_indices.is_empty() {
            let parts = chain_indices
                .into_iter()
                .filter_map(|i| items_opt[i].take())
                .collect();
            plans.push(ChainPlan::Append {
                anchor: anchor.clone(),
                parts,
            });
        }
    }

    // 2. Walk new chains in chronological order.
    for start_rel in 0..new_count {
        if visited[start_rel] || has_prev[start_rel] {
            continue;
        }
        let mut total_ms = 0i64;
        let mut chain_indices = Vec::new();
        let mut cur = Some(start_rel);
        while let Some(rel) = cur {
            if visited[rel] {
                break;
            }
            let part_dur = new_durations[rel];
            if !chain_indices.is_empty()
                && total_ms.saturating_add(part_dur) > MAX_CHAIN_DURATION_MS
            {
                // Cap chain at 24h and let `rel` open the next chain.
                has_prev[rel] = false;
                break;
            }
            visited[rel] = true;
            total_ms = total_ms.saturating_add(part_dur);
            chain_indices.push(rel);
            cur = next_new[anchor_count + rel];
        }
        let mut parts: Vec<Recording> = chain_indices
            .into_iter()
            .filter_map(|i| items_opt[i].take())
            .collect();
        if parts.len() == 1 {
            plans.push(ChainPlan::Single(parts.remove(0)));
        } else if parts.len() >= 2 {
            plans.push(ChainPlan::NewMulti(parts));
        }
    }

    // 3. Emit any remaining unvisited items defensively as standalone recordings.
    for (idx, item) in items_opt.into_iter().enumerate() {
        if !visited[idx]
            && let Some(r) = item
        {
            plans.push(ChainPlan::Single(r));
        }
    }

    plans
}

/// Returns the settle-tip `plaud_file_id` when a chain ends on a ~5h ceiling part and is under 24h.
/// Chains ending on a `<4h55m` tail or already reaching the 24h cap return `None` (no settle wait).
pub(crate) fn settle_tip_id(plan: &ChainPlan) -> Option<&str> {
    let (last, total_ms) = match plan {
        ChainPlan::Single(r) => (r, r.duration.unwrap_or(0)),
        ChainPlan::NewMulti(parts) => {
            let last = parts.last()?;
            let total: i64 = parts
                .iter()
                .map(|p| p.duration.unwrap_or(0).max(0))
                .fold(0i64, i64::saturating_add);
            (last, total)
        }
        ChainPlan::Append { anchor, parts } => {
            let last = parts.last()?;
            let extra: i64 = parts
                .iter()
                .map(|p| p.duration.unwrap_or(0).max(0))
                .fold(0i64, i64::saturating_add);
            (last, anchor.duration.max(0).saturating_add(extra))
        }
    };
    if is_split_ceiling_duration(last.duration.unwrap_or(0)) && total_ms < MAX_CHAIN_DURATION_MS {
        Some(last.id.as_str())
    } else {
        None
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
    if !client.is_v4_mode() && !parts.iter().any(|p| p.is_v4) {
        return Ok(AudioPreference::Default);
    }
    let mut details = Vec::with_capacity(parts.len());
    for part in parts {
        if let Some(detail) = client.peek_v4_detail(&part.id).await? {
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
    let last = parts.last().expect("non-empty parts");
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
    let last_plaud_ms = part_rows.last().map(|r| r.4).unwrap_or(0);
    let end_time = effective_end(
        last.start_time.unwrap_or(start),
        last.end_time.unwrap_or(0),
        last_plaud_ms,
    );
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

struct PreparedExportUpdate {
    staged: TempPath,
    folder: PathBuf,
    orig_path: PathBuf,
    orig_enc_path: String,
    orig_ext: String,
    target_ext: String,
    orig_len: u64,
    orig_mtime: SystemTime,
}

fn path_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn export_codec_matches_ext(ext: &str, codec: &str) -> bool {
    match ext {
        "mp3" => codec == "mp3",
        "ogg" | "opus" => matches!(codec, "opus" | "vorbis"),
        "m4a" | "mp4" | "aac" => codec == "aac",
        "flac" => codec == "flac",
        "wav" => codec.starts_with("pcm_"),
        "webm" => matches!(codec, "opus" | "vorbis"),
        _ => true,
    }
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
    anchor_id: &str,
    orig_path: &Path,
) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    #[derive(sqlx::FromRow)]
    struct OtherPathRow {
        storage_type: String,
        storage_path: String,
        auto_export_path: Option<String>,
        auto_export_target: Option<String>,
    }

    let rows: Vec<OtherPathRow> = sqlx::query_as(
        "SELECT storage_type, storage_path, auto_export_path, auto_export_target \
         FROM recordings WHERE user_id = ? AND id <> ? AND deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(anchor_id)
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

#[allow(clippy::too_many_arguments)]
async fn prepare_desktop_export_update(
    state: &AppState,
    user_id: &str,
    anchor: &OpenAnchor,
    existing_audio_path: &Path,
    existing_audio_ms: i64,
    new_storage: &import::Stored,
    new_stored_ext: &str,
) -> Option<PreparedExportUpdate> {
    state.config.desktop.as_ref()?;
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
    if !crate::local_folder::is_in_folder(&orig_path, &folder) {
        return None;
    }

    if export_path_claimed_by_other(&state.db, state, user_id, &anchor.id, &orig_path)
        .await
        .unwrap_or(true)
    {
        return None;
    }

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
        let probe = media::probe(&state.config.ffprobe, &orig_path).await?;
        if !export_codec_matches_ext(&orig_ext, &probe.codec)
            || (probe.duration_ms - existing_audio_ms).abs() > 2_500
        {
            return None;
        }
    }

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
            export_path = %orig_path.display(),
            "staging updated desktop auto-export after split append failed"
        );
        return None;
    }

    Some(PreparedExportUpdate {
        staged: tmp,
        folder,
        orig_path,
        orig_enc_path: orig_enc.to_owned(),
        orig_ext,
        target_ext,
        orig_len,
        orig_mtime,
    })
}

/// Appends late-arriving split parts in place onto an existing live anchor recording.
/// Holds `local_folder::lock()` BEFORE `db::begin_write()` strictly around export rename and DB commit.
pub(crate) async fn execute_late_append(
    state: &AppState,
    user_id: &str,
    client: &Client,
    anchor: &OpenAnchor,
    new_parts: &[Recording],
) -> Result<AppendOutcome, ItemError> {
    if new_parts.is_empty() {
        return Err(ItemError::Failed("no late parts to append".into()));
    }

    let existing_bytes = anchor.filesize.max(0) as u64;
    ensure_disk_space(state, existing_bytes, estimate_download_bytes(new_parts))?;

    let existing_file = state
        .storage
        .materialize(&anchor.storage_type, &anchor.storage_path)
        .await
        .map_err(|_| ItemError::Failed("existing split anchor audio is unavailable".into()))?;
    let actual_existing_bytes = tokio::fs::metadata(existing_file.path())
        .await
        .map(|m| m.len())
        .unwrap_or(existing_bytes);

    let anchor_lower = anchor.storage_path.to_ascii_lowercase();
    let anchor_is_ogg_or_opus = anchor_lower.ends_with(".ogg") || anchor_lower.ends_with(".opus");
    let pref = choose_audio_preference(client, new_parts, anchor_is_ogg_or_opus).await?;

    let mut downloaded = Vec::with_capacity(new_parts.len());
    let mut downloaded_bytes = 0u64;
    for part in new_parts {
        let dl = import::download_to_temp(state, user_id, client, &part.id, pref).await?;
        downloaded_bytes = downloaded_bytes.saturating_add(dl.byte_len.max(0) as u64);
        downloaded.push(dl);
    }
    ensure_disk_space(state, actual_existing_bytes, downloaded_bytes)?;

    let mut inputs = Vec::with_capacity(1 + downloaded.len());
    inputs.push(existing_file.path().to_path_buf());
    for dl in &downloaded {
        inputs.push(dl.temp.path().to_path_buf());
    }
    let concat = concat_audio_files(state, user_id, &inputs, false).await?;
    // Release downloaded raw `.partial` files immediately after concatenation succeeds.
    drop(downloaded);

    let existing_audio_ms = concat.input_durations_ms[0];
    let new_audio_durations = &concat.input_durations_ms[1..];
    let new_storage = import::stage_prepared_audio(
        state,
        user_id,
        &anchor.plaud_file_id,
        concat.ext,
        concat.temp,
        concat.byte_len,
        concat.file_md5,
        true,
    )
    .await?;

    let mut prepared_export = prepare_desktop_export_update(
        state,
        user_id,
        anchor,
        existing_file.path(),
        existing_audio_ms,
        &new_storage,
        concat.ext,
    )
    .await;
    drop(existing_file);

    // Inspect prior openaudiohub work and supersede any running pipeline job BEFORE taking the lock.
    let had_prior_oah_pre: bool = sqlx::query_scalar(
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

    if let Err(e) = crate::pipeline::supersede(state, user_id, &anchor.id).await {
        tracing::warn!(recording = %anchor.id, error = %e, "superseding active pipeline job before split append failed");
    }

    let mut added_plaud_ms = 0i64;
    let mut new_part_rows = Vec::with_capacity(new_parts.len());
    for (idx, (part, &audio_ms)) in new_parts.iter().zip(new_audio_durations.iter()).enumerate() {
        let p_dur = part_effective_plaud_ms(part, audio_ms);
        let p_start = part.start_time.unwrap_or(0);
        let p_end = effective_end(p_start, part.end_time.unwrap_or(0), p_dur);
        added_plaud_ms = added_plaud_ms.saturating_add(p_dur);
        new_part_rows.push((
            anchor.last_part_index + 1 + idx as i64,
            part,
            p_start,
            p_end,
            p_dur,
            audio_ms,
        ));
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
        },
        DeletedConcurrently,
        MissingRow,
        StorageChanged,
    }

    #[derive(sqlx::FromRow)]
    struct CurrentAnchorRow {
        deleted_at: Option<i64>,
        storage_path: String,
        auto_export_path: Option<String>,
        duration: i64,
        start_time: i64,
        end_time: i64,
        plaud_version: String,
    }

    // Strict lock order: always acquire `local_folder::lock()` BEFORE `db::begin_write()`.
    let action: Result<CommitAction, sqlx::Error> = async {
        let _folder_guard = crate::local_folder::lock().await;
        let mut tx = crate::db::begin_write(&state.db).await?;

        let current: Option<CurrentAnchorRow> = sqlx::query_as(
            "SELECT deleted_at, storage_path, auto_export_path, duration, start_time, end_time, plaud_version \
             FROM recordings WHERE id = ? AND user_id = ?",
        )
        .bind(&anchor.id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(CurrentAnchorRow {
            deleted_at,
            storage_path: current_storage_path,
            auto_export_path: current_export_path,
            duration: current_duration,
            start_time: current_start,
            end_time: current_end,
            plaud_version: current_version,
        }) = current
        else {
            tx.rollback().await?;
            return Ok(CommitAction::MissingRow);
        };
        if deleted_at.is_some() {
            tx.rollback().await?;
            return Ok(CommitAction::DeletedConcurrently);
        }
        if current_storage_path != anchor.storage_path {
            tx.rollback().await?;
            return Ok(CommitAction::StorageChanged);
        }

        // Re-verify export identity and atomically replace while holding `local_folder::lock()`.
        let mut new_export_enc: Option<String> = None;
        let mut created_sibling_export: Option<PathBuf> = None;
        let mut old_export_to_unlink: Option<PathBuf> = None;
        if let Some(prep) = prepared_export.as_mut()
            && current_export_path.as_deref() == Some(prep.orig_enc_path.as_str())
            && !export_path_claimed_by_other(&mut *tx, state, user_id, &anchor.id, &prep.orig_path)
                .await?
            && let Ok(meta) = tokio::fs::metadata(&prep.orig_path).await
            && meta.is_file()
            && meta.len() == prep.orig_len
            && meta.modified().ok() == Some(prep.orig_mtime)
        {
            let dest_path = if prep.orig_ext == prep.target_ext {
                prep.orig_path.clone()
            } else {
                let stem = prep
                    .orig_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("recording");
                unique_sibling_path(&prep.folder, stem, &prep.target_ext).await
            };
            match tokio::fs::rename(prep.staged.path(), &dest_path).await {
                Ok(()) => {
                    prep.staged.disarm();
                    new_export_enc = Some(
                        state
                            .config
                            .field_key
                            .encrypt(&dest_path.to_string_lossy()),
                    );
                    if dest_path != prep.orig_path {
                        created_sibling_export = Some(dest_path);
                        old_export_to_unlink = Some(prep.orig_path.clone());
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        recording = %anchor.id,
                        error = %e,
                        "atomic replacement of desktop auto-export failed"
                    );
                }
            }
        }

        let had_oah_in_tx: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM transcriptions WHERE recording_id = ? AND user_id = ? AND source = 'openaudiohub') \
             OR EXISTS (SELECT 1 FROM jobs WHERE recording_id = ? AND user_id = ? AND kind IN ('transcribe', 'pipeline') AND state IN ('queued', 'running', 'done'))",
        )
        .bind(&anchor.id)
        .bind(user_id)
        .bind(&anchor.id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
        let had_oah_work = had_prior_oah_pre || had_oah_in_tx;

        let new_total_duration = current_duration.max(0).saturating_add(added_plaud_ms);
        let new_end_time = new_part_rows.last().map(|r| r.3).unwrap_or(current_end);

        let write_result: Result<Vec<String>, sqlx::Error> = async {
            if current_export_path.is_none() {
                sqlx::query(
                    "UPDATE recordings SET duration = ?, end_time = ?, filesize = ?, file_md5 = ?, \
                     storage_type = ?, storage_path = ?, downloaded_at = ?, waveform_peaks = ?, \
                     auto_export_target = NULL, auto_export_attempts = 0, updated_at = ? \
                     WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                )
                .bind(new_total_duration)
                .bind(new_end_time)
                .bind(new_storage.byte_len)
                .bind(new_storage.file_md5.as_str())
                .bind(new_storage.storage_type)
                .bind(new_storage.key.as_str())
                .bind(now)
                .bind(peaks_json)
                .bind(now)
                .bind(&anchor.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            } else {
                sqlx::query(
                    "UPDATE recordings SET duration = ?, end_time = ?, filesize = ?, file_md5 = ?, \
                     storage_type = ?, storage_path = ?, downloaded_at = ?, waveform_peaks = ?, \
                     auto_export_path = COALESCE(?, auto_export_path), auto_export_target = NULL, \
                     auto_export_attempts = 0, updated_at = ? \
                     WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                )
                .bind(new_total_duration)
                .bind(new_end_time)
                .bind(new_storage.byte_len)
                .bind(new_storage.file_md5.as_str())
                .bind(new_storage.storage_type)
                .bind(new_storage.key.as_str())
                .bind(now)
                .bind(peaks_json)
                .bind(new_export_enc)
                .bind(now)
                .bind(&anchor.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            }

            // Backfill part 0 into `plaud_recording_parts` when upgrading a single-part anchor.
            if !anchor.has_parts {
                let anchor_plaud_dur = if current_duration > 0 {
                    current_duration
                } else {
                    existing_audio_ms
                };
                let anchor_end = effective_end(current_start, current_end, anchor_plaud_dur);
                sqlx::query(
                    "INSERT OR IGNORE INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, \
                     start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(user_id)
                .bind(&anchor.plaud_file_id)
                .bind(&anchor.id)
                .bind(current_start)
                .bind(anchor_end)
                .bind(anchor_plaud_dur)
                .bind(existing_audio_ms)
                .bind(&current_version)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }

            for (part_index, part, p_start, p_end, p_dur, audio_ms) in &new_part_rows {
                sqlx::query(
                    "INSERT INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, \
                     start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(user_id)
                .bind(&part.id)
                .bind(&anchor.id)
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

            // Atomically supersede any active pipeline jobs inside the commit tx so a racing
            // transcribe worker cannot leave an active pipeline job running on old audio.
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
            let superseded_pipeline_ids: Vec<String> = sqlx::query_scalar(
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

            // Cancel active transcribe jobs and queued summary jobs, and clear stale partial
            // transcripts/enhancements while keeping `recordings.filename` and `title_source`.
            sqlx::query(
                "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ? \
                 WHERE kind = 'transcribe' AND recording_id = ? AND user_id = ? AND state IN ('queued', 'running')",
            )
            .bind(now)
            .bind(now)
            .bind(&anchor.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE jobs SET state = 'cancelled', finished_at = ?, lease_until = NULL, updated_at = ? \
                 WHERE kind = 'summary' AND recording_id = ? AND user_id = ? AND state = 'queued'",
            )
            .bind(now)
            .bind(now)
            .bind(&anchor.id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM transcriptions WHERE recording_id = ? AND user_id = ?")
                .bind(&anchor.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM ai_enhancements WHERE recording_id = ? AND user_id = ?")
                .bind(&anchor.id)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;

            let mut settle_ids: Vec<&str> = new_parts.iter().map(|p| p.id.as_str()).collect();
            settle_ids.push(anchor.plaud_file_id.as_str());
            clear_settle_ids_in(&mut *tx, user_id, &settle_ids, now).await?;

            tx.commit().await?;
            Ok(superseded_pipeline_ids)
        }
        .await;

        let superseded_pipeline_ids = match write_result {
            Ok(ids) => ids,
            Err(e) => {
                if let Some(sibling) = created_sibling_export {
                    let _ = tokio::fs::remove_file(sibling).await;
                }
                return Err(e);
            }
        };

        // Unlink the superseded export path before releasing `local_folder::lock()` so a
        // watcher sharing `autoExportFolder == localStorageFolder` cannot import it as a duplicate.
        if let Some(old_export) = old_export_to_unlink {
            let _ = tokio::fs::remove_file(old_export).await;
        }

        Ok(CommitAction::Committed {
            had_oah_work,
            superseded_pipeline_ids,
        })
    }
    .await;

    // Ensure any unrenamed staged export temp is unlinked immediately.
    drop(prepared_export);

    match action {
        Ok(CommitAction::Committed {
            had_oah_work,
            superseded_pipeline_ids,
        }) => {
            if let Err(e) = state
                .storage
                .delete(&anchor.storage_type, &anchor.storage_path)
                .await
            {
                tracing::warn!(recording = %anchor.id, error = %e, "deleting superseded split audio failed");
            }
            for job_id in superseded_pipeline_ids {
                let _ = tokio::fs::remove_dir_all(
                    state.config.storage_root.join(".pipeline").join(job_id),
                )
                .await;
            }
            Ok(AppendOutcome::Updated {
                recording_id: anchor.id.clone(),
                had_oah_work,
            })
        }
        Ok(CommitAction::DeletedConcurrently) => {
            let _ = state
                .storage
                .delete(new_storage.storage_type, &new_storage.key)
                .await;
            // Record late parts as tombstones under the deleted recording so they never resurrect.
            let mut tx = crate::db::begin_write(&state.db).await?;
            for (part_index, part, p_start, p_end, p_dur, audio_ms) in &new_part_rows {
                sqlx::query(
                    "INSERT OR IGNORE INTO plaud_recording_parts (user_id, plaud_file_id, recording_id, part_index, \
                     start_time, end_time, plaud_duration_ms, audio_duration_ms, plaud_version, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(user_id)
                .bind(&part.id)
                .bind(&anchor.id)
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
            let settle_ids: Vec<&str> = new_parts.iter().map(|p| p.id.as_str()).collect();
            clear_settle_ids_in(&mut *tx, user_id, &settle_ids, now).await?;
            tx.commit().await?;
            Ok(AppendOutcome::Tombstoned)
        }
        Ok(CommitAction::MissingRow) => {
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
                "recording audio changed while appending split parts".into(),
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
pub(crate) fn has_open_split_head(anchors: &[OpenAnchor], new_items: &[Recording]) -> bool {
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
        ChainPlan::Append { .. } => false,
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

    fn anchor(id: &str, plaud_id: &str, sn: &str, start: i64, dur: i64) -> OpenAnchor {
        OpenAnchor {
            id: id.into(),
            device_sn: sn.into(),
            plaud_file_id: plaud_id.into(),
            duration: dur,
            filesize: 1024,
            storage_type: "local".into(),
            storage_path: format!("u1/{plaud_id}.ogg"),
            auto_export_path: None,
            last_part_index: 0,
            last_start_time: start,
            last_end_time: start + dur,
            last_plaud_duration_ms: dur,
            has_parts: false,
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
            ChainPlan::Append { anchor, parts } => {
                assert_eq!(anchor.id, "rec-1");
                let ids: Vec<&str> = parts.iter().map(|p| p.id.as_str()).collect();
                assert_eq!(ids, vec!["p1", "p2"]);
            }
            other => panic!("expected Append, got {other:?}"),
        }
        // Ends with 2h tail -> immediate append with no settle wait.
        assert!(settle_tip_id(&plans[0]).is_none());
    }

    #[test]
    fn settle_tip_applies_only_to_ceiling_tips_below_24h() {
        let single_5h = ChainPlan::Single(rec("p0", Some("SN1"), BASE_START, FIVE_HOURS));
        assert_eq!(settle_tip_id(&single_5h), Some("p0"));

        let single_2h = ChainPlan::Single(rec("p0", Some("SN1"), BASE_START, TWO_HOURS));
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
            prepare_desktop_export_update(
                &state,
                "u1",
                &open,
                &anchor_ogg,
                1000,
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
            prepare_desktop_export_update(
                &state,
                "u1",
                &open,
                &anchor_ogg,
                1000,
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
            prepare_desktop_export_update(
                &state,
                "u1",
                &open,
                &anchor_ogg,
                1000,
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
        let out = execute_late_append(&state, "u1", &client, &open, &[p1])
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
}
