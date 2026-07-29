'use strict';

const assert = require('node:assert');
const { resetDb, cli, cliJson, spawnWorkers, waitFor, killSafe } = require('./helpers');

// Scenario 1: a basic job completes.
module.exports = async function scenario1() {
  resetDb();
  cli(['enqueue', JSON.stringify({ id: 'basic-1', command: 'echo basic job ran' })]);

  const worker = spawnWorkers(1);
  try {
    await waitFor(() => cliJson(['list', '--state', 'completed', '--json']).length === 1, {
      label: 'basic-1 to complete',
    });
    const completed = cliJson(['list', '--state', 'completed', '--json']);
    assert.strictEqual(completed[0].id, 'basic-1');
    assert.strictEqual(completed[0].last_exit_code, 0);
  } finally {
    killSafe(worker.pid, 'SIGKILL');
  }
};
