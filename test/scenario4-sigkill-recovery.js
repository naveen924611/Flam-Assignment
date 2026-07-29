'use strict';

const assert = require('node:assert');
const { resetDb, cli, cliJson, spawnWorkers, waitFor, killSafe, sleep } = require('./helpers');

// Scenario 4: a worker is SIGKILLed mid-job. After a fresh worker starts,
// the job is recovered and completes, with nothing left stuck in
// "processing".
module.exports = async function scenario4() {
  resetDb();
  cli(['enqueue', JSON.stringify({ id: 'crash-1', command: 'sleep 3 && echo recovered' })]);

  const worker1 = spawnWorkers(1); // count=1 means this process IS the worker
  await waitFor(() => cliJson(['list', '--state', 'processing', '--json']).length === 1, {
    label: 'crash-1 to be claimed and start running',
  });

  // simulate a real crash - no cleanup handler runs
  killSafe(worker1.pid, 'SIGKILL');
  await sleep(300); // let the OS actually finish tearing down the process

  const midway = cliJson(['list', '--state', 'processing', '--json']);
  assert.strictEqual(midway.length, 1, 'job should still show processing right after the crash');
  assert.strictEqual(midway[0].attempts, 0, 'a crash must not consume a retry attempt');

  const recoverStart = Date.now();
  const worker2 = spawnWorkers(1);
  try {
    await waitFor(() => cliJson(['list', '--state', 'completed', '--json']).length === 1, {
      timeoutMs: 30000,
      label: 'crash-1 to complete after recovery',
    });
    const recoveryMs = Date.now() - recoverStart;

    assert.strictEqual(cliJson(['list', '--state', 'processing', '--json']).length, 0, 'nothing should be left stuck');
    assert.ok(recoveryMs < 60000, `recovery took ${recoveryMs}ms, must be under 60000ms`);
    console.log(`    (recovered and completed in ${recoveryMs}ms)`);
  } finally {
    killSafe(worker2.pid, 'SIGKILL');
  }
};
