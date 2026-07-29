# queuectl

A CLI-based background job queue: enqueue shell commands, run them with worker
processes, retry failures with exponential backoff, and quarantine permanently
failed jobs in a Dead Letter Queue (DLQ). Jobs and config are persisted in
SQLite (WAL mode) and survive process restarts and worker crashes.

See `DECISIONS.md` for the five required design-decision write-ups: atomic job
claiming, crash recovery timing, DLQ retry semantics, the `worker stop`
design, and what would change if priorities were added.

## Requirements

- Node.js **>= 22.5.0** - uses the built-in `node:sqlite` module, so there
  are no native dependencies and no `npm install` step.
- A shell available for running job commands (`spawn(cmd, { shell: true })`).
  Developed and tested primarily on Windows/PowerShell and Linux/bash.

Check your version: `node --version`.

## Setup

```bash
git clone <this-repo>
cd <this-repo>
npm link       # registers the "queuectl" command from package.json's bin field
```

No build step and no dependencies to install. Every command below can also be
run as `node index.js <command>` without linking, if you'd rather not install
it globally.

All state - the SQLite database and worker PID files - lives under `DB/` in
the project folder (`DB/queuectl.db`, `DB/workers/`). `DB/*.db`, `DB/*.db-*`,
and `DB/workers/` are gitignored; only `DB/schema.sql` (the table
definitions) is committed.

## Quick start

```bash
# Terminal 1: enqueue some jobs
queuectl enqueue '{"id":"job1","command":"echo hello"}'
queuectl enqueue '{"command":"sleep 2 && echo done"}'        # id auto-generated
queuectl enqueue '{"command":"exit 1","max_retries":2}'      # will end up in the DLQ

# Terminal 1: start workers (blocks in the foreground)
queuectl worker start --count 3

# Terminal 2: check on things while workers run
queuectl status
queuectl list --state pending --json
queuectl dlq list

# Terminal 2: stop the workers running in terminal 1
queuectl worker stop
```

`Ctrl+C` in the worker terminal does the same graceful shutdown as
`worker stop` run from elsewhere: the in-flight job is allowed to finish
before the process exits.

### A note on Windows PowerShell and quoting

PowerShell (specifically Windows PowerShell 5.1, not PowerShell 7/pwsh) has a
long-standing bug where double quotes inside an argument passed to a native
command can get stripped or mis-escaped, no matter how you try to escape them
from within PowerShell itself. If `enqueue '{"id":"job1",...}'` comes back
with a JSON parse error on Windows, check what actually arrived:

```powershell
node -e "console.log(process.argv)" enqueue '{"id":"job1","command":"echo hello"}'
```

If the quotes are missing or the string is split apart, use PowerShell's
stop-parsing token so it hands the argument to `node` completely raw instead
of re-encoding it:

```powershell
node --% index.js enqueue "{\"id\":\"job1\",\"command\":\"echo hello\"}"
```

This is a PowerShell-specific workaround, not something the CLI needs. In
bash, WSL, or Git Bash, the plain single-quoted syntax shown throughout this
README works with no escaping at all.

## CLI reference

| Command | Description |
|---|---|
| `queuectl enqueue '<json>'` | Add a job. Requires `command`; `id` is auto-generated (UUID) if omitted; `max_retries` defaults to the current `max-retries` config. |
| `queuectl worker start [--count N]` | Start N worker processes in the foreground (default 1). Blocks until stopped. Each is a real, separate OS process, not a thread. |
| `queuectl worker stop` | Send graceful-shutdown `SIGTERM` to every live worker, from any terminal. |
| `queuectl status [--json]` | Job counts by state. |
| `queuectl list [--state <state>] [--json]` | List jobs, optionally filtered by state (`pending`\|`processing`\|`completed`\|`failed`\|`dead`). `--json` prints a JSON array to stdout and nothing else on stdout. |
| `queuectl dlq list [--json]` | List jobs currently in the DLQ (`state = dead`), with their last error and attempt count. |
| `queuectl dlq retry <id>` | Re-enqueue a dead job, resetting `attempts` to 0 (see `DECISIONS.md` Q3). |
| `queuectl config set <key> <value>` | Set a config value (persisted in the database). |
| `queuectl config get [--json]` | Show all config values (persisted values plus defaults for anything not yet set). |

### Job fields

```json
{
  "id": "unique-job-id",
  "command": "echo 'Hello World'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-11-04T10:30:00Z",
  "updated_at": "2025-11-04T10:30:00Z"
}
```

