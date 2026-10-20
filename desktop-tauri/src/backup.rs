//! The database copy made before an upgrade (spec/desktop.md section 3.5). It is written with
//! SQLite's `VACUUM INTO`, so it is a consistent copy even when the database is in WAL mode. The
//! `backups/` directory is created with mode 0700 and each copy is written with mode 0600.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sqlx::Connection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};

use crate::files;

/// Newest copies kept in `backups/`.
const KEEP: usize = 5;

/// Writes a copy of `database` into `<data>/backups/` when this version starts on data that another
/// version last wrote (or that has no recorded version). Returns the file written, or `None` when no
/// copy is needed. A failed copy leaves no file behind and stops the start.
pub async fn before_upgrade(
    data_dir: &Path,
    database: &Path,
    last_version: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let current = env!("CARGO_PKG_VERSION");
    let upgrading = last_version.is_none_or(|last| files::newer(current, last));
    if !upgrading || !database.exists() {
        return Ok(None);
    }
    let target = copy_database(data_dir, database, &format!("before-{current}")).await?;
    files::log(
        data_dir,
        &format!(
            "database backup written before the upgrade: {}",
            target.display()
        ),
    );
    Ok(Some(target))
}

/// Writes `<data>/backups/<stamp>-<label>.sqlite` and keeps the newest `KEEP` copies.
async fn copy_database(data_dir: &Path, database: &Path, label: &str) -> Result<PathBuf, String> {
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("cannot restrict {}: {e}", dir.display()))?;
    }
    let name = format!("{}-{label}.sqlite", files::stamp());
    let target = dir.join(&name);
    let temp = dir.join(format!(".{name}.tmp"));
    let _ = std::fs::remove_file(&temp);

    let mut conn = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(database))
        .await
        .map_err(|e| format!("cannot open the database: {e}"))?;
    let copied = sqlx::query("VACUUM INTO ?")
        .bind(temp.to_string_lossy().into_owned())
        .execute(&mut conn)
        .await;
    let _ = conn.close().await;
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("the copy failed: {e}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("cannot place the copy: {e}"));
    }
    if let Err(e) = prune(&dir, KEEP) {
        files::log(
            data_dir,
            &format!("could not remove old database copies: {e}"),
        );
    }
    Ok(target)
}

/// Keeps the `keep` newest upgrade copies by modification time and removes the rest. Only files whose
/// names match the copy pattern are touched.
pub fn prune(dir: &Path, keep: usize) -> std::io::Result<()> {
    let mut copies: Vec<(SystemTime, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_copy_name(&name) {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            copies.push((modified, entry.path()));
        }
    }
    copies.sort_by_key(|copy| std::cmp::Reverse(copy.0));
    for (_, path) in copies.into_iter().skip(keep) {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn is_copy_name(name: &str) -> bool {
    !name.starts_with('.') && name.contains("-before-") && name.ends_with(".sqlite")
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oah-{label}-{}", oah::ids::token_hex(4)));
        std::fs::create_dir_all(&dir).expect("scratch folder");
        dir
    }

    #[test]
    fn prune_keeps_the_newest_five_copies_only() {
        let dir = scratch("prune");
        let base = UNIX_EPOCH + Duration::from_secs(1_000_000);
        for i in 0..7u64 {
            let path = dir.join(format!("copy-{i}-before-1.0.0.sqlite"));
            std::fs::write(&path, b"x").expect("copy");
            let file = std::fs::File::options()
                .write(true)
                .open(&path)
                .expect("open copy");
            file.set_modified(base + Duration::from_secs(i * 60))
                .expect("set time");
        }
        std::fs::write(dir.join("notes.txt"), b"keep me").expect("other file");
        std::fs::write(dir.join("manual.sqlite"), b"keep me").expect("other database");

        prune(&dir, KEEP).expect("prune");

        for i in 0..2 {
            assert!(
                !dir.join(format!("copy-{i}-before-1.0.0.sqlite")).exists(),
                "old copy {i} should be gone"
            );
        }
        for i in 2..7 {
            assert!(
                dir.join(format!("copy-{i}-before-1.0.0.sqlite")).exists(),
                "new copy {i} should stay"
            );
        }
        assert!(dir.join("notes.txt").exists());
        assert!(dir.join("manual.sqlite").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn copies_are_made_before_upgrades_only() {
        let dir = scratch("backup");
        let db = dir.join("openaudiohub.sqlite");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&db)
                .create_if_missing(true);
            let mut conn = SqliteConnection::connect_with(&options)
                .await
                .expect("database");
            sqlx::query("CREATE TABLE t (x INTEGER)")
                .execute(&mut conn)
                .await
                .expect("table");
            sqlx::query("INSERT INTO t VALUES (1)")
                .execute(&mut conn)
                .await
                .expect("row");
            conn.close().await.expect("close");
        });

        let current = env!("CARGO_PKG_VERSION");
        assert_eq!(
            rt.block_on(before_upgrade(&dir, &db, Some(current)))
                .expect("same version"),
            None
        );
        let written = rt
            .block_on(before_upgrade(&dir, &db, Some("0.9.0")))
            .expect("upgrade")
            .expect("a copy");
        assert!(written.exists());
        assert!(
            written
                .to_string_lossy()
                .ends_with(&format!("-before-{current}.sqlite"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(&written)
                .expect("copy metadata")
                .permissions()
                .mode();
            assert_eq!(
                file_mode & 0o777,
                0o600,
                "the copy should be readable by its owner only"
            );
            let dir_mode = std::fs::metadata(dir.join("backups"))
                .expect("backups metadata")
                .permissions()
                .mode();
            assert_eq!(
                dir_mode & 0o777,
                0o700,
                "the backups folder should be private to its owner"
            );
        }
        assert!(
            rt.block_on(before_upgrade(&dir, &dir.join("missing.sqlite"), None))
                .expect("no database")
                .is_none()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
