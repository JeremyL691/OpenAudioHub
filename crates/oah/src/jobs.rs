//! Durable background work queue on the `jobs` table.
//!
//! A worker claims a job by taking a lease. While it works it renews the lease;
//! if the process dies, the lease runs out and another worker claims the job
//! again. Handlers must therefore be safe to run more than once.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::Notify;

use crate::db::now_ms;
use crate::ids;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub user_id: Option<String>,
    pub recording_id: Option<String>,
    pub payload: String,
    pub attempts: i64,
    /// Identifies this claim. Every claim of the job gets a new, larger value, so a worker
    /// that lost its lease cannot pass its own generation to `renew`, `set_progress` or `finish`.
    pub lease_gen: i64,
}

impl Job {
    pub fn payload(&self) -> Value {
        serde_json::from_str(&self.payload).unwrap_or(Value::Null)
    }
}

/// What a handler decided about its job.
#[derive(Debug)]
pub enum Outcome {
    Done,
    /// Try again after the delay, unless the job is out of attempts.
    Retry {
        code: &'static str,
        message: String,
        after: Duration,
    },
    /// Give up now.
    Failed {
        code: &'static str,
        message: String,
    },
}

pub struct NewJob<'a> {
    pub kind: &'a str,
    pub user_id: Option<&'a str>,
    pub recording_id: Option<&'a str>,
    pub payload: Value,
}

/// Wakes idle workers when new work arrives.
#[derive(Default, Clone)]
pub struct Wakeup(Arc<Notify>);

impl Wakeup {
    pub fn notify(&self) {
        self.0.notify_waiters();
    }
}

/// Adds a job unless the same kind is already queued or running for the same
/// recording; returns the id of the new or existing job.
pub async fn enqueue(db: &SqlitePool, job: NewJob<'_>) -> Result<String, sqlx::Error> {
    let id = ids::new_id();
    let now = now_ms();
    let inserted = sqlx::query(
        "INSERT INTO jobs (id, kind, user_id, recording_id, payload, run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, recording_id) WHERE state IN ('queued', 'running') AND recording_id IS NOT NULL DO NOTHING",
    )
    .bind(&id)
    .bind(job.kind)
    .bind(job.user_id)
    .bind(job.recording_id)
    .bind(job.payload.to_string())
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    if inserted.rows_affected() == 1 {
        return Ok(id);
    }
    sqlx::query_scalar("SELECT id FROM jobs WHERE kind = ? AND recording_id = ? AND state IN ('queued', 'running')")
        .bind(job.kind)
        .bind(job.recording_id)
        .fetch_one(db)
        .await
}

/// Atomically takes the oldest due job of `kind`: a queued one whose time has
/// come, or a running one whose lease ran out (its worker died).
///
/// Every claim bumps `lease_gen`, so the returned value identifies this claim.
/// `renew`, `set_progress` and `finish` match on it, so a worker that lost its
/// lease cannot touch the run that replaced it. `attempts` counts retries and is
/// reset by an explicit retry, so it cannot serve as the claim identity.
pub async fn claim(
    db: &SqlitePool,
    kind: &str,
    lease: Duration,
) -> Result<Option<Job>, sqlx::Error> {
    let now = now_ms();
    sqlx::query_as(
        "UPDATE jobs SET state = 'running', lease_until = ?, attempts = attempts + 1,
                lease_gen = lease_gen + 1, updated_at = ?
         WHERE id = (
             SELECT id FROM jobs
             WHERE kind = ? AND ((state = 'queued' AND run_after <= ?) OR (state = 'running' AND lease_until < ?))
             ORDER BY run_after, created_at LIMIT 1
         )
         RETURNING id, kind, user_id, recording_id, payload, attempts, lease_gen",
    )
    .bind(now + lease.as_millis() as i64)
    .bind(now)
    .bind(kind)
    .bind(now)
    .bind(now)
    .fetch_optional(db)
    .await
}

/// Extends the lease of a job this worker still holds. `lease_gen` is the value
/// the worker got from `claim`. Returns false when the lease was lost, because
/// the job was reclaimed or is no longer running.
pub async fn renew(
    db: &SqlitePool,
    id: &str,
    lease_gen: i64,
    lease: Duration,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let res = sqlx::query(
        "UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_gen = ?",
    )
    .bind(now + lease.as_millis() as i64)
    .bind(now)
    .bind(id)
    .bind(lease_gen)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Records progress for the run that still holds the lease. Returns false, and writes nothing,
/// when the job was reclaimed, so an old worker cannot move the bar of the run that replaced it.
pub async fn set_progress(
    db: &SqlitePool,
    id: &str,
    lease_gen: i64,
    progress: f64,
) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_gen = ?",
    )
    .bind(progress.clamp(0.0, 1.0))
    .bind(now_ms())
    .bind(id)
    .bind(lease_gen)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Records the handler's outcome. `max_attempts` bounds retries so a job that
