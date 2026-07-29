'use strict';

// shared helpers for the scenario tests: run the real CLI as a child
// process (same as a grader's script would), wipe state between
// scenarios, and poll for a job to reach some state.

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const DB_DIR = path.join(ROOT, 'DB');

// there's no env var to point queuectl at a different db directory (it
// always uses <project root>/DB), so instead of isolating each scenario
// in its own temp folder, each scenario starts by wiping the one shared
// db clean. that means scenarios must run one at a time, not in
// parallel - test/run.js does exactly that.
function resetDb() {
  for (const name of ['queuectl.db', 'queuectl.db-wal', 'queuectl.db-shm']) {
    try {
      fs.unlinkSync(path.join(DB_DIR, name));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // on some setups (e.g. a onedrive-synced folder mid-sync) a
        // delete can transiently fail. not fatal for the same reason
        // it isn't fatal in src/workers.js: warn and move on.
        console.error(`  (warning: could not remove ${name}: ${err.message})`);
      }
    }
  }
  try {
    for (const file of fs.readdirSync(path.join(DB_DIR, 'workers'))) {
      try {
        fs.unlinkSync(path.join(DB_DIR, 'workers', file));
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* workers dir may not exist yet, fine */
  }
}

function cli(args) {
  return execFileSync(process.execPath, [INDEX, ...args], { encoding: 'utf8' });
}

function cliJson(args) {
  return JSON.parse(cli(args));
}

// starts `queuectl worker start --count N` as a background child so tests
// can signal it (including SIGKILL) independently of the test process
function spawnWorkers(count = 1) {
  return spawn(process.execPath, [INDEX, 'worker', 'start', '--count', String(count)], {
    stdio: 'ignore',
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 250, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function killSafe(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

module.exports = { INDEX, resetDb, cli, cliJson, spawnWorkers, sleep, waitFor, killSafe };
