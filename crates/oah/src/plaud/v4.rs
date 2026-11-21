//! Plaud 4.0 models, ID mapping, timezone conversion, and response adapters.

use serde::Deserialize;
use serde_json::{Value, json};

use super::api::{PlaudError, Recording};

pub const MIGRATED_STATUS: i64 = -1800907;
pub const VERSION_CONFLICT_STATUS: i64 = -1800313;
pub const TOKEN_REVOKED_STATUSES: [i64; 2] = [-419, -420];

fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

pub fn has_non_empty(opt: &Option<String>) -> bool {
    opt.as_deref().is_some_and(|s| !s.trim().is_empty())
}

pub fn is_token_revoked_status(status: i64) -> bool {
    TOKEN_REVOKED_STATUSES.contains(&status)
}

/// True when a Plaud API error indicates the account moved to 4.0 routes.
pub fn is_migrated_error(err: &PlaudError) -> bool {
    match err {
        PlaudError::Api { status, message } => {
            *status == MIGRATED_STATUS || message.to_ascii_lowercase().contains("migrated to 4.0")
        }
        _ => false,
    }
}

/// True when a raw Plaud JSON body indicates the account moved to 4.0 routes.
pub fn is_migrated_payload(body: &Value) -> bool {
    if body.get("status").and_then(Value::as_i64) == Some(MIGRATED_STATUS) {
        return true;
    }
    body.get("msg")
        .and_then(Value::as_str)
        .is_some_and(|m| m.to_ascii_lowercase().contains("migrated to 4.0"))
}

/// Converts a 4.0 `file_id` to the local `plaud_file_id` stored in SQLite.
/// Pre-migration items drop their `of_` prefix so they match existing rows and tombstones.
pub fn v4_file_id_to_local(v4_id: &str) -> String {
    v4_id.strip_prefix("of_").unwrap_or(v4_id).to_owned()
}

