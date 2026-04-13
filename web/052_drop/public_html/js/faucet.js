// faucet.js — Grin Drop claim flow + donation tabs + live stats
// =============================================================================

const REFRESH_SEC = 300; // 5 minutes — single shared poll

// ── Network context (injected by nginx sub_filter) ────────────────────────────
const API      = window.APP_BASE  || '';
const COIN     = window.DROP_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';
const NET_FLAG = window.DROP_NETWORK === 'testnet' ? '--testnet ' : '';
const ADDR_PFX = window.DROP_NETWORK === 'testnet' ? 'tgrin1' : 'grin1';

// ── State ─────────────────────────────────────────────────────────────────────
let _claimId          = null;
let _claimAmount      = null;   // null = use server max; number = override
let _countdown        = null;
let _invoiceId        = null;
let _donateWalletAddr = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function show(id)   { const el = $(id); if (el) el.style.display = ""; }
function hide(id)   { const el = $(id); if (el) el.style.display = "none"; }
function addClass(id, cls) { const el = $(id); if (el) el.classList.add(cls); }
function rmClass(id, cls)  { const el = $(id); if (el) el.classList.remove(cls); }

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

    setText("stat-balance", formatGrin(data.wallet_balance));
    setText("stat-today",   String(data.claims_today));
    setText("stat-total",   String(data.claims_total));

    // Update claim hint with server-configured max amount
    if (data.claim_amount != null) {
      const v = parseFloat(data.claim_amount) || 2;
      const maxLabel = (Number.isInteger(v) ? v : v.toFixed(2)) + " " + COIN;
      const hintEl = $("claim-hint");
      if (hintEl) {
        hintEl.innerHTML = `Up to ${maxLabel} per address per ${data.claim_window_hours || 24}h &nbsp;·&nbsp; No sign-up required &nbsp;·&nbsp; `
          + `This simulates exactly how <strong>mainnet withdrawals</strong> work.`;
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
        badge.innerHTML = '<span class="ws-dot"></span> Wallet online — ready to receive donations';
      } else {
        badge.className = "error";
        badge.innerHTML = '<span class="ws-dot"></span> Wallet address not configured';
      }
    }
  } catch {
    if (badge) {
      badge.className = "error";
      badge.innerHTML = '<span class="ws-dot"></span> Wallet offline — donations unavailable';
    }
  }
}

function formatGrin(n) {
  if (n === null || n === undefined) return "— " + COIN;
  return (typeof n === "number" ? n : parseFloat(n) || 0).toFixed(3) + " " + COIN;
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
      showError("claim-error", "The 5-minute window has expired. Please start a new claim.");
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
  el.style.display = msg ? "" : "none";
}

function clearError(id) { showError(id, ""); }

// ── Claim amount buttons ──────────────────────────────────────────────────────
function _initClaimAmountButtons() {
  document.querySelectorAll("#claim-amount-grid .amount-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#claim-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _claimAmount = parseFloat(btn.dataset.amount);
    });
  });
}

