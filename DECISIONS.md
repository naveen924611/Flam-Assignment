# DECISIONS.md

## 1. Which exact line(s) prevent two workers from claiming the same job, and why is that atomic across separate OS processes?

`src/claim.js`, the `claimNextJob` function:

```js
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
```

This is a single SQL statement, not a `SELECT` followed by a separate `UPDATE`. Picking the candidate job and marking it `processing` happen together, inside one statement. That matters because a two-step "find a pending job, then update it" approach has a window between the two steps where a second worker could read the exact same row before the first worker's write lands - here there is no such window, because there's only one step.

It's atomic **across processes**, not just within one process, because every worker (each is a separate `node` process, started via `worker start --count N`) opens its own connection to the same on-disk file (`src/db.js`, `getDb()`), and it's SQLite itself - not any code in this project - that only allows one write transaction to be in flight at a time, enforced with real OS file locks on the `-wal`/`-shm` files (`src/db.js` turns on `PRAGMA journal_mode = WAL`). If two worker processes call `claimNextJob` at the same instant, the OS lock serializes them: one actually runs first and commits, the other blocks (up to `PRAGMA busy_timeout = 5000`, also in `db.js`) and only then executes its own `UPDATE ... WHERE id = (SELECT ...)`. By that point its subquery no longer sees the row the first worker just claimed - `state = 'pending'` is no longer true for it - so it picks a different pending job, or none. No job is ever returned to two claimants.

`heartbeat`, `completeJob`, and `failJob` in the same file follow the same pattern for the same reason: a plain `UPDATE ... WHERE id = ?`, no read-then-write split anywhere.

## 2. A worker is SIGKILLed halfway through a job. Walk through what happens and the worst-case delay.

1. Worker W claims job J via `claimNextJob`: `state = 'processing'`, `worker_pid = W`, `heartbeat_at = now`.
2. While J's command runs, W bumps `heartbeat_at` on a timer - `src/worker.js`, `runCommand()`, `setInterval(() => heartbeat(job.id), HEARTBEAT_MS)`, every 3 seconds by default.
3. W gets `SIGKILL`. Node cannot intercept `SIGKILL` at all - no handler runs, nothing gets a chance to clean up. J is left with `state = 'processing'` and a `heartbeat_at` that simply stops advancing wherever it last was.
4. Nothing is watching W specifically. Instead, **every** worker - including J's eventual replacement - runs a stale-job sweep at the top of every loop iteration, before it tries to claim anything for itself (`src/worker.js`'s loop calls `reapStaleJobs()`; the query lives in `src/reaper.js`):
   ```sql
   UPDATE jobs
   SET state = 'pending', worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL, ...
   WHERE state = 'processing' AND heartbeat_at IS NOT NULL AND heartbeat_at < <now - 15s>
   ```
5. Once J's `heartbeat_at` is older than `STALE_AFTER_SECONDS` (15s, `src/reaper.js`), the next sweep by any live worker flips it back to `pending`. It's immediately claimable again - no extra delay beyond that.
6. Whichever worker gets there next runs J's command again from scratch. We have no way to know how far the killed process got, so a full re-run is the only safe option. `attempts` is **not** incremented for this - a crash isn't a failure of the command, so it doesn't spend part of the job's retry budget.

Worst case = `STALE_AFTER_SECONDS` + the worker poll interval (`POLL_MS`, 2 seconds): J's heartbeat can be just under 15s old before the next sweep even looks at it, and that sweep might not run until up to 2 more seconds pass on whichever worker gets there first. **15s + 2s = 17s worst case**, comfortably inside the 60s the assignment requires. This was measured directly with a real `SIGKILL` (not just Ctrl+C) against this codebase: recovery completed in 17-18 seconds.

Trade-off worth being honest about: this is a timeout-based liveness check, not a true "is this process actually dead" check. A worker that's simply slow - genuinely still working, but slower than 15s between heartbeats for some reason - would have its job reclaimed and re-run by someone else, meaning the same command could run twice back to back. We accept this because job commands are expected to be reasonably quick shell tasks, and the alternative (a much longer timeout, or none) directly breaks the 60-second recovery requirement.

## 3. Does `dlq retry` reset `attempts`? Why is that the right call?

