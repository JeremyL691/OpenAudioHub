//! Desktop-only auto export of new recordings and its 30 second check.
//! Rules are in spec/export.md.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::AppState;
use crate::error::ApiResult;
use crate::ids;
use crate::routes::recordings::media;
use crate::routes::settings::effective;

const TICK: Duration = Duration::from_secs(30);
/// Failed auto-export writes before a recording is left alone until the folder or format changes.
const MAX_ATTEMPTS: i64 = 3;

/// Starts the auto export check. Other builds have nothing to do.
pub(crate) fn spawn(state: &AppState) {
    if state.config.desktop.is_none() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(e) = auto_export(&state).await {
                tracing::warn!(error = %e.message, "auto export check failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// The export format a user's settings ask for, or `mp3` when the value is not one of them.
fn format_of(settings: &Map<String, Value>) -> &'static str {
    match settings.get("autoExportFormat").and_then(Value::as_str) {
        Some("ogg") => "ogg",
        Some("original") => "original",
        _ => "mp3",
    }
}

/// Whether a recording added right now should be auto exported. Read when a row is first added,
/// so a recording that arrives while auto export is on is exported once, and one that arrived
/// before it was on is never exported.
pub(crate) async fn auto_export_eligible(state: &AppState, user_id: &str) -> bool {
    if state.config.desktop.is_none() {
        return false;
    }
    let settings = match effective(state, user_id).await {
        Ok(settings) => settings,
        Err(_) => return false,
    };
    settings.get("autoExport") == Some(&Value::Bool(true))
        && settings
            .get("autoExportFolder")
            .and_then(Value::as_str)
            .is_some_and(|folder| !folder.is_empty())
}

/// The extension a recording is exported with, for a given format.
///
/// An Opus file is an Ogg container, so `original` saves it with the `.ogg` extension the user
/// expects while the bytes stay untouched.
fn export_ext(format: &str, stored_ext: &str) -> String {
    match format {
        "original" if stored_ext == "opus" => "ogg".to_owned(),
        "original" if !stored_ext.is_empty() => stored_ext.to_owned(),
        "original" => "mp3".to_owned(),
        "ogg" => "ogg".to_owned(),
        _ => "mp3".to_owned(),
    }
}

/// Whether a stored file already is what the format asks for, so a copy is enough.
fn matches_format(format: &str, stored_ext: &str) -> bool {
    match format {
        "original" => true,
        "ogg" => matches!(stored_ext, "ogg" | "opus"),
        _ => stored_ext == "mp3",
    }
}

/// Writes the audio into `dst` in the requested format. False when the conversion failed, in
/// which case no file is left at `dst`.
async fn write_audio(
    state: &AppState,
    format: &str,
    storage_type: &str,
    storage_path: &str,
    stored_ext: &str,
    dst: &Path,
) -> bool {
    if matches_format(format, stored_ext) {
        return state
            .storage
            .get_file(storage_type, storage_path, dst)
            .await
            .is_ok();
    }
    let Ok(source) = state.storage.materialize(storage_type, storage_path).await else {
        return false;
    };
    match format {
        "ogg" => media::to_ogg_opus(&state.config.ffmpeg, source.path(), dst).await,
        _ => media::to_mp3(&state.config.ffmpeg, source.path(), dst).await,
    }
}

/// Runs auto export for every user that has it on and a folder set.
async fn auto_export(state: &AppState) -> ApiResult<()> {
    const ON: &str = "json_extract(data, '$.autoExport') = 1";
    let users: Vec<String> =
        sqlx::query_scalar(&format!("SELECT user_id FROM user_settings WHERE {ON}"))
            .fetch_all(&state.db)
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
        if let Err(e) = export_new(state, &user_id, Path::new(folder), &settings).await {
            tracing::warn!(error = %e, "auto export failed");
        }
    }
    Ok(())
}

/// Exports each eligible recording once, then applies AI title renames.
///
/// A folder or format change resets the retry count, so a fixed folder resumes failed writes.
async fn export_new(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    settings: &Map<String, Value>,
) -> Result<(), String> {
    let mode = settings
        .get("autoExportTitleMode")
        .and_then(Value::as_str)
        .unwrap_or("original");
    let format = format_of(settings);
    tokio::fs::create_dir_all(folder)
        .await
        .map_err(|e| e.to_string())?;
    reset_attempts_on_change(state, user_id, folder, format).await?;
    if mode == "ai" {
        rename_ai_titles(state, user_id, folder).await?;
    }
    export_pending(state, user_id, folder, mode, format).await?;
    if format == "original" {
        normalize_opus_exports(state, user_id, folder, mode).await?;
    }
    reexport_outdated(state, user_id, folder, mode, format).await
}

/// Renames previous automatic exports of an Opus file from `.opus` to `.ogg`, the container's
/// name, without rewriting a byte. Only a file this app wrote, still at the recorded path and
/// still under the automatic name is touched, and only while it is byte-identical to the stored
/// audio. A file the user changed or renamed stays. The new file is in place before the old one
/// goes; a failed pass keeps the old file for the next one.
async fn normalize_opus_exports(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    mode: &str,
) -> Result<(), String> {
    let exported: Vec<(String, i64, String, String, String)> = sqlx::query_as(
        "SELECT id, start_time, auto_export_path, filename, title_source FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_path IS NOT NULL AND auto_export_attempts < ?",
    )
    .bind(user_id)
    .bind(MAX_ATTEMPTS)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for (id, start, encrypted_path, encrypted_title, title_source) in exported {
        let Some(stored_path) = decrypt_path(state, &encrypted_path) else {
            continue;
        };
        if ext_of(&stored_path) != "opus" {
            continue;
        }
        let path = PathBuf::from(&stored_path);
        if !path.exists() || path.parent() != Some(folder) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        let automatic = match mode {
            "date" => is_numbered(&stem, &date_stem(start).await),
            "ai" => {
                is_numbered(&stem, &date_stem(start).await)
                    || (title_source == "ai"
                        && is_numbered(&stem, &safe_name(&title_of(state, &encrypted_title), &id)))
            }
            _ => is_numbered(&stem, &safe_name(&title_of(state, &encrypted_title), &id)),
        };
        if !automatic {
            continue;
        }
        let (storage_type, storage_path): (String, String) =
            sqlx::query_as("SELECT storage_type, storage_path FROM recordings WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .map_err(|e| e.to_string())?;
        if !matches!(ext_of(&storage_path).as_str(), "opus" | "ogg") {
            continue;
        }
        let Ok(source) = state
            .storage
            .materialize(&storage_type, &storage_path)
            .await
        else {
            continue;
        };
        // A file that no longer matches the stored audio was changed by the user; it stays.
        if !same_bytes(&path, source.path()).await {
            continue;
        }
        let target = folder.join(format!("{stem}.ogg"));
        let dest = if tokio::fs::try_exists(&target).await.unwrap_or(false) {
            // A pass that stopped after writing the new file left it here; adopting it keeps a
            // retry from writing a second copy beside it.
            if same_bytes(&target, source.path()).await {
                target
            } else {
                unique_path(folder, &stem, "ogg").await
            }
        } else {
            target
        };
        if !tokio::fs::try_exists(&dest).await.unwrap_or(false) {
            let tmp = folder.join(format!(".{}.partial", ids::new_id()));
            if tokio::fs::copy(&path, &tmp).await.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
                count_failure(state, &id).await;
                continue;
            }
            if tokio::fs::rename(&tmp, &dest).await.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
                count_failure(state, &id).await;
                continue;
            }
        }
        // The row points at the new name first, so a failure between the steps cannot leave an
        // unrecorded file behind.
        finish(state, &id, &dest).await?;
        let _ = tokio::fs::remove_file(&path).await;
    }
    Ok(())
}

