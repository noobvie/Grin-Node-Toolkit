// faucet.js — Grin Drop claim flow + donation tabs + live stats
// =============================================================================

const REFRESH_SEC = 300; // 5 minutes — single shared poll

// ── Cloudflare Turnstile (optional — injected by nginx if CF_TURNSTILE_KEY is configured) ──
let _tsWidgetAddr = null;  // widget id for address-based claim pane
let _tsWidgetAnon = null;  // widget id for anonymous claim pane
let _tsCbAddr     = null;  // pending resolve callback for address widget
let _tsCbAnon     = null;  // pending resolve callback for anon widget

(function () {
  const key = window.CF_TURNSTILE_KEY;
  if (!key || !key.startsWith('0x')) return;  // Turnstile site keys start with 0x
  const s = document.createElement('script');
  s.src   = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.defer = true;
  s.onload = function () {
    _tsWidgetAddr = turnstile.render('#cf-turnstile-addr', {
      sitekey: key, execution: 'execute', appearance: 'interaction-only',
      callback:         function (t) { if (_tsCbAddr) { _tsCbAddr(t);  _tsCbAddr = null; } },
      'error-callback': function ()  { if (_tsCbAddr) { _tsCbAddr(''); _tsCbAddr = null; } },
    });
    _tsWidgetAnon = turnstile.render('#cf-turnstile-anon', {
      sitekey: key, execution: 'execute', appearance: 'interaction-only',
      callback:         function (t) { if (_tsCbAnon) { _tsCbAnon(t);  _tsCbAnon = null; } },
      'error-callback': function ()  { if (_tsCbAnon) { _tsCbAnon(''); _tsCbAnon = null; } },
    });
  };
  document.head.appendChild(s);
})();

// Returns a Promise resolving to a token string (or '' if Turnstile not active).
// cbSetter receives the resolve fn so the render-time callback can trigger it.
function getTurnstileToken(widgetId, cbSetter) {
  if (!widgetId || typeof turnstile === 'undefined') return Promise.resolve('');
  return new Promise(function (resolve) {
    cbSetter(resolve);
    turnstile.execute(widgetId);
  });
}

function resetTurnstile(widgetId) {
  if (widgetId && typeof turnstile !== 'undefined') turnstile.reset(widgetId);
}

// ── GA4 analytics (optional — injected by nginx if GA4_ID is configured) ──────
(function () {
  const id = window.GA4_ID;
  if (!id || !id.startsWith('G-')) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id);
})();

function trackEvent(name, params) {
  if (typeof window.gtag !== 'function') return;
  window.gtag('event', name, Object.assign({ network: window.DROP_NETWORK || 'unknown' }, params));
}

// ── Network context (injected by nginx sub_filter) ────────────────────────────
const API      = window.APP_BASE  || '';
const COIN     = window.DROP_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';
const NET_FLAG = window.DROP_NETWORK === 'testnet' ? '--testnet ' : '';
const ADDR_PFX = window.DROP_NETWORK === 'testnet' ? 'tgrin1' : 'grin1';

// ── State ─────────────────────────────────────────────────────────────────────
let _claimId          = null;
let _claimAmount      = null;   // null = use server max; number = override
let _claimAnonAmount  = null;   // null = use ANON_CLAIM_AMOUNT; number = override
let _activeClaimPane  = 'addr'; // 'addr' | 'anon' — tracks which claim tab is open
let _countdown        = null;
let _invoiceId        = null;
let _donateWalletAddr = '';

// Claim amount presets — smaller on mainnet to conserve real GRIN
const CLAIM_AMOUNTS   = window.DROP_NETWORK === 'mainnet'
  ? [0.002, 0.006, 0.008]
  : [0.1,   0.2,   0.5];
const ANON_CLAIM_AMOUNT  = window.DROP_NETWORK === 'mainnet' ? 0.005 : 2.0;
const ANON_CLAIM_AMOUNTS = window.DROP_NETWORK === 'mainnet'
  ? [0.001, 0.003, 0.005]
  : [0.5,   1.0,   2.0];
const CLAIM_CUSTOM_MIN = window.DROP_NETWORK === 'mainnet' ? 0.0001 : 0.001;
const CLAIM_CUSTOM_MAX = window.DROP_NETWORK === 'mainnet' ? 0.008  : 3.0;
const ANON_CUSTOM_MAX  = window.DROP_NETWORK === 'mainnet' ? 0.008  : ANON_CLAIM_AMOUNT;

// ── Session storage helpers (survive page refresh within same tab) ────────────
function clearClaimSession() {
  sessionStorage.removeItem('grin_drop_claim_id');
  sessionStorage.removeItem('grin_drop_slatepack');
  sessionStorage.removeItem('grin_drop_expires_at');
}

function clearDonateRcvSession() {
  sessionStorage.removeItem('grin_drop_donate_rcv_sp');
}

function clearDonateInvSession() {
  sessionStorage.removeItem('grin_drop_invoice_id');
  sessionStorage.removeItem('grin_drop_invoice_sp');
  sessionStorage.removeItem('grin_drop_invoice_exp');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function show(id)   { const el = $(id); if (el) el.style.display = ""; }
function hide(id)   { const el = $(id); if (el) el.style.display = "none"; }


async function apiPost(path, body, timeoutMs) {
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
    return json;
  } catch (e) {
    if (e.name === "AbortError") {
      const te = new Error("Request timed out");
      te.timedOut = true;
      throw te;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Copy helper ───────────────────────────────────────────────────────────────
function copyText(text, btnId) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = $(btnId);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  });
}

