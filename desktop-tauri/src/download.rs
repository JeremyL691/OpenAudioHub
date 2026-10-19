//! Native saving of the recording audio the page asks for.
//!
//! The webview never downloads audio itself: it asks for a save dialog, the file is streamed
//! from the local server into a temporary file, and only a complete file takes the chosen name.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

use crate::bridge::{self, Shared};

const MAX_IDS: usize = 100;
const ID_MAX_LEN: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The server may build a large archive before the first byte.
const START_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// A transfer that stops producing bytes for this long is treated as failed.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// One save dialog and one transfer at a time.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Resets the busy flag on every exit path, including early errors.
struct Busy;

impl Busy {
    fn acquire() -> Result<Busy, String> {
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err("A download is already in progress".into());
        }
        Ok(Busy)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// The server path for one page download request.
fn endpoint(ids: &[String], format: &str) -> Result<String, String> {
    if !matches!(format, "mp3" | "original") {
        return Err("format must be mp3 or original".into());
    }
    if ids.is_empty() || ids.len() > MAX_IDS {
        return Err("ids must be 1 to 100 recording ids".into());
    }
    for id in ids {
        let valid = !id.is_empty()
            && id.len() <= ID_MAX_LEN
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !valid {
            return Err("ids must be 1 to 100 recording ids".into());
        }
    }
    Ok(if ids.len() == 1 && format == "mp3" {
        format!("/api/recordings/{}/audio?download=1", ids[0])
    } else {
        format!(
            "/api/recordings/download?ids={}&format={format}",
            ids.join(",")
        )
    })
}

/// Saves the recording audio chosen by the page. Resolves with the chosen path, or `None`
/// when the save dialog was cancelled.
#[tauri::command]
pub async fn download_recordings(
    app: AppHandle,
    shared: State<'_, Shared>,
    ids: Vec<String>,
    format: String,
) -> Result<Option<String>, String> {
    let path = endpoint(&ids, &format)?;
    let _busy = Busy::acquire()?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{}{path}", shared.port);

    let mut cookie = session(&client, &shared).await?;
    let mut response = send(&client, &url, &cookie).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let renewed = bridge::session_cookie(&client, shared.port, &shared.launch_secret).await?;
        cookie = renewed.clone();
        *shared.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(renewed);
        response = send(&client, &url, &cookie).await?;
    }
    if !response.status().is_success() {
        return Err(refusal(response).await);
    }

    let name = suggested_name(&response)
        .map(|name| safe_name(&name))
        .unwrap_or_else(|| "download".into());
    let Some(destination) = ask_where(&app, name).await? else {
        return Ok(None);
    };
    copy_to(&mut response, &destination).await?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

/// The cached desktop session cookie, or a new one.
async fn session(client: &reqwest::Client, shared: &Shared) -> Result<String, String> {
    let cached = shared
        .session
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(cookie) = cached {
        return Ok(cookie);
    }
    let cookie = bridge::session_cookie(client, shared.port, &shared.launch_secret).await?;
    *shared.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(cookie.clone());
    Ok(cookie)
}

async fn send(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(
        START_TIMEOUT,
        client
            .get(url)
            .header(reqwest::header::COOKIE, cookie)
            .send(),
    )
    .await
    .map_err(|_| "The server did not answer the download request.".to_owned())?
    .map_err(|e| format!("The download could not start: {e}"))
}

/// The message the server sent with a refused download, or a generic one.
async fn refusal(response: reqwest::Response) -> String {
    let status = response.status();
    let body = tokio::time::timeout(Duration::from_secs(5), response.text())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            format!(
                "The server refused the download (HTTP {}).",
                status.as_u16()
            )
        })
}

/// The name the server put on the response, decoded from `filename*` when it is there.
fn suggested_name(response: &reqwest::Response) -> Option<String> {
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)?
        .to_str()
        .ok()?;
    if let Some(encoded) = value
        .split("filename*=UTF-8''")
        .nth(1)
        .map(|rest| rest.split(';').next().unwrap_or(rest))
    {
        if let Some(decoded) = bridge::percent_decode(encoded) {
            return Some(decoded);
        }
        if !encoded.is_empty() {
            return Some(encoded.to_owned());
        }
    }
    let start = value.find("filename=\"")? + "filename=\"".len();
    let end = value[start..].find('"')? + start;
    Some(value[start..end].to_owned())
}

/// Shows the save dialog attached to the main window. `None` means the user cancelled.
async fn ask_where(app: &AppHandle, name: String) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save download")
        .set_file_name(name);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx
        .await
        .map_err(|_| "Could not open the save dialog.".to_owned())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "Could not open the save dialog.".to_owned())?;
    Ok(Some(path))
}

