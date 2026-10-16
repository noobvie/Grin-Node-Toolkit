#!/usr/bin/env node
'use strict';
/*
 * check_comments.js — code -> doc drift for COMMENTS. Twin of check_doc_drift.sh (doc -> code).
 *
 *   node docs/tools/check_comments.js scan [--summary] [--show-allowed] [PATH ...]
 *   node docs/tools/check_comments.js diffgate [REV] [PATH ...]
 *   node docs/tools/check_comments.js --map section_map.tsv [--write] [--force] [PATH ...]
 *
 * scan      TSV `file<TAB>line<TAB>class<TAB>text` for every comment that breaks a rule.
 *           Classes: PLAN_TAG DIARY_DATE DEAD_PATH DEAD_SECTION STALE_TERM COMMENTED_CODE
 *                    TODO PATCH_MARKER.
 * diffgate  exit 1 if any line changed since REV (default HEAD, working tree included) is not a
 *           comment or blank line — on EITHER side of the diff. Heredoc bodies are code (they are
 *           file CONTENT written onto the VPS). A line whose only change is its trailing comment
 *           passes when the code part is byte-identical.
 * --map     rewrite `§N` / doc-filename pointers in comments from a section map. Dry run unless
 *           --write; a written file is recorded in `<map>.applied` and skipped next time so a
 *           chained map (12 -> 5, 5 -> 9) can never be applied twice. --force overrides.
 *           Map rows (TSV): old-doc  old-§  [→]  new-doc  new-§ ; old-§ `*` renames the file only.
 *
 * Allowlist: docs/tools/comment_allowlist.txt, `file-glob:regex  CLASS|*  reason` (reason mandatory).
 * Stale terms: docs/tools/comment_stale_terms.txt, `js-regex => reason` (each a CANDIDATE).
 * Excluded: vendor/, node_modules, *.min.*, 0z0_media; patches/ only gets the marker check.
 * Exit: 0 clean, 1 findings, 2 tool error. Zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..', '..');
const ALLOWLIST = path.join(TOOLS, 'comment_allowlist.txt');
const STALE = path.join(TOOLS, 'comment_stale_terms.txt');
const SELF = /^docs\/tools\/check_comments\.js$/;

// ---------------------------------------------------------------- file discovery
function git(args, opts) {
  return cp.execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 29 }, opts || {}));
}
const EXT = { sh: 'sh', js: 'js', mjs: 'js', cjs: 'js', css: 'css', html: 'html', htm: 'html', php: 'php', py: 'py' };
function langOf(f) { return EXT[(f.split('.').pop() || '').toLowerCase()] || null; }
function excluded(f) {
  return /(^|\/)(vendor|node_modules|0z0_media)\//.test(f) || /\.min\./.test(f) || SELF.test(f) ||
    /package-lock\.json$/.test(f);
}
function isPatch(f) { return /(^|\/)patches\//.test(f); }
function listFiles(filter) {
  const all = git(['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  const set = new Set(all.filter((f) => fs.existsSync(path.join(ROOT, f))));
  let files = [...set];
  if (filter && filter.length) {
    const fl = filter.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
    files = files.filter((f) => fl.some((p) => f === p || f.startsWith(p + '/')));
  }
  return { all: set, files: files.sort() };
}

// ---------------------------------------------------------------- scanners
// Each returns, per line: { cls: 'blank'|'comment'|'code', code: <line minus comments>,
//   segs: [{line, start, end, whole}], heredoc?: true }

function finish(info, segs, code, blankHint) {
  info.code = code;
  const whole = code.trim() === '';
  for (const s of segs) s.whole = whole;
  info.segs = segs;
  info.cls = !whole ? 'code' : segs.length ? 'comment' : 'blank';
  if (blankHint) info.cls = 'code';
  return info;
}

function scanSh(lines) {
  const out = [];
  let hd = null, hdTab = false, q = null;
  lines.forEach((s, ln) => {
    if (hd) {
      const t = hdTab ? s.replace(/^\t+/, '') : s;
      if (t === hd) hd = null;
      out.push({ cls: 'code', code: s, segs: [], heredoc: true });
      return;
    }
    const wasQuoted = q !== null;
    let i = 0, code = '';
    const segs = [];
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (q === "'") { if (c === "'") q = null; }
        else if (c === '\\') { code += c + (s[i + 1] || ''); i += 2; continue; }
        else if ((q === '"' && c === '"') || (q === "$'" && c === "'")) q = null;
        code += c; i++; continue;
      }
      if (c === '\\') { code += c + (s[i + 1] || ''); i += 2; continue; }
      if (c === '$' && s[i + 1] === "'") { q = "$'"; code += "$'"; i += 2; continue; }
      if (c === "'" || c === '"') { q = c; code += c; i++; continue; }
      if (c === '#' && (i === 0 || /[\s;|&(]/.test(s[i - 1])) && !(ln === 0 && s[1] === '!')) {
        segs.push({ line: ln + 1, start: i, end: s.length });
        break;
      }
      if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i + 2] !== '(') {
        const m = /^<<(-?)\s*(["']?)([A-Za-z_]\w*)\2/.exec(s.slice(i));
        if (m) { hd = m[3]; hdTab = !!m[1]; }
      }
      code += c; i++;
    }
    const info = {};
    finish(info, segs, code, wasQuoted && segs.length === 0 && s.trim() !== '' ? true : (wasQuoted ? true : false));
    if (s.trim() === '' && !wasQuoted) info.cls = 'blank';
    out.push(info);
  });
  return out;
}

// one line of C-like source; st carries block/template state across lines
function cLine(st, s, flavor, base) {
  base = base || 0;
  const slashOK = flavor !== 'css';
  const hashOK = flavor === 'php';
  let i = 0, code = '', last = '';
  const segs = [];
  const n = s.length;
  while (i < n) {
    if (st.blk) {
      const j = s.indexOf('*/', i);
      const end = j < 0 ? n : j + 2;
      segs.push({ start: base + i, end: base + end });
      i = end; if (j >= 0) st.blk = false;
      continue;
    }
    const c = s[i];
    if (st.tpl) {
      if (c === '\\') { code += c + (s[i + 1] || ''); i += 2; continue; }
      if (c === '`') st.tpl = false;
      code += c; i++; continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      segs.push({ start: base + i, end: base + end });
      if (j < 0) st.blk = true;
      i = end; continue;
    }
    if (slashOK && c === '/' && s[i + 1] === '/' && s[i - 1] !== ':') {
      segs.push({ start: base + i, end: base + n }); break;
    }
    if (hashOK && c === '#' && s[i + 1] !== '[') { segs.push({ start: base + i, end: base + n }); break; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      code += s.slice(i, Math.min(j + 1, n)); i = Math.min(j + 1, n); last = c; continue;
    }
    if (c === '`' && flavor !== 'css') { st.tpl = true; code += c; i++; continue; }
    if (flavor === 'js' && c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      let j = i + 1, cls = false, ok = false;
      while (j < n) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false;
        else if (s[j] === '/' && !cls) { ok = true; break; }
        j++;
      }
      if (ok) { code += s.slice(i, j + 1); i = j + 1; last = '/'; continue; }
    }
    code += c; if (!/\s/.test(c)) last = c; i++;
  }
  return { code, segs };
}