/// Converts a local `plaud_file_id` to the 4.0 `file_id` expected by `/file-app/v4/` routes.
pub fn local_id_to_v4_file_id(local_id: &str) -> String {
    if local_id.starts_with("f_") || local_id.starts_with("of_") {
        local_id.to_owned()
    } else {
        format!("of_{local_id}")
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4RecordingItem {
    pub file_id: String,
    #[allow(dead_code)]
    #[serde(default)]
    pub node_id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub created_at_show_ms: Option<i64>,
    #[serde(default)]
    pub updated_at_show_ms: Option<i64>,
    #[serde(default)]
    pub version_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4FolderInfo {
    #[serde(default, alias = "node_id", alias = "id")]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4Breadcrumb {
    #[serde(default, alias = "folder_id", alias = "id")]
    pub node_id: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4Node {
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub version_ms: Option<i64>,
    #[serde(default)]
    pub folder: Option<V4FolderInfo>,
    #[serde(default)]
    pub display_folder: Option<V4FolderInfo>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub breadcrumbs: Vec<V4Breadcrumb>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4FileMeta {
    #[allow(dead_code)]
    #[serde(default)]
    pub file_id: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub timezone_iana: Option<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub serial_number: Option<String>,
    #[serde(default)]
    pub version_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4FileObject {
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub object_type: Option<String>,
    #[serde(default)]
    pub content_id: Option<String>,
    #[serde(default)]
    pub content_url: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub task_status: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V4FileDetail {
    #[serde(default)]
    pub node: Option<V4Node>,
    #[serde(default)]
    pub meta: Option<V4FileMeta>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub objects: Vec<V4FileObject>,
}

/// Maps a 4.0 list item into the shared `Recording` shape before lazy detail hydration.
pub fn map_list_item(item: &V4RecordingItem) -> Recording {
    let edit_time = match (item.updated_at_show_ms, item.version_ms) {
        (Some(u), Some(v)) => Some(u.max(v)),
        (u, v) => u.or(v),
    };
    let version_ms = item
        .version_ms
        .or(item.updated_at_show_ms)
        .or(item.created_at_show_ms);
    let start_time = item.created_at_show_ms;
    let end_time = start_time.map(|start| start.saturating_add(item.duration_ms.unwrap_or(0)));
    Recording {
        id: v4_file_id_to_local(&item.file_id),
        filename: item.name.clone(),
        duration: item.duration_ms,
        start_time,
        end_time,
        filesize: None,
        file_md5: None,
        serial_number: None,
        version_ms,
        timezone: None,
        zonemins: None,
        scene: None,
        edit_time,
        is_v4: true,
    }
}

/// Sorts recordings by edit time descending, breaking ties by start time descending.
pub fn sort_recordings_desc(items: &mut [Recording]) {
    items.sort_by(|a, b| {
        b.edit_time
            .unwrap_or(0)
            .cmp(&a.edit_time.unwrap_or(0))
            .then_with(|| b.start_time.unwrap_or(0).cmp(&a.start_time.unwrap_or(0)))
    });
}

/// Converts an IANA timezone name into `(hours, minutes)` UTC offset at `at_ms`.
pub fn iana_offset_parts(iana: &str, at_ms: i64) -> Option<(i64, i64)> {
    let iana = iana.trim();
    if iana.is_empty() {
        return None;
    }
    let tz = jiff::tz::TimeZone::get(iana).ok()?;
    let ts = jiff::Timestamp::from_millisecond(at_ms).ok()?;
    let offset = tz.to_offset(ts);
    let total_mins = i64::from(offset.seconds()) / 60;
    Some((total_mins / 60, total_mins % 60))
}

/// Ranks playable audio objects: ready `AUDIO_TRANSCODED` first, then `AUDIO`,
/// preferring direct `content_url` over `content_id`-only entries.
/// Unready `AUDIO_TRANSCODED` tasks (`task_status` other than `1`) are skipped.
pub fn select_audio_candidates(detail: &V4FileDetail) -> Vec<&V4FileObject> {
    let mut ranked: Vec<(u8, u8, u8, &V4FileObject)> = detail
        .objects
        .iter()
        .filter_map(|obj| {
            let kind = obj.object_type.as_deref()?.to_ascii_uppercase();
            let has_url = has_non_empty(&obj.content_url);
            let has_id = has_non_empty(&obj.content_id);
            if !has_url && !has_id {
                return None;
            }
            let (ready_rank, type_rank) = match kind.as_str() {
                "AUDIO_TRANSCODED" => match obj.task_status {
                    Some(1) => (0, 0),
                    None if has_url => (0, 0),
                    None => (1, 0),
                    Some(_) => return None,
                },
                "AUDIO" => match obj.task_status {
                    Some(1) | None => (0, 1),
                    Some(_) => (1, 1),
                },
                _ => return None,
            };
            let source_rank = if has_url { 0 } else { 1 };
            Some((ready_rank, type_rank, source_rank, obj))
        })
        .collect();
    ranked.sort_by_key(|&(r, t, s, _)| (r, t, s));
    ranked.into_iter().map(|(_, _, _, obj)| obj).collect()
}

pub fn is_content_object(obj: &V4FileObject) -> bool {
    matches!(
        obj.object_type
            .as_deref()
            .map(str::to_ascii_uppercase)
            .as_deref(),
        Some("TRANSCRIPT" | "SUMMARY")
    )
}

/// Ready when `task_status == 1` with either URL or content id, or migrated (`task_status == null`) with a URL.
pub fn is_object_ready(obj: &V4FileObject) -> bool {
    let has_url = has_non_empty(&obj.content_url);
    let has_id = has_non_empty(&obj.content_id);
    match obj.task_status {
        Some(1) => has_url || has_id,
        None => has_url,
        _ => false,
    }
}

/// Applies hydrated 4.0 detail fields onto a list recording while keeping the list's change token.
pub fn apply_detail(base: &Recording, detail: &V4FileDetail) -> Recording {
    let mut out = base.clone();
    out.is_v4 = true;

    if let Some(node) = &detail.node {
        if let Some(name) = node
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.filename = Some(name.to_owned());
        }
        if out.version_ms.is_none() {
            out.version_ms = node.version_ms;
        }
    }

    if let Some(meta) = &detail.meta {
        if let Some(sn) = meta
            .serial_number
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            out.serial_number = Some(sn.to_owned());
        }
        if let Some(duration) = meta.duration.filter(|&d| d > 0) {
            out.duration = Some(duration);
        } else if out.duration.is_none() {
            out.duration = meta.duration;
        }
        if let Some(start) = meta.start_time.filter(|&t| t > 0) {
            out.start_time = Some(start);
        } else if out.start_time.is_none() {
            out.start_time = meta.start_time;
        }
        if out.version_ms.is_none() {
            out.version_ms = meta.version_ms;
        }
        if let Some(iana) = meta.timezone_iana.as_deref() {
            let at_ms = out.start_time.unwrap_or(0);
            if let Some((hours, mins)) = iana_offset_parts(iana, at_ms) {
                out.timezone = Some(hours);
                out.zonemins = Some(mins);
            }
        }
    }

    if let Some(start) = out.start_time {
        out.end_time = Some(start.saturating_add(out.duration.unwrap_or(0)));
    }

    out
}

/// Adapts ready 4.0 `TRANSCRIPT` and `SUMMARY` objects into the legacy `content_list` payload.
pub fn detail_to_legacy_content(detail: &V4FileDetail) -> Value {
    let mut content_list = Vec::new();
    for obj in &detail.objects {
        if !is_object_ready(obj) {
            continue;
        }
        let Some(url) = obj
            .content_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let obj_id = obj
            .object_id
            .as_deref()
            .or(obj.content_id.as_deref())
            .unwrap_or_default();
        match obj
            .object_type
            .as_deref()
            .map(str::to_ascii_uppercase)
            .as_deref()
        {
            Some("TRANSCRIPT") => {
                content_list.push(json!({
                    "data_id": format!("source_transaction:{obj_id}"),
                    "data_type": "transaction",
                    "data_link": url,
                    "task_status": 1,
                }));
            }
            Some("SUMMARY") => {
                content_list.push(json!({
                    "data_id": format!("auto_sum:{obj_id}"),
                    "data_type": "auto_sum_note",
                    "data_link": url,
                    "task_status": 1,
                }));
            }
            _ => {}
        }
    }
    json!({
        "content_list": content_list,
        "pre_download_content_list": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(
        object_type: &str,
        content_url: Option<&str>,
        content_id: Option<&str>,
        task_status: Option<i64>,
    ) -> V4FileObject {
        V4FileObject {
            object_id: Some(format!("obj_{object_type}")),
            object_type: Some(object_type.to_owned()),
            content_id: content_id.map(str::to_owned),
            content_url: content_url.map(str::to_owned),
            mime_type: None,
            task_status,
        }
    }

    #[test]
    fn migrated_detection_checks_status_and_message() {
        assert!(is_migrated_error(&PlaudError::Api {
            status: MIGRATED_STATUS,
            message: "anything".into(),
        }));
        assert!(is_migrated_error(&PlaudError::Api {
            status: -1,
            message: "Account Migrated To 4.0 already".into(),
        }));
        assert!(!is_migrated_error(&PlaudError::Api {
            status: -419,
            message: "token revoked".into(),
        }));
        assert!(!is_migrated_error(&PlaudError::Upstream));

        assert!(is_migrated_payload(&json!({ "status": -1800907 })));
        assert!(is_migrated_payload(
            &json!({ "status": -1, "msg": "User migrated to 4.0" })
        ));
        assert!(!is_migrated_payload(&json!({ "status": 0, "msg": "ok" })));
    }

    #[test]
    fn id_mapping_strips_of_and_keeps_f_prefix() {
        assert_eq!(v4_file_id_to_local("of_abc123"), "abc123");
        assert_eq!(v4_file_id_to_local("f_new999"), "f_new999");
        assert_eq!(v4_file_id_to_local("plain_id"), "plain_id");

        assert_eq!(local_id_to_v4_file_id("abc123"), "of_abc123");
        assert_eq!(local_id_to_v4_file_id("of_abc123"), "of_abc123");
        assert_eq!(local_id_to_v4_file_id("f_new999"), "f_new999");
    }

    #[test]
    fn list_mapping_and_desc_sorting_handle_edits_and_ties() {
        let older_edited = map_list_item(&V4RecordingItem {
            file_id: "of_old".into(),
            node_id: Some("n1".into()),
            parent_id: Some("p1".into()),
            name: Some("Old Edited".into()),
            duration_ms: Some(5_000),
            created_at_show_ms: Some(1_000),
            updated_at_show_ms: Some(9_000),
            version_ms: Some(8_000),
        });
        assert_eq!(older_edited.id, "old");
        assert_eq!(older_edited.edit_time, Some(9_000));
        assert_eq!(older_edited.version_ms, Some(8_000));
        assert_eq!(older_edited.end_time, Some(6_000));
        assert!(older_edited.is_v4);

        let tie_newer_start = map_list_item(&V4RecordingItem {
            file_id: "f_tie_a".into(),
            node_id: None,
            parent_id: None,
            name: Some("Tie Newer".into()),
            duration_ms: Some(1_000),
            created_at_show_ms: Some(5_000),
            updated_at_show_ms: None,
            version_ms: Some(7_000),
        });
        let tie_older_start = map_list_item(&V4RecordingItem {
            file_id: "f_tie_b".into(),
            node_id: None,
            parent_id: None,
            name: Some("Tie Older".into()),
            duration_ms: Some(1_000),
            created_at_show_ms: Some(4_000),
            updated_at_show_ms: Some(7_000),
            version_ms: None,
        });
        assert_eq!(tie_older_start.version_ms, Some(7_000));

        let mut list = vec![tie_older_start, tie_newer_start, older_edited];
        sort_recordings_desc(&mut list);
        let ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["old", "f_tie_a", "f_tie_b"]);
    }

    #[test]
    fn iana_offset_handles_dst_and_fractional_zones() {
        // 2026-01-15T12:00:00Z (winter) vs 2026-07-15T12:00:00Z (summer)
        let winter = 1_768_478_400_000;
        let summer = 1_784_116_800_000;
        assert_eq!(
            iana_offset_parts("America/Los_Angeles", winter),
            Some((-8, 0))
        );
        assert_eq!(
            iana_offset_parts("America/Los_Angeles", summer),
            Some((-7, 0))
        );
        assert_eq!(iana_offset_parts("Asia/Kolkata", winter), Some((5, 30)));
        assert_eq!(
            iana_offset_parts("America/St_Johns", winter),
            Some((-3, -30))
        );
        assert_eq!(iana_offset_parts("", winter), None);
        assert_eq!(iana_offset_parts("Not/A_Zone", winter), None);
    }

    #[test]
    fn audio_candidates_prefer_transcoded_and_direct_url() {
        let detail = V4FileDetail {
            node: None,
            meta: None,
            objects: vec![
                object("TRANSCRIPT", Some("https://t"), None, Some(1)),
                object("AUDIO", Some("https://raw"), None, Some(1)),
                object("AUDIO_TRANSCODED", None, Some("cid_tr"), Some(1)),
                object("AUDIO_TRANSCODED", Some("https://tr"), None, Some(1)),
                object("AUDIO_TRANSCODED", Some("https://pending"), None, Some(0)),
                object("AUDIO", None, None, Some(0)),
            ],
        };
        let ranked = select_audio_candidates(&detail);
        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].content_url.as_deref(), Some("https://tr"));
        assert_eq!(ranked[1].content_id.as_deref(), Some("cid_tr"));
        assert_eq!(ranked[2].content_url.as_deref(), Some("https://raw"));

        // Unready AUDIO_TRANSCODED is skipped so ready AUDIO wins.
        let pending_detail = V4FileDetail {
            node: None,
            meta: None,
            objects: vec![
                object("AUDIO_TRANSCODED", None, Some("cid_pending"), Some(0)),
                object("AUDIO", Some("https://raw-ready"), None, None),
            ],
        };
        let pending_ranked = select_audio_candidates(&pending_detail);
        assert_eq!(pending_ranked.len(), 1);
        assert_eq!(
            pending_ranked[0].content_url.as_deref(),
            Some("https://raw-ready")
        );
    }

    #[test]
    fn object_readiness_handles_status_1_and_migrated_null() {
        assert!(is_object_ready(&object(
            "TRANSCRIPT",
            Some("https://t"),
            None,
            Some(1)
        )));
        assert!(is_object_ready(&object(
            "TRANSCRIPT",
            None,
            Some("cid"),
            Some(1)
        )));
        assert!(!is_object_ready(&object("TRANSCRIPT", None, None, Some(1))));
        assert!(is_object_ready(&object(
            "SUMMARY",
            Some("https://s"),
            None,
            None
        )));
        assert!(!is_object_ready(&object(
            "SUMMARY",
            None,
            Some("cid"),
            None
        )));
        assert!(!is_object_ready(&object(
            "SUMMARY",
            Some("https://s"),
            None,
            Some(0)
        )));
    }

    #[test]
    fn apply_detail_and_legacy_content_adapter_map_fields() {
        let base = map_list_item(&V4RecordingItem {
            file_id: "f_1".into(),
            node_id: Some("node_f_1".into()),
            parent_id: Some("wrap_f_1".into()),
            name: Some("Initial".into()),
            duration_ms: Some(1_000),
            created_at_show_ms: Some(1_768_478_400_000),
            updated_at_show_ms: Some(1_768_478_500_000),
            version_ms: Some(42),
        });
        let detail = V4FileDetail {
            node: Some(V4Node {
                node_id: Some("node_f_1".into()),
                parent_id: Some("wrap_f_1".into()),
                name: Some("Hydrated Name".into()),
                version_ms: Some(99),
                folder: None,
                display_folder: None,
                breadcrumbs: vec![],
            }),
            meta: Some(V4FileMeta {
                file_id: Some("f_1".into()),
                duration: Some(12_000),
                timezone_iana: Some("Asia/Kolkata".into()),
                start_time: Some(1_768_478_400_000),
                serial_number: Some("SN-400".into()),
                version_ms: Some(99),
            }),
            objects: vec![
                object("TRANSCRIPT", Some("https://t"), None, None),
                object("SUMMARY", Some("https://s"), None, Some(1)),
                object("SUMMARY", Some("https://pending"), None, Some(0)),
            ],
        };
        let hydrated = apply_detail(&base, &detail);
        assert_eq!(hydrated.filename.as_deref(), Some("Hydrated Name"));
        assert_eq!(hydrated.serial_number.as_deref(), Some("SN-400"));
        assert_eq!(hydrated.duration, Some(12_000));
        assert_eq!(hydrated.end_time, Some(1_768_478_412_000));
        // Size and MD5 come from the downloaded bytes, never from Plaud's metadata.
        assert_eq!(hydrated.filesize, None);
        assert_eq!(hydrated.timezone, Some(5));
        assert_eq!(hydrated.zonemins, Some(30));
        // Preserves list version_ms so sync change detection matches next pass.
        assert_eq!(hydrated.version_ms, Some(42));

        let legacy = detail_to_legacy_content(&detail);
        let items = legacy["content_list"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["data_id"], "source_transaction:obj_TRANSCRIPT");
        assert_eq!(items[0]["data_type"], "transaction");
        assert_eq!(items[0]["task_status"], 1);
        assert_eq!(items[1]["data_id"], "auto_sum:obj_SUMMARY");
        assert_eq!(items[1]["data_type"], "auto_sum_note");
        assert_eq!(items[1]["task_status"], 1);
    }
}