/// Streams the response into a temporary file next to the destination, then renames it into
/// place. A failure leaves the destination as it was and removes the temporary file.
async fn copy_to(response: &mut reqwest::Response, destination: &Path) -> Result<(), String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let temp = destination.with_file_name(format!(".{name}.{}.tmp", oah::ids::token_hex(6)));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .await
        .map_err(|e| format!("The download could not be saved: {e}"))?;
    let result = async {
        loop {
            let chunk = tokio::time::timeout(READ_TIMEOUT, response.chunk())
                .await
                .map_err(|_| "The download stalled and was stopped.".to_owned())?
                .map_err(|e| format!("The download failed: {e}"))?;
            let Some(chunk) = chunk else {
                break;
            };
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("The download could not be saved: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("The download could not be saved: {e}"))?;
        file.sync_all()
            .await
            .map_err(|e| format!("The download could not be saved: {e}"))
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error);
    }
    if let Err(error) = tokio::fs::rename(&temp, destination).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("The download could not be saved: {error}"));
    }
    Ok(())
}

/// A suggested name reduced to one safe file name.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control())
        .skip_while(|c| *c == '.')
        .take(200)
        .collect();
    if cleaned.is_empty() {
        "download".into()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn one_mp3_download_uses_the_audio_route() {
        assert_eq!(
            endpoint(&ids(&["rec_1"]), "mp3").unwrap(),
            "/api/recordings/rec_1/audio?download=1"
        );
    }

    #[test]
    fn one_original_download_uses_the_stored_file_route() {
        assert_eq!(
            endpoint(&ids(&["rec_1"]), "original").unwrap(),
            "/api/recordings/download?ids=rec_1&format=original"
        );
    }

    #[test]
    fn several_recordings_download_as_one_archive() {
        assert_eq!(
            endpoint(&ids(&["a", "b"]), "mp3").unwrap(),
            "/api/recordings/download?ids=a,b&format=mp3"
        );
    }

    #[test]
    fn bad_requests_are_refused_before_anything_is_saved() {
        assert!(endpoint(&[], "mp3").is_err());
        assert!(endpoint(&ids(&["a"]), "wav").is_err());
        assert!(endpoint(&ids(&["../etc"]), "mp3").is_err());
        let long = "a".repeat(65);
        assert!(endpoint(&[long], "mp3").is_err());
        let too_many: Vec<String> = (0..101).map(|index| index.to_string()).collect();
        assert!(endpoint(&too_many, "mp3").is_err());
    }

    #[test]
    fn suggested_names_are_reduced_to_safe_file_names() {
        assert_eq!(safe_name("../report\n.txt"), "report.txt");
        assert_eq!(safe_name("..."), "download");
        assert_eq!(safe_name("東京.vtt"), "東京.vtt");
        assert_eq!(safe_name(&"a".repeat(201)).chars().count(), 200);
    }

    #[test]
    fn the_utf8_file_name_is_used_when_the_server_sends_one() {
        let name = "recordings-2026-10-18.mp3";
        let value = format!("attachment; filename=\"____.mp3\"; filename*=UTF-8''{name}");
        assert_eq!(
            value.split("filename*=UTF-8''").nth(1).map(str::to_owned),
            Some(name.to_owned())
        );
        assert_eq!(
            bridge::percent_decode("a%20b.mp3").as_deref(),
            Some("a b.mp3")
        );
    }

    /// Serves one test router on a random local port.
    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn the_download_is_written_and_no_temporary_file_stays() {
        let app = axum::Router::new().route(
            "/file",
            axum::routing::get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_DISPOSITION,
                        "attachment; filename=\"x.mp3\"; filename*=UTF-8''x%20y.mp3",
                    )],
                    vec![1u8, 2, 3, 4],
                )
            }),
        );
        let base = serve(app).await;
        let mut response = reqwest::get(format!("{base}/file")).await.unwrap();
        assert_eq!(suggested_name(&response).as_deref(), Some("x y.mp3"));

        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.mp3");
        copy_to(&mut response, &destination).await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), vec![1, 2, 3, 4]);
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, ["out.mp3"]);
    }

    #[tokio::test]
    async fn a_failed_write_leaves_no_temporary_file() {
        let app =
            axum::Router::new().route("/file", axum::routing::get(|| async { vec![1u8, 2, 3, 4] }));
        let base = serve(app).await;
        let mut response = reqwest::get(format!("{base}/file")).await.unwrap();

        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("taken");
        std::fs::create_dir(&destination).unwrap();
        assert!(copy_to(&mut response, &destination).await.is_err());
        assert!(destination.is_dir());
        let entries: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, ["taken"], "the temporary file is removed");
    }

    #[tokio::test]
    async fn a_refusal_keeps_the_server_message() {
        let app = axum::Router::new().route(
            "/missing",
            axum::routing::get(|| async {
                (
                    axum::http::StatusCode::NOT_FOUND,
                    axum::Json(serde_json::json!({
                        "error": "Recording not found",
                        "code": "RECORDING_NOT_FOUND"
                    })),
                )
            }),
        );
        let base = serve(app).await;
        let response = reqwest::get(format!("{base}/missing")).await.unwrap();
        assert_eq!(refusal(response).await, "Recording not found");
    }
}
