'use strict';

// Syntax-check every JS file the games platform ships: the service (index.js, lib/**,
// scripts/), and — once they exist — the game folders (../games/**: rules.js runs on the
// server, frame/*.js in the browser) and the shell (../shell/**). `node --check` parses
// browser JS just as well.
//
// Walks the directories itself (no shell globbing) and exits non-zero on any failure —
// see the pool's scripts/check-syntax.js header for what an inline glob + `|| true` cost
// that codebase.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const PLAY = path.join(SERVER, '..');

// [dir, recurse]
const TARGETS = [
  [path.join(SERVER, 'lib'), true],
  [path.join(SERVER, 'scripts'), false],
  [path.join(PLAY, 'games'), true],
  [path.join(PLAY, 'shell'), true],
];

const files = [path.join(SERVER, 'index.js')];
for (const [dir, recurse] of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (recurse && entry.name !== 'node_modules') walk(full); continue; }
      if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL  ${path.relative(PLAY, file).replace(/\\/g, '/')}`);
    console.error((r.stderr || '').trimEnd());
  }
}

if (failed) {
  console.error(`\n${failed} of ${files.length} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax OK — ${files.length} files checked.`);
