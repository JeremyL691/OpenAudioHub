//! Desktop-only scheduled backups and auto export, plus the 30 s maintenance loop.
//! Rules are in spec/export-backup.md.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::{Map, Value};

use crate::AppState;
use crate::db::now_ms;
use crate::error::ApiResult;
use crate::ids;
use crate::routes::recordings::media;
use crate::routes::settings::effective;

const DAY_MS: i64 = 86_400_000;
const TICK: Duration = Duration::from_secs(30);
/// Backup copies kept in the backup folder.
const KEEP: usize = 5;

/// Starts the maintenance loop: expired archives are removed on every build;
/// scheduled backups and auto export run on the desktop build only.
pub(super) fn spawn(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = super::archive::cleanup(&state).await {
                tracing::warn!(error = %e, "backup cleanup failed");
            }
            if state.config.desktop.is_some() {
                if let Err(e) = scheduled(&state).await {
                    tracing::warn!(error = %e.message, "scheduled backup check failed");
                }
                if let Err(e) = auto_export(&state).await {
                    tracing::warn!(error = %e.message, "auto export check failed");
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

fn interval_ms(frequency: &str) -> Option<i64> {
    match frequency {
        "daily" => Some(DAY_MS),
        "weekly" => Some(7 * DAY_MS),
        "monthly" => Some(30 * DAY_MS),
        _ => None,
    }
}

/// The user's backup folder, or `Documents/OpenAudioHub Backups` in the home folder.
fn backup_folder(settings: &Map<String, Value>) -> PathBuf {
    match settings
        .get("backupFolder")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    {
        Some(path) => PathBuf::from(path),
        None => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join("Documents").join("OpenAudioHub Backups")
        }
    }
}

/// `OpenAudioHub-backup-YYYY-MM-DD.zip`, with an optional `-N` suffix for later copies on the same day.
fn is_backup_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix("OpenAudioHub-backup-")
        .and_then(|r| r.strip_suffix(".zip"))
    else {
        return false;
    };
    let Some(date) = rest.get(..10) else {
        return false;
    };
    let date_ok = date.bytes().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            b == b'-'
        } else {
            b.is_ascii_digit()
        }
    });
    let suffix = &rest[10..];
    let suffix_ok = suffix.is_empty()
        || suffix
            .strip_prefix('-')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    date_ok && suffix_ok
}

/// The newest backup copy's modification time, in Unix milliseconds.
fn newest_copy(folder: &Path) -> Option<i64> {
    std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| is_backup_name(&e.file_name().to_string_lossy()))
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Queues a scheduled backup for each user whose schedule is due.
async fn scheduled(state: &AppState) -> ApiResult<()> {
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM user_settings WHERE json_extract(data, '$.backupFrequency') IN ('daily', 'weekly', 'monthly')",
    )
    .fetch_all(&state.db)
    .await?;
    for user_id in users {
        let settings = effective(state, &user_id).await?;
        let Some(interval) = settings
            .get("backupFrequency")
            .and_then(Value::as_str)
            .and_then(interval_ms)
        else {
            continue;
        };
        let last_job: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(created_at) FROM export_jobs WHERE user_id = ? AND kind = 'scheduled'",
        )
        .bind(&user_id)
        .fetch_one(&state.db)
        .await?;
        let last = last_job
            .into_iter()
            .chain(newest_copy(&backup_folder(&settings)))
            .max();
        if last.is_some_and(|t| now_ms() - t <= interval) {
            continue;
        }
        // A user with an active job is skipped; the next tick checks again.
        super::queue(state, &user_id, "scheduled").await?;
    }
    Ok(())
}

/// Copies a finished archive into the backup folder and keeps only the newest copies.
pub(super) async fn copy_to_folder(
    state: &AppState,
    user_id: &str,
    archive: &Path,
) -> Result<(), String> {
    let settings = effective(state, user_id).await.map_err(|e| e.message)?;
    let folder = backup_folder(&settings);
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|e| e.to_string())?;
    let date = crate::routes::recordings::local_date().await;
    let name = free_name(&folder, &date).await;
    let tmp = folder.join(format!(".copy-{}.partial", ids::new_id()));
    tokio::fs::copy(archive, &tmp)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = tokio::fs::rename(&tmp, folder.join(&name)).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e.to_string());
    }
    prune(&folder);
    Ok(())
}