// ── Maintenance overlay ───────────────────────────────────────────────────────
function showMaintenanceOverlay(dropName, message) {
  const overlay = $("maintenance-overlay");
  if (!overlay) return;
  const titleEl = $("maintenance-title");
  const msgEl   = $("maintenance-msg");
  if (titleEl && dropName) titleEl.textContent = dropName;
  if (msgEl && message)    msgEl.textContent   = message;
  overlay.style.display = "flex";
}

// ── Shared status refresh (stats bar + donate badge) ──────────────────────────
// Single poll — replaces separate loadStats + checkDonateWalletStatus timers.
async function refreshStatus() {
  const addrInput = $("claim-address");
  const addrParam = addrInput && addrInput.value.trim()
    ? "?addr=" + encodeURIComponent(addrInput.value.trim())
    : "";
  const badge = $("donate-wallet-status");
  try {
    const data = await apiGet(API + "/api/status" + addrParam);

    if (data.maintenance_mode) {
      showMaintenanceOverlay(data.drop_name, data.maintenance_message);
      return;
    }

    const giveawaySection = $("section-giveaway");
    if (giveawaySection) {
      giveawaySection.style.display = (data.giveaway_enabled === false) ? "none" : "";
    }

    const donationSection = $("section-donation");
    if (donationSection) {
      donationSection.style.display = (data.donation_enabled === false) ? "none" : "";
    }

    setText("stat-balance", (data.low_balance ? '⚠ ' : '') + formatGrin(data.wallet_balance));
    const balEl = $('stat-balance');
    if (balEl) balEl.classList.toggle('stat-value--warn', !!data.low_balance);
    setText("stat-today",            String(data.claims_today));
    setText("stat-donations-today",  String(data.donations_today  ?? 0));
    setText("stat-total",            String(data.claims_total));
    setText("stat-donations-total",  String(data.donations_total  ?? 0));

    // Cap warnings
    const capWarn = $("claim-cap-warning");
    if (capWarn) {
      if (data.hourly_cap_reached) {
        capWarn.style.display = '';
        capWarn.textContent   = '⚠ Hourly claim limit reached — please try again in a few minutes.';
      } else if (data.daily_cap_reached) {
        capWarn.style.display = '';
        capWarn.textContent   = '⚠ Daily claim limit reached — please try again tomorrow.';
      } else {
        capWarn.style.display = 'none';
        capWarn.textContent   = '';
      }
    }

    if (data.show_public_stats) {
      if (typeof data.total_given !== "undefined") {
        setText("stat-total-given", formatGrinShort(data.total_given));
        const givenItem = $("stat-item-given");
        if (givenItem) givenItem.style.display = "";
      }
      if (typeof data.total_received !== "undefined") {
        setText("stat-total-received", formatGrinShort(data.total_received));
        const receivedItem = $("stat-item-received");
        if (receivedItem) receivedItem.style.display = "";
      }
    } else {
      const gi = $("stat-item-given");
      const ri = $("stat-item-received");
      if (gi) gi.style.display = "none";
      if (ri) ri.style.display = "none";
    }

    if (data.next_claim_at) {
      const dt   = new Date(data.next_claim_at);
      const diff = Math.max(0, Math.round((dt - Date.now()) / 1000));
      const h    = Math.floor(diff / 3600);
      const m    = Math.floor((diff % 3600) / 60);
      setText("stat-next", h > 0 ? `${h}h ${m}m` : `${m}m`);
    } else {
      setText("stat-next", "Available now");
    }

    // ── Donate badge + address/balance ──
    if (badge) {
      const addr = data.wallet_address || "";
      _donateWalletAddr = addr;
      const addrEl = $("donate-address");
      if (addrEl) addrEl.textContent = addr || "Not configured";
      const balEl = $("donate-balance");
      if (balEl) balEl.textContent = formatGrin(data.wallet_balance);
      _updateSendCmd();
      if (addr) {
        badge.className = "ok";
        badge.innerHTML = `<span class="ws-dot"></span> Wallet online — giveaways active &nbsp;·&nbsp; accepting donations`;
      } else {
        badge.className = "error";
        badge.innerHTML = '<span class="ws-dot"></span> Wallet address not configured';
      }
    }
  } catch {
    if (badge) {
      badge.className = "error";
      badge.innerHTML = '<span class="ws-dot"></span> Wallet offline — giveaways &amp; donations unavailable';
    }
  }
}

function formatGrin(n) {
  if (n === null || n === undefined) return "— " + COIN;
  const v = typeof n === "number" ? n : parseFloat(n) || 0;
  return v.toFixed(v > 0 && v < 0.001 ? 4 : 3) + " " + COIN;
}

function formatGrinShort(n) {
  const v = typeof n === "number" ? n : parseFloat(n) || 0;
  return v.toFixed(2) + " " + COIN;
}

