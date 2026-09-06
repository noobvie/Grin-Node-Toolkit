// ─────────────────────────────────────────────────────────────────────────────
// Payment Proof Verifier — page wiring for /proof
//
// This page is the ONE tool in the hub that transmits what you paste. /slate and
// /wallet-check are client-side by design; here the kernel lookup needs the node
// and ed25519 has no dependable browser primitive yet, so the proof is POSTed to
// /api/proof/verify. The page says so in the panel badge and in its own details
// block — do not copy the "checked locally" wording from the other two.
//
// TWO VERDICTS, NEVER ONE. The signature check and the chain check answer
// different questions, and a rendering that collapses them is the failure mode
// this tool exists to avoid: a valid signature over a kernel that never
// confirmed is not a settled payment. Both are always drawn, and the chain row
// is drawn even when it was not reached ("not checked" is a third state, not a
// pass and not a fail).
//
// Amounts are u64 nanogrin. The server sends them as STRINGS for that reason —
// never Number() one here, and never re-derive GRIN from a Number.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  'use strict';

  const MAX_BYTES = 16 * 1024;    // matches the express.text limit on the route

  // That limit is BYTES. A string.length is UTF-16 code units, so a proof with
  // any non-ASCII in it would clear this pre-flight and then 413 at the server
  // — which the page renders honestly, but under the wrong explanation. Measure
  // what the server measures.
  const TEXT_ENCODER = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  function byteLength(s) {
    return TEXT_ENCODER ? TEXT_ENCODER.encode(s).length : new Blob([s]).size;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function row(label, value, copyVal) {
    const r = el('div', 'tx-row');
    r.appendChild(el('div', 'tx-row-label', label));
    const v = el('div', 'tx-row-value');
    if (value instanceof Node) v.appendChild(value); else v.textContent = value;
    r.appendChild(v);
    if (copyVal) {
      const b = el('button', 'tx-copy', 'Copy');
      b.type = 'button';
      b.addEventListener('click', () => {
        if (typeof root.copyText === 'function') root.copyText(copyVal, b);
      });
      r.appendChild(b);
    }
    return r;
  }

  function link(text, href) {
    const a = el('a', 'tx-link', text);
    a.href = href;
    return a;
  }

  // One check row: mark + name + the sentence that says what the mark means.
  // state is 'ok' | 'bad' | 'skip'.
  function checkRow(state, name, note) {
    const r = el('div', 'tx-pf-check');
    const mark = el('span', 'tx-pf-mark is-' + state, state === 'ok' ? '✓' : state === 'bad' ? '✕' : '–');
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', state === 'ok' ? 'pass' : state === 'bad' ? 'fail' : 'not checked');
    r.appendChild(mark);
    r.appendChild(el('span', 'tx-pf-check-name', name));
    r.appendChild(el('span', 'tx-pf-check-note', note));
    return r;
  }

  // Verdict wording. Every branch names BOTH halves — a one-word verdict is
  // exactly what this tool must not print.
  const VERDICTS = {
    settled: {
      cls: 'is-ok', mark: '✓',
      text: 'Both signatures are valid and the kernel is on chain. This payment settled.',
    },
    not_on_chain: {
      cls: 'is-bad', mark: '✕',
      text: 'Both signatures are valid, but this kernel is not on the mainnet chain. ' +
            'A signed proof of a transaction that never confirmed is not a settled payment.',
    },
    invalid_signature: {
      cls: 'is-bad', mark: '✕',
      text: 'A signature does not verify, so the chain was not checked. ' +
            'This file does not prove a payment between these two addresses.',
    },
    chain_unavailable: {
      cls: 'is-warn', mark: '!',
      text: 'Both signatures are valid, but the chain could not be checked right now — ' +
            'so whether this payment settled is still unanswered.',
    },
  };

  const CHAIN_NOTES = {
    not_found: 'No kernel with this excess exists on the mainnet chain.',
    not_found_testnet_claim:
      'Not on the mainnet chain. The addresses claim testnet, and this explorer only ever ' +
      'asks mainnet — so this is not evidence either way. Check it on a testnet explorer.',
    node_unreachable: 'The node could not be reached. Try again shortly.',
    not_checked: 'Not checked — a signature failed first, so the lookup was not made.',
  };

  function renderError(out, message) {
    out.textContent = '';
    out.hidden = false;
    const v = el('div', 'tx-wc-verdict is-bad');
    v.appendChild(el('span', 'tx-wc-mark', '✕'));
    v.appendChild(el('span', 'tx-wc-verdict-text', message));
    out.appendChild(v);
  }

  function render(out, res) {
    out.textContent = '';
    out.hidden = false;

    const verdict = VERDICTS[res.verdict] || VERDICTS.chain_unavailable;
    const banner = el('div', 'tx-wc-verdict ' + verdict.cls);
    banner.appendChild(el('span', 'tx-wc-mark', verdict.mark));
    banner.appendChild(el('span', 'tx-wc-verdict-text', verdict.text));
    out.appendChild(banner);

    // ── The three checks ─────────────────────────────────────────────────────
    const checks = el('div', 'tx-pf-checks');
    const rs = res.checks.recipient_sig;
    const ss = res.checks.sender_sig;
    const ch = res.checks.chain || { ok: false, reason: 'not_checked' };

    checks.appendChild(checkRow(rs.ok ? 'ok' : 'bad', 'Recipient signature',
      rs.ok ? 'The payee signed this amount, this kernel and this payer.'
            : 'Does not verify under the recipient address.'));
    checks.appendChild(checkRow(ss.ok ? 'ok' : 'bad', 'Sender signature',
      ss.ok ? 'The payer signed the same 73 bytes.'
            : 'Does not verify under the sender address.'));
    checks.appendChild(checkRow(ch.ok ? 'ok' : (ch.checked ? 'bad' : 'skip'), 'Kernel on chain',
      ch.ok ? ('Confirmed at height ' + fmtNum(ch.height)
               + (ch.confirmations != null ? ' · ' + fmtNum(ch.confirmations) + ' confirmations' : ''))
            : (CHAIN_NOTES[ch.reason] || 'Not checked.')));
    out.appendChild(checks);

    // ── What the file says ───────────────────────────────────────────────────
    const p = res.proof;
    const rows = el('div', 'tx-rows');

    const amt = el('span');
    amt.appendChild(document.createTextNode(p.amount_grin + ' ツ'));
    const tag = el('span', 'tx-pf-attested', 'attested');
    tag.title = 'Signed by both parties — Grin amounts are confidential and cannot be read off the chain';
    amt.appendChild(tag);
    amt.appendChild(el('div', 'tx-pf-check-note', p.amount_nano + ' nanogrin'));
    rows.appendChild(row('Amount', amt, p.amount_nano));

    rows.appendChild(row('Kernel excess', link(p.excess, '/kernel/' + p.excess), p.excess));
    rows.appendChild(row('Sender', p.sender_address, p.sender_address));
    rows.appendChild(row('Recipient', p.recipient_address, p.recipient_address));
    rows.appendChild(row('Network (claimed)',
      (p.network_claim === 'mainnet' ? 'Mainnet' : p.network_claim === 'testnet' ? 'Testnet' : 'Unknown')
      + ' — prefix "' + p.sender_hrp + '", which no signature covers'));

    if (ch.ok) {
      if (ch.block) rows.appendChild(row('Block', link(fmtHashShort(ch.block), '/block/' + ch.block), ch.block));
      if (ch.timestamp) {
        rows.appendChild(row('Settled', new Date(ch.timestamp * 1000).toUTCString()
          + '  (' + fmtAge(ch.timestamp) + ')'));
      }
    }
    out.appendChild(rows);

    // ── Flags: surfaced, never hidden ────────────────────────────────────────
    if (res.self_payment) {
      const n = el('div', 'tx-note');
      n.appendChild(el('strong', null, 'Sender and recipient are the same address.'));
      n.appendChild(document.createTextNode(
        ' Both signatures cover the same message, so one key signing twice satisfies both checks. ' +
        'Whatever else this file is, it is not evidence that one party paid another.'));
      out.appendChild(n);
    }
    if (res.hrp_mismatch) {
      const n = el('div', 'tx-note');
      n.appendChild(el('strong', null, 'The two addresses claim different networks.'));
      n.appendChild(document.createTextNode(
        ' "' + p.sender_hrp + '" and "' + p.recipient_hrp + '". No wallet exports that, ' +
        'so this file was assembled by hand — and because no signature covers the prefix, ' +
        'the signatures above can still be perfectly valid.'));
      out.appendChild(n);
    }

    // The exact bytes both parties signed. Anyone re-deriving the check by hand
    // needs this, and it makes the "73 bytes" claim above checkable rather than
    // something the page merely asserts.
    const d = el('details', 'tx-details');
    d.appendChild(el('summary', null, 'The 73 bytes both parties signed'));
    const body = el('div', 'tx-details-body');
    body.appendChild(el('p', 'tx-pf-msg', res.message_hex));
    body.appendChild(el('p', null,
      'amount as a big-endian u64 (8 bytes) ‖ kernel excess (33) ‖ sender public key (32). ' +
      'ed25519 hashes it internally — it is signed as-is, with no domain separator.'));
    d.appendChild(body);
    out.appendChild(d);
  }

  function initProof() {
    const input = document.getElementById('pf-input');
    const out   = document.getElementById('pf-out');
    if (!input || !out) return;

    const btn   = document.getElementById('pf-verify');
    const clear = document.getElementById('pf-clear');
    let busy = false;

    async function run() {
      const text = input.value.trim();
      if (!text) { out.hidden = true; out.textContent = ''; return; }
      if (byteLength(text) > MAX_BYTES) {
        renderError(out, 'That file is too large to be a payment proof (the format is six short keys).');
        return;
      }
      if (busy) return;
      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
      try {
        const r = await fetch('/api/proof/verify', {
          method: 'POST',
          // The route parses the body as RAW TEXT on purpose (a u64 `amount`
          // must not go through JSON.parse) — so say text/plain, not JSON.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: text,
        });
        const data = await r.json().catch(() => null);
        if (!r.ok) {
          renderError(out, (data && data.error) ||
            (r.status === 429 ? 'Too many requests — wait a moment and try again.'
                              : 'The proof could not be checked (HTTP ' + r.status + ').'));
          return;
        }
        render(out, data);
      } catch {
        renderError(out, 'Could not reach the verifier. Check your connection and try again.');
      } finally {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
      }
    }

    if (btn) btn.addEventListener('click', run);
    if (clear) clear.addEventListener('click', () => {
      input.value = ''; out.hidden = true; out.textContent = ''; input.focus();
    });
    // Unlike the client-side tools there is no verify-as-you-type: every run is
    // a request. Explicit submit only — the button, or Ctrl/Cmd+Enter.
    input.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    });

    // ── File drop, anywhere on the page (same behaviour as /slate) ───────────
    function readFile(file) {
      if (file.size > MAX_BYTES) {
        renderError(out, 'That file is too large to be a payment proof (the format is six short keys).');
        return;
      }
      const reader = new FileReader();
      reader.onload  = () => { input.value = String(reader.result || ''); run(); };
      reader.onerror = () => renderError(out, 'Could not read that file.');
      reader.readAsText(file);
    }

    ['dragenter', 'dragover'].forEach(ev =>
      document.addEventListener(ev, e => { e.preventDefault(); input.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      document.addEventListener(ev, e => {
        e.preventDefault();
        if (ev === 'drop' || e.target === document || !e.relatedTarget) input.classList.remove('is-over');
      }));
    document.addEventListener('drop', e => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) { readFile(file); return; }
      const text = e.dataTransfer && e.dataTransfer.getData('text');
      if (text) { input.value = text; run(); }
    });

    // Deliberately NO ?proof= deep link. A payment proof names both parties and
    // an amount; putting one in a URL would leak it into browser history,
    // referrers and any proxy log between here and the server.
  }

  root.ProofUI = { initProof };

  // Self-initialising, like wallet-check.js: this file is only loaded by the
  // page that needs it, so it does not go through tiny-explorer.js's router.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initProof);
    } else {
      initProof();
    }
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
