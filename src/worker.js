'use strict';

// this is the actual worker loop: reap stale jobs, look for a job, run it,
// repeat.

const { spawn } = require('node:child_process');
const { claimNextJob, completeJob, failJob, heartbeat } = require('./claim');
const { reapStaleJobs } = require('./reaper');
const { registerWorker, deregisterWorker } = require('./workers');

const POLL_MS = 2000; // how often to check for a new job when there's nothing to do
const HEARTBEAT_MS = 3000; // how often to touch a running job's heartbeat

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// runs the job's command in the shell, keeping its heartbeat fresh the
// whole time it's running, and waits for it to finish
function runCommand(job) {
  return new Promise((resolve) => {
    const child = spawn(job.command, { shell: true, stdio: 'inherit' });

    // this is what lets the reaper tell "still running" apart from
    // "worker died, nobody is touching this job anymore"
    const hb = setInterval(() => heartbeat(job.id), HEARTBEAT_MS);

    child.on('error', (err) => {
      // this happens if the command doesn't even exist
      clearInterval(hb);
      resolve({ code: 127, error: err.message });
    });

    child.on('exit', (code, signal) => {
      clearInterval(hb);
      if (signal) {
        resolve({ code: 1, error: `killed by signal ${signal}` });
      } else {
        resolve({ code, error: code === 0 ? null : `exited with code ${code}` });
      }
    });
  });
}

// one worker: claim a job, run it, update its state, repeat until told to stop
async function runWorker() {
  const pid = process.pid;
  registerWorker(pid);
  console.error(`[worker ${pid}] started`);

  let stopping = false;
  const onSignal = (sig) => {
    console.error(`[worker ${pid}] got ${sig}, finishing current job then stopping`);
    stopping = true;
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  try {
    while (!stopping) {
      // before looking for new work, recover anything another (now-gone)
      // worker left stuck in processing. every worker does this, not just
      // one dedicated process, so recovery doesn't depend on any single
      // process staying alive.
      try {
        const reaped = reapStaleJobs();
        if (reaped > 0) console.error(`[worker ${pid}] recovered ${reaped} stuck job(s)`);
      } catch (err) {
        console.error(`[worker ${pid}] db busy during reap, will retry: ${err.message}`);
      }

      // claiming a job talks to a shared db file that other worker
      // processes are hitting at the same time. a busy/locked error here
      // is expected sometimes under contention - it should never crash
      // the worker, just try again next loop.
      let job;
      try {
        job = claimNextJob(pid);
      } catch (err) {
        console.error(`[worker ${pid}] db busy, will retry: ${err.message}`);
        await sleep(300);
        continue;
      }

      if (!job) {
        // nothing to do, wait a bit, but check for shutdown often so
        // stopping doesn't take the full POLL_MS to notice
        for (let waited = 0; waited < POLL_MS && !stopping; waited += 200) {
          await sleep(200);
        }
        continue;
      }

      console.error(`[worker ${pid}] running job ${job.id}: ${job.command}`);
      const { code, error } = await runCommand(job);

      try {
        if (code === 0) {
          completeJob(job.id, code);
          console.error(`[worker ${pid}] job ${job.id} completed`);
        } else {
          failJob(job.id, code, error);
          console.error(`[worker ${pid}] job ${job.id} failed: ${error}`);
        }
      } catch (err) {
        // job already ran, but saving the result hit a busy db. it stays
        // "processing" and gets picked up again later (this is the same
        // situation a crash leaves behind) instead of crashing the worker.
        console.error(`[worker ${pid}] could not save result for job ${job.id}: ${err.message}`);
      }
    }
  } finally {
    deregisterWorker(pid);
    console.error(`[worker ${pid}] stopped`);
  }
}

// starts N workers. if count is 1, this process itself becomes the worker.
// if count is more than 1, this process spawns real child processes (each
// one its own worker) and just waits for them, forwarding signals.
async function startWorkers(count) {
  if (count <= 1) {
    await runWorker();
    return;
  }

  const entry = process.argv[1];
  const children = [];
  for (let i = 0; i < count; i++) {
    const child = spawn(process.execPath, [entry, 'worker', 'start', '--count', '1'], {
      stdio: 'inherit',
    });
    children.push(child);
  }

  const forward = (signal) => {
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve))));
}

module.exports = { runWorker, startWorkers };
