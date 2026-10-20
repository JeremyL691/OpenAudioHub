-- Identifies each claim of a job. `attempts` counts retries and is reset by an explicit
-- retry, so it repeats; this counter only ever grows. A worker that lost its lease fails
-- every write because its generation is no longer the stored one.
ALTER TABLE jobs ADD COLUMN lease_gen INTEGER NOT NULL DEFAULT 0;
