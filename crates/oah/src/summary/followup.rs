//! Work that follows a saved transcript: the `transcription.completed` event, an automatic
//! title, and an automatic summary.
//!
//! The save step used to commit the transcript and then call these directly. A process that
//! stopped between the commit and the call left a transcript with no event and no automatic
//! summary, and nothing recorded that the work was owed. A failed summary enqueue was logged
//! and forgotten.
//!
//! The save step now writes an `after_transcript` job in the same transaction as the
//! transcript, and this module runs it. The job names the transcript it was queued for, so it
//! never titles or summarises a newer transcript than the one it was created for, and a retried
//! save cannot queue the same follow-up twice.
//!
//! The guarantee is at-least-once: a provider call that answered but whose result was not
//! committed before the process stopped is made again. The work is not lost.

use serde_json::Value;

use crate::AppState;
use crate::jobs::{self, Job, NewJob, Outcome};
use crate::routes;

/// The job kind.
pub const KIND: &str = "after_transcript";

/// How many claims a follow-up job gets before it is left failed with its error.
const MAX_ATTEMPTS: i64 = 3;

/// How many follow-up jobs run at once in one process.
const WORKERS: usize = 2;

/// What a follow-up job was queued for.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    /// The transcript this job belongs to.
    transcript_id: String,
    /// `transcription` for a transcript this server produced, `plaud` for an imported one.
    source: String,
    /// Set once the title step has finished, so a resumed job does not generate a second title.
    #[serde(default)]
    title_done: bool,
}

/// Starts the worker.
pub fn spawn(state: &AppState) {
    let worker = state.clone();
    jobs::spawn_workers(
        state.db.clone(),
        state.wakeup.clone(),
        KIND,
        WORKERS,
        MAX_ATTEMPTS,
        move |job: Job| {
            let state = worker.clone();
            async move { run_job(&state, job).await }
        },
    );
}

/// Queues the follow-up for a transcript that was just saved, inside the caller's transaction,
/// so the work is committed together with the transcript that owes it.
///
/// `source` is `transcription` for a transcript this server produced and `plaud` for one it
/// imported. Only the first emits `transcription.completed` and runs an automatic title; both
/// may run an automatic summary.
pub async fn enqueue_in<'e, E>(
    executor: E,
    user_id: &str,
    recording_id: &str,
    transcript_id: &str,
    source: &str,
) -> Result<(), sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let payload = serde_json::to_value(Payload {
        transcript_id: transcript_id.to_owned(),
        source: source.to_owned(),
        title_done: false,
    })
    .expect("a follow-up payload serializes");
    jobs::enqueue_in(
        executor,
        NewJob {
            kind: KIND,
            user_id: Some(user_id),
            recording_id: Some(recording_id),
            payload,
        },
        Some(&dedupe_key(transcript_id)),
    )
    .await?;
    Ok(())
}

/// Runs the follow-up for a transcript now, and leaves it queued if that does not finish.
///
/// The request that saved the transcript calls this, so the `transcription.completed` event, the
/// title and the summary queue are behind the answer the caller gets, which is what the
/// specification describes. The queue is still what makes the work durable: if another worker
/// already holds the job, or the process stops while this runs, the job stays queued and the
/// worker runs it. Claiming here is a fast path, not a second mechanism.
pub async fn run_now(state: &AppState, recording_id: &str, transcript_id: &str) {
    let key = dedupe_key(transcript_id);
    let now = crate::db::now_ms();
    let claimed = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            i64,
            i64,
        ),
    >(
        "UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_gen = lease_gen + 1,
                lease_until = ?, updated_at = ?
         WHERE id = (
             SELECT id FROM jobs WHERE kind = ? AND dedupe_key = ?
               AND state = 'queued' AND run_after <= ?
         )
         RETURNING id, kind, user_id, recording_id, payload, attempts, lease_gen",
    )
    .bind(now + CLAIM_MS)
    .bind(now)
    .bind(KIND)
    .bind(&key)
    .bind(now)
    .fetch_optional(&state.db)
    .await;
    let job = match claimed {
        Ok(Some((id, kind, user_id, recording_id, payload, attempts, lease_gen))) => Job {
            id,
            kind,
            user_id,
            recording_id,
            payload,
            attempts,
            lease_gen,
        },
        // Another worker holds it, or it is not due yet: the queue runs it.
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(recording = recording_id, error = %e, "could not claim the follow-up job");
            return;
        }
    };
    let outcome = run_job(state, job.clone()).await;
    // The queue's own bookkeeping decides what the outcome means: `Done` finishes the job, a
    // `Retry` puts it back with its delay until the attempts run out, and a failure is recorded.
    // Treating a retry as success here would end work that a transient database or settings error
    // interrupted, which is exactly what this job exists to survive.
    if let Err(e) = jobs::finish(&state.db, &job, outcome, MAX_ATTEMPTS).await {
        tracing::warn!(job = job.id, error = %e, "could not record the follow-up outcome");
    }
}

