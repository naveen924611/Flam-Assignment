#!/usr/bin/env node
'use strict';

// hide the node:sqlite experimental warning, it's just noise on every run
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && w.message.includes('SQLite')) return;
  console.warn(w);
});

const { parseArgs } = require('./src/args');
const commands = require('./src/commands');

const USAGE = [
  'queuectl <command> [options]',
  '',
  'commands:',
  '  enqueue \'{"command": "..."}\'',
  '  worker start [--count N]',
  '  worker stop',
  '  status [--json]',
  '  list [--state <state>] [--json]',
  '  dlq list [--json]',
  '  dlq retry <id>',
  '  config set <key> <value>',
  '  config get',
].join('\n');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log(USAGE);
    return;
  }

  // some commands have a subcommand, like "worker start"
  let key, rest;
  if (['worker', 'dlq', 'config'].includes(command)) {
    const sub = args[1];
    key = sub ? `${command} ${sub}` : command;
    rest = args.slice(2);
  } else {
    key = command;
    rest = args.slice(1);
  }

  const fn = commands[key];
  if (!fn) {
    console.error(`queuectl: unknown command "${key}"`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const { positional, flags } = parseArgs(rest);
  // worker start returns a promise (it blocks until stopped), everything
  // else finishes right away - awaiting works for both cases.
  await fn(positional, flags);
}

main().catch((err) => {
  console.error(`queuectl: unexpected error: ${err.stack || err.message}`);
  process.exitCode = 1;
});