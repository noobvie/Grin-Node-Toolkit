// payout-methods.js — payout-rail registry for the account page.
//
// WHY THIS EXISTS
// Every payout rail (Tor, Slatepack, Goblin/Nostr, and Transporter when it ships) used to
// leak into the account page through the same four scattered places: a hardcoded line in
// syncPayMethod(), an entry in WD_METHOD, two or three entries in WD_STATUS, and a
// special-case inside the pending-strip label. Adding or removing a rail meant hunting all
// four down in a 1,800-line file, and missing one produced a silent wrong label rather than
// an error.
//
// A rail now describes itself ONCE, as an object, and registers here. Removing a rail is
// deleting its <script> tag (plus its own markup block) — nothing in the shared page code
// names it. Nothing here knows what "nostr" or "tor" mean.
//
// LOOKUPS ARE DELIBERATELY FAILURE-TOLERANT. A withdrawal history row keeps its method
// string forever, so a pool that removes a rail still has old rows referencing it. Every
// lookup falls back to the raw string instead of rendering "undefined".
//
// A RAIL DEFINITION
//   key            'nostr'              — matches withdrawals.method server-side
//   label          'Goblin (Nostr)'     — history table's Method column
//   radio          element id of its radio input
//   radioLabel     element id of the wrapping <label> (hidden when the rail is disabled)
//   pane           element id of its payout pane (shown only when its radio is checked)
//   destination    element id of its card in the "Payout destinations" section (optional —
//                  only rails that pay somewhere other than the miner's own address have one)
//   statuses       { withdrawal_status: 'label' } merged into the shared status map
//   rowStatuses    per-rail OVERRIDE of a shared status, applied only to that rail's rows
//                  (Goblin parks in slatepack_pending but "awaiting response" is wrong for it)
//   pendingStatuses{ status: 'label' } for the live pending strip
//   pendingLabel   fn(p) → string|null, wins over pendingStatuses when it returns a string
//   isEnabled      fn(summary) → bool; omit for rails that are always available
//   fallback       true on the ONE rail selected when the chosen rail becomes unavailable.
//                  Only valid on a rail with no isEnabled — a fallback that can itself be
//                  switched off is not a fallback.
//   onSummary      fn(summary, ctx) — render rail-specific state after each account lookup
//   init           fn(host) — wire the rail's own listeners, once, on DOMContentLoaded
(function () {
  'use strict';

  // Rail-agnostic states: owned by the withdrawal scheduler, not by any one transport.
  // 'finalizing' is the brief claim the scheduler holds while it broadcasts — seconds in the
  // normal case. It is deliberately NOT presented as an error: the money is on its way out and
  // the payout can no longer be cancelled, so "settling" is the honest word for it.
  // Keys must be statuses the SCHEDULER actually writes. 'expired' was not one of them — the TTL
  // sweep writes 'slatepack_expired' — so that entry never matched and those rows rendered the raw
  // token. The label now also says what the miner most wants to know: the balance came back.
  var BASE_STATUS = {
    confirmed: 'paid ✓',
    retry_scheduled: 'retrying',
    finalizing: 'settling',
    cancelled: 'cancelled',
    slatepack_expired: 'expired — balance returned'
  };
  var BASE_PENDING = {
    retry_scheduled: 'wallet unreachable — parked for retry',
    finalizing: 'broadcasting to the Grin network — almost done'
  };

  var defs = [];

  function $(id) { return document.getElementById(id); }

  function register(def) {
    if (!def || !def.key) return;
    // Idempotent: a double-registered rail (script tag included twice) replaces rather
    // than duplicating, which would otherwise render two radios for the same method.
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].key === def.key) { defs[i] = def; return; }
    }
    defs.push(def);
  }

  function get(key) {
    for (var i = 0; i < defs.length; i++) if (defs[i].key === key) return defs[i];
    return null;
  }

  function all() { return defs.slice(); }

  // ── Label lookups (withdrawal history table) ──────────────────────────
  function methodLabel(method) {
    var d = get(method);
    return (d && d.label) || method || '—';
  }

  function statusLabel(row) {
    if (!row) return '—';
    var d = get(row.method);
    if (d && d.rowStatuses && d.rowStatuses[row.status]) return d.rowStatuses[row.status];
    if (d && d.statuses && d.statuses[row.status]) return d.statuses[row.status];
    return BASE_STATUS[row.status] || row.status || '—';
  }

  // ── Live pending strip ────────────────────────────────────────────────
  function pendingLabel(p) {
    if (!p) return '';
    var d = get(p.method);
    if (d && typeof d.pendingLabel === 'function') {
      var s = d.pendingLabel(p);
      if (s) return s;
    }
    if (d && d.pendingStatuses && d.pendingStatuses[p.status]) return d.pendingStatuses[p.status];
    return BASE_PENDING[p.status] || p.status;
  }

  // ── Radio ⇄ pane ──────────────────────────────────────────────────────
  function selected() {
    var m = document.querySelector('input[name="acct-pay-method"]:checked');
    return m ? m.value : (defs.length ? defs[0].key : '');
  }

  function sync() {
    var cur = selected();
    defs.forEach(function (d) {
      var pane = d.pane && $(d.pane);
      if (pane) pane.style.display = (d.key === cur) ? '' : 'none';
    });
  }

  // ── Per-lookup render ─────────────────────────────────────────────────
  // Called after every account summary. Toggles each rail's radio + destination card by
  // its own enablement rule, then hands the summary to the rail to render its own state.
  function applySummary(summary, ctx) {
    var anyDestination = false;
    var enabled = [];

    defs.forEach(function (d) {
      var on = (typeof d.isEnabled === 'function') ? !!d.isEnabled(summary) : true;
      if (on) enabled.push(d);

      var lbl = d.radioLabel && $(d.radioLabel);
      if (lbl) lbl.style.display = on ? '' : 'none';

      var card = d.destination && $(d.destination);
      if (card) card.style.display = on ? '' : 'none';
      if (on && d.destination) anyDestination = true;

      var radio = d.radio && $(d.radio);
      if (!on && radio && radio.checked) radio.checked = false;

      if (typeof d.onSummary === 'function') d.onSummary(summary, ctx || {});
    });

    // The destinations section exists only for rails that need one. A pool running just
    // Tor + Slatepack never sees the heading at all.
    var wrap = $('acct-destinations');
    if (wrap) wrap.style.display = anyDestination ? '' : 'none';

    // Exactly one ENABLED radio must end up checked. Both failure modes render identically
    // — a withdraw form with no method pane at all — so neither announces itself on screen:
    // a rail that was checked when the operator turned it off leaves a hidden radio checked,
    // and an empty group leaves none checked.
    //
    // NEVER fall back to defs[0]. Registration order follows <script> tag order, and a
    // self-registering rail file loads BEFORE the page registers its built-ins, so defs[0]
    // is whichever optional rail happens to ship — quite possibly the one just disabled.
    // A rail marks itself `fallback: true` to claim the default instead; that rail must be
    // one that cannot be turned off (no isEnabled), which is why it is Tor and not Goblin.
    var stillChecked = enabled.some(function (d) {
      var r = d.radio && $(d.radio);
      return !!(r && r.checked);
    });
    if (!stillChecked && enabled.length) {
      var pick = null;
      for (var i = 0; i < enabled.length; i++) {
        if (enabled[i].fallback) { pick = enabled[i]; break; }
      }
      if (!pick) pick = enabled[0];
      var radioEl = pick.radio && $(pick.radio);
      if (radioEl) radioEl.checked = true;
    }

    sync();
  }

  // ── One-time wiring ───────────────────────────────────────────────────
  // `host` carries the page helpers a rail needs ($id/setMsg/getProof/…) so a rail module
  // never reaches into account-settings.html's scope by bare identifier. The contract is
  // explicit, which is what makes a rail file deletable without a second thought.
  function init(pageHost) {
    var h = pageHost || {};
    defs.forEach(function (d) {
      var radio = d.radio && $(d.radio);
      if (radio) radio.addEventListener('change', sync);
      if (typeof d.init === 'function') d.init(h);
    });
    sync();
  }

  window.PayoutMethods = {
    register: register,
    get: get,
    all: all,
    methodLabel: methodLabel,
    statusLabel: statusLabel,
    pendingLabel: pendingLabel,
    selected: selected,
    sync: sync,
    applySummary: applySummary,
    init: init
  };
})();