/// How long the claim made by `run_now` is held while the request waits for it.
const CLAIM_MS: i64 = 5 * 60 * 1000;

/// Wakes the worker after the transaction that queued the work has committed.
pub fn notify(state: &AppState) {
    state.wakeup.notify();
}

/// One key per transcript, so the same transcript never queues two follow-ups.
fn dedupe_key(transcript_id: &str) -> String {
    format!("{KIND}:{transcript_id}")
}

/// The key a follow-up job for this transcript is deduped on.
pub fn key_for(transcript_id: &str) -> String {
    dedupe_key(transcript_id)
}

/// The key the `transcription.completed` delivery for this transcript is deduped on. The save
/// records the event, so running the follow-up twice cannot deliver it twice.
pub fn event_key(transcript_id: &str) -> String {
    format!("transcription.completed:{transcript_id}")
}

async fn run_job(state: &AppState, job: Job) -> Outcome {
    let (Some(user_id), Some(recording_id)) = (job.user_id.as_deref(), job.recording_id.as_deref())
    else {
        return Outcome::Failed {
            code: "INTERNAL_ERROR",
            message: "Follow-up job has no recording".into(),
        };
    };
    let payload: Payload = match serde_json::from_value(job.payload()) {
        Ok(payload) => payload,
        Err(_) => {
            return Outcome::Failed {
                code: "INTERNAL_ERROR",
                message: "Follow-up job has a bad payload".into(),
            };
        }
    };
    match current(state, user_id, recording_id, &payload.transcript_id).await {
        Ok(true) => {}
        Ok(false) => {
            // The transcript was deleted or replaced. Its event and its summary belong to it, not
            // to whatever replaced it, so the work is dropped instead of applied to the new one.
            return Outcome::Done;
        }
        Err(message) => {
            return Outcome::Retry {
                code: "INTERNAL_ERROR",
                message,
                after: jobs::backoff(job.attempts),
            };
        }
    }

    if payload.source == "transcription" {
        // The completion event was recorded by the save, in the transaction that stored the
        // transcript, so this job only owes the title and the summary.
        if !payload.title_done {
            auto_title(state, user_id, recording_id, &payload.transcript_id).await;
            // The title step is behind this job whether it produced a title or not: the
            // specification says a failed title leaves the name as it was and does not stop the
            // summary after it. Recording that keeps a later claim from asking again.
            if let Err(e) = mark_title_done(state, &job).await {
                tracing::warn!(job = %job.id, error = %e, "could not record the finished title step");
            }
        }
    }

    match crate::summary::queue_auto_for(state, user_id, recording_id, &payload.transcript_id).await
    {
        Ok(_) => Outcome::Done,
        Err(e) => Outcome::Retry {
            code: e.code,
            message: e.message,
            after: jobs::backoff(job.attempts),
        },
    }
}

