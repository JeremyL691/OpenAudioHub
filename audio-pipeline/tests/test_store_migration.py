import sqlite3
from pathlib import Path

from audio_pipeline.store import JobStore

LEGACY_JOBS_TABLE = """
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    riffado_job_id TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    error_type TEXT,
    error TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _columns(path: Path) -> set[str]:
    with sqlite3.connect(path) as db:
        return {row[1] for row in db.execute("PRAGMA table_info(jobs)")}


def test_legacy_database_column_is_renamed_and_rows_kept(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as db:
        db.executescript(LEGACY_JOBS_TABLE)
        db.execute(
            "INSERT INTO jobs (id, idempotency_key, riffado_job_id, duration_ms, "
            "status, phase, created_at, updated_at) "
            "VALUES ('job-1', 'job-1', 'core-job-1', 1000, 'queued', 'queued', 'now', 'now')"
        )

    JobStore(path)

    columns = _columns(path)
    assert "core_job_id" in columns
    assert "riffado_job_id" not in columns
    with sqlite3.connect(path) as db:
        value = db.execute("SELECT core_job_id FROM jobs WHERE id = 'job-1'").fetchone()
    assert value == ("core-job-1",)


def test_new_database_uses_core_job_id_and_reopening_is_a_no_op(tmp_path: Path) -> None:
    path = tmp_path / "fresh.sqlite3"
    JobStore(path)
    JobStore(path)

    columns = _columns(path)
    assert "core_job_id" in columns
    assert "riffado_job_id" not in columns