// ── Countdown timer (5-min window) ────────────────────────────────────────────
function startCountdown(expiresIso) {
  stopCountdown();
  const el = $("slatepack-countdown");
  function tick() {
    const left = Math.max(0, Math.round((new Date(expiresIso) - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = left % 60;
    if (el) el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
    if (left <= 0) {
      stopCountdown();
      if (el) el.textContent = "Expired";
      clearClaimSession();
      showError("claim-error", "The claim window has expired. Please start a new claim.");
      setStep(1);
    }
  }
  tick();
  _countdown = setInterval(tick, 1000);
}

function stopCountdown() {
  if (_countdown) { clearInterval(_countdown); _countdown = null; }
}

// ── Step management (claim flow) ──────────────────────────────────────────────
function setStep(n) {
  [1, 2, 3].forEach(i => {
    const el = $("step-" + i);
    if (el) el.style.display = i === n ? "block" : "none";
  });
  if (n !== 2) stopCountdown();
}

function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

function clearError(id) { showError(id, ""); }

// Force-clamp an <input> field to at most 3 decimal places in-place.
function _clamp3dec(el) {
  if (!el) return;
  const dot = el.value.indexOf('.');
  if (dot !== -1 && el.value.length - dot > 4) {
    el.value = el.value.slice(0, dot + 4);
  }
}

// Force-clamp an <input> field to at most 4 decimal places in-place.
function _clamp4dec(el) {
  if (!el) return;
  const dot = el.value.indexOf('.');
  if (dot !== -1 && el.value.length - dot > 5) {
    el.value = el.value.slice(0, dot + 5);
  }
}

// ── Address prefix validation ─────────────────────────────────────────────────
// Minimum full address length = prefix (5-6) + 40 alphanumeric chars = 45-46
const ADDR_MIN_LEN = ADDR_PFX.length + 40;

function _validateAddrPrefix(addr, errorId) {
  if (!addr) return true;
  const net = window.DROP_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
  if (!addr.startsWith(ADDR_PFX)) {
    showError(errorId, `Invalid address — ${net} addresses start with ${ADDR_PFX}`);
    return false;
  }
  if (addr.length < ADDR_MIN_LEN) {
    showError(errorId, `Address too short — ${net} addresses are at least ${ADDR_MIN_LEN} characters`);
    return false;
  }
  clearError(errorId);
  return true;
}

// ── Claim amount buttons ──────────────────────────────────────────────────────
function _initClaimAmountButtons() {
  document.querySelectorAll("#claim-amount-grid .amount-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#claim-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.amount === "custom") {
        show("claim-custom-wrap");
        const v = parseFloat($("claim-custom-amt")?.value);
        _claimAmount = (v >= CLAIM_CUSTOM_MIN && v <= CLAIM_CUSTOM_MAX) ? parseFloat(v.toFixed(4)) : null;
      } else {
        hide("claim-custom-wrap");
        _claimAmount = parseFloat(btn.dataset.amount);
      }
    });
  });
  $("claim-custom-amt")?.addEventListener("input", () => {
    const el = $("claim-custom-amt");
    _clamp4dec(el);
    const v = parseFloat(el?.value);
    _claimAmount = (v >= CLAIM_CUSTOM_MIN && v <= CLAIM_CUSTOM_MAX) ? parseFloat(v.toFixed(4)) : null;
  });
}

// ── Anon claim amount buttons ─────────────────────────────────────────────────
function _initAnonAmountButtons() {
  document.querySelectorAll("#anon-amount-grid .amount-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#anon-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.amount === "custom") {
        show("anon-custom-wrap");
        const v = parseFloat($("anon-custom-amt")?.value);
        _claimAnonAmount = (v >= CLAIM_CUSTOM_MIN && v <= ANON_CUSTOM_MAX) ? parseFloat(v.toFixed(4)) : null;
      } else {
        hide("anon-custom-wrap");
        _claimAnonAmount = parseFloat(btn.dataset.amount);
      }
    });
  });
  $("anon-custom-amt")?.addEventListener("input", () => {
    const el = $("anon-custom-amt");
    _clamp4dec(el);
    const v = parseFloat(el?.value);
    _claimAnonAmount = (v >= CLAIM_CUSTOM_MIN && v <= ANON_CUSTOM_MAX) ? parseFloat(v.toFixed(4)) : null;
  });
}

