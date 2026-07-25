'use strict';

// claiming, completing, and failing jobs

const { getDb } = require('./db');

function nowIso() {
  return new Date().toISOString();
}

// picks the oldest pending job that is ready to run and marks it as
// processing, all in one sql statement. this is what stops two workers
// from grabbing the same job - the SELECT that finds the job and the
// UPDATE that claims it happen together, not as two separate steps.
function claimNextJob(workerPid) {
  const db = getDb();
  const ts = nowIso();

  const row = db
    .prepare(
      `UPDATE jobs
       SET state = 'processing', worker_pid = ?, claimed_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = (
         SELECT id FROM jobs
         WHERE state = 'pending' AND next_run_at <= ?
         ORDER BY next_run_at ASC, created_at ASC
         LIMIT 1
       )
       RETURNING *`
    )
    .get(workerPid, ts, ts, ts, ts);

  return row || null;
}

// called on a timer while a job is running, so the reaper can tell this
// job is still being actively worked on
function heartbeat(id) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND state = 'processing'`).run(
    nowIso(),
    id
  );
}

function completeJob(id, exitCode) {
  const db = getDb();
  db.prepare(
    `UPDATE jobs
     SET state = 'completed', updated_at = ?, last_exit_code = ?, last_error = NULL,
         worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
     WHERE id = ?`
  ).run(nowIso(), exitCode, id);
}

// note: no backoff delay yet (that's the next phase). for now a failed
// job either goes straight back to pending if it still has retries left,
// or to dead if it's used them all up.
function failJob(id, exitCode, errorMessage) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return;

  const attempts = job.attempts + 1;
  const ts = nowIso();

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs
       SET state = 'dead', attempts = ?, updated_at = ?, last_exit_code = ?, last_error = ?,
           worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`
    ).run(attempts, ts, exitCode, errorMessage, id);
  } else {
    db.prepare(
      `UPDATE jobs
       SET state = 'pending', attempts = ?, updated_at = ?, next_run_at = ?, last_exit_code = ?, last_error = ?,
           worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`
    ).run(attempts, ts, ts, exitCode, errorMessage, id);
  }
}

module.exports = { claimNextJob, completeJob, failJob, heartbeat };
