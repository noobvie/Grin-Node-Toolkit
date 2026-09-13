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
const os = require('os');

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

// ── Inline <script> blocks in the admin panel's HTML pages ──────────────────────
// Most of the admin panel's JavaScript does not live in a .js file: payments.html,
// regions.html, ads.html and the rest carry ~2,750 lines of logic inside a single inline
// <script> each — the payout queue, the freeze kill-switch, the region CRUD, the money
// tables. The loop above cannot see any of it, so the pool's only pre-commit gate was blind
// to roughly half the panel, including every screen that moves money. Extract each block to
// a temp file and run the same `node --check` over it. Audit §J14.
//
// The regex deliberately skips <script src=…> (nothing inline to check) and does not try to
// parse HTML: an admin page carries exactly one inline block, at the end of <body>.
//
// `../public_html` added 2026-09-02 (audit §J11): the PUBLIC pages have the same shape — the
// leaderboards, the blocks explorer, the payouts table, the donor wall and the whole account
// page are inline <script>, not .js files — so the gate was blind to the money UI miners
// actually use as well as to half the panel. Unlike the admin pages these carry a second
// inline block, `<script type="application/ld+json">`, which is JSON and not JavaScript; the
// type filter below skips it, or every public page would "fail" on its schema.org markup.
const INLINE_HTML_DIRS = ['admin-panel', '../public_html'];
let inlineBlocks = 0;
for (const dir of INLINE_HTML_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs).filter((n) => n.endsWith('.html'))) {
    const rel = `${dir}/${name}`;
    const html = fs.readFileSync(path.join(abs, name), 'utf8');
    let n = 0;
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const code = m[1];
      if (!code.trim()) continue;
      // Skip non-JavaScript payloads (JSON-LD, templates). A bare <script> or an explicit
      // JS type is checked; anything else is data.
      const typeAttr = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(m[0]);
      const type = typeAttr ? typeAttr[1].toLowerCase() : '';
      if (type && !/^(text\/javascript|application\/javascript|module)$/.test(type)) continue;
      n++;
      inlineBlocks++;
      // Line-align the temp file with the source, so node's error line number is the real one.
      const before = html.slice(0, m.index + m[0].indexOf(code));
      const pad = '\n'.repeat(before.split('\n').length - 1);
      const tmp = path.join(os.tmpdir(), `grinpool-inline-${name}-${n}.js`);
      fs.writeFileSync(tmp, pad + code);
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      fs.unlinkSync(tmp);
      if (r.status !== 0) {
        failed++;
        console.error(`FAIL  ${rel}  (inline <script> #${n})`);
        console.error((r.stderr || '').split(tmp).join(rel).trimEnd());
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed across ${files.length} file(s) + ${inlineBlocks} inline block(s).`);
  process.exit(1);
}
console.log(`Syntax OK — ${files.length} files + ${inlineBlocks} inline <script> blocks checked.`);
