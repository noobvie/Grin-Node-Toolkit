// payout-goblin.js — the Goblin (Nostr) payout rail for the account page.
//
// SELF-CONTAINED BY DESIGN. Goblin is a third-party rail: it depends on relays we don't run
// and on wallet software the miner installs separately, so it is the rail most likely to be
// changed, disabled or dropped. Everything rail-specific lives here — registration, the
// destination card, the send action, the security-window copy. Removing Goblin entirely is:
//
//   1. delete this file
//   2. delete its <script> tag in account-settings.html
//   3. delete the two marked markup blocks (the radio <label> and the payout pane, plus the
//      destination card in the "Payout destinations" section)
//
// Nothing in the shared page code names "nostr". Old withdrawal rows that used the rail keep
// rendering — payout-methods.js falls back to the raw method string.
//
// WHY A DESTINATION IS SEPARATE FROM A PAYOUT
// Tor pays this address's OWN wallet and a slatepack is encrypted TO this address, so neither
// can send money anywhere else — there is nothing to configure and nothing to steal. Goblin
// pays a USERNAME, which is a different security model: the ownership gate now guards where
// the money goes, not just whether it moves. That is why registering a destination is a
// separate, deliberate act with its own cooldown, and why it lives in its own section rather
// than buried inside the withdraw form.
//
// THE COOLDOWN IS THE UNDO WINDOW. A destination is inert until `active_at`. If someone who
// guessed your gate registers their own Goblin name, re-registering yours evicts theirs and
// restarts the clock — so the attacker never reaches an active state as long as you notice
// within the window. Tor and Slatepack keep working the whole time.
(function () {
  'use strict';

  if (!window.PayoutMethods) return;   // registry missing → rail simply never appears

  var H = null;                         // host helpers, set in init()
  var state = { dest: null, canWithdraw: false };

  function $(id) { return document.getElementById(id); }

  // ── Destination state readout ───────────────────────────────────────────
  // Rendered into the payout pane (not the destination card): it answers "can I press send,
  // and if not, why not" at the moment the miner is looking at the send button.
  function renderState() {
    var stateEl = $('acct-nostr-state');
    var removeBtn = $('acct-nostr-remove');
    var sendBtn = $('acct-nostr-send');
    if (!stateEl || !sendBtn) return;
    // onSummary can only fire after init() in the current page flow, but that is an ordering
    // assumption about a file we don't own. Failing closed (button disabled) beats throwing
    // a TypeError mid-render and leaving the rest of the account page half-drawn.
    if (!H) { sendBtn.disabled = true; return; }

    var d = state.dest;
    if (!d) {
      stateEl.textContent = 'No Goblin destination registered yet — add one under "Payout destinations" below.';
      if (removeBtn) removeBtn.style.display = 'none';
      sendBtn.disabled = true;
      return;
    }
    if (removeBtn) removeBtn.style.display = '';
    if (d.active) {
      stateEl.innerHTML = '✅ Active destination: <b>' + H.escHtml(d.username) + '</b>';
      sendBtn.disabled = !state.canWithdraw;
    } else {
      stateEl.innerHTML = '⏳ <b>' + H.escHtml(d.username) + '</b> — in security cooldown, active at '
        + H.fmtWhen(d.active_at) + '. You can still use Tor or Slatepack meanwhile.';
      sendBtn.disabled = true;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────
  // Registration is the ONLY action on this page that can point money at an address the
  // miner does not own, so it takes its own two proof inputs (IP AND rig password) rather
  // than the page's shared single-proof box. Removal and send keep the shared box: neither
  // can redirect anything.
  function hideConfirm() {
    var box = $('acct-nostr-confirm');
    if (box) box.style.display = 'none';
  }

  async function register(confirmReplace) {
    if (!H.addr()) return;
    var msg = $('acct-nostr-reg-msg');
    if (H.demoBlock(msg)) return;
    var ipProof = ($('acct-nostr-ip-proof').value || '').trim();
    var passProof = $('acct-nostr-pass-proof').value || '';
    var username = ($('acct-nostr-username').value || '').trim();
    if (!username) { H.setMsg(msg, 'Enter your Goblin username.', false); return; }
    if (!ipProof || !passProof) {
      H.setMsg(msg, 'Changing a payout destination needs BOTH proofs — a recent mining IP and your rig password.', false);
      return;
    }
    H.setMsg(msg, 'Resolving + registering…', true);
    try {
      var body = { username: username, ip_proof: ipProof, password_proof: passProof };
      if (confirmReplace) body.confirm_replace = confirmReplace;
      var r = await fetch('/api/account/' + encodeURIComponent(H.addr()) + '/nostr-destination', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body)
      });
      var json = await r.json().catch(function () { return null; });

      // The server refuses an unconfirmed replacement and tells us what would be replaced.
      if (r.status === 409 && json && json.reason === 'confirm_replace_required') {
        var box = $('acct-nostr-confirm');
        var txt = $('acct-nostr-confirm-text');
        if (box && txt) {
          txt.innerHTML = 'Replace <b>' + H.escHtml(json.replacing) + '</b> with <b>'
            + H.escHtml(json.replacing_with) + '</b>?<br>This restarts the security cooldown, and '
            + 'we will message your current destination to warn it.';
          box.dataset.replacing = json.replacing;
          box.style.display = '';
        }
        H.setMsg(msg, 'You already have a destination registered — confirm the change below.', false);
        return;
      }
      hideConfirm();

      if (r.ok && json && json.success) {
        var note = 'Registered ' + json.username + ' — active at ' + H.fmtWhen(json.active_at)
          + ' (a ' + json.cooldown_hours + 'h security cooldown). Payouts to it unlock then.';
        // A warning that never arrived is not a warning — say so rather than imply cover.
        if (json.previous_notified === false) {
          note += ' NOTE: we could not reach your previous destination to warn it — if you did not '
            + 'expect this change, withdraw via Tor or Slatepack now.';
        }
        H.setMsg(msg, note, json.previous_notified !== false);
        $('acct-nostr-pass-proof').value = '';
        H.refresh();
      } else {
        H.setMsg(msg, H.apiErr(json, 'Registration failed'), false);
      }
    } catch (e) { hideConfirm(); H.setMsg(msg, 'Registration failed: ' + e.message, false); }
  }

  async function remove() {
    if (!H.addr()) return;
    var msg = $('acct-nostr-reg-msg');
    if (H.demoBlock(msg)) return;
    var proof = H.getProof(msg);
    if (!proof) return;
    H.setMsg(msg, 'Removing…', true);
    try {
      var r = await fetch('/api/account/' + encodeURIComponent(H.addr()) + '/nostr-destination', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ proof: proof })
      });
      var json = await r.json().catch(function () { return null; });
      if (r.ok && json && json.success) {
        var note = 'Destination removed.';
        if (json.previous_notified === false) {
          note += ' NOTE: we could not reach it to send the confirmation message.';
        }
        H.setMsg(msg, note, true);
        H.refresh();
      }
      else { H.setMsg(msg, H.apiErr(json, 'Remove failed'), false); }
    } catch (e) { H.setMsg(msg, 'Remove failed: ' + e.message, false); }
  }

  async function send() {
    if (!H.addr()) return;
    var msg = $('acct-nostr-send-msg');
    if (H.demoBlock(msg)) return;
    var proof = H.getProof(msg);
    if (!proof) return;
    var amount = H.amountValue(msg);
    if (amount === null) return;
    var btn = $('acct-nostr-send');
    btn.disabled = true;
    H.setMsg(msg, 'Sending to your Goblin wallet over Nostr…', true);
    try {
      var r = await fetch('/api/account/' + encodeURIComponent(H.addr()) + '/withdraw', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ method: 'nostr', amount: amount, proof: proof })
      });
      var json = await r.json().catch(function () { return null; });
      if (r.ok && json && json.success) {
        H.setMsg(msg, 'Payout #' + json.withdrawal_id + ' sent — your Goblin wallet finalizes it '
          + 'automatically when it next comes online.', true);
        H.refresh();
      } else {
        H.setMsg(msg, H.apiErr(json, 'Send failed'), false);
        btn.disabled = false;
      }
    } catch (e) { H.setMsg(msg, 'Send failed: ' + e.message, false); btn.disabled = false; }
  }

  // ── Rail definition ─────────────────────────────────────────────────────
  window.PayoutMethods.register({
    key: 'nostr',
    label: 'Goblin (Nostr)',
    radio: 'acct-pay-nostr',
    radioLabel: 'acct-pay-nostr-label',
    pane: 'acct-pay-nostr-pane',
    destination: 'acct-dest-goblin',

    statuses: {
      nostr_sending: 'sending (Nostr)',
      nostr_failed: 'failed'
    },
    // A Goblin payout deliberately reuses the slatepack state machine server-side (it parks
    // in slatepack_pending), but "awaiting response" is the wrong words for it — nobody is
    // pasting anything back. The Goblin wallet answers on its own.
    rowStatuses: {
      slatepack_pending: 'awaiting your wallet'
    },
    pendingLabel: function (p) {
      return p.status === 'slatepack_pending' ? 'sent to your Goblin wallet — awaiting auto-finalize' : null;
    },

    isEnabled: function (summary) { return !!(summary && summary.nostr_payouts_enabled); },

    onSummary: function (summary, ctx) {
      state.dest = (summary && summary.nostr_destination) || null;
      state.canWithdraw = !!(ctx && ctx.canWithdraw);
      renderState();
    },

    init: function (pageHost) {
      H = pageHost;
      var reg = $('acct-nostr-register'); if (reg) reg.addEventListener('click', function () { register(null); });
      var rem = $('acct-nostr-remove');   if (rem) rem.addEventListener('click', remove);
      var snd = $('acct-nostr-send');     if (snd) snd.addEventListener('click', send);
      // Re-submits with the username being replaced, which the server matches against what it
      // actually holds — so a stale panel (destination changed in another tab meanwhile)
      // fails the check rather than confirming a replacement the miner never saw.
      var yes = $('acct-nostr-confirm-yes');
      if (yes) yes.addEventListener('click', function () {
        var box = $('acct-nostr-confirm');
        register((box && box.dataset.replacing) || '');
      });
      var no = $('acct-nostr-confirm-no');
      if (no) no.addEventListener('click', function () {
        hideConfirm();
        H.setMsg($('acct-nostr-reg-msg'), 'Change cancelled — your destination is unchanged.', true);
      });
    }
  });
})();
