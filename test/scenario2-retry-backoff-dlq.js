'use strict';

const assert = require('node:assert');
const { resetDb, cli, cliJson, spawnWorkers, waitFor, killSafe } = require('./helpers');

// Scenario 2: a failing job retries with backoff and lands in the DLQ.
module.exports = async function scenario2() {
  resetDb();
  cli(['config', 'set', 'backoff-base', '2']);
  cli(['enqueue', JSON.stringify({ id: 'flaky-1', command: 'exit 1', max_retries: 2 })]);

  const t0 = Date.now();
  const worker = spawnWorkers(1);
  try {
    await waitFor(() => cliJson(['dlq', 'list', '--json']).length === 1, {
      timeoutMs: 15000,
      label: 'flaky-1 to land in the DLQ',
    });
    const elapsedMs = Date.now() - t0;

    const dlq = cliJson(['dlq', 'list', '--json']);
    assert.strictEqual(dlq[0].id, 'flaky-1');
    assert.strictEqual(dlq[0].state, 'dead');
    assert.strictEqual(dlq[0].attempts, 2);

    // attempt 1 fails immediately, then a ~2s backoff before attempt 2 -
    // loose lower bound to avoid flakiness, but tight enough to prove this
    // isn't retrying instantly.
    assert.ok(elapsedMs > 1500, `expected a backoff delay, only took ${elapsedMs}ms`);

    assert.strictEqual(cliJson(['list', '--state', 'pending', '--json']).length, 0);
  } finally {
    killSafe(worker.pid, 'SIGKILL');
  }
};
