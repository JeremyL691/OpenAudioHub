//! Native save handling for files requested by the webview.

use std::collections::{HashMap, VecDeque};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::webview::DownloadEvent;
use tauri::{Manager, Webview};
use tauri_plugin_dialog::DialogExt;

static NEXT_DOWNLOAD: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default)]
pub struct DownloadManager(Arc<Mutex<PendingDownloads>>);

#[derive(Default)]
struct PendingDownloads {
    by_url: HashMap<String, VecDeque<u64>>,
    unknown_finishes: HashMap<String, VecDeque<bool>>,
    entries: HashMap<u64, Entry>,
}

struct Entry {
    staging_path: PathBuf,
    destination: Option<PathBuf>,
    dialog_answered: bool,
    finished: Option<bool>,
}

/// Routes a webview download into a temporary file, then moves it to the path selected by the
/// native save dialog. Returning false from the dialog callback is treated as cancellation.
pub fn handle<R: tauri::Runtime>(
    webview: Webview<R>,
    event: DownloadEvent<'_>,
    manager: DownloadManager,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let app = webview.app_handle().clone();
            let name = safe_name(
                destination
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("download"),
            );
            let Some(shared) = app.try_state::<crate::bridge::Shared>() else {
                return false;
            };
            let staging_dir = shared.data_dir.join(".pending-downloads");
            if std::fs::create_dir_all(&staging_dir).is_err() {
                return false;
            }
            #[cfg(unix)]
            if let Err(error) =
                std::fs::set_permissions(&staging_dir, std::fs::Permissions::from_mode(0o700))
            {
                tracing::warn!(%error, "could not restrict pending download directory permissions");
                return false;
            }
            let id = NEXT_DOWNLOAD.fetch_add(1, Ordering::Relaxed);
            let extension = std::path::Path::new(&name)
                .extension()
                .and_then(|ext| ext.to_str())
                .filter(|ext| !ext.is_empty())
                .map(|ext| format!(".{ext}"))
                .unwrap_or_default();
            let staging_path = staging_dir.join(format!("download-{id}{extension}"));
            *destination = staging_path.clone();

            let key = url.to_string();
            manager
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .register(key.clone(), id, staging_path.clone());

            let dialog_manager = manager.clone();
            let default_dir = app.path().download_dir().ok();
            let mut dialog = app.dialog().file().set_file_name(name);
            if let Some(dir) = default_dir {
                dialog = dialog.set_directory(dir);
            }
            dialog.save_file(move |picked| {
                let destination = picked.and_then(|p| p.into_path().ok());
                let action = dialog_manager
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .dialog_answered(&key, id, destination);
                if let Some((staging, target, success)) = action {
                    finish_download(app.clone(), &staging, target, success);
                }
            });
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let key = url.to_string();
            let actions = manager
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .finished(&key, path, success);
            for (staging, target, success) in actions {
                finish_download(webview.app_handle().clone(), &staging, target, success);
            }
            true
        }
        _ => true,
    }
}

/// Removes only abandoned temporary files created by this module at the prior launch.
pub fn clear_stale(data_dir: &std::path::Path) {
    let dir = data_dir.join(".pending-downloads");
    if let Err(error) = std::fs::remove_dir_all(dir)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, "could not clear abandoned download files");
    }
}

impl PendingDownloads {
    fn register(&mut self, url: String, id: u64, staging_path: PathBuf) {
        self.by_url.entry(url).or_default().push_back(id);
        self.entries.insert(
            id,
            Entry {
                staging_path,
                destination: None,
                dialog_answered: false,
                finished: None,
            },
        );
    }

    fn dialog_answered(
        &mut self,
        url: &str,
        id: u64,
        destination: Option<PathBuf>,
    ) -> Option<(PathBuf, Option<PathBuf>, bool)> {
        let entry = self.entries.get_mut(&id)?;
        entry.dialog_answered = true;
        entry.destination = destination;
        let success = entry.finished?;
        let entry = self.entries.remove(&id)?;
        self.remove_id(url, id);
        Some((entry.staging_path, entry.destination, success))
    }

    fn finished(
        &mut self,
        url: &str,
        path: Option<PathBuf>,
        success: bool,
    ) -> Vec<(PathBuf, Option<PathBuf>, bool)> {
        if let Some(path) = path {
            let Some(id) = self.by_url.get(url).and_then(|ids| {
                ids.iter()
                    .find(|id| {
                        self.entries
                            .get(id)
                            .is_some_and(|entry| entry.staging_path == path)
                    })
                    .copied()
            }) else {
                return Vec::new();
            };
            return self.mark_finished(url, id, success).into_iter().collect();
        }

        let Some(ids) = self.by_url.get(url) else {
            return Vec::new();
        };
        let finishes = self.unknown_finishes.entry(url.to_owned()).or_default();
        finishes.push_back(success);
        if finishes.len() < ids.len() {
            return Vec::new();
        }
        let completions: Vec<_> = ids.iter().copied().zip(finishes.drain(..)).collect();
        self.by_url.remove(url);
        self.unknown_finishes.remove(url);
        completions
            .into_iter()
            .filter_map(|(id, success)| self.mark_finished(url, id, success))
            .collect()
    }

