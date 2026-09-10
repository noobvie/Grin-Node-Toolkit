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
// Third rule, and the reason this page has TWO legs: THE API LEG IS NOT THE
// VERDICT. 3413 is what a wallet dials; 3414 is what the network dials. A node
// that peers perfectly and deliberately keeps its API off the internet is a
// correct configuration, and drawing it as a red ✕ — which is what a
// single-leg check did — is the worst answer this tool can give. So the banner
// is COMPOSED from both legs, and two of the four combinations are neither a
// pass nor a fail: they are configurations, and they are worded as such.
//
// Fourth rule: THE P2P LEG SAYS "PORT OPEN", NEVER "NODE REACHABLE". It is a
// bare TCP connect that sends nothing. This page tells the reader two boxes
// further down that an HTTP 200 proves nothing; a bare accept is weaker
// evidence than that, and the label must not claim more than the probe did.
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

  // ── The two legs ──────────────────────────────────────────────────────
  //
  // Each leg carries a one-word status of its own, because the combined banner
  // deliberately does not name which half failed — that is this block's job.

  // The API leg, keyed by the same code the banner uses.
  const API_LEG = {
    ok:           { mark: '✓', cls: 'is-ok',   label: 'Answered get_tip' },
    refused:      { mark: '✕', cls: 'is-bad',  label: 'Refused' },
    timeout:      { mark: '✕', cls: 'is-bad',  label: 'Filtered' },
    unreachable:  { mark: '✕', cls: 'is-bad',  label: 'No route' },
    reset:        { mark: '✕', cls: 'is-bad',  label: 'Connection reset' },
    dns_failed:   { mark: '✕', cls: 'is-bad',  label: 'No DNS record' },
    tls_error:    { mark: '✕', cls: 'is-bad',  label: 'TLS handshake failed' },
    http_status:  { mark: '!',      cls: 'is-skip', label: 'Not a node reply' },
    not_json_rpc: { mark: '!',      cls: 'is-skip', label: 'Not a Grin node' },
    node_error:   { mark: '!',      cls: 'is-skip', label: 'Node error' },
  };

  // The P2P leg. `open` is the one to read carefully: a completed TCP handshake
  // is ALL it means. Never relabel this "node reachable" — see rule four above.
  const P2P_LEG = {
    open:        { mark: '✓', cls: 'is-ok',   label: 'Port open' },
    refused:     { mark: '✕', cls: 'is-bad',  label: 'Refused' },
    filtered:    { mark: '✕', cls: 'is-bad',  label: 'Filtered' },
    unreachable: { mark: '✕', cls: 'is-bad',  label: 'No route' },
    error:       { mark: '!',      cls: 'is-skip', label: 'Not checked' },
  };

  // The API codes where BYTES CAME BACK. Every one of these means the port is
  // open and something is serving it — the check failed on what was said, not on
  // whether anything said it. `ok` is in the set for completeness; the callers
  // that read it have already branched on reachable.
  const API_ANSWERED = { ok: 1, http_status: 1, not_json_rpc: 1, node_error: 1 };

  // The four-way banner. Two of these are CONFIGURATIONS, not failures, and
  // they carry ⓘ rather than ✓/✕ so the mark itself stops short of a
  // judgement — greyscale-readable, like every other verdict on this site.
  function composeVerdict(res) {
    const p = res && res.p2p;
    if (!p) return null;                    // nothing dialled — single-leg path
    const apiOk   = !!res.reachable;
    const p2pOpen = p.state === 'open';
    const port    = p.port;

    if (apiOk && p2pOpen) return {
      cls: 'is-ok', mark: '✓',
      text: 'Reachable both ways — wallets can call the API, and peers can connect on ' + port + '.',
    };
    if (apiOk && !p2pOpen) return {
      cls: 'is-warn', mark: 'ⓘ',
      text: 'Reachable for wallets — but nothing accepted a peer connection on ' + port + '.',
      note: 'That is a complete answer for a node published to serve wallets. It does mean this '
          + 'node takes no INBOUND peers: it can still dial out and sync, but the rest of the '
          + 'network cannot start a connection to it. Forward TCP ' + port + ' if you want it to.',
    };
    // THREE failures, three sentences. "Did not answer" is only true when
    // nothing came back at all — a 403 or a parked page means the port is OPEN
    // and serving, and a TLS error means the connection WAS made and only the
    // handshake failed. Collapsing all three into "did not answer" is how an
    // operator spends an hour in ufw while the actual problem is nginx, or a
    // missing certificate, or a web server squatting the port.
    const answered = !!API_ANSWERED[res.code];   // bytes came back, wrong shape
    const tlsFail  = res.code === 'tls_error';   // connected, handshake failed

    const apiClause = answered ? 'the API port answered with something that is not a Grin node'
                    : tlsFail  ? 'the API port accepted the connection and then failed the TLS handshake'
                    :            'the wallet API did not answer';

    const apiNote = answered
      ? 'The port is open and something is serving it, so this is not a firewall problem. '
      + 'Check what is bound to that port, and that you pointed this at the node rather than '
      + 'at a web server in front of it.'
      : tlsFail
      ? 'The port is open, so this is not a firewall problem either — it is a TLS one. A node '
      + 'with no nginx front and no certificate looks exactly like this when it is dialled over '
      + 'HTTPS; so does a certificate that does not match the name you typed.'
      : 'This is often deliberate, and it is the safer half to leave closed: a node that only '
      + 'peers does not need its API on the internet at all. Publish /v2/foreign only if you '
      + 'actually want wallets to use this node.';

    if (!apiOk && p2pOpen) return {
      cls: 'is-warn', mark: 'ⓘ',
      text: 'Peers can connect on ' + port + ' — but ' + apiClause + '.',
      note: apiNote,
    };
    return {
      cls: 'is-bad', mark: '✕',
      text: (answered || tlsFail)
        ? 'Not usable — the P2P port on ' + port + ' did not answer, and ' + apiClause + '.'
        : 'Not reachable — neither the wallet API nor the P2P port on ' + port + ' answered.',
      note: (answered || tlsFail) ? apiNote : null,
    };
  }

  // Both hedges exist because a confident-looking ✕ on the P2P leg can be an
  // artefact of what we ASSUMED, rather than a fact about the operator's node.
  function p2pCaveats(res) {
    const out = [];
    const p = res.p2p;
    if (!p || p.state === 'open') return out;
    if (p.source === 'default') {
      out.push('Port ' + p.port + ' was assumed (mainnet), because you gave no port and left the '
             + 'network on Auto. If this is a testnet node, switch to Testnet and check again — '
             + 'its P2P port is 13414.');
    }
    if (res.scheme === 'https' && res.port === 443) {
      out.push('You checked the API over TLS on 443, which usually means an nginx front. The P2P '
             + 'probe went to the same NAME — if that name points at a proxy or CDN rather than '
             + 'the node’s own box, this result describes the proxy, not your node.');
    }
    return out;
  }

  // One row of the two-leg block. Same markup the Payment Proof checks use, so
  // a "not checked" row looks the same everywhere on this site.
  function legRow(name, spec, detail) {
    const r = el('div', 'tx-pf-check');
    r.appendChild(el('span', 'tx-pf-mark ' + spec.cls, spec.mark));
    r.appendChild(el('span', 'tx-pf-check-name', name));
    const note = el('span', 'tx-pf-check-note');
    note.appendChild(el('b', null, spec.label));
    if (detail) {
      note.appendChild(document.createElement('br'));
      note.appendChild(document.createTextNode(detail));
    }
    r.appendChild(note);
    return r;
  }

  // The codes where "try plain HTTP on 3413 instead" is a real diagnosis, as an
  // ALLOWLIST rather than a blocklist. A blocklist was wrong twice over — it
  // had to enumerate every code that must stay silent, and it silently opted in
  // any code added later.
  //
  // ⚠ THIS LIST GREW WHEN THE DEFAULT FLIPPED (2026-09-10). It used to hold
  // refused + timeout only, because the assumed endpoint was a bare PORT (3413)
  // and those were the only two ways a port itself dead-ends. The assumed
  // endpoint is now https://name:443, which is a port AND a protocol AND a
  // certificate — so there are three more ways for the assumption to be wrong,
  // and every one of them means the same thing: the node is probably sitting on
  // its own port with no front.
  //
  //   · refused      — nothing is listening on 443 at all
  //   · timeout      — packets to 443 are being dropped, i.e. filtered
  //   · tls_error    — 443 answered but does not speak TLS, or the certificate
  //                    does not verify. For a name with no nginx front this is
  //                    now the single likeliest failure on the page.
  //   · http_status  — a web server answered 404/403/parked. Something owns 443,
  //                    but it is not publishing a node there.
  //   · not_json_rpc — a website answered 200. Same conclusion.
  //
  // Excluded, and each for its own reason:
  //   · node_error   — it IS a Grin node, just unable to give a tip. Sending the
  //                    operator to another port contradicts the banner above it.
  //   · dns_failed / unreachable — name- and host-level, so 3413 fails
  //                    identically. A retry that cannot succeed is a dead end
  //                    dressed as a fix.
  //   · reset        — something was mid-answer when the connection died. Too
  //                    ambiguous to advise on; staying silent is the honest move.
  //   · blocked / bad_input / busy — nothing was dialled, so there is no
  //                    assumption to correct.
  const SUGGEST_OK = { refused: 1, timeout: 1, tls_error: 1, http_status: 1, not_json_rpc: 1 };

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

    // When both legs ran, the headline is composed from the PAIR and the API
    // leg's own sentence moves down into the two-leg block. Announcing one
    // half's result as the whole answer is precisely the bug the second leg
    // exists to fix, so `both` wins over the single-code verdict whenever the
    // server actually dialled a P2P port.
    const both = composeVerdict(res);
    const head = both || verdict;

    const banner = el('div', 'tx-wc-verdict ' + head.cls);
    banner.appendChild(el('span', 'tx-wc-mark', head.mark));
    const txt = el('span', 'tx-wc-verdict-text');
    txt.appendChild(el('b', null, head.text));
    // `reason` on a result, `error` on a refusal — the route names the field
    // differently either side of the 400, and the sentence is the whole value
    // of a refusal ("Remove the credentials from that URL"). With both legs the
    // per-leg sentences live in the block below, so the banner's second line is
    // the composed guidance instead — and may be absent entirely.
    const detail = both ? both.note : (res.reason || res.error);
    if (detail) {
      txt.appendChild(document.createElement('br'));
      txt.appendChild(document.createTextNode(detail));
    }
    banner.appendChild(txt);
    out.appendChild(banner);

    // The two legs, always both, always in this order — a missing row would
    // read as a check that passed.
    if (both) {
      const p       = res.p2p;
      const legs    = el('div', 'tx-pf-checks');
      const apiSpec = API_LEG[res.code] || (res.reachable ? API_LEG.ok : API_LEG.unreachable);
      const p2pSpec = P2P_LEG[p.state]  || P2P_LEG.error;

      legs.appendChild(legRow('Wallet API · ' + res.port, apiSpec, res.reason || res.error || ''));

      let p2pDetail = p.reason || '';
      if (p.same_port) {
        p2pDetail += ' You aimed the API check at this same port, so it was measured once, '
                   + 'not dialled twice.';
      }
      legs.appendChild(legRow('P2P · ' + p.port + ' (' + p.network + ')', p2pSpec, p2pDetail));
      out.appendChild(legs);

      // A ✕ on the P2P leg can be an artefact of a port WE assumed, or of a name
      // that fronts a proxy rather than the node. Say so next to the ✕, not in a
      // collapsed section further down.
      p2pCaveats(res).forEach(c => {
        const n = el('div', 'tx-note');
        n.textContent = c;
        out.appendChild(n);
      });
    }

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
      s.appendChild(el('strong', null, 'Is your node on its own port, without nginx in front?'));
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

    // Which P2P port to dial. 'auto' lets the server derive it from a port the
    // visitor typed themselves; the two explicit values are how someone with a
    // bare host name says "this is a testnet node". Read at submit time, never
    // cached — and a missing control degrades to 'auto' rather than throwing,
    // because the API leg does not depend on it.
    function currentNetwork() {
      const picked = document.querySelector('input[name="nc-net"]:checked');
      return (picked && picked.value) || 'auto';
    }

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
          body: JSON.stringify({ target: text, network: currentNetwork() }),
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