/// Whether two files hold the same bytes. Sizes are compared before any content is read.
async fn same_bytes(a: &Path, b: &Path) -> bool {
    use tokio::io::AsyncReadExt;
    let (Ok(ma), Ok(mb)) = (tokio::fs::metadata(a).await, tokio::fs::metadata(b).await) else {
        return false;
    };
    if ma.len() != mb.len() {
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

/// Clears the retry count of every recording when the folder or format differs from the last pass.
async fn reset_attempts_on_change(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    format: &str,
) -> Result<(), String> {
    let signature = format!("{}|{}", folder.to_string_lossy(), format);
    let previous: Option<String> =
        sqlx::query_scalar("SELECT signature FROM auto_export_run WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    if previous.as_deref() == Some(signature.as_str()) {
        return Ok(());
    }
    sqlx::query("UPDATE recordings SET auto_export_attempts = 0 WHERE user_id = ? AND auto_export_eligible = 1")
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO auto_export_run (user_id, signature) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET signature = excluded.signature",
    )
    .bind(user_id)
    .bind(&signature)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Writes every eligible recording that has no finished export yet.
async fn export_pending(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    mode: &str,
    format: &str,
) -> Result<(), String> {
    let pending: Vec<(String, i64, String, String, String)> = sqlx::query_as(
        "SELECT id, start_time, storage_type, storage_path, filename FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_eligible = 1 AND auto_export_path IS NULL AND auto_export_attempts < ? ORDER BY created_at LIMIT 50",
    )
    .bind(user_id)
    .bind(MAX_ATTEMPTS)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    for (id, start, storage_type, storage_path, encrypted_title) in pending {
        let stored_ext = ext_of(&storage_path);
        let ext = export_ext(format, &stored_ext);
        let stem = match mode {
            "date" | "ai" => date_stem(start).await,
            _ => safe_name(&title_of(state, &encrypted_title), &id),
        };
        let stem = strip_extension(&stem, &ext);
        // A reserved target from an interrupted pass is adopted, so a crash cannot leave two copies.
        let reserved: Option<String> =
            sqlx::query_scalar("SELECT auto_export_target FROM recordings WHERE id = ?")
                .bind(&id)
                .fetch_optional(&state.db)
                .await
                .map_err(|e| e.to_string())?
                .flatten();
        let dest = match reserved.as_deref().and_then(|p| decrypt_path(state, p)) {
            Some(path) if Path::new(&path).exists() => {
                // The interrupted pass had already written this file, so record it and move on.
                finish(state, &id, Path::new(&path)).await?;
                continue;
            }
            Some(path) => PathBuf::from(path),
            None => unique_path(folder, &stem, &ext).await,
        };
        if reserved.is_none() {
            sqlx::query("UPDATE recordings SET auto_export_target = ? WHERE id = ?")
                .bind(state.config.field_key.encrypt(&dest.to_string_lossy()))
                .bind(&id)
                .execute(&state.db)
                .await
                .map_err(|e| e.to_string())?;
        }
        // Written under a temporary name, then renamed, so a partial file never looks finished.
        let tmp = folder.join(format!(".{}.partial", ids::new_id()));
        if !write_audio(
            state,
            format,
            &storage_type,
            &storage_path,
            &stored_ext,
            &tmp,
        )
        .await
        {
            let _ = tokio::fs::remove_file(&tmp).await;
            count_failure(state, &id).await;
            tracing::warn!(recording = id, "auto export could not write the file");
            continue;
        }
        if let Err(e) = tokio::fs::rename(&tmp, &dest).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            count_failure(state, &id).await;
            tracing::warn!(recording = id, error = %e, "auto export could not rename the file");
            continue;
        }
        finish(state, &id, &dest).await?;
    }
    Ok(())
}

/// Counts one failed write. After `MAX_ATTEMPTS` the recording is left alone until the folder or
/// format changes.
async fn count_failure(state: &AppState, id: &str) {
    if let Err(e) = sqlx::query(
        "UPDATE recordings SET auto_export_attempts = auto_export_attempts + 1 WHERE id = ?",
    )
    .bind(id)
    .execute(&state.db)
    .await
    {
        tracing::warn!(recording = id, error = %e, "could not count an export failure");
    }
}

/// Records a finished export: the path, a cleared reservation and a cleared retry count.
async fn finish(state: &AppState, id: &str, dest: &Path) -> Result<(), String> {
    sqlx::query(
        "UPDATE recordings SET auto_export_path = ?, auto_export_target = NULL, auto_export_attempts = 0 WHERE id = ?",
    )
    .bind(state.config.field_key.encrypt(&dest.to_string_lossy()))
    .bind(id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Re-exports recordings whose saved file no longer matches the chosen format.
///
/// Only files this app wrote, still at the recorded path and still under the automatic name are
/// touched; a file the user renamed is left alone. The old file goes only after the new one is in
/// place.
async fn reexport_outdated(
    state: &AppState,
    user_id: &str,
    folder: &Path,
    mode: &str,
    format: &str,
) -> Result<(), String> {
    if format == "original" {
        return Ok(());
    }
    let exported: Vec<(String, i64, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, start_time, auto_export_path, filename, title_source, auto_export_attempts FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_path IS NOT NULL AND auto_export_attempts < ?",
    )
    .bind(user_id)
    .bind(MAX_ATTEMPTS)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for (id, start, encrypted_path, encrypted_title, title_source, _) in exported {
        let Some(stored_path) = decrypt_path(state, &encrypted_path) else {
            continue;
        };
        let path = PathBuf::from(&stored_path);
        if ext_of(&stored_path) == export_ext(format, &ext_of(&stored_path)) {
            continue;
        }
        if !path.exists() || path.parent() != Some(folder) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        // Only a file still under the automatic name is replaced.
        let automatic = match mode {
            "date" => is_numbered(&stem, &date_stem(start).await),
            "ai" => {
                is_numbered(&stem, &date_stem(start).await)
                    || (title_source == "ai"
                        && is_numbered(&stem, &safe_name(&title_of(state, &encrypted_title), &id)))
            }
            _ => is_numbered(&stem, &safe_name(&title_of(state, &encrypted_title), &id)),
        };
        if !automatic {
            continue;
        }
        let ext = export_ext(format, &ext_of(&stored_path));
        let dest = unique_path(folder, &stem, &ext).await;
        let tmp = folder.join(format!(".{}.partial", ids::new_id()));
        let (storage_type, storage_path): (String, String) =
            sqlx::query_as("SELECT storage_type, storage_path FROM recordings WHERE id = ?")
                .bind(&id)
                .fetch_one(&state.db)
                .await
                .map_err(|e| e.to_string())?;
        if !write_audio(
            state,
            format,
            &storage_type,
            &storage_path,
            &ext_of(&storage_path),
            &tmp,
        )
        .await
        {
            let _ = tokio::fs::remove_file(&tmp).await;
            count_failure(state, &id).await;
            continue;
        }
        if tokio::fs::rename(&tmp, &dest).await.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
            count_failure(state, &id).await;
            continue;
        }
        // The row points at the new file first, so a failed write of the marker cannot leave an
        // unrecorded export behind.
        finish(state, &id, &dest).await?;
        let _ = tokio::fs::remove_file(&path).await;
    }
    Ok(())
}

/// Whether `stem` is `base` or `base (2)` and so on, the automatic names a clash adds.
fn is_numbered(stem: &str, base: &str) -> bool {
    if stem == base {
        return true;
    }
    let Some(rest) = stem.strip_prefix(base) else {
        return false;
    };
    rest.strip_prefix(" (")
        .and_then(|r| r.strip_suffix(')'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// With AI titles on, an export still named by its date gets renamed once the title comes from AI.
async fn rename_ai_titles(state: &AppState, user_id: &str, folder: &Path) -> Result<(), String> {
    let exported: Vec<(String, i64, String, String, String)> = sqlx::query_as(
        "SELECT id, start_time, auto_export_path, filename, title_source FROM recordings WHERE user_id = ? AND deleted_at IS NULL \
         AND auto_export_path IS NOT NULL",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    for (id, start, encrypted_path, encrypted_title, title_source) in exported {
        // A title the user typed, kept from the upload, or still waiting for the AI keeps the date name.
        if title_source != "ai" {
            continue;
        }
        // The stored path is encrypted; a plain value passes through.
        let Some(stored_path) = decrypt_path(state, &encrypted_path) else {
            continue;
        };
        let path = PathBuf::from(stored_path);
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        // Only a file still named by its date is renamed; a user's own rename stays.
        // A "date (2)" file is still the automatic name.
        let day = date_stem(start).await;
        if !is_numbered(&stem, &day) {
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

/// `YYYY-MM-DD` of the recording's own instant in local time.
async fn date_stem(start: i64) -> String {
    let offset = crate::routes::recordings::local_offset_at(start).await;
    crate::time::local_date(start, offset)
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

/// A title that already ends with the extension loses it first, so the export is not named
/// `x.mp3.mp3`. An Opus file exported as `.ogg` drops either name, since both describe it.
fn strip_extension(stem: &str, ext: &str) -> String {
    let mut suffixes = vec![format!(".{}", ext.to_lowercase())];
    if ext.eq_ignore_ascii_case("ogg") {
        suffixes.push(".opus".to_owned());
    }
    let lower = stem.to_lowercase();
    for suffix in suffixes {
        if lower.ends_with(&suffix) {
            return stem[..stem.len() - suffix.len()].to_owned();
        }
    }
    stem.to_owned()
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
    use crate::db::now_ms;
    use serde_json::json;

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
    fn export_extensions_follow_the_format() {
        assert_eq!(export_ext("mp3", "opus"), "mp3");
        assert_eq!(export_ext("ogg", "mp3"), "ogg");
        assert_eq!(export_ext("ogg", "opus"), "ogg");
        // An Opus file is an Ogg container, so its export carries the container's name.
        assert_eq!(export_ext("original", "opus"), "ogg");
        assert_eq!(export_ext("original", "wav"), "wav");
        assert_eq!(export_ext("original", "ogg"), "ogg");
        assert_eq!(export_ext("original", "mp3"), "mp3");
        assert_eq!(export_ext("original", ""), "mp3");
    }

    #[test]
    fn an_opus_title_does_not_keep_its_extension() {
        assert_eq!(strip_extension("Meeting.opus", "ogg"), "Meeting");
        assert_eq!(strip_extension("Meeting.OPUS", "ogg"), "Meeting");
        assert_eq!(strip_extension("Meeting.ogg", "ogg"), "Meeting");
        assert_eq!(strip_extension("Meeting.opus", "wav"), "Meeting.opus");
    }

    #[test]
    fn a_stored_file_is_reused_only_when_it_already_matches() {
        assert!(matches_format("mp3", "mp3"));
        assert!(!matches_format("mp3", "opus"));
        assert!(matches_format("ogg", "opus"));
        assert!(matches_format("ogg", "ogg"));
        assert!(!matches_format("ogg", "mp3"));
        assert!(matches_format("original", "wav"));
    }

    #[test]
    fn the_format_setting_falls_back_to_mp3() {
        let mut settings = Map::new();
        assert_eq!(format_of(&settings), "mp3");
        settings.insert("autoExportFormat".into(), json!("ogg"));
        assert_eq!(format_of(&settings), "ogg");
        settings.insert("autoExportFormat".into(), json!("original"));
        assert_eq!(format_of(&settings), "original");
        settings.insert("autoExportFormat".into(), json!("flac"));
        assert_eq!(format_of(&settings), "mp3");
    }

    #[test]
    fn a_numbered_automatic_name_is_recognised() {
        let day = "2026-10-18";
        assert!(is_numbered(day, day));
        assert!(is_numbered("2026-10-18 (2)", day));
        assert!(!is_numbered("2026-10-18 (x)", day));
        assert!(!is_numbered("2026-10-18 notes", day));
        assert!(!is_numbered("Team sync", day));
        assert!(is_numbered("Team sync (3)", "Team sync"));
    }

    /// A desktop test server with one user and the given settings.
    async fn desktop_state(settings: serde_json::Value) -> (crate::AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::Config::for_tests(dir.path());
        config.desktop = Some(crate::config::Desktop {
            launch_secret: "0123456789abcdef0123456789abcdef-launch".into(),
            user_id: None,
        });
        let state = crate::AppState::new(config, crate::db::open_memory().await.unwrap());
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@example.test', 0, 0)")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        (state, dir)
    }

    /// Writes a stored recording row. Returns its id.
    async fn add_recording(state: &crate::AppState, id: &str, storage_path: &str, eligible: bool) {
        let key = &state.config.field_key;
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, \
             filesize, file_md5, storage_type, storage_path, downloaded_at, plaud_version, is_trash, created_at, \
             updated_at, title_source, auto_export_eligible) \
             VALUES (?, 'u', 'SN-1', ?, ?, 3000, 1_792_305_000_000, 1_792_305_003_000, 10, '', 'local', ?, 0, '1', 0, ?, ?, 'original', ?)",
        )
        .bind(id)
        .bind(id)
        .bind(key.encrypt("Team sync"))
        .bind(storage_path)
        .bind(now_ms())
        .bind(now_ms())
        .bind(eligible)
        .execute(&state.db)
        .await
        .unwrap();
    }

    /// Copies a real audio file into storage so export has something to write.
    async fn store_audio(state: &crate::AppState, key: &str, source: &Path) {
        let dest = state.config.storage_root.join(key);
        tokio::fs::create_dir_all(dest.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::copy(source, &dest).await.unwrap();
    }

    /// An audio file the tests can export: the fixture the contract suite already ships.
    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract-tests/fixtures/tone-3s.mp3")
    }

    #[tokio::test]
    async fn eligibility_requires_the_desktop_build_a_folder_and_the_switch() {
        let (state, dir) = desktop_state(json!({})).await;
        assert!(!auto_export_eligible(&state, "u").await);
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let on = json!({ "autoExport": true, "autoExportFolder": folder.to_string_lossy() });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(on.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        assert!(auto_export_eligible(&state, "u").await);
        // The web server never writes to a folder, even with the settings set.
        let mut web = crate::Config::for_tests(dir.path());
        web.desktop = None;
        let web = crate::AppState::new(web, state.db.clone());
        assert!(!auto_export_eligible(&web, "u").await);
    }

    #[tokio::test]
    async fn only_eligible_recordings_are_exported_once() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "mp3",
            "autoExportTitleMode": "original",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        store_audio(&state, "u/new.mp3", &fixture()).await;
        store_audio(&state, "u/old.mp3", &fixture()).await;
        add_recording(&state, "new", "u/new.mp3", true).await;
        add_recording(&state, "old", "u/old.mp3", false).await;

        auto_export(&state).await.unwrap();
        let mut names: Vec<String> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["Team sync.mp3"]);

        // A second pass writes nothing more, and the pre-existing recording stays untouched.
        auto_export(&state).await.unwrap();
        let again: Vec<String> = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(again.len(), 1);
        let exported: Option<String> =
            sqlx::query_scalar("SELECT auto_export_path FROM recordings WHERE id = 'old'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(exported.is_none());
    }

    #[tokio::test]
    async fn ogg_output_is_an_ogg_container_and_mp3_output_is_mp3() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        store_audio(&state, "u/a.mp3", &fixture()).await;
        add_recording(&state, "a", "u/a.mp3", true).await;

        for (format, ext, marker) in [
            ("ogg", "ogg", b"OggS".as_slice()),
            ("mp3", "mp3", b"ID3".as_slice()),
        ] {
            sqlx::query("UPDATE recordings SET auto_export_path = NULL, auto_export_attempts = 0 WHERE id = 'a'")
                .execute(&state.db)
                .await
                .unwrap();
            let settings = json!({
                "autoExport": true,
                "autoExportFolder": folder.to_string_lossy(),
                "autoExportFormat": format,
                "autoExportTitleMode": "date",
            });
            sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
                .bind(settings.to_string())
                .execute(&state.db)
                .await
                .unwrap();
            auto_export(&state).await.unwrap();
            let file = std::fs::read_dir(&folder)
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| p.extension().is_some_and(|e| e == ext))
                .unwrap_or_else(|| panic!("no .{ext} file"));
            let head = std::fs::read(&file).unwrap();
            assert!(head.starts_with(marker), "{format} output is not {format}");
            std::fs::remove_dir_all(&folder).unwrap();
        }
    }

    #[tokio::test]
    async fn a_failed_write_is_retried_three_times_then_left_alone() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "mp3",
            "autoExportTitleMode": "original",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        // No stored audio: every write fails.
        add_recording(&state, "broken", "u/missing.mp3", true).await;
        for _ in 0..3 {
            auto_export(&state).await.unwrap();
        }
        let attempts: i64 =
            sqlx::query_scalar("SELECT auto_export_attempts FROM recordings WHERE id = 'broken'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(attempts, MAX_ATTEMPTS);
        auto_export(&state).await.unwrap();
        let after: i64 =
            sqlx::query_scalar("SELECT auto_export_attempts FROM recordings WHERE id = 'broken'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            after, MAX_ATTEMPTS,
            "the recording is left alone after the limit"
        );
    }

    #[tokio::test]
    async fn a_file_in_the_old_format_is_reexported_and_the_old_one_goes() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        store_audio(&state, "u/a.mp3", &fixture()).await;
        add_recording(&state, "a", "u/a.mp3", true).await;
        // An export written by an earlier version: the true extension was kept.
        let old = folder.join("Team sync.opus");
        std::fs::copy(fixture(), &old).unwrap();
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "ogg",
            "autoExportTitleMode": "original",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&old.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert!(
            !old.exists(),
            "the old file goes after the new one is written"
        );
        let written = folder.join("Team sync.ogg");
        assert!(written.exists());
        assert!(std::fs::read(&written).unwrap().starts_with(b"OggS"));
    }

    #[tokio::test]
    async fn a_user_renamed_export_is_not_reexported() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        store_audio(&state, "u/a.mp3", &fixture()).await;
        add_recording(&state, "a", "u/a.mp3", true).await;
        let renamed = folder.join("My own name.opus");
        std::fs::copy(fixture(), &renamed).unwrap();
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "ogg",
            "autoExportTitleMode": "original",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&renamed.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert!(renamed.exists(), "a name the user chose is left alone");
    }

    #[tokio::test]
    async fn an_original_title_does_not_rename_the_date_file() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "mp3",
            "autoExportTitleMode": "ai",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        store_audio(&state, "u/a.mp3", &fixture()).await;
        add_recording(&state, "a", "u/a.mp3", true).await;

        auto_export(&state).await.unwrap();
        auto_export(&state).await.unwrap();
        let day = date_stem(1_792_305_000_000).await;
        assert!(
            folder.join(format!("{day}.mp3")).exists(),
            "the date name stays while the title is not from AI"
        );
        assert!(
            !folder.join("Team sync.mp3").exists(),
            "an original title must not rename the file"
        );
    }

    #[tokio::test]
    async fn an_ai_title_renames_the_date_file() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        let settings = json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "mp3",
            "autoExportTitleMode": "ai",
        });
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
        store_audio(&state, "u/a.mp3", &fixture()).await;
        add_recording(&state, "a", "u/a.mp3", true).await;
        auto_export(&state).await.unwrap();
        let day = date_stem(1_792_305_000_000).await;
        assert!(folder.join(format!("{day}.mp3")).exists());

        sqlx::query("UPDATE recordings SET title_source = 'ai' WHERE id = 'a'")
            .execute(&state.db)
            .await
            .unwrap();
        auto_export(&state).await.unwrap();
        assert!(!folder.join(format!("{day}.mp3")).exists());
        assert!(folder.join("Team sync.mp3").exists());
    }

    #[test]
    fn extension_is_not_repeated() {
        assert_eq!(strip_extension("recording.mp3", "mp3"), "recording");
        assert_eq!(strip_extension("recording.MP3", "mp3"), "recording");
        assert_eq!(strip_extension("recording.ogg", "mp3"), "recording.ogg");
    }

    /// Writes an Ogg/Opus file into storage and adds a recording that points at it.
    async fn store_opus(state: &crate::AppState, dir: &std::path::Path, id: &str) -> PathBuf {
        let source = dir.join("source.opus");
        let made = tokio::process::Command::new(&state.config.ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg("sine=frequency=440:duration=1")
            .args(["-c:a", "libopus", "-f", "ogg"])
            .arg(&source)
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(made, "the test needs ffmpeg to make an Ogg/Opus file");
        let key = format!("u/{id}.opus");
        store_audio(state, &key, &source).await;
        add_recording(state, id, &key, true).await;
        source
    }

    async fn original_settings(folder: &std::path::Path, mode: &str) -> serde_json::Value {
        json!({
            "autoExport": true,
            "autoExportFolder": folder.to_string_lossy(),
            "autoExportFormat": "original",
            "autoExportTitleMode": mode,
        })
    }

    async fn set_settings(state: &crate::AppState, settings: serde_json::Value) {
        sqlx::query("UPDATE user_settings SET data = ? WHERE user_id = 'u'")
            .bind(settings.to_string())
            .execute(&state.db)
            .await
            .unwrap();
    }

    fn names(folder: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn original_format_saves_an_opus_file_as_ogg_byte_for_byte() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        let source = store_opus(&state, dir.path(), "a").await;
        set_settings(&state, original_settings(&folder, "original").await).await;

        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync.ogg"]);
        let written = std::fs::read(folder.join("Team sync.ogg")).unwrap();
        assert!(written.starts_with(b"OggS"));
        assert_eq!(
            written,
            std::fs::read(&source).unwrap(),
            "the bytes are the stored file's, not a re-encode"
        );

        // A second pass is quiet: one file, and no `.opus` beside it.
        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync.ogg"]);
    }

    #[tokio::test]
    async fn a_previous_opus_export_is_renamed_to_ogg_without_a_copy() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let source = store_opus(&state, dir.path(), "a").await;
        // An export written by an earlier version: the stored extension was kept.
        let old = folder.join("Team sync.opus");
        std::fs::copy(&source, &old).unwrap();
        set_settings(&state, original_settings(&folder, "original").await).await;
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&old.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync.ogg"]);
        assert_eq!(
            std::fs::read(folder.join("Team sync.ogg")).unwrap(),
            std::fs::read(&source).unwrap()
        );

        // A repeated pass does not rename again or add a numbered copy.
        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync.ogg"]);
    }

    #[tokio::test]
    async fn a_changed_previous_opus_export_is_left_alone() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let source = store_opus(&state, dir.path(), "a").await;
        let old = folder.join("Team sync.opus");
        // The user edited the exported file, so it no longer matches the stored audio.
        let mut edited = std::fs::read(&source).unwrap();
        edited.extend_from_slice(b"edited");
        std::fs::write(&old, &edited).unwrap();
        set_settings(&state, original_settings(&folder, "original").await).await;
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&old.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync.opus"]);
        assert_eq!(std::fs::read(&old).unwrap(), edited);
    }

    #[tokio::test]
    async fn a_previous_opus_export_under_a_user_name_is_left_alone() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let source = store_opus(&state, dir.path(), "a").await;
        let renamed = folder.join("My own name.opus");
        std::fs::copy(&source, &renamed).unwrap();
        set_settings(&state, original_settings(&folder, "original").await).await;
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&renamed.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["My own name.opus"]);
    }

    #[tokio::test]
    async fn an_ogg_taken_by_the_user_makes_the_rename_step_aside() {
        let (state, dir) = desktop_state(json!({})).await;
        let folder = dir.path().join("out");
        tokio::fs::create_dir_all(&folder).await.unwrap();
        let source = store_opus(&state, dir.path(), "a").await;
        let old = folder.join("Team sync.opus");
        std::fs::copy(&source, &old).unwrap();
        // Another file already holds the target name.
        let other = folder.join("Team sync.ogg");
        std::fs::write(&other, b"not the recording").unwrap();
        set_settings(&state, original_settings(&folder, "original").await).await;
        sqlx::query("UPDATE recordings SET auto_export_path = ? WHERE id = 'a'")
            .bind(state.config.field_key.encrypt(&old.to_string_lossy()))
            .execute(&state.db)
            .await
            .unwrap();

        auto_export(&state).await.unwrap();
        assert_eq!(names(&folder), ["Team sync (2).ogg", "Team sync.ogg"]);
        assert_eq!(std::fs::read(&other).unwrap(), b"not the recording");
        assert!(!old.exists());
    }
}
