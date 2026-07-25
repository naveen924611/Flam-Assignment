'use strict';

const { randomUUID } = require('node:crypto');
const { getDb } = require('./db');

// default retry count until config command is done
const DEFAULT_MAX_RETRIES = 3;

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
  const maxRetries = input.max_retries || DEFAULT_MAX_RETRIES;

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

// worker stuff is not built yet, just placeholders for now
function workerStart(positional, flags) {
  const count = flags.count ? Number(flags.count) : 1;
  console.log(`would start ${count} worker(s)`);
}

function workerStop() {
  console.log('would stop all running workers');
}

function status() {
  console.log('would show job counts by state');
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

function dlqList() {
  console.log('would list dead jobs');
}

function dlqRetry(positional) {
  const id = positional[0];
  if (!id) {
    console.error('usage: queuectl dlq retry <id>');
    process.exitCode = 1;
    return;
  }
  console.log(`would retry dead job "${id}"`);
}

function configSet(positional) {
  const [key, value] = positional;
  if (!key || value === undefined) {
    console.error('usage: queuectl config set <key> <value>');
    process.exitCode = 1;
    return;
  }
  console.log(`would set config ${key} = ${value}`);
}

function configGet() {
  console.log('would show all config values');
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