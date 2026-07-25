'use strict';

// keeps track of which worker processes are currently running, using
// small json files on disk. this is how "worker stop" (run from a
// different terminal) can find workers that were started somewhere else.

const fs = require('node:fs');
const path = require('node:path');

const WORKERS_DIR = path.join(__dirname, '..', 'DB', 'workers');

function pidFile(pid) {
  return path.join(WORKERS_DIR, `${pid}.json`);
}

function registerWorker(pid) {
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  fs.writeFileSync(pidFile(pid), JSON.stringify({ pid, started_at: new Date().toISOString() }));
}

function deregisterWorker(pid) {
  try {
    fs.unlinkSync(pidFile(pid));
  } catch (err) {
    if (err.code === 'ENOENT') return; // already gone, fine

    // a onedrive-synced folder can briefly lock a file while it's syncing,
    // which can make a delete fail with a permission error. not fatal:
    // listLiveWorkers() will clean this up next time it runs anyway, since
    // it checks whether the pid is actually still alive.
    console.error(`warning: could not remove pid file for worker ${pid}: ${err.message}`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 just checks if the process exists
    return true;
  } catch {
    return false;
  }
}

// lists workers that are actually still alive, and quietly removes pid
// files left behind by workers that crashed without cleaning up
function listLiveWorkers() {
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  const live = [];
  for (const file of fs.readdirSync(WORKERS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const pid = Number(file.replace('.json', ''));
    if (isAlive(pid)) {
      live.push(pid);
    } else {
      deregisterWorker(pid);
    }
  }
  return live;
}

function stopAllWorkers() {
  const pids = listLiveWorkers();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone, ignore
    }
  }
  return pids;
}

module.exports = { registerWorker, deregisterWorker, listLiveWorkers, stopAllWorkers };
