'use strict';

// claiming, completing, failing (with backoff), and heartbeating jobs

const { getDb } = require('./db');
const { getConfig } = require('./config');

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

// a failed job either goes to "dead" (out of retries) or "failed" with a
// next_run_at pushed into the future by backoff-base ^ attempts seconds.
// "failed" jobs are not claimable - claimNextJob only looks at "pending" -
// so promoteReadyRetries() is what flips them back to pending once their
// wait is over.
function failJob(id, exitCode, errorMessage) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return null;

  const attempts = job.attempts + 1;
  const ts = nowIso();

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs
       SET state = 'dead', attempts = ?, updated_at = ?, last_exit_code = ?, last_error = ?,
           worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`
    ).run(attempts, ts, exitCode, errorMessage, id);
    return 'dead';
  }

  const base = Number(getConfig('backoff-base'));
  const delaySeconds = Math.pow(base, attempts);
  const nextRunAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  db.prepare(
    `UPDATE jobs
     SET state = 'failed', attempts = ?, updated_at = ?, next_run_at = ?,
         last_exit_code = ?, last_error = ?,
         worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
     WHERE id = ?`
  ).run(attempts, ts, nextRunAt, exitCode, errorMessage, id);
  return 'failed';
}

// flips "failed" jobs back to "pending" once their backoff delay has
// passed, so the claim query (which only looks at "pending") can pick
// them up again
function promoteReadyRetries() {
  const db = getDb();
  const ts = nowIso();
  db.prepare(`UPDATE jobs SET state = 'pending', updated_at = ? WHERE state = 'failed' AND next_run_at <= ?`).run(
    ts,
    ts
  );
}

module.exports = { claimNextJob, completeJob, failJob, heartbeat, promoteReadyRetries };
