'use strict';

const assert = require('node:assert');
const { resetDb, cli, cliJson, spawnWorkers, waitFor, killSafe } = require('./helpers');

// Scenario 5: jobs survive a full restart - enqueued with no worker
// process ever having run, then picked up by one started later, as if the
// machine had rebooted in between.
module.exports = async function scenario5() {
  resetDb();
  cli(['enqueue', JSON.stringify({ id: 'persist-1', command: 'echo one' })]);
  cli(['enqueue', JSON.stringify({ id: 'persist-2', command: 'echo two' })]);

  const beforeRestart = cliJson(['list', '--json']);
  assert.strictEqual(beforeRestart.length, 2);
  assert.ok(beforeRestart.every((j) => j.state === 'pending'), 'jobs should still be pending, untouched, before any worker runs');

  const worker = spawnWorkers(1);
  try {
    await waitFor(() => cliJson(['list', '--state', 'completed', '--json']).length === 2, {
      label: 'both persisted jobs to complete after the "restart"',
    });
  } finally {
    killSafe(worker.pid, 'SIGKILL');
  }
};
