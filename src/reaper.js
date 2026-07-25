'use strict';

// finds jobs stuck in "processing" whose worker has gone silent (crashed,
// got killed, terminal closed, whatever) and puts them back to pending so
// some worker picks them up again.

const { getDb } = require('./db');

// if a job's heartbeat hasn't updated in this many seconds, we assume
// whatever worker had it is gone. worst case time to notice = this value
// plus however long a worker waits between checks (worker.js's POLL_MS).
// 15s + 2s poll = 17s worst case, under the 60s the assignment asks for.
const STALE_AFTER_SECONDS = 15;

function reapStaleJobs() {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_AFTER_SECONDS * 1000).toISOString();
  const ts = new Date().toISOString();

  const result = db
    .prepare(
      `UPDATE jobs
       SET state = 'pending', worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL,
           updated_at = ?, next_run_at = ?
       WHERE state = 'processing' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`
    )
    .run(ts, ts, cutoff);

  return result.changes;
}

module.exports = { reapStaleJobs, STALE_AFTER_SECONDS };