// ── Step 1 — Claim ────────────────────────────────────────────────────────────
async function submitClaim() {
  clearError("claim-error");
  const address = ($("claim-address")?.value || "").trim();
  if (!address) { showError("claim-error", "Please enter your Grin address."); return; }
  if (!_validateAddrPrefix(address, "claim-error")) return;

  const btn = $("claim-btn");
  const origBtnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = "Requesting…"; }

  try {
    const tsToken = await getTurnstileToken(_tsWidgetAddr, function (fn) { _tsCbAddr = fn; });
    const claimBody = { grin_address: address };
    if (_claimAmount !== null) claimBody.amount = _claimAmount;
    if (tsToken) claimBody.cf_token = tsToken;
    const data = await apiPost(API + "/api/claim", claimBody);
    _claimId = data.claim_id;
    trackEvent('claim_started', { method: 'address', amount: _claimAmount });

    const sp = $("slatepack-text");
    if (sp) sp.textContent = data.slatepack;
    sessionStorage.setItem('grin_drop_claim_id',   String(data.claim_id));
    sessionStorage.setItem('grin_drop_slatepack',  data.slatepack);
    sessionStorage.setItem('grin_drop_expires_at', data.expires_at);
    startCountdown(data.expires_at);
    setStep(2);
    refreshStatus();
  } catch (err) {
    resetTurnstile(_tsWidgetAddr);
    if (err.status === 429) {
      trackEvent('claim_rate_limited', { method: 'address' });
      showError("claim-error", "You already claimed recently. " + err.message);
    } else {
      trackEvent('claim_error', { method: 'address' });
      showError("claim-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origBtnText || "Claim GRIN"; }
  }
}

// ── Step 3 — Finalize ─────────────────────────────────────────────────────────
async function submitFinalize() {
  clearError("finalize-error");
  const response = ($("response-slate")?.value || "").trim();
  if (!response) { showError("finalize-error", "Please paste your response slatepack."); return; }
  if (!_claimId)  { showError("finalize-error", "No active claim. Please start again."); return; }

  const btn = $("finalize-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Finalizing…"; }

  try {
    const data = await apiPost(API + "/api/finalize", {
      claim_id:       _claimId,
      response_slate: response,
    });
    stopCountdown();
    clearClaimSession();
    trackEvent('claim_success', { amount: data.amount });
    setText("confirm-tx-id",  data.tx_slate_id || "(not available)");
    setText("confirm-amount", formatGrin(data.amount));
    setStep(3);
    refreshStatus();
  } catch (err) {
    if (err.status === 410) {
      trackEvent('claim_expired');
      showError("finalize-error", "Claim expired. Please start a new claim.");
      setStep(1);
    } else {
      trackEvent('finalize_error');
      showError("finalize-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Finalize Transaction"; }
  }
}

function resetClaim() {
  _claimId         = null;
  _claimAmount     = null;
  _claimAnonAmount = null;
  clearClaimSession();
  stopCountdown();
  const ra = $("response-slate");
  if (ra) ra.value = "";
  hide("claim-custom-wrap");
  hide("anon-custom-wrap");
  document.querySelectorAll("#claim-amount-grid .amount-btn, #anon-amount-grid .amount-btn")
    .forEach(b => b.classList.remove("active"));
  clearError("claim-error");
  clearError("finalize-error");
  clearError("anon-claim-error");
  setStep(1);
  // Restore whichever claim tab was last active
  document.querySelectorAll(".claim-pane").forEach(p => p.classList.remove("active"));
  const paneId = _activeClaimPane === 'anon' ? 'claim-pane-anon' : 'claim-pane-addr';
  const pane = $(paneId);
  if (pane) pane.classList.add("active");
}


// ── Claim tab switching ───────────────────────────────────────────────────────
function initClaimTabs() {
  document.querySelectorAll(".claim-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".claim-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".claim-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const pane = $(btn.dataset.pane);
      if (pane) pane.classList.add("active");
      _activeClaimPane = btn.dataset.pane === 'claim-pane-anon' ? 'anon' : 'addr';
    });
  });
}

// ── Anonymous claim (no address — IP rate limited) ────────────────────────────
async function submitClaimAnon() {
  clearError("anon-claim-error");
  const btn = $("anon-claim-btn");
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = "Requesting…"; }
  try {
    const amount   = _claimAnonAmount !== null ? _claimAnonAmount : ANON_CLAIM_AMOUNT;
    const tsToken  = await getTurnstileToken(_tsWidgetAnon, function (fn) { _tsCbAnon = fn; });
    const anonBody = { amount };
    if (tsToken) anonBody.cf_token = tsToken;
    const data = await apiPost(API + "/api/claim/anonymous", anonBody);
    _claimId = data.claim_id;
    trackEvent('claim_started', { method: 'anonymous', amount });
    const sp = $("slatepack-text");
    if (sp) sp.textContent = data.slatepack;
    sessionStorage.setItem('grin_drop_claim_id',   String(data.claim_id));
    sessionStorage.setItem('grin_drop_slatepack',  data.slatepack);
    sessionStorage.setItem('grin_drop_expires_at', data.expires_at);
    startCountdown(data.expires_at);
    setStep(2);
    refreshStatus();
  } catch (err) {
    resetTurnstile(_tsWidgetAnon);
    if (err.status === 429) {
      trackEvent('claim_rate_limited', { method: 'anonymous' });
      showError("anon-claim-error", "You already claimed recently. " + err.message);
    } else {
      trackEvent('claim_error', { method: 'anonymous' });
      showError("anon-claim-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || "Claim — No Address Needed"; }
  }
}

function _updateSendCmd() {
  const el = $("donate-send-cmd");
  if (!el) return;
  if (!_donateWalletAddr) {
    el.textContent = "Wallet offline — address unavailable";
    return;
  }
  const amt = _rcvAmount != null ? _rcvAmount : "<amount>";
  el.textContent = `./grin-wallet ${NET_FLAG}send -m -d ${_donateWalletAddr} ${amt}`;
}

// ── Donate: tab switching (CSS class toggle) ───────────────────────────────────
function initDonateTabs() {
  document.querySelectorAll(".donate-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".donate-tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".donate-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const pane = $(btn.dataset.pane);
      if (pane) pane.classList.add("active");
    });
  });
}