`list`/`dlq list --json` also include `next_run_at`, `worker_pid`,
`claimed_at`, `heartbeat_at`, `last_error`, and `last_exit_code` for
observability - a superset of the required fields.

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `max-retries` | `3` | Default `max_retries` for jobs enqueued without an explicit one. |
| `backoff-base` | `2` | Base of the exponential backoff: `delay = base ^ attempts` seconds. |

**Do config changes affect already-enqueued jobs?** `max-retries` is captured
onto each job at enqueue time (the `max_retries` column), so changing the
default afterwards only affects jobs enqueued *after* the change - not
existing ones. `backoff-base` is read fresh every time a failure needs to
compute its next delay, so a change to it applies immediately, to every job,
including ones already mid-flight.

## Retry & backoff

On failure, `attempts` is incremented first, then:

- if `attempts >= max_retries`: the job moves to the DLQ (`state = dead`).
- otherwise: the job goes to `failed`, eligible to run again after
  `backoff-base ^ attempts` seconds (tracked in `next_run_at`), and gets
  promoted back to `pending` automatically once that time passes.

Example with the defaults (`max_retries = 3`, `backoff-base = 2`): attempt 1
fails -> `attempts = 1`, retried after 2s. Attempt 2 fails -> `attempts = 2`,
retried after 4s. Attempt 3 fails -> `attempts = 3 == max_retries` -> DLQ, no
further retries. `max_retries` caps the *total number of attempts*, not
"retries in addition to the first try." This was verified empirically, not
just asserted - the ~2s and ~4s gaps were measured directly against real
timestamps.

## System Architecture

There is no server and no daemon. Every `queuectl` command - `enqueue`,
`list`, `worker start`, `worker stop`, whatever - is its own short-lived OS
process that opens the same SQLite file, does its work, and exits. The
database file is the *only* thing shared between them; there is no in-memory
state anywhere that another process could see. That single fact is what
makes "enqueue from one terminal, run workers in a second, stop them from a
third" all work correctly.

```
   Terminal 1                Terminal 2                Terminal 3
 +--------------+          +--------------+          +------------------+
 | queuectl      |          | queuectl      |          | queuectl worker   |
 | enqueue        |          | worker stop    |          | start --count 3   |
 | list / status  |          |                |          | (spawns 3 real    |
 | dlq / config   |          |                |          |  OS processes)    |
 +-------+--------+          +-------+--------+          +---------+---------+
         |                            |                              |
         |   every command is its own short-lived process,           |
         |   opens the db, does its work, exits                      |
         v                            v                              v
 +----------------------------------------------------------------------+
 |                   DB/queuectl.db   (SQLite, WAL mode)                 |
 |                       tables: jobs, config                             |
 |  one writer at a time; busy_timeout=5000 makes a blocked writer wait   |
 |  and retry instead of erroring immediately (src/db.js)                 |
 +----------------------------------------------------------------------+
                                     ^
                                     |  each worker writes its own pid file
                                     |  here on start, removes it on clean
                                     |  exit (src/workers.js)
                                     v
                       DB/workers/<pid>.json
                       (used by "worker stop" to discover which
                        worker processes are actually still alive)
```

Job lifecycle - the state machine every row in the `jobs` table moves
through:

```
                enqueue
                   |
                   v
   +----------------------+   atomic claim      +--------------+
   |       pending         |--------------------> |  processing  |
   +----------------------+  (src/claim.js)       +------+-------+
       ^              ^                                  |
       |              |                            exit 0 |  exit != 0
       |              |                                   v         v
       |              |  heartbeat goes stale       +-----------+  attempts++
       |              |  (worker crashed) ->        | completed |     |
       |              |  reaper puts it back        +-----------+     |
       |              |  (src/reaper.js), attempts                    v
       |              |  UNCHANGED                     attempts >= max_retries?
       |              |                                  /                \
       |              +---------------------------------+                  |
       |               no (has retries left)            |                 yes
       |                                                 v                  |
       |                                          +--------------+          |
       |    backoff delay (base^attempts sec)      |    failed    |          |
       +------------------------------------------- +--------------+          |
         promoteReadyRetries() once next_run_at                              v
         has passed (src/claim.js)                                    +--------+
                                                                        |  dead  |
                              dlq retry (attempts reset to 0) <---------+--------+
```

Two exits from `processing` are worth calling out because they're easy to
conflate: a *crash* (heartbeat goes stale) returns straight to `pending`
with `attempts` untouched, because the crash wasn't the job's fault. A
*command failure* (non-zero exit) increments `attempts` and goes to
`failed` first, waiting out a real backoff delay before becoming claimable
again.

## Module layout

