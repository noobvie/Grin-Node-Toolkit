'use strict';

// Runs every scripts/test-*.js in its own process and totals the results. A suite ends
// by printing one line `RESULT pass=<n> fail=<n>`; a suite that exits non-zero, or never
// prints that line (it crashed or hung up early), counts as failed whatever it printed.
//
// Nothing here starts a long-running process: each suite must leave nothing running and
// exit on its own (CLAUDE.md "Local Test Processes"). The timeout is the backstop.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const TIMEOUT_MS = 120 * 1000;

const suites = fs.readdirSync(DIR).filter((n) => /^test-[a-z0-9-]+\.js$/.test(n)).sort();
let pass = 0;
let fail = 0;
const broken = [];

for (const name of suites) {
  console.log(`\n══ ${name} ══`);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(DIR, name)], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  const m = /^RESULT pass=(\d+) fail=(\d+)$/m.exec(r.stdout || '');
  if (m) { pass += Number(m[1]); fail += Number(m[2]); }
  if (r.status !== 0 || !m) broken.push(`${name} (exit ${r.status === null ? r.signal : r.status}${m ? '' : ', no RESULT line'})`);
}

console.log(`\n${suites.length} suite(s): ${pass} passed, ${fail} failed.`);
if (broken.length) {
  console.error(`Failed suites: ${broken.join(', ')}`);
  process.exit(1);
}
