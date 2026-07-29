'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resetDb, cli, cliJson, spawnWorkers, waitFor, killSafe } = require('./helpers');

// Scenario 3: many jobs across multiple worker processes; every job runs
// exactly once. Each job appends its own id to a shared file - if the
// atomic claim in src/claim.js ever let two workers grab the same job,
// that id would show up twice.
module.exports = async function scenario3() {
  resetDb();
  const outFile = path.join(os.tmpdir(), `queuectl-test-scenario3-${Date.now()}.log`);
  fs.writeFileSync(outFile, '');
  const jobCount = 25;

  for (let i = 0; i < jobCount; i++) {
    const id = `job-${i}`;
    cli(['enqueue', JSON.stringify({ id, command: `echo ${id} >> "${outFile}"` })]);
  }

  const worker = spawnWorkers(5); // 5 separate OS processes
  try {
    await waitFor(() => cliJson(['list', '--state', 'completed', '--json']).length === jobCount, {
      timeoutMs: 30000,
      label: `all ${jobCount} jobs to complete`,
    });

    const lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, jobCount, `expected exactly ${jobCount} executions total`);
    assert.strictEqual(new Set(lines).size, jobCount, 'every job id must be unique - no duplicate execution');
    assert.strictEqual(cliJson(['list', '--state', 'dead', '--json']).length, 0);
  } finally {
    killSafe(worker.pid, 'SIGKILL');
    fs.unlinkSync(outFile);
  }
};
