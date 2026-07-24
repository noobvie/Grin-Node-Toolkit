'use strict';

// ── Slate Inspector UI ───────────────────────────────────────────────────────
// Renders the output of SlatepackDecode. Purely presentational: no fetch, no
// keys, no node calls — every fact on screen came out of the pasted text.

(function () {

  const $ = id => document.getElementById(id);
  const input = $('input');
  const out   = $('out');
  const drop  = $('drop');

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Kernel feature codes as used by the node/wallet.
  const KERNEL_FEATURES = {
    0: 'Plain',
    1: 'Coinbase',
    2: 'Height-locked',
    3: 'No-recent-duplicate',
  };

  const STEP_LABELS = {
    standard: ['Offer', 'Receive', 'Finalize'],
    invoice:  ['Request', 'Pay', 'Finalize'],
  };

  function badge(kind, text) {
    return `<span class="sp-badge sp-badge--${kind}">${esc(text)}</span>`;
  }

  function row(label, value) {
    return `<div class="sp-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  }

  function stepRail(flow, step) {
    const labels = STEP_LABELS[flow] || STEP_LABELS.standard;
    const cells = labels.map((label, i) => {
      const n = i + 1;
      const cls = n < step ? 'is-done' : n === step ? 'is-active' : '';
      const mark = n < step ? '&#10003;' : String(n);
      return `<div class="sp-step ${cls}">
                <div class="sp-step-dot">${mark}</div>
                <div class="sp-step-label">${esc(label)}</div>
              </div>`;
    }).join('');
    return `<div class="sp-steps">${cells}</div>`;
  }

  function networkBadge(network) {
    if (network === 'mainnet') return badge('mainnet', 'Mainnet');
    if (network === 'testnet') return badge('testnet', 'Testnet');
    return badge('unknown', 'Network unknown');
  }

  // ── Renderers ──────────────────────────────────────────────────────────────

  function renderError(message) {
    out.hidden = false;
    out.innerHTML = `
      <div class="sp-panel sp-panel--alert">
        <div class="sp-panel-label">Could not read this</div>
        <p class="sp-error-title">Not a readable slatepack</p>
        <p class="sp-error-body">${esc(message)}</p>
      </div>`;
  }

  function renderEncrypted(r) {
    out.hidden = false;
    out.innerHTML = `
      <div class="sp-panel sp-panel--locked">
        <div class="sp-panel-label">Encrypted slatepack</div>
        <p class="sp-locked-title">&#128274; Sealed to the recipient</p>
        <p class="sp-locked-body">
          This slatepack is encrypted. The sender's address, the amount, and the transaction step
          are all inside the encrypted payload — only the wallet holding the recipient's key can
          open it. That is the format working as intended, not an error.
        </p>
        <p class="sp-locked-body" style="margin-top:12px">
          To read it, receive it in the wallet it was addressed to. If you expected a readable
          slate, ask the sender to produce one with <code>grin-wallet send</code> <em>without</em>
          a <code>-d</code> destination.
        </p>
      </div>
      <div class="sp-panel">
        <div class="sp-panel-label">What is still visible</div>
        <dl class="sp-rows">
          ${row('Slatepack version', esc(r.slatepackVersion))}
          ${row('Mode', '1 &mdash; age-encrypted')}
          ${row('Encrypted payload', esc(r.payloadBytes.toLocaleString()) + ' bytes')}
          ${row('Checksum', r.checksumOk === true
              ? '<span style="color:var(--sp-green)">valid</span>'
              : '<span class="sp-mute">not verified</span>')}
        </dl>
      </div>`;
  }

  function renderSlate(r) {
    const s = r.slate;
    const g = s.guide;
    const isFinal = s.state === 'S3' || s.state === 'I3';

    const flowLabel = s.flow === 'invoice' ? 'Invoice flow' : 'Standard flow';
    const badges = [
      networkBadge(r.network),
      badge('flow', `${flowLabel} &middot; ${s.state}`),
    ].join('');

    // A missing/unverifiable sender means we genuinely cannot say which chain
    // this belongs to — say so rather than implying mainnet by omission.
    const netWarn = r.network === 'unknown' ? `
      <div class="sp-warn">
        <strong>Network could not be determined.</strong> This slate carries no sender address, so
        there is no way to tell whether it is mainnet or testnet. A slate itself has no network
        field — signing a slate from the wrong network succeeds, and only fails at broadcast.
      </div>` : '';

    const feeNote = s.feeShift ? ` <span class="sp-mute">(fee shift ${s.feeShift})</span>` : '';
    const featName = KERNEL_FEATURES[s.kernelFeatures] || `Unknown (${s.kernelFeatures})`;

    out.hidden = false;
    out.innerHTML = `
      <div class="sp-panel">
        <div class="sp-panel-label">What this slatepack says</div>
        <div class="sp-verdict-top">${badges}</div>

        <div class="sp-amount">
          <span class="sp-amount-value">${esc(s.amountGrin)}</span>
          <span class="sp-amount-unit">${r.network === 'testnet' ? 'tGRIN' : 'GRIN'}</span>
        </div>
        <div class="sp-amount-sub">
          fee ${esc(s.feeGrin)} ${r.network === 'testnet' ? 'tGRIN' : 'GRIN'}${feeNote}
          &nbsp;&#183;&nbsp; ${esc(s.amount.toString())} nanogrin
        </div>

        <h2 class="sp-headline">${esc(g.title)}</h2>
        <p class="sp-says">${esc(g.says)}</p>

        ${g.step ? stepRail(s.flow, g.step) : ''}

        <div class="sp-next">
          <div class="sp-next-label">${isFinal ? 'Status' : 'Your next move'}</div>
          <p>${esc(g.next)}</p>
        </div>

        ${netWarn}
      </div>

      <div class="sp-panel">
        <div class="sp-panel-label">Details</div>
        <dl class="sp-rows">
          ${row('Transaction step', `${esc(s.state)} &mdash; ${esc(s.stateLabel)}`)}
          ${row('Flow', esc(s.flow === 'invoice' ? 'Invoice (receiver initiated)' : 'Standard (sender initiated)'))}
          ${row('Amount', `${esc(s.amountGrin)} <span class="sp-mute">(${esc(s.amount.toString())} nanogrin)</span>`)}
          ${row('Fee', `${esc(s.feeGrin)} <span class="sp-mute">(${esc(s.fee.toString())} nanogrin)</span>`)}
          ${row('Slate ID', `<code>${esc(s.id)}</code>`)}
          ${row('Participants', esc(s.numParts))}
          ${row('Kernel features', esc(featName))}
          ${s.ttlCutoffHeight && s.ttlCutoffHeight > 0n
              ? row('TTL cutoff height', esc(s.ttlCutoffHeight.toString())) : ''}
          ${row('Sender address', r.sender
              ? `<code>${esc(r.sender)}</code>${r.senderValid ? '' : ' <span class="sp-mute">(checksum invalid)</span>'}`
              : '<span class="sp-mute">not included</span>')}
          ${row('Network', esc(r.network === 'unknown' ? 'unknown — no sender address' : r.network)
              + (r.hrp ? ` <span class="sp-mute">(prefix "${esc(r.hrp)}")</span>` : ''))}
          ${row('Slate version', esc(s.slateVersion))}
          ${row('Slatepack version', esc(r.slatepackVersion))}
          ${row('Checksum', r.checksumOk === true
              ? '<span style="color:var(--sp-green)">valid</span>'
              : '<span class="sp-mute">not verified (needs a secure context)</span>')}
        </dl>
      </div>`;
  }

  function renderPartial(r) {
    // Envelope read fine but the slate body did not parse — show what we trust
    // and be explicit about what failed, rather than pretending the whole thing
    // is unreadable.
    out.hidden = false;
    out.innerHTML = `
      <div class="sp-panel sp-panel--alert">
        <div class="sp-panel-label">Partially readable</div>
        <p class="sp-error-title">The envelope opened, the slate did not</p>
        <p class="sp-error-body">
          This is a valid slatepack, but its inner slate could not be parsed — it may use a newer
          slate version than this page understands. Reason: ${esc(r.slateError || 'unknown')}
        </p>
      </div>
      <div class="sp-panel">
        <div class="sp-panel-label">What is still readable</div>
        <div class="sp-verdict-top">${networkBadge(r.network)}</div>
        <dl class="sp-rows">
          ${row('Sender address', r.sender ? `<code>${esc(r.sender)}</code>` : '<span class="sp-mute">not included</span>')}
          ${row('Network', esc(r.network))}
          ${row('Slatepack version', esc(r.slatepackVersion))}
          ${row('Payload', esc(r.payloadBytes.toLocaleString()) + ' bytes')}
        </dl>
      </div>`;
  }

  // ── Drive ──────────────────────────────────────────────────────────────────

  async function inspect() {
    const text = input.value.trim();
    if (!text) { out.hidden = true; out.innerHTML = ''; return; }
    try {
      const r = await window.SlatepackDecode.decodeSlatepack(text);
      if (r.encrypted)        renderEncrypted(r);
      else if (r.slateError)  renderPartial(r);
      else                    renderSlate(r);
    } catch (e) {
      renderError(e && e.message ? e.message : String(e));
    }
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('btn-decode').addEventListener('click', inspect);
  $('btn-clear').addEventListener('click', () => {
    input.value = '';
    out.hidden = true;
    out.innerHTML = '';
    input.focus();
  });

  // Pasting a slatepack is the overwhelmingly common action — just decode it.
  input.addEventListener('paste', () => setTimeout(inspect, 0));

  // Ctrl/Cmd+Enter from the textarea.
  input.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); inspect(); }
  });

  // ── File drop (anywhere on the page) ───────────────────────────────────────

  function readFile(file) {
    const reader = new FileReader();
    reader.onload = () => { input.value = String(reader.result || ''); inspect(); };
    reader.onerror = () => renderError('Could not read that file.');
    reader.readAsText(file);
  }

  ['dragenter', 'dragover'].forEach(ev =>
    document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    document.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'drop' || e.target === document || !e.relatedTarget) drop.classList.remove('is-over');
    }));
  document.addEventListener('drop', e => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) { readFile(file); return; }
    const text = e.dataTransfer && e.dataTransfer.getData('text');
    if (text) { input.value = text; inspect(); }
  });

  // ── Deep link: /slate?s=<armored> ──────────────────────────────────────────
  // Handy for sharing an inspection, and lets the explorer's search box route a
  // pasted slatepack straight here.
  try {
    const q = new URLSearchParams(location.search).get('s');
    if (q) { input.value = q; inspect(); }
  } catch { /* no-op */ }

  // The footer itself is static markup (it must survive a JS failure); only the
  // version tag is server-supplied, so that is all we fill in here.
  const footVer = document.getElementById('foot-ver');
  if (footVer && window.TINYEXP_VERSION) {
    footVer.textContent = ' v' + window.TINYEXP_VERSION;
  }

})();