async fn free_name(folder: &Path, date: &str) -> String {
    let base = format!("OpenAudioHub-backup-{date}");
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{base}.zip")
        } else {
            format!("{base}-{n}.zip")
        };
        if !tokio::fs::try_exists(folder.join(&name))
            .await
            .unwrap_or(false)
        {
            return name;
        }
        n += 1;
    }
}

/// Deletes backup copies beyond the newest `KEEP`. Other files are never touched.
fn prune(folder: &Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let mut copies: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| is_backup_name(&e.file_name().to_string_lossy()))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    copies.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in copies.into_iter().skip(KEEP) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(error = %e, "could not prune old backup copy");
        }
    }
}

/// Auto export is on for these users. The first time it is seen on, uploads from then on are exported.
async fn auto_export(state: &AppState) -> ApiResult<()> {
    const ON: &str = "json_extract(data, '$.autoExport') = 1";
    let users: Vec<String> =
        sqlx::query_scalar(&format!("SELECT user_id FROM user_settings WHERE {ON}"))
            .fetch_all(&state.db)
            .await?;
    sqlx::query(&format!("DELETE FROM auto_export_state WHERE user_id NOT IN (SELECT user_id FROM user_settings WHERE {ON})"))
        .execute(&state.db)
        .await?;
    for user_id in users {
        let settings = effective(state, &user_id).await?;
        let Some(folder) = settings
            .get("autoExportFolder")
            .and_then(Value::as_str)
            .filter(|f| !f.is_empty())
        else {
            continue;
        };
        let folder = PathBuf::from(folder);
        // The "new recordings from now" window opens when auto export was switched on. The
        // settings row's timestamp covers a state row that is missing (for example right
        // after a data import).
        let settings_updated_at: Option<i64> =
            sqlx::query_scalar("SELECT updated_at FROM user_settings WHERE user_id = ?")
                .bind(&user_id)
                .fetch_optional(&state.db)
                .await?;
        sqlx::query(
            "INSERT INTO auto_export_state (user_id, since) VALUES (?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(&user_id)
        .bind(now_ms().min(settings_updated_at.unwrap_or(i64::MAX)))
        .execute(&state.db)
        .await?;
        if let Err(e) = export_new(state, &user_id, &folder, &settings).await {
            tracing::warn!(error = %e, "auto export failed");
        }
    }
    Ok(())
}

/// Exports recordings uploaded since auto export was switched on, then applies AI title renames.
async fn export_new(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    settings: &Map<String, Value>,
) -> Result<(), String> {
    let since: i64 = sqlx::query_scalar("SELECT since FROM auto_export_state WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    let mode = settings
        .get("autoExportTitleMode")
        .and_then(Value::as_str)
        .unwrap_or("original");
    let original = settings.get("autoExportFormat").and_then(Value::as_str) == Some("original");
    let offset = crate::routes::recordings::local_offset().await;
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|e| e.to_string())?;
    if mode == "ai" {
        rename_ai_titles(state, user_id, folder, offset).await?;
    }

    let pending: Vec<(String, i64, String, String, String)> = sqlx::query_as(
        "SELECT id, start_time, storage_type, storage_path, filename FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_path IS NULL AND created_at >= ? ORDER BY created_at LIMIT 50",
    )
    .bind(user_id)
    .bind(since)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    for (id, start, storage_type, storage_path, encrypted_title) in pending {
        let stored_ext = ext_of(&storage_path);
        let transcode = !original && stored_ext != "mp3";
        let ext = if original {
            if stored_ext.is_empty() {
                "mp3".to_owned()
            } else {
                stored_ext
            }
        } else {
            "mp3".to_owned()
        };
        let stem = match mode {
            "date" | "ai" => date_stem(start, offset),
            _ => safe_name(&title_of(state, &encrypted_title), &id),
        };
        let stem = strip_extension(&stem, &ext);
        let dest = unique_path(folder, &stem, &ext).await;
        // Written under a temporary name, then renamed, so a partial file never looks finished.
        let tmp = folder.join(format!(".{}.partial", ids::new_id()));
        let written = if transcode {
            match state
                .storage
                .materialize(&storage_type, &storage_path)
                .await
            {
                Ok(source) => media::to_mp3(&state.config.ffmpeg, source.path(), &tmp).await,
                Err(_) => false,
            }
        } else {
            state
                .storage
                .get_file(&storage_type, &storage_path, &tmp)
                .await
                .is_ok()
        };
        if !written {
            let _ = tokio::fs::remove_file(&tmp).await;
            tracing::warn!(recording = id, "auto export could not write the file");
            continue;
        }
        if let Err(e) = tokio::fs::rename(&tmp, &dest).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            tracing::warn!(recording = id, error = %e, "auto export could not rename the file");
            continue;
        }
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = ?")
            .bind(state.config.field_key.encrypt(&dest.to_string_lossy()))
            .bind(&id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// With AI titles on, an export still named by its date gets renamed to the title once one exists.
async fn rename_ai_titles(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    offset: ::time::UtcOffset,
) -> Result<(), String> {
    let exported: Vec<(String, i64, String, String)> = sqlx::query_as(
        "SELECT id, start_time, auto_export_path, filename FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_path IS NOT NULL",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for (id, start, encrypted_path, encrypted_title) in exported {
        // The stored path is encrypted; a plain value passes through.
        let Some(stored_path) = decrypt_path(state, &encrypted_path) else {
            continue;
        };
        let path = PathBuf::from(stored_path);
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        // Only a file still named by its date is renamed; a user's own rename stays.
        if stem != date_stem(start, offset) {
            continue;
        }
        let ext = ext_of(&path.to_string_lossy());
        let ext = if ext.is_empty() {
            "mp3".to_owned()
        } else {
            ext
        };
        let desired = strip_extension(&safe_name(&title_of(state, &encrypted_title), &id), &ext);
        if desired.to_lowercase() == stem.to_lowercase() {
            continue;
        }
        let dest = unique_path(folder, &desired, &ext).await;
        if tokio::fs::rename(&path, &dest).await.is_err() {
            continue;
        }
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = ?")
            .bind(state.config.field_key.encrypt(&dest.to_string_lossy()))
            .bind(&id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The stored export path, decrypted. Ciphertext that cannot be opened is skipped.
fn decrypt_path(state: &AppState, stored: &str) -> Option<String> {
    match state.config.field_key.decrypt(stored) {
        Ok(path) if !path.is_empty() => Some(path),
        _ => None,
    }
}

fn title_of(state: &AppState, encrypted: &str) -> String {
    state
        .config
        .field_key
        .decrypt(encrypted)
        .unwrap_or_default()
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// `YYYY-MM-DD` in local time.
fn date_stem(start: i64, offset: ::time::UtcOffset) -> String {
    let t = ::time::OffsetDateTime::from_unix_timestamp_nanos(start as i128 * 1_000_000)
        .unwrap_or(::time::OffsetDateTime::UNIX_EPOCH)
        .to_offset(offset);
    format!("{:04}-{:02}-{:02}", t.year(), t.month() as u8, t.day())
}

/// A title as a file name: control characters are
/// dropped, the listed symbols become `-`, whitespace runs collapse to one space, the result
/// is trimmed and capped at 200 characters, and reserved Windows names get a `_` prefix.
/// Falls back to the id when nothing is left.
fn safe_name(title: &str, fallback: &str) -> String {
    let cleaned = sanitized_title(title).or_else(|| sanitized_title(fallback));
    escape_windows_reserved(&cleaned.unwrap_or_else(|| "recording".to_owned()))
}

fn sanitized_title(value: &str) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in value.chars() {
        let code = c as u32;
        if code < 32 || code == 127 {
            continue;
        }
        if c.is_whitespace() {
            if !space {
                space = true;
                out.push(' ');
            }
            continue;
        }
        space = false;
        out.push(if "/\\:*?\"<>|".contains(c) { '-' } else { c });
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return None;
    }
    let capped: String = trimmed.chars().take(200).collect();
    let capped = capped.trim().to_owned();
    (!capped.is_empty()).then_some(capped)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, alone or with one extension,
/// are invalid file names on Windows, so they are prefixed with `_`.
fn escape_windows_reserved(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let (base, rest) = match lower.split_once('.') {
        Some((base, rest)) => (base, Some(rest)),
        None => (lower.as_str(), None),
    };
    let fixed = matches!(base, "con" | "prn" | "aux" | "nul");
    let numbered = base.len() == 4
        && (base.starts_with("com") || base.starts_with("lpt"))
        && matches!(base.as_bytes()[3], b'1'..=b'9');
    let one_extension = rest.is_none_or(|r| !r.is_empty() && !r.contains('.'));
    if (fixed || numbered) && one_extension {
        format!("_{name}")
    } else {
        name.to_owned()
    }
}

/// A title that already ends with the extension loses it first,
/// so the export is not named `x.mp3.mp3`.
fn strip_extension(stem: &str, ext: &str) -> String {
    let suffix = format!(".{}", ext.to_lowercase());
    let lower = stem.to_lowercase();
    if lower.ends_with(&suffix) {
        stem[..stem.len() - suffix.len()].to_owned()
    } else {
        stem.to_owned()
    }
}

/// `stem.ext`, or `stem (2).ext` and so on when that name is taken. Existing files are never overwritten.
async fn unique_path(folder: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let path = folder.join(name);
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return path;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_names_match_the_pattern() {
        assert!(is_backup_name("OpenAudioHub-backup-2026-10-16.zip"));
        assert!(is_backup_name("OpenAudioHub-backup-2026-10-16-2.zip"));
        assert!(!is_backup_name("OpenAudioHub-backup-2026-10-16-x.zip"));
        assert!(!is_backup_name("notes.zip"));
        assert!(!is_backup_name(
            "OpenAudioHub-backup-2026-10-16.zip.partial"
        ));
    }

    #[test]
    fn interval_for_each_frequency() {
        assert_eq!(interval_ms("daily"), Some(DAY_MS));
        assert_eq!(interval_ms("weekly"), Some(7 * DAY_MS));
        assert_eq!(interval_ms("never"), None);
    }

    #[test]
    fn names_are_sanitised_like_1x() {
        assert_eq!(safe_name("a/b: c", "id"), "a-b- c");
        assert_eq!(safe_name("  ", "rec_1"), "rec_1");
        assert_eq!(safe_name("a\nb\t c", "id"), "ab c");
        assert_eq!(safe_name("CON", "id"), "_CON");
        assert_eq!(safe_name("lpt3.txt", "id"), "_lpt3.txt");
        assert_eq!(safe_name("con.foo.bar", "id"), "con.foo.bar");
        assert_eq!(safe_name(&"x".repeat(250), "id").chars().count(), 200);
    }

    #[test]
    fn dates_are_local_and_extension_is_not_repeated() {
        let offset = ::time::UtcOffset::from_hms(-7, 0, 0).unwrap();
        // 1970-01-01T05:00:00Z is 1969-12-31 22:00 in UTC-7.
        assert_eq!(date_stem(18_000_000, offset), "1969-12-31");
        assert_eq!(date_stem(0, ::time::UtcOffset::UTC), "1970-01-01");
        assert_eq!(strip_extension("recording.mp3", "mp3"), "recording");
        assert_eq!(strip_extension("recording.MP3", "mp3"), "recording");
        assert_eq!(strip_extension("recording.ogg", "mp3"), "recording.ogg");
    }
}
