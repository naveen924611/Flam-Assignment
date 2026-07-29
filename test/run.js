'use strict';

// runs all 5 scenarios required by the assignment, in order, against the
// real CLI (as real child processes - the same way a grader's script
// would drive it). scenarios run one at a time, not in parallel, since
// they all share the one project-level database.

const scenarios = [
  ['1. basic job completes', require('./scenario1-basic-completion')],
  ['2. failing job retries with backoff, lands in DLQ', require('./scenario2-retry-backoff-dlq')],
  ['3. many jobs / multiple workers, exactly-once execution', require('./scenario3-exactly-once')],
  ['4. SIGKILLed worker recovers after restart', require('./scenario4-sigkill-recovery')],
  ['5. jobs survive a full restart', require('./scenario5-restart-persistence')],
];

async function main() {
  let failures = 0;
  for (const [name, fn] of scenarios) {
    process.stdout.write(`-> ${name}\n`);
    const start = Date.now();
    try {
      await fn();
      console.log(`   PASS (${Date.now() - start}ms)`);
    } catch (err) {
      failures++;
      console.log(`   FAIL (${Date.now() - start}ms): ${err.message}`);
      console.log(
        (err.stack || '')
          .split('\n')
          .slice(1)
          .map((l) => '   ' + l)
          .join('\n')
      );
    }
  }
  console.log('');
  if (failures > 0) {
    console.log(`${failures}/${scenarios.length} scenario(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`all ${scenarios.length} scenarios passed`);
  }
}

main();
