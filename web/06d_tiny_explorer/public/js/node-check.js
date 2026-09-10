// ─────────────────────────────────────────────────────────────────────────────
// Node Reachability Checker — page wiring for /node-check
//
// The rendering rule this page exists to obey: NEVER DRAW AN UNKNOWN AS A ZERO.
// Peer count and sync state cannot be learned from outside a node — a public
// node publishes /v2/foreign and refuses /v2/owner — so they are drawn as
// "unavailable" with the reason attached, in the same list as the figures that
// ARE known. Printing "0 peers" would render a perfectly healthy node as an
// idle one, which is the single most misleading thing this tool could do.
//
// Second rule: a failure is a RESULT, not an error toast. "Refused" and "timed
// out" are the two answers an operator opening a port most needs to tell apart,
// so each failure code gets its own sentence and the same verdict banner as a
// success — never a bare "check failed".
//
// Like /proof and unlike /slate and /wallet-check, this page transmits what you
// type: the whole question is what a request from OUTSIDE sees, which only the
// server can answer. Do not copy the other two tools' "checked locally" badge.
// ─────────────────────────────────────────────────────────────────────────────

(function (root) {
  'use strict';

  const MAX_LEN = 300;   // matches parseTarget's cap in lib/node-check.js

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

  // An unavailable row is a first-class row: the label, the word "unavailable",
  // and why. It is deliberately not omitted — a missing row reads as an
  // oversight, and a "0" would read as a fact.
  function unavailableRow(label, reason) {
    const v = el('span');
    v.appendChild(el('span', 'tx-nc-unavail', 'unavailable'));
    v.appendChild(el('div', 'tx-pf-check-note', reason));
    return row(label, v);
  }

  // Every failure code the route can send, worded for someone who is trying to
  // get a port open. The route sends its own `reason` sentence too; this map is
  // the headline, and the two are shown together.
  const VERDICTS = {
    ok: {
      cls: 'is-ok', mark: '✓',
      text: 'Reachable — that node answered get_tip from the public internet.',
    },
    refused: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable — the connection was refused.',
    },
    timeout: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable — nothing answered before the timeout.',
    },
    unreachable: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable — the connection could not be made.',
    },
    reset: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable — the connection was closed part-way through the answer.',
    },
    dns_failed: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable — that host name does not resolve.',
    },
    tls_error: {
      cls: 'is-bad', mark: '✕',
      text: 'Not reachable over TLS — the handshake failed.',
    },
    http_status: {
      cls: 'is-warn', mark: '!',
      text: 'Something is listening, but it did not answer as a Grin node.',
    },
    not_json_rpc: {
      cls: 'is-warn', mark: '!',
      text: 'Something is listening, but it is not a Grin node.',
    },
    node_error: {
      cls: 'is-warn', mark: '!',
      text: 'A node answered, but returned an error instead of a tip.',
    },
    blocked: {
      cls: 'is-warn', mark: '!',
      text: 'Not checked — that address is on this server’s own network.',
    },
    // The route rejects a host it cannot parse with 400 {error, code} and none
    // of the result shape — no target, no reachable. It is a refusal to dial,
    // NOT a failed dial, so it gets its own headline: falling through to
    // `unreachable` told the operator their node was down because they typed a
    // bad host, which is the one wrong answer this tool must never give.
    bad_input: {
      cls: 'is-warn', mark: '!',
      text: 'Not checked — that is not an address this checker can use.',
    },
    // 503 from the server's total in-flight cap (NODE_CHECK_MAX_INFLIGHT). Like
    // bad_input this is a refusal to dial, so it is is-warn and not is-bad — an
    // ✕ here would say the operator's node is down when we never called it. It
    // must read as a WAIT: the sentence says what to do, and `rows: false`
    // suppresses the row block, because the 503 carries the full `base` shape
    // (target, peers, sync_state) and drawing it would dress a queue full up as
    // a measurement — the same trap R1 fixed for bad_input, which gets there via
    // the no-target guard instead.
    busy: {
      cls: 'is-warn', mark: '!', rows: false,
      text: 'Not checked yet — this checker is dialling as many hosts as it will hold at once.',
    },
  };

  // The ONLY two codes where "try 443 instead" is a real diagnosis, as an
  // ALLOWLIST rather than a blocklist: both mean the assumed port itself was
  // the dead end, and nothing else does. A blocklist was wrong twice over —
  // it had to enumerate every code that must stay silent, and it silently
  // opted in any code added later.
  //
  //   · refused  — the host answered, nothing is listening on THAT port
  //   · timeout  — packets to that port are being dropped, i.e. filtered
  //
  // Everything else is excluded for one of two reasons. Either nothing was
  // dialled at all (busy, blocked, bad_input) or the port was never the
  // problem: dns_failed and unreachable are name- and host-level, so 443 fails
  // identically, and http_status / not_json_rpc / node_error / reset all mean
  // SOMETHING ANSWERED on the assumed port. Offering the retry there prints a
  // suggestion that contradicts the banner directly above it — "a node
  // answered" followed by "your node is probably on 443" is the tool arguing
  // with itself, and the operator has no way to tell which half to believe.
  const SUGGEST_OK = { refused: 1, timeout: 1 };

  function driftText(drift) {
    if (drift === 0) return 'In step with this explorer’s tip.';
    if (drift > 0)  return 'Behind this explorer’s tip by ' + fmtNum(drift)
                         + (drift === 1 ? ' block.' : ' blocks.');
    return 'Ahead of this explorer’s tip by ' + fmtNum(-drift)
         + (drift === -1 ? ' block.' : ' blocks.');
  }

  function renderError(out, message) {
    out.textContent = '';
    out.hidden = false;
    const v = el('div', 'tx-wc-verdict is-bad');
    v.appendChild(el('span', 'tx-wc-mark', '✕'));
    v.appendChild(el('span', 'tx-wc-verdict-text', message));
    out.appendChild(v);
  }

  function render(out, res, onRetry) {
    out.textContent = '';
    out.hidden = false;

    const verdict = VERDICTS[res.code] || (res.reachable ? VERDICTS.ok : VERDICTS.unreachable);
    const banner = el('div', 'tx-wc-verdict ' + verdict.cls);
    banner.appendChild(el('span', 'tx-wc-mark', verdict.mark));
    const txt = el('span', 'tx-wc-verdict-text');
    txt.appendChild(el('b', null, verdict.text));
    // `reason` on a result, `error` on a refusal — the route names the field
    // differently either side of the 400, and the sentence is the whole value
    // of a refusal ("Remove the credentials from that URL").
    const detail = res.reason || res.error;
    if (detail) {
      txt.appendChild(document.createElement('br'));
      txt.appendChild(document.createTextNode(detail));
    }
    banner.appendChild(txt);
    out.appendChild(banner);

    // The commonest wrong verdict this tool gives is a CORRECT answer about the
    // wrong port: a bare host name is dialled on an assumed :3413, while the
    // toolkit's own Script 04 publishes the node behind nginx on 443. The route
    // does not dial the alternative itself (that would double the cost of every
    // failing check), so the fix has to be reachable in one click from the
    // verdict that caused the confusion — not buried in the placeholder text.
    if (!res.reachable && res.suggest && res.suggest.target
        && SUGGEST_OK[res.code] && typeof onRetry === 'function') {
      const alt = (res.suggest.scheme || 'https') + '://' + res.suggest.target;
      const s = el('div', 'tx-note tx-nc-suggest');
      s.appendChild(el('strong', null, 'Is your node published behind nginx or TLS?'));
      s.appendChild(document.createTextNode(' ' + (res.suggest.note || '') + ' '));
      const b = el('button', 'tx-btn', 'Check ' + alt + ' instead');
      b.type = 'button';
      b.addEventListener('click', () => onRetry(alt));
      s.appendChild(b);
      out.appendChild(s);
    }

    // No target means nothing was dialled, so there is nothing to report about
    // it: a 'Checked: undefined' row plus two 'unavailable' rows would dress a
    // rejected input up as a measurement. `rows: false` says the same thing for
    // a verdict that DOES carry a target but never used it (busy).
    if (verdict.rows === false) return;
    if (typeof res.target !== 'string' || !res.target) return;

    const rows = el('div', 'tx-rows');
    rows.appendChild(row('Checked', res.target, res.target));

    if (res.reachable) {
      rows.appendChild(row('Node version', res.node_version || 'unavailable'));
      rows.appendChild(row('Tip height', fmtNum(res.height), String(res.height)));
      if (res.drift == null) {
        rows.appendChild(row('Drift', 'This explorer’s own tip was unavailable, so no comparison was made.'));
      } else {
        const d = el('span');
        d.appendChild(document.createTextNode(driftText(res.drift)));
        d.appendChild(el('div', 'tx-pf-check-note',
          'This explorer is at ' + fmtNum(res.our_height) + '.'));
        rows.appendChild(row('Drift', d));
      }
      if (res.last_block) {
        rows.appendChild(row('Its tip block', res.last_block, res.last_block));
      }
    } else if (res.http_status) {
      rows.appendChild(row('HTTP status', String(res.http_status)));
    }

    // Always drawn, reachable or not — these two are unanswerable from out here
    // by design, and saying so is part of the answer.
    if (res.peers)      rows.appendChild(unavailableRow('Peer count', res.peers.reason));
    if (res.sync_state) rows.appendChild(unavailableRow('Sync state', res.sync_state.reason));
    out.appendChild(rows);

    if (res.reachable) {
      const n = el('div', 'tx-note');
      n.appendChild(el('strong', null, 'Now check the other half.'));
      n.appendChild(document.createTextNode(
        ' A reachable Foreign API is what a wallet needs. The Owner API on the same port must '
        + 'NOT be reachable — ask for /v2/owner from outside and make sure it answers 403.'));
      out.appendChild(n);
    }
  }

  function initNodeCheck() {
    const input = document.getElementById('nc-input');
    const out   = document.getElementById('nc-out');
    if (!input || !out) return;

    const btn   = document.getElementById('nc-check');
    const clear = document.getElementById('nc-clear');
    let busy = false;

    // `override` is the one-click retry from a suggestion: it rewrites the input
    // so what is on screen always matches what was dialled, then asks again. It
    // is a fresh visitor-initiated question, not a fallback inside one.
    //
    // The busy guard comes FIRST, before the rewrite. The suggestion button lives
    // in the results area and stays clickable while a check is in flight (the
    // output is not cleared until the answer lands), so a rewrite above this line
    // would put a host in the box that was never dialled and then bail — the
    // exact "what did it actually check" confusion this whole feature exists to
    // remove. Nothing may touch the input on a run that is not going to happen.
    async function run(override) {
      if (busy) return;
      if (typeof override === 'string' && override) input.value = override;
      const text = input.value.trim();
      if (!text) { out.hidden = true; out.textContent = ''; return; }
      if (text.length > MAX_LEN) { renderError(out, 'That is too long to be a host.'); return; }
      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      try {
        const r = await fetch('/api/node-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: text }),
        });
        const data = await r.json().catch(() => null);
        // A 400 still carries an ANSWER here — `blocked` sends the full result
        // shape, `bad_input` sends only {error, code}. Both are things the
        // operator asked for, so both go through render(); the verdict map is
        // what decides, and render() draws the value rows only when a target
        // was actually dialled. Anything with no mapped code is a genuine
        // transport failure and falls through to the toast-style error, the
        // same way /proof handles !r.ok.
        if (data && data.code && VERDICTS[data.code]) { render(out, data, run); return; }
        if (!r.ok || !data) {
          renderError(out, (data && data.error) ||
            (r.status === 429 ? 'Too many checks — wait a moment and try again.'
                              : 'The check could not be made (HTTP ' + r.status + ').'));
          return;
        }
        render(out, data, run);
      } catch {
        renderError(out, 'Could not reach the checker. Check your connection and try again.');
      } finally {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Check'; }
      }
    }

    if (btn) btn.addEventListener('click', () => run());
    if (clear) clear.addEventListener('click', () => {
      input.value = ''; out.hidden = true; out.textContent = ''; input.focus();
    });
    // Every run is an outbound request from this server, so there is no
    // check-as-you-type here: explicit submit only.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); run(); }
    });

    // A ?host= deep link is deliberately absent. It would let a link decide what
    // this server dials on the visitor's behalf the moment the page opens — a
    // one-click SSRF trigger, even with the blocklist doing its job.
  }

  root.NodeCheckUI = { initNodeCheck };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initNodeCheck);
    } else {
      initNodeCheck();
    }
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
