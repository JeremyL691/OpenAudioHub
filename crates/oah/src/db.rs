use std::path::Path;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Sqlite, SqlitePool, Transaction};

/// Opens (or creates) the database and applies pending migrations.
/// WAL + synchronous=FULL: no committed write is lost on power failure.
pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// An in-memory database for tests.
pub async fn open_memory() -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
    // One connection: every in-memory connection would be a separate database.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

/// Starts a transaction that takes the write lock before its first statement.
///
/// A plain `BEGIN` reads before it writes. Under WAL, if another connection commits in between,
/// the write fails at once with SQLITE_BUSY_SNAPSHOT, and `busy_timeout` does not apply.
/// `BEGIN IMMEDIATE` makes other writers wait instead.
pub async fn begin_write(pool: &SqlitePool) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// Current time in Unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    /// A file database under .dev-artifacts with a `probe` table. Two connections are needed,
    /// and the in-memory pool has only one.
    async fn file_pool(name: &str) -> SqlitePool {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.dev-artifacts/db-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let pool = open(&dir.join(format!("{name}-{}.sqlite", now_ms())))
            .await
            .unwrap();
        sqlx::query("CREATE TABLE probe (id INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    /// The failure `begin_write` exists to avoid. The read fixes a snapshot, and a commit from
    /// another connection makes the next write fail at once rather than wait for `busy_timeout`.
    #[tokio::test]
    async fn plain_begin_fails_at_once_when_another_writer_commits_first() {
        let pool = file_pool("plain-begin").await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT COUNT(*) FROM probe")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO probe (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();

        let started = Instant::now();
        let err = sqlx::query("INSERT INTO probe (id) VALUES (2)")
            .execute(&mut *tx)
            .await
            .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "waited for busy_timeout"
        );
        assert_eq!(
            err.as_database_error().and_then(|e| e.code()).as_deref(),
            Some("517")
        );
    }

    /// A read and a write inside `begin_write` both succeed, and another writer waits for the
    /// commit instead of failing.
    #[tokio::test]
    async fn begin_write_keeps_its_read_and_write_and_queues_other_writers() {
        let pool = file_pool("begin-write").await;
        let mut tx = begin_write(&pool).await.unwrap();
        sqlx::query("SELECT COUNT(*) FROM probe")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let other = pool.clone();
        let waiting = tokio::spawn(async move {
            sqlx::query("INSERT INTO probe (id) VALUES (2)")
                .execute(&other)
                .await
        });
        // Let the other writer reach the lock before this transaction writes.
        tokio::time::sleep(Duration::from_millis(100)).await;
        sqlx::query("INSERT INTO probe (id) VALUES (1)")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        waiting.await.unwrap().unwrap();
    }

    /// Every transaction in the server starts with `begin_write`, so a plain `begin()` cannot come
    /// back unnoticed.
    #[test]
    fn no_source_file_starts_a_transaction_with_plain_begin() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut dirs = vec![src.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && path != src.join("db.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    for (n, line) in text.lines().enumerate() {
                        assert!(
                            !line.contains(".begin()") && !line.contains(".begin_with("),
                            "{}:{} starts a transaction without db::begin_write",
                            path.display(),
                            n + 1
                        );
                    }
                }
            }
        }
    }
}
