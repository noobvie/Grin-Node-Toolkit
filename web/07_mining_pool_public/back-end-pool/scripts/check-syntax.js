#!/usr/bin/env node
'use strict';

// Syntax-check every JS file the pool ships.
//
// Replaces the old inline npm script, which looked thorough but checked exactly ONE file
// and could never fail:
//     node -c index.js && node -c lib/*.js && node -c routes/*.js 2>/dev/null || true
//   1. `node --check` takes a SINGLE file — the shell expanded `lib/*.js` to 43 paths and
//      node silently checked only the first (lib/ads.js), ignoring the other 42.
//   2. The trailing `|| true` swallowed every failure, so `npm test` exited 0 even on a
//      hard syntax error.
//   3. `routes/` does not exist in this codebase.
// Net effect: the pool's only pre-commit gate was reporting success unconditionally.
//
// Walks each directory itself (no shell globbing), so it behaves identically under sh,
// PowerShell and cmd, and exits non-zero on the first real failure.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// [dir, recurse] — admin-panel ships browser JS that Node can still parse for syntax.
const TARGETS = [
  ['lib', false],
  ['scripts', false],
  ['admin-panel', false],
];

const files = [path.join(ROOT, 'index.js')];

for (const [dir, recurse] of TARGETS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { if (recurse) walk(full); continue; }
      if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(abs);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL  ${rel}`);
    console.error((r.stderr || '').trimEnd());
  }
}

if (failed) {
  console.error(`\n${failed} of ${files.length} file(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`Syntax OK — ${files.length} files checked.`);
