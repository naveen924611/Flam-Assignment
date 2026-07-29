'use strict';

const { randomUUID } = require('node:crypto');
const { getDb } = require('./db');
const { startWorkers } = require('./worker');
const { stopAllWorkers } = require('./workers');
const { getConfig, getAllConfig, setConfig } = require('./config');

const VALID_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

// adds a new job to the jobs table
function enqueue(positional) {
  const raw = positional[0];
  if (!raw) {
    console.error(`usage: queuectl enqueue '{"command": "..."}'`);
    process.exitCode = 1;
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    console.error(`invalid json: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!input.command) {
    console.error('job needs a "command" field');
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const id = input.id || randomUUID();
  const now = new Date().toISOString();
  // max_retries is fixed on the job at enqueue time, using whatever the
  // config default is right now. changing the config later does not
  // change jobs that are already enqueued, only new ones.
  const maxRetries = input.max_retries || Number(getConfig('max-retries'));

  try {
    db.prepare(
      `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at, next_run_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)`
    ).run(id, input.command, maxRetries, now, now, now);
  } catch (err) {
    // this happens if the same id is used twice
    console.error(`could not add job: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`job added: ${id}`);
}

// starts count workers in the foreground, blocks here until they stop
async function workerStart(positional, flags) {
  const count = flags.count ? Number(flags.count) : 1;
  await startWorkers(count);
}

// signals every running worker (even ones started in another terminal)
// to finish their current job and stop
function workerStop() {
  const pids = stopAllWorkers();
  if (pids.length === 0) {
    console.log('no workers running');
  } else {
    console.log(`stopped ${pids.length} worker(s): ${pids.join(', ')}`);
  }
}

// counts of jobs in each state
function status(positional, flags) {
  const db = getDb();
  const rows = db.prepare('SELECT state, COUNT(*) as n FROM jobs GROUP BY state').all();

  const counts = {};
  for (const s of VALID_STATES) counts[s] = 0;
  for (const row of rows) counts[row.state] = row.n;

  if (flags.json) {
    console.log(JSON.stringify(counts, null, 2));
    return;
  }

  console.log('job counts:');
  for (const s of VALID_STATES) {
    console.log(`  ${s}: ${counts[s]}`);
  }
}

// shows jobs from the db, can filter by state
function list(positional, flags) {
  const db = getDb();

  let rows;
  if (flags.state) {
      rows = db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at').all(flags.state);
    } else {
        rows = db.prepare('SELECT * FROM jobs ORDER BY created_at').all();
    }

    if (flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }

    if (rows.length === 0) {
        console.log('no jobs found');
        return;
    }
    console.log("Id\tState\tCommand");

  for (const job of rows) {
    console.log(`${job.id}\t${job.state}\t${job.command}`);
  }
}

// jobs that permanently failed (state = dead)
function dlqList(positional, flags) {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC`).all();

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('dlq is empty');
    return;
  }

  console.log('Id\tAttempts\tLastError\tCommand');
  for (const job of rows) {
    console.log(`${job.id}\t${job.attempts}/${job.max_retries}\t${job.last_error}\t${job.command}`);
  }
}

// re-enqueues a dead job. resets attempts back to 0, since this is a
// manual, deliberate retry, not another automatic one - it should get a
// full fresh set of attempts, not immediately die again on the next failure.
function dlqRetry(positional) {
  const id = positional[0];
  if (!id) {
    console.error('usage: queuectl dlq retry <id>');
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) {
    console.error(`no job with id "${id}"`);
    process.exitCode = 1;
    return;
  }
  if (job.state !== 'dead') {
    console.error(`job "${id}" is not in the dlq (state is "${job.state}")`);
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs
     SET state = 'pending', attempts = 0, next_run_at = ?, updated_at = ?,
         last_error = NULL, last_exit_code = NULL,
         worker_pid = NULL, claimed_at = NULL, heartbeat_at = NULL
     WHERE id = ?`
  ).run(now, now, id);

  console.log(`job ${id} re-enqueued (attempts reset to 0)`);
}

function configSet(positional) {
  const [key, value] = positional;
  if (!key || value === undefined) {
    console.error('usage: queuectl config set <key> <value>');
    process.exitCode = 1;
    return;
  }
  try {
    setConfig(key, value);
    console.log(`${key} = ${value}`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function configGet(positional, flags) {
  const all = getAllConfig();
  if (flags.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  for (const [k, v] of Object.entries(all)) {
    console.log(`${k} = ${v}`);
  }
}

module.exports = {
  enqueue,
  'worker start': workerStart,
  'worker stop': workerStop,
  status,
  list,
  'dlq list': dlqList,
  'dlq retry': dlqRetry,
  'config set': configSet,
  'config get': configGet,
};