function scanC(lines, flavor) {
  const st = { blk: false, tpl: false };
  return lines.map((s, ln) => {
    const wasTpl = st.tpl;
    const r = cLine(st, s, flavor);
    r.segs.forEach((g) => { g.line = ln + 1; });
    const info = {};
    finish(info, r.segs, r.code, wasTpl);
    if (s.trim() === '' && !wasTpl) info.cls = 'blank';
    return info;
  });
}

function scanHtml(lines) {
  const st = { mode: 'html', hc: false, js: { blk: false, tpl: false }, css: { blk: false, tpl: false } };
  return lines.map((s, ln) => {
    let pos = 0, code = '';
    const segs = [];
    while (pos < s.length) {
      if (st.hc) {
        const j = s.indexOf('-->', pos);
        const end = j < 0 ? s.length : j + 3;
        segs.push({ start: pos, end }); pos = end; if (j >= 0) st.hc = false; continue;
      }
      if (st.mode === 'html') {
        const rest = s.slice(pos);
        const m = /<!--|<script\b[^>]*>|<style\b[^>]*>/i.exec(rest);
        if (!m) { code += rest; break; }
        code += rest.slice(0, m.index);
        const at = pos + m.index;
        if (m[0] === '<!--') {
          const j = s.indexOf('-->', at + 4);
          const end = j < 0 ? s.length : j + 3;
          segs.push({ start: at, end });
          if (j < 0) st.hc = true;
          pos = end; continue;
        }
        code += m[0]; pos = at + m[0].length;
        st.mode = /^<script/i.test(m[0]) ? 'script' : 'style';
        continue;
      }
      const close = st.mode === 'script' ? /<\/script\s*>/i : /<\/style\s*>/i;
      const rest = s.slice(pos);
      const idx = rest.search(close);
      const part = idx < 0 ? rest : rest.slice(0, idx);
      const r = cLine(st.mode === 'script' ? st.js : st.css, part, st.mode === 'script' ? 'js' : 'css', pos);
      code += r.code; segs.push(...r.segs);
      if (idx < 0) break;
      pos += idx; st.mode = 'html';
    }
    segs.forEach((g) => { g.line = ln + 1; });
    const info = {};
    finish(info, segs, code, false);
    if (s.trim() === '') info.cls = 'blank';
    return info;
  });
}