// ── Donate Pane 2 — Slatepack: You Send / We Receive ──────────────────────────
let _rcvAmount = null;
let _invAmount = null;

function _initRcvAmountButtons() {
  document.querySelectorAll("#donate-rcv-amount-grid .amount-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#donate-rcv-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.amount === "custom") {
        show("donate-rcv-custom-wrap");
        const v = parseFloat($("donate-rcv-custom-amt")?.value);
        _rcvAmount = (v >= 1) ? v : null;
      } else {
        hide("donate-rcv-custom-wrap");
        _rcvAmount = parseFloat(btn.dataset.amount);
      }
      _updateSendCmd();
    });
  });
  $("donate-rcv-custom-amt")?.addEventListener("input", () => {
    const el = $("donate-rcv-custom-amt");
    _clamp3dec(el);
    const v = parseFloat(el?.value);
    _rcvAmount = (v >= 1) ? parseFloat(v.toFixed(3)) : null;
    _updateSendCmd();
  });
}

async function submitDonateReceive() {
  clearError("donate-receive-error");
  const slate = ($("donate-send-slate")?.value || "").trim();
  if (!slate) { showError("donate-receive-error", "Please paste your send slatepack."); return; }
  if (!slate.includes("BEGINSLATEPACK") || !slate.includes("ENDSLATEPACK")) {
    showError("donate-receive-error", "Invalid slatepack — must include BEGINSLATEPACK…ENDSLATEPACK."); return;
  }

  const btn = $("donate-receive-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Processing…"; }

  const SCAN_MSG = "Wallet is busy (full scan / LMDB write lock) — Slatepack is unavailable right now. Try again in a minute, or switch to Tab 1 · TOR Direct which always works during a scan.";
  try {
    const data = await apiPost(API + "/api/donate/receive", { send_slate: slate }, 25000);
    trackEvent('donate_slatepack_received');
    const sp = data.response_slatepack || data.slatepack || "";
    const spEl = $("donate-response-slatepack");
    if (spEl) spEl.textContent = sp;
    sessionStorage.setItem('grin_drop_donate_rcv_sp', sp);
    hide("donate-rcv-s1");
    show("donate-rcv-s2");
  } catch (err) {
    const msg = (err.timedOut || err.status === 503) ? SCAN_MSG : "Error: " + err.message;
    showError("donate-receive-error", msg);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Process Donation →"; }
  }
}

function resetDonateReceive() {
  clearDonateRcvSession();
  const ta = $("donate-send-slate");
  if (ta) ta.value = "";
  clearError("donate-receive-error");
  document.querySelectorAll("#donate-rcv-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
  hide("donate-rcv-custom-wrap");
  _rcvAmount = null;
  _updateSendCmd();
  hide("donate-rcv-s2");
  show("donate-rcv-s1");
}

// ── Donate Pane 3 — Invoice: We Request / You Pay ─────────────────────────────
function _initInvAmountButtons() {
  document.querySelectorAll("#donate-inv-amount-grid .amount-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#donate-inv-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.amount === "custom") {
        show("donate-inv-custom-wrap");
        const v = parseFloat($("donate-inv-custom-amt")?.value);
        _invAmount = (v >= 1) ? v : null;
      } else {
        hide("donate-inv-custom-wrap");
        _invAmount = parseFloat(btn.dataset.amount);
      }
      _updateInvBtn();
    });
  });
  $("donate-inv-custom-amt")?.addEventListener("input", () => {
    const el = $("donate-inv-custom-amt");
    _clamp3dec(el);
    const v = parseFloat(el?.value);
    _invAmount = (v >= 1) ? parseFloat(v.toFixed(3)) : null;
    _updateInvBtn();
  });
  $("donate-invoice-address")?.addEventListener("input", _updateInvBtn);
}

function _updateInvBtn() {
  const addr  = ($("donate-invoice-address")?.value || "").trim();
  const valid = _invAmount != null && _invAmount >= 1 && addr.length >= ADDR_MIN_LEN && addr.startsWith(ADDR_PFX);
  const btn   = $("donate-invoice-btn");
  if (btn) btn.disabled = !valid;
}

async function submitDonateInvoice() {
  clearError("donate-invoice-error");
  const address = ($("donate-invoice-address")?.value || "").trim();
  if (!address) { showError("donate-invoice-error", "Please enter your Grin address."); return; }
  if (!_validateAddrPrefix(address, "donate-invoice-error")) return;
  if (_invAmount == null || _invAmount < 1) {
    showError("donate-invoice-error", "Please select a donation amount."); return;
  }

  const btn = $("donate-invoice-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Creating invoice…"; }

  const SCAN_MSG_INV = "Wallet is busy (full scan / LMDB write lock) — Invoice is unavailable right now. Try again in a minute, or switch to Tab 1 · TOR Direct which always works during a scan.";
  try {
    const data = await apiPost(API + "/api/donate/invoice", { amount: _invAmount, address }, 25000);
    _invoiceId = data.invoice_id;
    const sp = data.invoice_slatepack || data.slatepack || "";
    const spEl = $("donate-invoice-slatepack");
    if (spEl) spEl.textContent = sp;
    sessionStorage.setItem('grin_drop_invoice_id', _invoiceId);
    sessionStorage.setItem('grin_drop_invoice_sp', sp);
    if (data.expires_at) sessionStorage.setItem('grin_drop_invoice_exp', data.expires_at);
    hide("donate-inv-s1");
    show("donate-inv-s2");
    return; // success — leave button hidden with step
  } catch (err) {
    const msg = (err.timedOut || err.status === 503) ? SCAN_MSG_INV : "Error: " + err.message;
    showError("donate-invoice-error", msg);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Create Invoice →"; }
  }
}