    fn mark_finished(
        &mut self,
        url: &str,
        id: u64,
        success: bool,
    ) -> Option<(PathBuf, Option<PathBuf>, bool)> {
        let dialog_answered = {
            let entry = self.entries.get_mut(&id)?;
            entry.finished = Some(success);
            entry.dialog_answered
        };
        self.remove_id(url, id);
        if !dialog_answered {
            return None;
        }
        let entry = self.entries.remove(&id)?;
        Some((entry.staging_path, entry.destination, success))
    }

    fn remove_id(&mut self, url: &str, id: u64) {
        if let Some(ids) = self.by_url.get_mut(url) {
            if let Some(index) = ids.iter().position(|candidate| *candidate == id) {
                ids.remove(index);
            }
            if ids.is_empty() {
                self.by_url.remove(url);
            }
        }
    }
}

fn finish_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    staging: &std::path::Path,
    destination: Option<PathBuf>,
    success: bool,
) {
    let Some(destination) = destination else {
        let _ = std::fs::remove_file(staging);
        return;
    };
    let staging = staging.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            if !success {
                let _ = std::fs::remove_file(&staging);
                return Err(std::io::Error::other(
                    "the webview download did not complete",
                ));
            }
            let result = copy_atomic(&staging, &destination);
            let _ = std::fs::remove_file(&staging);
            result
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, "could not save completed download");
                app.dialog()
                    .message(format!("The download could not be saved: {error}"))
                    .show(|_| {});
            }
            Err(error) => {
                tracing::warn!(%error, "download save worker stopped");
                app.dialog()
                    .message("The download could not be saved. Please try again.")
                    .show(|_| {});
            }
        }
    });
}

fn copy_atomic(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write;
    let parent = destination
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    let temp = destination.with_file_name(format!(".{name}.{}.tmp", oah::ids::token_hex(6)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut output = options.open(&temp)?;
        let mut input = std::fs::File::open(source)?;
        std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        std::fs::rename(&temp, destination)?;
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

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

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn suggested_names_are_reduced_to_safe_file_names() {
        assert_eq!(safe_name("../report\n.txt"), "report.txt");
        assert_eq!(safe_name("..."), "download");
        assert_eq!(safe_name("東京.vtt"), "東京.vtt");
        assert_eq!(safe_name(&"a".repeat(201)).chars().count(), 200);
    }

    #[test]
    fn download_waits_for_both_dialog_and_transfer() {
        let mut pending = PendingDownloads::default();
        let staging = PathBuf::from("/tmp/staging");
        let target = PathBuf::from("/tmp/result.txt");
        pending.register("blob:test".into(), 1, staging.clone());
        assert!(pending.finished("blob:test", None, true).is_empty());
        assert_eq!(
            pending.dialog_answered("blob:test", 1, Some(target.clone())),
            Some((staging.clone(), Some(target), true))
        );

        pending.register("http://local/file".into(), 2, staging.clone());
        assert!(
            pending
                .dialog_answered("http://local/file", 2, None)
                .is_none()
        );
        assert_eq!(
            pending.finished("http://local/file", None, true),
            vec![(staging, None, true)]
        );
    }

    #[test]
    fn same_url_finishes_do_not_leave_a_completed_entry_at_the_front() {
        let mut pending = PendingDownloads::default();
        let first = PathBuf::from("/tmp/first");
        let second = PathBuf::from("/tmp/second");
        pending.register("http://local/file".into(), 1, first.clone());
        pending.register("http://local/file".into(), 2, second.clone());

        assert!(
            pending
                .finished("http://local/file", Some(second.clone()), true)
                .is_empty()
        );
        assert!(
            pending
                .finished("http://local/file", Some(first.clone()), true)
                .is_empty()
        );
        assert_eq!(
            pending.dialog_answered("http://local/file", 2, None),
            Some((second, None, true))
        );
        assert_eq!(
            pending.dialog_answered("http://local/file", 1, None),
            Some((first, None, true))
        );
        assert!(pending.by_url.is_empty());
    }

    #[test]
    fn pathless_same_url_finishes_are_deferred_until_each_transfer_completes() {
        let mut pending = PendingDownloads::default();
        let first = PathBuf::from("/tmp/first");
        let second = PathBuf::from("/tmp/second");
        pending.register("blob:identical".into(), 1, first.clone());
        pending.register("blob:identical".into(), 2, second.clone());
        assert!(pending.dialog_answered("blob:identical", 1, None).is_none());
        assert!(pending.dialog_answered("blob:identical", 2, None).is_none());

        assert!(pending.finished("blob:identical", None, true).is_empty());
        let completions = pending.finished("blob:identical", None, false);
        assert_eq!(
            completions,
            vec![(first.clone(), None, true), (second.clone(), None, false)]
        );
        assert!(pending.by_url.is_empty());
    }

    #[test]
    fn failed_copy_preserves_existing_user_file() {
        let dir =
            std::env::temp_dir().join(format!("oah-download-test-{}", oah::ids::token_hex(6)));
        std::fs::create_dir(&dir).unwrap();
        let _cleanup = TestDir(dir.clone());
        let destination = dir.join("existing.txt");
        std::fs::write(&destination, "keep this file").unwrap();
        let missing_source = dir.join("missing.part");

        assert!(copy_atomic(&missing_source, &destination).is_err());
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "keep this file"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }
}