// ── Step 1 — Claim ────────────────────────────────────────────────────────────
async function submitClaim() {
  clearError("claim-error");
  const address = ($("claim-address")?.value || "").trim();
  if (!address) { showError("claim-error", "Please enter your Grin address."); return; }

  const btn = $("claim-btn");
  const origBtnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = "Requesting…"; }

  try {
    const claimBody = { grin_address: address };
    if (_claimAmount !== null) claimBody.amount = _claimAmount;
    const data = await apiPost(API + "/api/claim", claimBody);
    _claimId = data.claim_id;

    const sp = $("slatepack-text");
    if (sp) sp.textContent = data.slatepack;
    startCountdown(data.expires_at);
    setStep(2);
    refreshStatus();
  } catch (err) {
    if (err.status === 429) {
      showError("claim-error", "You already claimed recently. " + err.message);
    } else {
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
    setText("confirm-tx-id",  data.tx_slate_id || "(not available)");
    setText("confirm-amount", formatGrin(data.amount));
    setStep(3);
    refreshStatus();
  } catch (err) {
    if (err.status === 410) {
      showError("finalize-error", "Claim expired. Please start a new claim.");
      setStep(1);
    } else {
      showError("finalize-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Finalize Transaction"; }
  }
}

function resetClaim() {
  _claimId = null;
  stopCountdown();
  const ra = $("response-slate");
  if (ra) ra.value = "";
  clearError("claim-error");
  clearError("finalize-error");
  setStep(1);
}


function _updateSendCmd() {
  const el = $("donate-send-cmd");
  if (!el) return;
  if (!_donateWalletAddr) {
    el.textContent = "Wallet offline — address unavailable";
    return;
  }
  const amt = _rcvAmount != null ? _rcvAmount : "<amount>";
  el.textContent = `grin-wallet ${NET_FLAG}send -m -d ${_donateWalletAddr} ${amt}`;
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
    const v = parseFloat($("donate-rcv-custom-amt")?.value);
    _rcvAmount = (v >= 1) ? v : null;
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
    const sp = data.response_slatepack || data.slatepack || "";
    const spEl = $("donate-response-slatepack");
    if (spEl) spEl.textContent = sp;
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
  const ta = $("donate-send-slate");
  if (ta) ta.value = "";
  clearError("donate-receive-error");
  document.querySelectorAll("#donate-rcv-amount-grid .amount-btn").forEach(b => b.classList.remove("active"));
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
    const v = parseFloat($("donate-inv-custom-amt")?.value);
    _invAmount = (v >= 1) ? v : null;
    _updateInvBtn();
  });
  $("donate-invoice-address")?.addEventListener("input", _updateInvBtn);
}

function _updateInvBtn() {
  const addr  = ($("donate-invoice-address")?.value || "").trim();
  const valid = _invAmount != null && _invAmount >= 1 && addr.length > 5;
  const btn   = $("donate-invoice-btn");
  if (btn) btn.disabled = !valid;
}

async function submitDonateInvoice() {
  clearError("donate-invoice-error");
  const address = ($("donate-invoice-address")?.value || "").trim();
  if (!address) { showError("donate-invoice-error", "Please enter your Grin address."); return; }
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
let _statsTimer = null;
function startStatsRefresh() {
  refreshStatus();
  _statsTimer = setInterval(refreshStatus, REFRESH_SEC * 1000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Network badge in header
  if (window.DROP_NETWORK) {
    const titleEl = document.querySelector(".site-title");
    if (titleEl) {
      const badge = document.createElement("span");
      badge.style.cssText = "margin-left:.5rem;font-size:.6rem;font-weight:700;padding:.15rem .4rem;border-radius:3px;vertical-align:middle;background:var(--accent,#00e676);color:#000;letter-spacing:.05em;";
      badge.textContent = window.DROP_NETWORK.toUpperCase();
      titleEl.appendChild(badge);
    }
  }

  // Network-specific title + address placeholder + label
  const titleEl = $("claim-title");
  if (titleEl) titleEl.textContent = `Claim free ${COIN}`;
  const addrInput = $("claim-address");
  if (addrInput) addrInput.placeholder = ADDR_PFX + "1...";
  const addrLabel = $("claim-address-label");
  if (addrLabel) addrLabel.textContent = `Your ${COIN} Address (${ADDR_PFX}1...)`;

  const invAddrInput = $("donate-invoice-address");
  if (invAddrInput) invAddrInput.placeholder = ADDR_PFX + "1...";

  // Network-specific amount button labels (donate + claim preset)
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
  if (payCmd) payCmd.textContent = `grin-wallet ${NET_FLAG}pay -i invoice.slatepack`;

  setStep(1);
  startStatsRefresh(); // single shared poll every 5 min
  initTabs();
  initDonateTabs();
  _initClaimAmountButtons();
  _initRcvAmountButtons();
  _initInvAmountButtons();
  _updateSendCmd();

  // ── Claim flow ──
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
  $("claim-address")?.addEventListener("blur", refreshStatus);

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