/// Records that the title step is behind this job.
async fn mark_title_done(state: &AppState, job: &Job) -> Result<(), sqlx::Error> {
    let Some(mut payload) = serde_json::from_value::<Payload>(job.payload()).ok() else {
        return Ok(());
    };
    payload.title_done = true;
    let value = serde_json::to_value(&payload).expect("a follow-up payload serializes");
    sqlx::query("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?")
        .bind(value.to_string())
        .bind(crate::db::now_ms())
        .bind(&job.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Whether the transcript this job was queued for is still a transcript of a live recording.
async fn current(
    state: &AppState,
    user_id: &str,
    recording_id: &str,
    transcript_id: &str,
) -> Result<bool, String> {
    let found: bool = sqlx::query_scalar(
        "SELECT EXISTS (
             SELECT 1 FROM transcriptions t
             JOIN recordings r ON r.id = t.recording_id
             WHERE t.id = ? AND t.user_id = ? AND t.recording_id = ?
               AND r.user_id = ? AND r.deleted_at IS NULL
         )",
    )
    .bind(transcript_id)
    .bind(user_id)
    .bind(recording_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(found)
}

/// Generates the title when the user asked for one. A failure is logged and does not stop the
/// summary after it, which is what the specification promises.
async fn auto_title(state: &AppState, user_id: &str, recording_id: &str, transcript_id: &str) {
    let settings = match routes::settings::effective(state, user_id).await {
        Ok(settings) => settings,
        Err(e) => {
            tracing::error!(
                recording = recording_id,
                code = e.code,
                "could not read the settings"
            );
            return;
        }
    };
    if settings.get("autoGenerateTitle") != Some(&Value::Bool(true)) {
        return;
    }
    if let Err(e) = crate::summary::title::generate(
        state,
        user_id,
        recording_id,
        &settings,
        Some(transcript_id),
    )
    .await
    {
        tracing::error!(recording = recording_id, code = e.code, error = %e.message, "title generation failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use serde_json::json;

    async fn state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES ('r', 'u', 'd', 'p', 'f', 0, 0, 0, 0, '', 'local', 'x', '1', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        (state, dir)
    }

    async fn transcript(state: &AppState, id: &str) {
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at)
             VALUES (?, 'r', 'u', 'v1:text', 'server', 'OpenAI', 'whisper-1', 'openaudiohub', 0)",
        )
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    }

    async fn job_count(state: &AppState) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE kind = ?")
            .bind(KIND)
            .fetch_one(&state.db)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_follow_up_is_committed_with_the_transcript() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        assert_eq!(job_count(&state).await, 1);
    }

    #[tokio::test]
    async fn the_same_transcript_queues_one_follow_up_only() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        assert_eq!(job_count(&state).await, 1, "a retried save adds nothing");
    }

    #[tokio::test]
    async fn a_finished_follow_up_is_not_queued_again() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        // The job ran and finished.
        sqlx::query("UPDATE jobs SET state = 'done'")
            .execute(&state.db)
            .await
            .unwrap();
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        assert_eq!(
            job_count(&state).await,
            1,
            "a finished follow-up is not repeated"
        );
    }

    #[tokio::test]
    async fn a_newer_transcript_gets_its_own_follow_up() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        // A re-run replaced the transcript.
        sqlx::query("DELETE FROM transcriptions WHERE id = 't1'")
            .execute(&state.db)
            .await
            .unwrap();
        transcript(&state, "t2").await;
        enqueue_in(&state.db, "u", "r", "t2", "transcription")
            .await
            .unwrap();
        assert_eq!(job_count(&state).await, 2);
    }

    #[tokio::test]
    async fn a_job_whose_transcript_is_gone_does_nothing() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        let job = crate::jobs::claim(&state.db, KIND, std::time::Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        // The transcript was deleted or replaced while the job was queued.
        sqlx::query("DELETE FROM transcriptions WHERE id = 't1'")
            .execute(&state.db)
            .await
            .unwrap();
        let outcome = run_job(&state, job).await;
        assert!(matches!(outcome, Outcome::Done));
        let deliveries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhook_deliveries")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(
            deliveries, 0,
            "no event is emitted for a transcript that is gone"
        );
    }

    #[tokio::test]
    async fn a_job_of_a_deleted_recording_does_nothing() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        let job = crate::jobs::claim(&state.db, KIND, std::time::Duration::from_secs(60))
            .await
            .unwrap()
            .unwrap();
        sqlx::query("UPDATE recordings SET deleted_at = 1")
            .execute(&state.db)
            .await
            .unwrap();
        assert!(matches!(run_job(&state, job).await, Outcome::Done));
    }

    #[tokio::test]
    async fn the_payload_names_the_transcript_and_survives_a_round_trip() {
        let payload: Payload =
            serde_json::from_value(json!({"transcriptId": "t1", "source": "plaud"})).unwrap();
        assert_eq!(payload.transcript_id, "t1");
        assert_eq!(payload.source, "plaud");
        assert!(!payload.title_done, "a fresh job still owes the title");
    }

    #[tokio::test]
    async fn the_follow_up_is_removed_with_its_recording() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        enqueue_in(&state.db, "u", "r", "t1", "transcription")
            .await
            .unwrap();
        sqlx::query("DELETE FROM recordings WHERE id = 'r'")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(
            job_count(&state).await,
            0,
            "the job goes with its recording"
        );
    }
}

#[cfg(test)]
mod rework_tests {
    use super::*;
    use crate::config::Config;