function scanPy(lines) {
  let tq = null;
  return lines.map((s, ln) => {
    let i = 0, code = '';
    const segs = [];
    const was = tq !== null;
    while (i < s.length) {
      if (tq) {
        const j = s.indexOf(tq, i);
        if (j < 0) { code += s.slice(i); i = s.length; } else { code += s.slice(i, j + 3); i = j + 3; tq = null; }
        continue;
      }
      const c = s[i];
      if (s.startsWith('"""', i) || s.startsWith("'''", i)) { tq = s.substr(i, 3); code += tq; i += 3; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; }
        code += s.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === '#' && !(ln === 0 && s[1] === '!')) { segs.push({ line: ln + 1, start: i, end: s.length }); break; }
      code += c; i++;
    }
    const info = {};
    finish(info, segs, code, was);
    if (s.trim() === '' && !was) info.cls = 'blank';
    return info;
  });
}

function scanSource(lang, text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let infos;
  if (lang === 'sh') infos = scanSh(lines);
  else if (lang === 'js') infos = scanC(lines, 'js');
  else if (lang === 'css') infos = scanC(lines, 'css');
  else if (lang === 'php') infos = scanC(lines, 'php');
  else if (lang === 'html') infos = scanHtml(lines);
  else if (lang === 'py') infos = scanPy(lines);
  else infos = lines.map(() => ({ cls: 'code', code: '', segs: [] }));
  return { lines, infos };
}

// ---------------------------------------------------------------- docs + sections
function docDirs() {
  return ['docs/reference', 'docs/generated'].filter((d) => fs.existsSync(path.join(ROOT, d)));
}
let _docs = null;
function loadDocs() {
  if (_docs) return _docs;
  const docs = new Map(); // basename -> Set(ids)
  for (const d of docDirs()) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      if (!f.endsWith('.md') || docs.has(f)) continue;
      const ids = new Set();
      let fence = false;
      for (const l of fs.readFileSync(path.join(ROOT, d, f), 'utf8').split('\n')) {
        if (/^\s*```/.test(l)) { fence = !fence; continue; }
        if (fence) continue;
        const h = /^#{1,6}\s+(.*)$/.exec(l);
        if (!h) continue;
        let t = h[1].replace(/^[*_`]+/, '');
        for (const m of t.matchAll(/§\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/g)) ids.add(m[1]);
        t = t.replace(/^(?:§\s*|part\s+|section\s+|appendix\s+)/i, '');
        let m = /^([A-Z]?\d+(?:\.\d+)*[a-z]?)(?=[.):\s—–-]|$)/.exec(t);
        if (!m) m = /^([A-Z])(?=[.):])/.exec(t);
        if (m) ids.add(m[1]);
      }
      for (const id of [...ids]) { // implicit parents
        const p = id.split('.');
        for (let k = 1; k < p.length; k++) ids.add(p.slice(0, k).join('.'));
      }
      docs.set(f, ids);
    }
  }
  _docs = docs;
  return docs;
}
function productKey(file) {
  const m = /(?:^|\/)(\d{2,3}[a-z]*)_/.exec(file);
  return m ? m[1] : null;
}
function productDocs(file) {
  const docs = loadDocs();
  let key = productKey(file);
  while (key) {
    const hit = [...docs.keys()].filter((d) => d.startsWith('script' + key + '_'));
    if (hit.length) return hit;
    key = key.slice(0, -1);
    if (key.length < 2) break;
  }
  return [];
}
const DOCNAME = /script\d{2,3}[a-z]*_[a-z0-9_]+?\.md/g;
const SECPTR = /§§?\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?|[A-Z](?![a-z\w]))/g;