async function submitDonateFinalize() {
  clearError("donate-invoice-finalize-error");
  const response = ($("donate-pay-slate")?.value || "").trim();
  if (!response) { showError("donate-invoice-finalize-error", "Please paste your payment response."); return; }
  if (!_invoiceId) { showError("donate-invoice-finalize-error", "No active invoice. Please start again."); return; }
  if (!response.includes("BEGINSLATEPACK") || !response.includes("ENDSLATEPACK")) {
    showError("donate-invoice-finalize-error", "Invalid slatepack format."); return;
  }

  const btn = $("donate-invoice-finalize-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Finalizing…"; }

  try {
    await apiPost(API + "/api/donate/finalize", {
      invoice_id:     _invoiceId,
      response_slate: response,
    });
    trackEvent('donate_success', { method: 'invoice', amount: _invAmount });
    clearDonateInvSession();
    hide("donate-inv-s2");
    show("donate-inv-s3");
    refreshStatus();
  } catch (err) {
    if (err.status === 410) {
      showError("donate-invoice-finalize-error", "Invoice expired. Please create a new one.");
      hide("donate-inv-s2");
      show("donate-inv-s1");
    } else {
      showError("donate-invoice-finalize-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Finalize Donation →"; }
  }
}

function resetDonateInvoice() {
  clearDonateInvSession();
  _invoiceId = null;
  _invAmount = null;
  const af = $("donate-invoice-address");
  const ta = $("donate-pay-slate");
  if (af) af.value = "";
  if (ta) ta.value = "";
  document.querySelectorAll("#donate-inv-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
  hide("donate-inv-custom-wrap");
  clearError("donate-invoice-error");
  clearError("donate-invoice-finalize-error");
  const btn = $("donate-invoice-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Create Invoice →"; }
  hide("donate-inv-s2");
  hide("donate-inv-s3");
  show("donate-inv-s1");
}

// ── How it works tabs ─────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.getElementById("tab-" + target);
      if (panel) panel.classList.add("active");
    });
  });
  document.querySelector(".tab-btn")?.click();
}

// ── Auto-refresh (single shared poll) ────────────────────────────────────────
function startStatsRefresh() {
  refreshStatus();
  setInterval(refreshStatus, REFRESH_SEC * 1000);
}