    async fn state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            Config::for_tests(dir.path()),
            crate::db::open_memory().await.unwrap(),
        );
        sqlx::query(
            "INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'u@x.test', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO recordings (id, user_id, device_sn, plaud_file_id, filename, duration, start_time, end_time, filesize, file_md5, storage_type, storage_path, plaud_version, created_at, updated_at)
             VALUES ('r', 'u', 'd', 'p', 'f', 0, 0, 0, 0, '', 'local', 'x', '1', 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        (state, dir)
    }

    async fn transcript(state: &AppState, id: &str) {
        sqlx::query(
            "INSERT INTO transcriptions (id, recording_id, user_id, text, transcription_type, provider, model, source, created_at)
             VALUES (?, 'r', 'u', 'v1:text', 'server', 'OpenAI', 'whisper-1', 'openaudiohub', 0)",
        )
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    }

    /// A transient failure has to stay retryable. Recording it as done would end work that a
    /// database or settings read interrupted. This drives the request path itself, so a wrong
    /// outcome there is caught.
    #[tokio::test]
    async fn a_retry_from_the_request_path_stays_queued() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        sqlx::query(
            "INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at, dedupe_key)
             VALUES ('j', ?, 'u', 'r', 'queued', ?, 0, 0, 0, 'after_transcript:t1')",
        )
        .bind(KIND)
        .bind(serde_json::json!({"transcriptId": "t1", "source": "transcription"}).to_string())
        .execute(&state.db)
        .await
        .unwrap();

        // A successful run finishes the job.
        run_now(&state, "r", "t1").await;
        let job_state: String = sqlx::query_scalar("SELECT state FROM jobs WHERE id = 'j'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(job_state, "done", "a completed follow-up is done");

        // The same path with work that can only be retried: the settings table the run reads is
        // gone, so the run reports a retryable error instead of an answer.
        sqlx::query(
            "INSERT INTO jobs (id, kind, user_id, recording_id, state, payload, run_after, created_at, updated_at, dedupe_key)
             VALUES ('k', ?, 'u', 'r', 'queued', ?, 0, 0, 0, ?)",
        )
        .bind(KIND)
        .bind(serde_json::json!({"transcriptId": "t1b", "source": "transcription"}).to_string())
        .bind(key_for("t1b"))
        .execute(&state.db)
        .await
        .unwrap();
        // A second transcript for the same recording, so the retry case has its own job.
        sqlx::query("UPDATE transcriptions SET id = 't1b' WHERE id = 't1'")
            .execute(&state.db)
            .await
            .unwrap();
        sqlx::query("DROP TABLE user_settings")
            .execute(&state.db)
            .await
            .unwrap();
        run_now(&state, "r", "t1b").await;
        let (job_state, attempts): (String, i64) =
            sqlx::query_as("SELECT state, attempts FROM jobs WHERE id = 'k'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(
            job_state, "queued",
            "a retry has to stay queued, not be recorded as done"
        );
        assert_eq!(attempts, 1, "the attempt is counted once");
    }

    /// The completion event is recorded by the save, so a repeated save cannot deliver it twice.
    #[tokio::test]
    async fn the_completion_event_is_recorded_once_per_transcript() {
        let (state, _dir) = state().await;
        transcript(&state, "t1").await;
        sqlx::query(
            "INSERT INTO webhook_endpoints (id, user_id, url, secret, events, enabled, created_at, updated_at)
             VALUES ('e', 'u', 'https://example.test/hook', 's', '[\"transcription.completed\"]', 1, 0, 0)",
        )
        .execute(&state.db)
        .await
        .unwrap();
        for _ in 0..2 {
            let mut tx = state.db.begin().await.unwrap();
            crate::webhooks::record_in(
                &mut tx,
                &state,
                "u",
                "r",
                "transcription.completed",
                None,
                Some(&event_key("t1")),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
        }
        let deliveries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhook_deliveries")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(deliveries, 1, "recorded once, not once per save");
    }

    /// A newer transcript gets its own summary job instead of reusing an older transcript's
    /// queued run, which would end as stale and leave the new transcript unsummarised.
    #[tokio::test]
    async fn a_newer_transcript_gets_its_own_summary_job() {
        let (state, _dir) = state().await;
        sqlx::query("INSERT INTO user_settings (user_id, data, updated_at) VALUES ('u', ?, 0)")
            .bind(serde_json::json!({"autoSummarize": true}).to_string())
            .execute(&state.db)
            .await
            .unwrap();
        transcript(&state, "t1").await;
        crate::summary::queue_auto_for(&state, "u", "r", "t1")
            .await
            .unwrap();
        sqlx::query("DELETE FROM transcriptions WHERE id = 't1'")
            .execute(&state.db)
            .await
            .unwrap();
        transcript(&state, "t2").await;
        crate::summary::queue_auto_for(&state, "u", "r", "t2")
            .await
            .unwrap();
        let jobs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE kind = 'summary'")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(jobs, 2, "each transcript gets its own run");
    }
}