function resolveDocs(file, text, at) {
  // explicit filename nearest before the pointer, else the sole one in the comment
  const names = [];
  for (const m of text.matchAll(DOCNAME)) names.push({ n: m[0], i: m.index });
  const before = names.filter((x) => x.i < at);
  if (before.length) return { docs: [before[before.length - 1].n], explicit: before[before.length - 1] };
  const uniq = [...new Set(names.map((x) => x.n))];
  if (uniq.length === 1) return { docs: uniq, explicit: names[0] };
  const pre = text.slice(Math.max(0, at - 40), at);
  if (/memory|MEMORY/i.test(pre)) return { docs: [], explicit: null };
  const own = productDocs(file);
  const kind = /(impl\w*|IMPL)\s*$/.exec(pre) ? 'implementation' : /audit\s*$/i.test(pre) ? 'security_audit' : /design\s*$/i.test(pre) ? 'design' : null;
  const sc = /script(\d{2,3}[a-z]*)[ _]?(design|impl\w*|security_audit|audit)?\s*$/i.exec(pre);
  let pool = own;
  if (sc) {
    const k = sc[1];
    pool = [...loadDocs().keys()].filter((d) => d.startsWith('script' + k + '_'));
    const kk = (sc[2] || '').toLowerCase();
    const t = kk.startsWith('impl') ? 'implementation' : kk.includes('audit') ? 'security_audit' : kk === 'design' ? 'design' : null;
    if (t) pool = pool.filter((d) => d.includes('_' + t));
  } else if (kind) {
    const f = own.filter((d) => d.includes('_' + kind));
    if (f.length) pool = f;
  }
  return { docs: pool, explicit: null };
}
function secExists(doc, id) {
  const ids = loadDocs().get(doc);
  if (!ids) return false;
  if (ids.has(id)) return true;
  for (const x of ids) if (x.startsWith(id + '.')) return true;
  return false;
}