Yes - `src/commands.js`, `dlqRetry`, sets `attempts = 0` when moving the job back to `pending`.

A job only reaches the DLQ once `attempts >= max_retries` (`src/claim.js`, `failJob`). If `dlq retry` left `attempts` untouched, the job would come back exactly at the threshold that just sent it to the DLQ - one more failure and it's immediately dead-lettered again, giving it no real second chance at all.

`dlq retry` is a deliberate, manual action by a human who looked at the failure and decided it's worth trying again - that's a different kind of event from the automatic retries the job already used up. Treating it as "give this job a full fresh attempt budget" matches that intent. The trade-off: a job that is genuinely, permanently broken could be retried forever by someone repeatedly running `dlq retry` - but that requires a human to keep choosing to do that, which is a very different failure mode from the system silently retrying forever on its own.

## 4. What designs were considered and rejected for `worker stop`, and why?

Chosen: **PID files plus real `SIGTERM`.** Every worker process writes `DB/workers/<pid>.json` on start and removes it on clean exit (`src/workers.js`, `registerWorker`/`deregisterWorker`). `worker stop` lists that folder, confirms each PID is actually still alive with `process.kill(pid, 0)` (quietly cleaning up stale entries left by workers that died without deregistering), and sends real `SIGTERM` to each live one (`stopAllWorkers`).

Considered and rejected:

- **A "please stop" flag/row in the database, polled by workers.** Easy to add since workers already poll the DB. Rejected because it ties shutdown responsiveness to the poll interval on top of whatever the flag-check itself adds, and because it would mean "stop from another terminal" and "Ctrl+C in this terminal" are two *separate* code paths (one polling a DB value, one catching `SIGINT`) that both need to correctly implement "finish the current job, then exit" - two places for that logic to drift apart. Real OS signals let both cases share the exact same handler in `src/worker.js`.
- **A Unix domain socket per worker**, with `worker stop` connecting to send a stop command. Rejected: this doesn't remove the discovery problem, it just moves it - `worker stop` still needs some way to find each worker's socket path, which in practice ends up being a directory of files anyway. It also adds a long-lived listener per worker that has to be set up and torn down correctly (stale socket files after a crash, connection races) for no real benefit over a signal.
- **Process-group signaling (`killpg`-style).** Would let one signal reach every worker with no registry needed at all, but only works if `worker stop` is guaranteed to share a process group with the workers - which isn't true once "start in one terminal, stop from a different terminal/session" is a hard requirement. That's exactly the case a shared process group doesn't survive.

PID files won because there's no long-lived listener to manage, they're trivially inspectable while debugging (`ls DB/workers`), stale entries self-heal (`listLiveWorkers` prunes dead PIDs it finds), and `worker stop` ends up reusing the exact same graceful-shutdown path Ctrl+C already needs.

## 5. If priorities were added tomorrow, what survives and what breaks?

**Survives unchanged:** the atomic claim mechanism itself - the single-statement `UPDATE ... WHERE id = (SELECT ...) RETURNING *` pattern doesn't care *how* the candidate row is chosen, only that picking it and marking it taken happen together. Backoff math, the DLQ transition, crash recovery via heartbeats, `worker stop` via PID files, persistence, and the config system are all independent of job ordering. The CLI surface and job schema mostly hold, aside from one additive column.

**Breaks / needs to change:** the `ORDER BY next_run_at ASC, created_at ASC` inside `claimNextJob`'s subquery is exactly where priority has to slot in - e.g. `ORDER BY priority DESC, next_run_at ASC, created_at ASC`, with a new `priority INTEGER NOT NULL DEFAULT 0` column and a matching addition in `DB/schema.sql`. `enqueue` (`src/commands.js`) would need to accept and validate an optional `priority` field. The index `idx_jobs_state_next_run` on `(state, next_run_at)` should become `(state, priority, next_run_at)` so the claim query stays an index lookup as the table grows rather than degrading into a scan. One real risk worth flagging honestly: nothing here prevents low-priority jobs from starving under sustained high-priority load - that would need an explicit mitigation (e.g. boosting priority the longer a job waits) if it turned out to matter, and that's a product decision, not something blocked by the current design.