// ── Node status — How It Works ────────────────────────────────────────────────
async function loadNodeStatus() {
  const targetIds = ["node-list-cli", "node-list-grim"];
  try {
    const data = await apiGet(API + "/api/nodes");
    const nodes = data.nodes || [];
    const html = nodes.map(n => {
      const dot   = n.online ? '●' : '○';
      const cls   = n.online ? 'node-ok' : 'node-err';
      const label = n.online ? 'online' : 'offline';
      const ms    = n.online && n.ms != null ? `<span class="node-ms">(${n.ms}ms)</span>` : '';
      return `<div class="node-item">
        <span class="${cls}">${dot}</span>
        <code>${n.url}</code>
        <span class="${cls}">${label}</span>
        ${ms}
      </div>`;
    }).join('');
    targetIds.forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = html || '<span style="color:var(--text-dim);font-size:.82rem;">No nodes found</span>';
    });
  } catch {
    targetIds.forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = '<span style="color:var(--text-dim);font-size:.82rem;">Could not load node status</span>';
    });
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Network badge in header
  if (window.DROP_NETWORK) {
    const titleEl = document.querySelector(".site-title");
    if (titleEl) {
      const badge = document.createElement("span");
      badge.className = "net-badge";
      badge.textContent = window.DROP_NETWORK.toUpperCase();
      titleEl.appendChild(badge);
    }
  }

  // Network-specific title + address placeholder + label
  const isMainnet = window.DROP_NETWORK === 'mainnet';
  const bannerCls  = 'net-banner ' + (isMainnet ? 'net-mainnet' : 'net-testnet');
  const bannerIcon = isMainnet ? '⚡' : '🧪';
  const bannerText = isMainnet ? 'MAINNET — Real GRIN coins' : 'TESTNET — No real value';

  // Browser tab title
  document.title = isMainnet
    ? 'Grin Drop — Mainnet Real GRIN'
    : 'Grin Drop — Free tGRIN Testnet';

  // Claim section title
  const titleEl = $("claim-title");
  if (titleEl) titleEl.textContent = isMainnet
    ? 'Claim free real GRIN — Mainnet'
    : 'Claim free tGRIN — Testnet';

  // Network banner below claim title (above tabs)
  const claimSectionBanner = $("net-banner-claim-section");
  if (claimSectionBanner) {
    claimSectionBanner.className = bannerCls;
    claimSectionBanner.textContent = bannerIcon + ' ' + bannerText;
  }

  // Network banners above claim buttons
  ['net-banner-claim', 'net-banner-anon'].forEach(id => {
    const el = $(id);
    if (el) { el.className = bannerCls; el.textContent = bannerIcon + ' ' + bannerText; }
  });

  // Donate section title
  const donateTitleEl = $("donate-section-title");
  if (donateTitleEl) donateTitleEl.textContent = isMainnet
    ? 'Mainnet Wallet Needs More Donations'
    : 'Donate to Testnet Wallet';

  // Tor Direct tab — "Our Grin Address" label + address box highlight
  const torAddrLabel = $("donate-tor-addr-label");
  if (torAddrLabel) torAddrLabel.textContent = isMainnet
    ? 'Our Mainnet Grin Address'
    : 'Our Testnet Grin Address';
  const torBanner = $("net-banner-tor");
  if (torBanner) { torBanner.className = bannerCls; torBanner.textContent = bannerIcon + ' ' + bannerText; }
  const torAddr = $("donate-address");
  if (torAddr) torAddr.classList.add(isMainnet ? 'donate-addr-mainnet' : 'donate-addr-testnet');

  // Network banners above Process Donation and Create Invoice buttons
  ['net-banner-pane2', 'net-banner-pane3'].forEach(id => {
    const el = $(id);
    if (el) { el.className = bannerCls; el.textContent = bannerIcon + ' ' + bannerText; }
  });

  // Fix CLI commands in claim step-2 and How It Works section
  const receiveCmd = $("claim-receive-cmd");
  if (receiveCmd) receiveCmd.textContent = `./grin-wallet ${NET_FLAG}receive`;
  [
    ["howitworks-init-cmd",     `./grin-wallet ${NET_FLAG}init`],
    ["howitworks-info-cmd",     `./grin-wallet ${NET_FLAG}info`],
    ["howitworks-addr-cmd",     `./grin-wallet ${NET_FLAG}address`],
    ["howitworks-receive-cmd",  `./grin-wallet ${NET_FLAG}receive`],
  ].forEach(([id, cmd]) => { const el = $(id); if (el) el.textContent = cmd; });
  const addrPfxEl = $("howitworks-addr-pfx");
  if (addrPfxEl) addrPfxEl.textContent = ADDR_PFX + '...';
  const initLabel = $("howitworks-init-label");
  if (initLabel) initLabel.textContent = isMainnet ? 'Initialize a mainnet wallet' : 'Initialize a testnet wallet';
  const setupLabel = $("howitworks-setup-label");
  if (setupLabel) setupLabel.textContent = isMainnet ? 'A) Set up your mainnet wallet' : 'A) Set up your testnet wallet';
  const grimNetEl = $("howitworks-grim-net");
  if (grimNetEl) grimNetEl.textContent = isMainnet ? 'Mainnet' : 'Testnet';

  const addrInput = $("claim-address");
  if (addrInput) addrInput.placeholder = ADDR_PFX + "1...";
  const addrLabel = $("claim-address-label");
  if (addrLabel) addrLabel.textContent = `Your ${COIN} Address (${ADDR_PFX}1...)`;
  const invAddrInput = $("donate-invoice-address");
  if (invAddrInput) invAddrInput.placeholder = ADDR_PFX + "1...";

  // Apply network-specific claim amounts to the claim grid buttons
  [...document.querySelectorAll('#claim-amount-grid .amount-btn[data-amount]')]
    .forEach((btn, i) => { if (CLAIM_AMOUNTS[i] != null) btn.dataset.amount = String(CLAIM_AMOUNTS[i]); });

  // Apply network-specific anon claim amounts to the anon grid buttons
  [...document.querySelectorAll('#anon-amount-grid .amount-btn[data-amount]')]
    .forEach((btn, i) => { if (ANON_CLAIM_AMOUNTS[i] != null) btn.dataset.amount = String(ANON_CLAIM_AMOUNTS[i]); });

  // Update anon custom input max for network
  const anonCustomEl = $("anon-custom-amt");
  if (anonCustomEl) {
    anonCustomEl.min         = String(CLAIM_CUSTOM_MIN);
    anonCustomEl.max         = String(ANON_CUSTOM_MAX);
    anonCustomEl.step        = String(CLAIM_CUSTOM_MIN);
    anonCustomEl.placeholder = `${CLAIM_CUSTOM_MIN} – ${ANON_CUSTOM_MAX}`;
  }

  const claimCustomEl = $("claim-custom-amt");
  if (claimCustomEl) {
    claimCustomEl.min         = String(CLAIM_CUSTOM_MIN);
    claimCustomEl.max         = String(CLAIM_CUSTOM_MAX);
    claimCustomEl.step        = String(CLAIM_CUSTOM_MIN);
    claimCustomEl.placeholder = `${CLAIM_CUSTOM_MIN} – ${CLAIM_CUSTOM_MAX}`;
  }

  // Update all amount button labels (donate + claim) using the (now-patched) data-amount values
  document.querySelectorAll(".amount-btn[data-amount]").forEach(btn => {
    const amt = btn.dataset.amount;
    if (amt !== "custom") {
      btn.textContent = amt + " " + COIN;
    }
  });
  // Network-specific custom amount placeholders
  ["donate-rcv-custom-amt", "donate-inv-custom-amt"].forEach(id => {
    const el = $(id);
    if (el) el.placeholder = `Min 1 ${COIN}`;
  });

  // Network-specific wallet pay command in pane 3
  const payCmd = $("donate-pay-cmd");
  if (payCmd) payCmd.textContent = `./grin-wallet ${NET_FLAG}pay -i invoice.slatepack`;

  setStep(1);

  // ── Restore claim state from sessionStorage (survives page refresh) ──
  const _savedId  = sessionStorage.getItem('grin_drop_claim_id');
  const _savedSp  = sessionStorage.getItem('grin_drop_slatepack');
  const _savedExp = sessionStorage.getItem('grin_drop_expires_at');
  if (_savedId && _savedSp && _savedExp && Date.now() < new Date(_savedExp).getTime()) {
    _claimId = parseInt(_savedId, 10);
    const sp = $('slatepack-text');
    if (sp) sp.textContent = _savedSp;
    startCountdown(_savedExp);
    setStep(2);
  }

  // ── Restore donate pane 2 (receive) response slatepack ──
  const _savedRcvSp = sessionStorage.getItem('grin_drop_donate_rcv_sp');
  if (_savedRcvSp) {
    const spEl = $('donate-response-slatepack');
    if (spEl) spEl.textContent = _savedRcvSp;
    hide('donate-rcv-s1');
    show('donate-rcv-s2');
  }

  // ── Restore donate pane 3 (invoice) state ──
  const _savedInvId  = sessionStorage.getItem('grin_drop_invoice_id');
  const _savedInvSp  = sessionStorage.getItem('grin_drop_invoice_sp');
  const _savedInvExp = sessionStorage.getItem('grin_drop_invoice_exp');
  const _invStillValid = _savedInvExp ? Date.now() < new Date(_savedInvExp).getTime() : true;
  if (_savedInvId && _savedInvSp && _invStillValid) {
    _invoiceId = _savedInvId;
    const spEl = $('donate-invoice-slatepack');
    if (spEl) spEl.textContent = _savedInvSp;
    hide('donate-inv-s1');
    show('donate-inv-s2');
  }

  startStatsRefresh(); // single shared poll every 5 min
  loadNodeStatus();    // one-shot node ping for How It Works section
  initTabs();
  initDonateTabs();
  initClaimTabs();
  _initClaimAmountButtons();
  _initAnonAmountButtons();
  _initRcvAmountButtons();
  _initInvAmountButtons();
  _updateSendCmd();

  // ── Claim flow ──
  $("anon-claim-btn")?.addEventListener("click", submitClaimAnon);
  $("claim-btn")?.addEventListener("click", submitClaim);
  $("claim-address")?.addEventListener("keydown", e => {
    if (e.key === "Enter") submitClaim();
  });
  $("copy-slatepack-btn")?.addEventListener("click", () => {
    const sp = $("slatepack-text");
    if (sp) copyText(sp.textContent, "copy-slatepack-btn");
  });
  $("finalize-btn")?.addEventListener("click", submitFinalize);
  $("new-claim-btn")?.addEventListener("click", resetClaim);
  $("claim-address")?.addEventListener("blur", () => {
    const addr = ($("claim-address")?.value || "").trim();
    if (addr) _validateAddrPrefix(addr, "claim-error");
    else clearError("claim-error");
    refreshStatus();
  });

  // ── Donate pane 1 ──
  $("copy-donate-addr-btn")?.addEventListener("click", () => {
    const el = $("donate-address");
    if (el) copyText(el.textContent, "copy-donate-addr-btn");
  });

  // ── Donate pane 2 ──
  $("donate-copy-send-cmd")?.addEventListener("click", () => {
    const el = $("donate-send-cmd");
    if (el) copyText(el.textContent, "donate-copy-send-cmd");
  });
  $("donate-receive-btn")?.addEventListener("click", submitDonateReceive);
  $("copy-donate-response-btn")?.addEventListener("click", () => {
    const el = $("donate-response-slatepack");
    if (el) copyText(el.textContent, "copy-donate-response-btn");
  });
  $("download-donate-response-btn")?.addEventListener("click", () => {
    const text = $("donate-response-slatepack")?.textContent || "";
    if (!text) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "response.slatepack";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("donate-receive-reset-btn")?.addEventListener("click", resetDonateReceive);

  // ── Donate pane 3 ──
  $("donate-invoice-address")?.addEventListener("blur", () => {
    const addr = ($("donate-invoice-address")?.value || "").trim();
    if (addr) _validateAddrPrefix(addr, "donate-invoice-error");
    else clearError("donate-invoice-error");
  });
  $("donate-invoice-btn")?.addEventListener("click", submitDonateInvoice);
  $("copy-donate-invoice-btn")?.addEventListener("click", () => {
    const el = $("donate-invoice-slatepack");
    if (el) copyText(el.textContent, "copy-donate-invoice-btn");
  });
  $("donate-invoice-finalize-btn")?.addEventListener("click", submitDonateFinalize);
  $("donate-invoice-back-btn")?.addEventListener("click", () => {
    hide("donate-inv-s2");
    show("donate-inv-s1");
  });
  $("donate-invoice-reset-btn")?.addEventListener("click", resetDonateInvoice);
});