// ---------------------------------------------------------------- rules
const PLAN = [
  /\bParts?\s+\d+(?:\s*[-–]\s*\d+)?\b/,
  /\bR\d+-\d+\b/,
  /\bdelta\s*#\d+/i,
  /\b(?:review[- ]round|round)[- ]?\d\b/i,
  /\bS\d+\s+(?:packet|pass)\b|\bpacket\s+S\d+\b/,
  /\bbatch\s+[A-C]\d\b|\bTier\s+[ABCZ]\b|\bTrack\s+G\b/,
];
const EVIDENCE = /verified|live|tested|confirmed|observed|measured|checked|reproduced|probed|captured|against|empirical/i;
const DATE = /\b20\d\d-\d\d-\d\d\b/;
const DIARY = [
  /\b(?:it|that|this|they|which|there|was|were)\s+used to\b/i,
  /\bused to\s+(?:be|have|walk|break|end|leak|run|do|fail|call|return|read|write|take|get|need|miss|hide|show|send|cost|stall|loop)\b/i,
  /\bpreviously\b/i, /\bformerly\b/i,
  /\bwas\b[^.;]{0,60}\bnow\b/i, /\bnow\b[^.;]{0,40}\binstead of\b/i,
  /\b(?:was|were|has been|have been)\s+(?:renamed|moved|replaced|removed|deleted|changed|split|merged)\b/i,
  /\b(?:added|fixed|changed|moved|introduced)\s+(?:in|on|at)\s+20\d\d/i,
];
const TODO = /\b(?:TODO|FIXME|XXX|HACK)\b/;
const CODE_SH = /^ ?(?:(?:if|elif|while|until|for|case)\s.*(?:;\s*then|;\s*do|\sin)\s*$|(?:fi|done|esac|then|else|do)\s*$|local\s+\w+=|export\s+\w+=|[A-Za-z_]\w*=["$\w\/.\-]\S*\s*$|[A-Za-z_][\w-]*\(\)\s*\{|(?:cd|rm|cp|mv|mkdir|chmod|chown|systemctl|ln|sed|awk|grep|curl|printf|echo)\s+.*[$"'|>\/].*|\}\s*$)/;
const CODE_JS = /^ ?(?:(?:const|let|var)\s+[\w{[$]+\s*[=;]|function\s+\w+\s*\(|(?:return|await|throw)\b.*;\s*$|import\s.*from\s|(?:if|for|while|switch)\s*\(.*[){]\s*$|[\w.$\[\]'"]+\s*(?:=|\+=|\|\|=)\s*[^=].*;\s*$|[\w.$]+\([^)]*\);?\s*$|\}\s*(?:else\b.*)?\{?\s*$|\}\)?;?\s*$)/;
const CODE_CSS = /^\s*(?:[\w-]+\s*:\s*[^;]+;|[.#]?[\w-]+(?:\s+[.#]?[\w-]+)*\s*\{)\s*$/;
const CODE_PY = /^ ?(?:def |class |import |from \w+ import|return\b|[\w.]+\(.*\)\s*$|[A-Za-z_][\w.]*\s*=\s*\S+\s*$)/;

function loadStale() {
  if (!fs.existsSync(STALE)) return [];
  const out = [];
  for (const l of fs.readFileSync(STALE, 'utf8').split('\n')) {
    if (!l.trim() || l.startsWith('#')) continue;
    const i = l.indexOf(' => ');
    if (i < 0) throw new Error('comment_stale_terms.txt: missing " => reason": ' + l);
    out.push({ re: new RegExp(l.slice(0, i).trim(), 'i'), reason: l.slice(i + 4).trim() });
  }
  return out;
}
function globRe(g) {
  return new RegExp('^' + g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
function loadAllow() {
  if (!fs.existsSync(ALLOWLIST)) return [];
  const out = [];
  fs.readFileSync(ALLOWLIST, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim() || l.startsWith('#')) return;
    const m = /^(\S+)\s+(\S+)\s+(\S.*)$/.exec(l);
    if (!m) throw new Error(`comment_allowlist.txt:${i + 1}: need "file:pattern CLASS reason" (reason mandatory)`);
    const c = m[1].indexOf(':');
    if (c < 0) throw new Error(`comment_allowlist.txt:${i + 1}: first field must be file-glob:regex`);
    out.push({ file: globRe(m[1].slice(0, c)), pat: new RegExp(m[1].slice(c + 1)), cls: m[2], used: 0 });
  });
  return out;
}

function pathChecks(file, text, all) {
  const hits = [];
  const seen = new Set();
  const exists = (p) => {
    p = p.replace(/\/+$/, '');
    if (all.has(p) || fs.existsSync(path.join(ROOT, p))) return true;
    const dir = path.dirname(file);
    if (all.has(dir + '/' + p) || fs.existsSync(path.join(ROOT, dir, p))) return true;
    for (const f of all) if (f.endsWith('/' + p) || f.startsWith(p + '/') || f.includes('/' + p + '/')) return true;
    return false;
  };
  const docNames = new Set(loadDocs().keys());
  const note = (p) => { if (!seen.has(p)) { seen.add(p); hits.push({ cls: 'DEAD_PATH', text: p }); } };
  for (const m of text.matchAll(/(?<![\w.\/~$-])((?:scripts|web|docs|panel|back-end-pool|public_html)\/[\w.\-\/]*[\w\-\/])/g)) {
    const p = m[1];
    if (/[*<{$%]|\.\.\.|\bNN\b|\bXX\b|##|[-_]$/.test(p) || /[*<{$%[]/.test(text[m.index + p.length] || '')) continue;
    if (!exists(p)) note(p);
  }
  for (const m of text.matchAll(/\b(script\d{2,3}[a-z]*_[a-z0-9_]+\.md)\b/g)) {
    if (!docNames.has(m[1]) && !exists(m[1])) note(m[1]);
  }
  for (const m of text.matchAll(/(?<![\w\/-])(\d{2,3}[a-z]*_[A-Za-z0-9_]+\.(?:sh|py|js)|(?:grin|nginx|ui|nostr)_[a-z0-9_]+\.sh)\b/g)) {
    if (!exists(m[1])) note(m[1]);
  }
  return hits;
}

const PROSE = /\b[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\b| — /;
function classify(file, lang, seg, text, ctx) {
  const hits = [];
  const add = (cls, t) => hits.push({ cls, text: t || text });
  if (PLAN.some((r) => r.test(text))) add('PLAN_TAG');
  if ((DATE.test(text) && !EVIDENCE.test(text)) || DIARY.some((r) => r.test(text))) add('DIARY_DATE');
  if (TODO.test(text)) add('TODO');
  for (const s of ctx.stale) if (s.re.test(text)) add('STALE_TERM', text + '  <<' + s.reason + '>>');
  for (const h of pathChecks(file, text, ctx.all)) hits.push(h);
  for (const m of text.matchAll(SECPTR)) {
    const r = resolveDocs(file, text, m.index);
    if (!r.docs.length) continue;
    if (/\b(?:RFC|BIP|EIP|ISO|IETF|section)\s*\d*\s*$/i.test(text.slice(Math.max(0, m.index - 16), m.index))) continue; // external spec
    if (!r.docs.some((d) => loadDocs().has(d))) continue; // missing filename already DEAD_PATH
    if (!r.docs.some((d) => secExists(d, m[1]))) add('DEAD_SECTION', `§${m[1]} not in ${r.docs.join('|')} :: ${text}`);
  }
  if (seg.whole) {
    const body = text.replace(/^\s*(?:#+|\/\/+|\/\*+|\*+|<!--)/, '').replace(/(?:\*\/|-->)\s*$/, '');
    const re = lang === 'sh' ? CODE_SH : lang === 'py' ? CODE_PY : lang === 'css' ? CODE_CSS : CODE_JS;
    const raw = text.replace(/^\s*(?:#+|\/\/+|\/\*+|<!--)/, '').replace(/(?:\*\/|-->)\s*$/, '');
    if (body.trim() && re.test(raw) && !/^\s{3,}/.test(raw) && !/[.:]\s*$/.test(raw.trim()) && !PROSE.test(raw) && text.trim() !== '#!') add('COMMENTED_CODE');
  }
  return hits;
}

function scanFiles(filter) {
  const { all, files } = listFiles(filter);
  const stale = loadStale();
  const allow = loadAllow();
  const ctx = { all, stale };
  const out = [];
  let allowed = 0;
  const patchReadme = fs.existsSync(path.join(ROOT, 'web/052_accio/patches/README.md'))
    ? fs.readFileSync(path.join(ROOT, 'web/052_accio/patches/README.md'), 'utf8') : '';
  for (const f of files) {
    if (excluded(f)) continue;
    if (isPatch(f)) {
      if (/\/patches\/public_html\//.test(f)) {
        const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (!t.includes('ACCIO PATCH') && !patchReadme.includes(path.basename(f))) {
          out.push({ f, line: 1, cls: 'PATCH_MARKER', text: 'no ACCIO PATCH marker and not listed in patches/README.md' });
        }
      }
      continue;
    }
    const lang = langOf(f);
    if (!lang) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
    if (text.includes('\0')) continue;
    const { lines, infos } = scanSource(lang, text);
    infos.forEach((info, i) => {
      for (const seg of info.segs) {
        const t = lines[i].slice(seg.start, seg.end);
        for (const h of classify(f, lang, seg, t, ctx)) {
          const a = allow.find((x) => x.file.test(f) && (x.cls === '*' || x.cls === h.cls) && x.pat.test(t));
          if (a) { a.used++; allowed++; out.push({ f, line: i + 1, cls: h.cls, text: h.text, allowed: true }); continue; }
          out.push({ f, line: i + 1, cls: h.cls, text: h.text });
        }
      }
    });
  }
  return { hits: out, allow, allowed };
}

// ---------------------------------------------------------------- diffgate
function diffgate(rev, paths) {
  const args = ['diff', '--no-renames', '-U0', '--no-color', rev];
  if (paths.length) args.push('--', ...paths);
  const diff = git(args);
  const cache = new Map();
  const infoFor = (side, file) => {
    const k = side + ':' + file;
    if (cache.has(k)) return cache.get(k);
    let txt = null;
    try {
      txt = side === 'new' ? fs.readFileSync(path.join(ROOT, file), 'utf8') : git(['show', rev + ':' + file]);
    } catch (e) { txt = null; }
    const lang = langOf(file);
    const r = txt === null || !lang ? null : scanSource(lang, txt);
    cache.set(k, r);
    return r;
  };
  const bad = [];
  let file = null, hunks = [];
  const flush = () => {
    if (!file) return;
    const lang = langOf(file);
    if (!lang) { bad.push(`${file}: not a recognised source type — cannot gate`); return; }
    const nw = infoFor('new', file), od = infoFor('old', file);
    for (const h of hunks) {
      const pairs = h.del.length === h.add.length;
      const ok = (r, n) => r && r.infos[n - 1] && (r.infos[n - 1].cls === 'comment' || r.infos[n - 1].cls === 'blank');
      h.add.forEach((n, k) => {
        if (ok(nw, n)) return;
        if (pairs && od && nw && od.infos[h.del[k] - 1] && nw.infos[n - 1] &&
          od.infos[h.del[k] - 1].code.trim() === nw.infos[n - 1].code.trim() && !nw.infos[n - 1].heredoc) return;
        bad.push(`${file}:${n}: changed line is not a comment/blank${nw && nw.infos[n - 1] && nw.infos[n - 1].heredoc ? ' (heredoc body)' : ''}: ${nw ? nw.lines[n - 1].trim().slice(0, 100) : '?'}`);
      });
      h.del.forEach((n, k) => {
        if (ok(od, n)) return;
        if (pairs && od && nw && od.infos[n - 1] && nw.infos[h.add[k] - 1] &&
          od.infos[n - 1].code.trim() === nw.infos[h.add[k] - 1].code.trim() && !od.infos[n - 1].heredoc) return;
        bad.push(`${file}:-${n}: removed line was not a comment/blank${od && od.infos[n - 1] && od.infos[n - 1].heredoc ? ' (heredoc body)' : ''}: ${od ? od.lines[n - 1].trim().slice(0, 100) : '?'}`);
      });
    }
  };
  for (const l of diff.split('\n')) {
    let m;
    if ((m = /^diff --git a\/.* b\/(.*)$/.exec(l))) { flush(); file = m[1]; hunks = []; }
    else if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l))) {
      const oc = m[2] === undefined ? 1 : +m[2], nc = m[4] === undefined ? 1 : +m[4];
      const h = { del: [], add: [] };
      for (let i = 0; i < oc; i++) h.del.push(+m[1] + i);
      for (let i = 0; i < nc; i++) h.add.push(+m[3] + i);
      hunks.push(h);
    }
  }
  flush();
  return bad;
}

// ---------------------------------------------------------------- --map
function loadMap(file) {
  const rows = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim() || l.startsWith('#')) return;
    const c = l.split('\t').map((x) => x.trim()).filter((x) => x !== '→' && x !== '->');
    if (c.length < 3) throw new Error(`${file}:${i + 1}: need old-doc, old-§, new-doc[, new-§]`);
    const doc = (x) => (x.endsWith('.md') ? x : x + '.md');
    const sec = (x) => (x || '').replace(/^§\s*/, '');
    rows.push({ od: doc(c[0]), os: sec(c[1]), nd: doc(c[2]), ns: sec(c[3] || (c[1] === '*' ? '*' : c[1])) });
  });
  return rows;
}
function applyMap(mapFile, filter, write, force) {
  const rows = loadMap(mapFile);
  const stampF = mapFile + '.applied';
  const applied = new Set(fs.existsSync(stampF) ? JSON.parse(fs.readFileSync(stampF, 'utf8')) : []);
  const bySec = new Map(), byDoc = new Map();
  for (const r of rows) {
    if (r.os === '*') byDoc.set(r.od, r.nd);
    else { const k = r.od + '|' + r.os; if (!bySec.has(k)) bySec.set(k, new Set()); bySec.get(k).add(r.nd + '|' + r.ns); }
  }
  const { files } = listFiles(filter);
  let changed = 0, edits = 0, unmapped = 0, ambiguous = 0;
  const log = [];
  for (const f of files) {
    if (excluded(f) || isPatch(f)) continue;
    const lang = langOf(f);
    if (!lang) continue;
    if (applied.has(f) && !force) { log.push(`skip (already applied): ${f}`); continue; }
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const { lines, infos } = scanSource(lang, text);
    const own = productDocs(f);
    const design = own.find((d) => /_design\.md$/.test(d));
    let fileEdits = 0;
    infos.forEach((info, i) => {
      const reps = [];
      for (const seg of info.segs) {
        const t = lines[i].slice(seg.start, seg.end);
        for (const m of t.matchAll(SECPTR)) {
          const r = resolveDocs(f, t, m.index);
          if (!r.docs.length) continue;
          const targets = new Set();
          let from = null;
          for (const d of r.docs) { const s = bySec.get(d + '|' + m[1]); if (s) { s.forEach((x) => targets.add(x)); from = d; } }
          if (!targets.size) { unmapped++; continue; }
          if (targets.size > 1) { ambiguous++; log.push(`AMBIGUOUS ${f}:${i + 1} §${m[1]} -> ${[...targets].join(' / ')}`); continue; }
          const [nd, ns] = [...targets][0].split('|');
          const sIdx = seg.start + m.index;
          const ptrTxt = m[0].replace(/(§§?\s*).*$/, '$1') + ns;
          let tail = '';
          if (r.explicit) {
            // swap the explicit filename too
            if (nd !== from) reps.push({ s: seg.start + r.explicit.i, e: seg.start + r.explicit.i + r.explicit.n.length, v: nd });
          } else if (nd !== design && nd !== from) tail = ` (${nd})`;
          reps.push({ s: sIdx, e: sIdx + m[0].length, v: ptrTxt + tail });
        }
        for (const m of t.matchAll(DOCNAME)) {
          const nd = byDoc.get(m[0]);
          if (nd && !reps.some((x) => x.s === seg.start + m.index)) reps.push({ s: seg.start + m.index, e: seg.start + m.index + m[0].length, v: nd });
        }
      }
      if (!reps.length) return;
      reps.sort((a, b) => b.s - a.s);
      let L = lines[i];
      for (const r of reps) { L = L.slice(0, r.s) + r.v + L.slice(r.e); fileEdits++; }
      if (L !== lines[i]) log.push(`${f}:${i + 1}\n  - ${lines[i].trim()}\n  + ${L.trim()}`);
      lines[i] = L;
    });
    if (fileEdits) {
      changed++; edits += fileEdits;
      if (write) { fs.writeFileSync(path.join(ROOT, f), lines.join(eol) + (text.endsWith('\n') ? eol : '')); applied.add(f); }
    }
  }
  if (write) fs.writeFileSync(stampF, JSON.stringify([...applied].sort(), null, 1));
  return { log, changed, edits, unmapped, ambiguous };
}

// ---------------------------------------------------------------- CLI
function main(argv) {
  const cmd = argv[0];
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.startsWith('--map')));
  const mapAt = argv.indexOf('--map');
  try {
    if (mapAt >= 0) {
      const rest = argv.filter((a, i) => i !== mapAt && i !== mapAt + 1 && !a.startsWith('--'));
      const r = applyMap(argv[mapAt + 1], rest, flags.has('--write'), flags.has('--force'));
      console.log(r.log.join('\n'));
      console.error(`${flags.has('--write') ? 'WROTE' : 'DRY RUN'}: ${r.edits} edit(s) in ${r.changed} file(s); ${r.unmapped} pointer(s) not in map; ${r.ambiguous} ambiguous`);
      return r.ambiguous ? 1 : 0;
    }
    if (cmd === 'scan') {
      const paths = argv.slice(1).filter((a) => !a.startsWith('--'));
      const r = scanFiles(paths);
      const show = flags.has('--show-allowed');
      const rows = r.hits.filter((h) => show || !h.allowed);
      if (flags.has('--summary')) {
        const c = {};
        rows.forEach((h) => { c[h.cls] = (c[h.cls] || 0) + 1; });
        console.log(JSON.stringify(c));
      } else {
        rows.forEach((h) => console.log([h.f, h.line, h.cls + (h.allowed ? ' (allowed)' : ''), h.text.replace(/\t/g, ' ').trim().slice(0, 240)].join('\t')));
      }
      if (!paths.length) r.allow.filter((a) => !a.used).forEach((a) => console.error(`stale allowlist entry (matched nothing): ${a.file.source} ${a.pat.source}`));
      return rows.length ? 1 : 0;
    }
    if (cmd === 'diffgate') {
      const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
      let rev = 'HEAD';
      const paths = [];
      for (const a of rest) { if (fs.existsSync(path.join(ROOT, a)) || fs.existsSync(a)) paths.push(a); else rev = a; }
      const bad = diffgate(rev, paths);
      if (bad.length) { console.log(bad.join('\n')); console.error(`diffgate FAILED: ${bad.length} non-comment line(s) changed`); return 1; }
      console.error('diffgate OK: only comment/blank lines changed');
      return 0;
    }
    console.error('usage: check_comments.js scan|diffgate|--map  (see header)');
    return 2;
  } catch (e) { console.error('check_comments: ' + (e.stack || e.message)); return 2; }
}

module.exports = { scanSource, scanFiles, diffgate, listFiles, langOf, excluded, isPatch };
if (require.main === module) process.exit(main(process.argv.slice(2)));
