-- jobs table, this is the main table for the queue
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  command       TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  next_run_at   TEXT NOT NULL,
  worker_pid    INTEGER,
  claimed_at    TEXT,
  heartbeat_at  TEXT,
  last_error    TEXT,
  last_exit_code INTEGER
);

-- index to make finding pending jobs fast
CREATE INDEX IF NOT EXISTS idx_jobs_state_next_run ON jobs (state, next_run_at);

-- config table, key-value pairs for settings like max retries
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
