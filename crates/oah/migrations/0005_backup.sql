-- A user has at most one active (pending or processing) export or backup job.
-- Concurrent POST /api/backup requests collide here and both get the same job.
CREATE UNIQUE INDEX export_jobs_one_active ON export_jobs(user_id) WHERE status IN ('pending', 'processing');

-- Desktop auto export: the time auto export was switched on for a user. Uploads
-- made before that time are never exported.
CREATE TABLE auto_export_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    since INTEGER NOT NULL
);