/// always fails stops instead of looping forever. Returns false, and writes
/// nothing, when this worker no longer holds the lease.
pub async fn finish(
    db: &SqlitePool,
    job: &Job,
    outcome: Outcome,
    max_attempts: i64,
) -> Result<bool, sqlx::Error> {
    let now = now_ms();
    let (state, code, message, run_after) = match outcome {
        Outcome::Done => ("done", None, None, now),
        Outcome::Retry {
            code,
            message,
            after,
        } if job.attempts < max_attempts => (
            "queued",
            Some(code),
            Some(message),
            now + after.as_millis() as i64,
        ),
        Outcome::Retry { code, message, .. } | Outcome::Failed { code, message } => {
            ("failed", Some(code), Some(message), now)
        }
    };
    let finished = matches!(state, "done" | "failed").then_some(now);
    let res = sqlx::query(
        "UPDATE jobs SET state = ?, error_code = ?, error_message = ?, run_after = ?, lease_until = NULL,
         progress = CASE WHEN ? = 'done' THEN 1 ELSE progress END, finished_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_gen = ?",
    )
    .bind(state)
    .bind(code)
    .bind(message)
    .bind(run_after)
    .bind(state)
    .bind(finished)
    .bind(now)
    .bind(&job.id)
    .bind(job.lease_gen)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Exponential backoff with jitter: 30 s, 1 min, 2 min, ... capped at 1 h.
pub fn backoff(attempts: i64) -> Duration {
    let base = 30u64
        .saturating_mul(1 << attempts.clamp(1, 7).saturating_sub(1))
        .min(3600);
    let jitter = rand::random_range(0..=base / 5);
    Duration::from_secs(base + jitter)
}

/// Runs `concurrency` workers for one job kind until the process stops.
/// The lease is renewed in the background while a handler runs.
pub fn spawn_workers<F, Fut>(
    db: SqlitePool,
    wakeup: Wakeup,
    kind: &'static str,
    concurrency: usize,
    max_attempts: i64,
    handler: F,
) where
    F: Fn(Job) -> Fut + Send + Sync + Clone + 'static,
    Fut: Future<Output = Outcome> + Send + 'static,
{
    const LEASE: Duration = Duration::from_secs(120);
    for _ in 0..concurrency {
        let (db, wakeup, handler) = (db.clone(), wakeup.clone(), handler.clone());
        tokio::spawn(async move {
            loop {
                let job = match claim(&db, kind, LEASE).await {
                    Ok(Some(job)) => job,
                    Ok(None) => {
                        // Sleep until new work is announced, or poll again in 5 s for delayed retries.
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), wakeup.0.notified()).await;
                        continue;
                    }
                    Err(e) => {
                        tracing::error!(kind, error = %e, "job claim failed");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };
                let handler_task = tokio::spawn(handler(job.clone()));
                // When another worker has reclaimed the job, this worker stops its handler.
                let renewer = {
                    let (db, id, lease_gen) = (db.clone(), job.id.clone(), job.lease_gen);
                    let abort = handler_task.abort_handle();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(LEASE / 3).await;
                            match renew(&db, &id, lease_gen, LEASE).await {
                                Ok(true) => {}
                                Ok(false) => {
                                    tracing::warn!(
                                        job = id,
                                        "job lease was lost; stopping its handler"
                                    );
                                    abort.abort();
                                    return;
                                }
                                Err(e) => tracing::warn!(error = %e, "lease renewal failed"),
                            }
                        }
                    })
                };
                // A panicking handler must not kill the worker; treat it as a retryable failure.
                // Only the renewer aborts the handler, so a cancelled handler means the lease is gone.
                let outcome = match handler_task.await {
                    Ok(outcome) => Some(outcome),
                    Err(e) if e.is_cancelled() => None,
                    Err(e) => Some(Outcome::Retry {
                        code: "INTERNAL_ERROR",
                        message: format!("handler crashed: {e}"),
                        after: backoff(job.attempts),
                    }),
                };
                renewer.abort();
                let Some(outcome) = outcome else {
                    continue;
                };
                match finish(&db, &job, outcome, max_attempts).await {
                    Ok(true) => {}
                    Ok(false) => {
                        tracing::warn!(kind, job = job.id, "job result discarded: lease was lost");
                    }
                    Err(e) => {
                        tracing::error!(kind, job = job.id, error = %e, "could not record job result");
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use serde_json::json;

    async fn db() -> SqlitePool {
        open_memory().await.unwrap()
    }

    fn job<'a>(recording: Option<&'a str>) -> NewJob<'a> {
        NewJob {
            kind: "test",
            user_id: None,
            recording_id: recording,
            payload: json!({"n": 1}),
        }
    }

    #[tokio::test]
    async fn enqueue_dedupes_active_jobs_per_recording() {
        let db = db().await;
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES ('r', 'u', 'd', 'p', 'f', 0, 0, 0, 0, '', 'local', 'x', '1', 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        let a = enqueue(&db, job(Some("r"))).await.unwrap();
        let b = enqueue(&db, job(Some("r"))).await.unwrap();
        assert_eq!(a, b);
        assert_ne!(a, enqueue(&db, job(None)).await.unwrap());
    }

    #[tokio::test]
    async fn claim_takes_each_job_once_and_reclaims_expired_leases() {
        let db = db().await;
        let id = enqueue(&db, job(None)).await.unwrap();
        let first = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.id, id);
        assert_eq!(first.payload(), json!({"n": 1}));
        assert!(
            claim(&db, "test", Duration::from_secs(60))
                .await
                .unwrap()
                .is_none()
        );
        // Simulate a dead worker: its lease is in the past.
        sqlx::query("UPDATE jobs SET lease_until = 0")
            .execute(&db)
            .await
            .unwrap();
        let again = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(again.attempts, 2);
    }

    #[tokio::test]
    async fn stale_finish_is_ignored_after_reclaim() {
        let db = db().await;
        enqueue(&db, job(None)).await.unwrap();
        let stale = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE jobs SET lease_until = 0")
            .execute(&db)
            .await
            .unwrap();
        let current = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        // The stale worker wakes up and reports; its result must not land.
        assert!(!finish(&db, &stale, Outcome::Done, 3).await.unwrap());
        let state: String = sqlx::query_scalar("SELECT state FROM jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(state, "running");
        assert!(finish(&db, &current, Outcome::Done, 3).await.unwrap());
        let state: String = sqlx::query_scalar("SELECT state FROM jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(state, "done");
    }

    #[tokio::test]
    async fn renew_after_reclaim_reports_lease_loss() {
        let db = db().await;
        enqueue(&db, job(None)).await.unwrap();
        let stale = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE jobs SET lease_until = 0")
            .execute(&db)
            .await
            .unwrap();
        let current = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        assert!(
            !renew(&db, &stale.id, stale.lease_gen, Duration::from_secs(60))
                .await
                .unwrap()
        );
        assert!(
            renew(&db, &current.id, current.lease_gen, Duration::from_secs(60))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn a_retry_that_resets_attempts_does_not_revive_the_old_claim() {
        // An explicit retry sets `attempts` back to 0, so `attempts` alone cannot identify a
        // claim: the counter repeats. The lease generation never repeats.
        let db = db().await;
        enqueue(&db, job(None)).await.unwrap();
        let first = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        finish(
            &db,
            &first,
            Outcome::Failed {
                code: "X",
                message: "boom".into(),
            },
            3,
        )
        .await
        .unwrap();
        sqlx::query("UPDATE jobs SET state = 'queued', attempts = 0, lease_until = NULL")
            .execute(&db)
            .await
            .unwrap();
        let second = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            first.attempts, second.attempts,
            "the test needs equal counters"
        );
        assert!(second.lease_gen > first.lease_gen);
        assert!(
            !renew(&db, &first.id, first.lease_gen, Duration::from_secs(60))
                .await
                .unwrap()
        );
        assert!(!finish(&db, &first, Outcome::Done, 3).await.unwrap());
        assert!(
            renew(&db, &second.id, second.lease_gen, Duration::from_secs(60))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn progress_from_a_lost_lease_is_ignored() {
        let db = db().await;
        enqueue(&db, job(None)).await.unwrap();
        let stale = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE jobs SET lease_until = 0")
            .execute(&db)
            .await
            .unwrap();
        let current = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        assert!(
            !set_progress(&db, &stale.id, stale.lease_gen, 0.9)
                .await
                .unwrap()
        );
        let progress: f64 = sqlx::query_scalar("SELECT progress FROM jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(progress, 0.0);
        assert!(
            set_progress(&db, &current.id, current.lease_gen, 0.5)
                .await
                .unwrap()
        );
        let progress: f64 = sqlx::query_scalar("SELECT progress FROM jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(progress, 0.5);
    }

    #[tokio::test]
    async fn retries_stop_at_max_attempts() {
        let db = db().await;
        enqueue(&db, job(None)).await.unwrap();
        let retry = || Outcome::Retry {
            code: "X",
            message: "boom".into(),
            after: Duration::ZERO,
        };
        let j = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        finish(&db, &j, retry(), 2).await.unwrap();
        let j = claim(&db, "test", Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        finish(&db, &j, retry(), 2).await.unwrap();
        let (state, code): (String, String) = sqlx::query_as("SELECT state, error_code FROM jobs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!((state.as_str(), code.as_str()), ("failed", "X"));
        assert!(
            claim(&db, "test", Duration::from_secs(60))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff(1) >= Duration::from_secs(30) && backoff(1) <= Duration::from_secs(36));
        assert!(backoff(3) >= Duration::from_secs(120));
        assert!(backoff(50) <= Duration::from_secs(4320));
    }
}
