-- Who started each background job in a sandbox (workspace_job_start, src/tools/jobs.ts), so
-- that workspace_job_cancel can let only them, or a workspace admin, stop it. One row per job
-- id in a session (one Slack thread, one sandbox); the first start writes it, before the start
-- is sent (its answer may be lost after guestd started it), and a replayed start leaves it as
-- it was; a start guestd refused (nothing ran) removes the row it wrote. `started_by` is the
-- Slack user id of the turn's speaker when Slack vouched for it (a signed event), else NULL:
-- then anyone in the thread may cancel. A job with no row may be cancelled only by an admin.
-- No text is kept: the command stays in the sandbox. Rows older than two days (a job runs at
-- most six hours) go on start and daily.
CREATE TABLE sandbox_jobs (
  session     TEXT NOT NULL,
  job         TEXT NOT NULL,
  started_by  TEXT,
  started_at  TEXT NOT NULL,
  PRIMARY KEY (session, job)
);