```
index.js          CLI entrypoint: argv parsing, command dispatch.
src/args.js       Minimal --flag/positional argv parser.
src/db.js         Single SQLite connection per process (node:sqlite),
                  WAL + busy_timeout pragmas, runs schema.sql on startup.
DB/schema.sql     Table definitions (jobs, config).
src/config.js     Get/set config, backed by the config table, with defaults.
src/commands.js   enqueue / list / status / dlq list / dlq retry /
                  config set / config get - the non-worker command surface.
src/claim.js      Atomic claim, heartbeat, complete, and fail (retry-or-DLQ
                  with backoff). This is what DECISIONS.md Q1 and Q3 point to.
src/reaper.js     Crash recovery: reclaims "processing" jobs whose heartbeat
                  has gone stale back to "pending". DECISIONS.md Q2.
src/workers.js    PID-file registry for cross-process worker discovery and
                  the SIGTERM used by `worker stop`. DECISIONS.md Q4.
src/worker.js     The foreground worker loop: reap stale jobs -> promote
                  ready retries -> claim -> run -> complete/fail, with
                  heartbeats during execution and graceful shutdown on
                  SIGTERM/SIGINT. Also spawns N real child processes for
                  `--count N > 1`.
```

All shared state lives in one SQLite file; there is no in-memory state shared
between processes anywhere. That's what makes "start workers in separate
terminals" and "stop from a different terminal" both work - every CLI
invocation is a fresh process talking to the same file, and coordination
happens entirely through it.

### Persistence & locking

SQLite in WAL mode, one connection per process, `PRAGMA busy_timeout = 5000`.
Every state transition (claim, heartbeat, complete, fail, reap, promote,
DLQ retry) is a single `UPDATE` with the row selection built into the same
statement - no read-then-write race window. See `DECISIONS.md` Q1 for why
this holds across OS processes, not just within one.

A worker treats a busy/locked database as a transient condition to retry on
the next loop iteration, not a fatal error - see the try/catch around each
database call in `src/worker.js`'s main loop.

### Crash recovery

Workers can't run cleanup code after `SIGKILL`, so recovery is heartbeat-based
rather than signal-based: every worker refreshes a heartbeat on its current
job periodically, and every worker (not one dedicated process) sweeps for
jobs whose heartbeat has gone stale at the start of every loop iteration.
Worst-case recovery time is `STALE_AFTER_SECONDS` (15s) + the poll interval
(2s) = 17s, under the 60s requirement - measured directly with a real
`SIGKILL`, not simulated. Full walkthrough in `DECISIONS.md` Q2.

## Testing

All five required scenarios are covered by an automated suite in `test/`,
committed to this repo. Each scenario drives the real CLI as actual child
processes - `enqueue`, `worker start`, `SIGKILL`, restarts, all of it - the
same way a grader's script would, not by calling internal functions directly.

Run it with:

```
npm test
```

`test/run.js` runs the five scenarios below in sequence (not in parallel -
they share the one project database, so `test/helpers.js` resets `DB/` between
scenarios):

1. `test/scenario1-basic-completion.js` - a job with a command that exits 0
   reaches `completed`.
2. `test/scenario2-retry-backoff-dlq.js` - a job with `"command":"exit 1"`
   retries with delays following `backoff-base ^ attempts`, then lands in
   `dead` once `max_retries` is exhausted.
3. `test/scenario3-exactly-once.js` - a batch of jobs, each writing a unique
   marker to a shared file, run under `worker start --count N`; every marker
   appears exactly once, proving no job is claimed twice.
4. `test/scenario4-sigkill-recovery.js` - a worker is actually `SIGKILL`ed
   mid-job (not Ctrl+C); confirms the job is reclaimed and completed by a
   fresh worker well inside the 60s requirement (observed ~17-20s).
5. `test/scenario5-restart-persistence.js` - jobs enqueued with no worker
   running are still present in `list` after the process exits and a new one
   starts, proving persistence isn't relying on any in-memory state.

The suite has passed 5/5 consistently across multiple independent runs.

## Known limitations / not implemented

Job timeouts, priority queues, scheduled (`run_at`) jobs, structured job
output logging, metrics, and a web dashboard are out of scope for this
submission (all listed as optional bonus items in the assignment).
`DECISIONS.md` Q5 covers what would and wouldn't need to change to add
priorities specifically.

`STALE_AFTER_SECONDS`, the heartbeat interval, and the worker poll interval
(`src/reaper.js`, `src/worker.js`) are currently fixed constants rather than
configurable via `config set` - only `max-retries` and `backoff-base` are,
matching what the assignment explicitly asks for.
