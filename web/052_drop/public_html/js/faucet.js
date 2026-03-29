// faucet.js — Grin Drop claim flow + live stats
// =============================================================================

const REFRESH_SEC = 60;

// ── State ─────────────────────────────────────────────────────────────────────
let _claimId   = null;
let _countdown = null;

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

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { status: res.status });
  return json;
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
    // Fallback for older browsers
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

// ── Live stats ────────────────────────────────────────────────────────────────
async function loadStats() {
  const addrInput = $("claim-address");
  const addrParam = addrInput && addrInput.value.trim()
    ? "?addr=" + encodeURIComponent(addrInput.value.trim())
    : "";
  try {
    const data = await apiGet("/api/status" + addrParam);

    // Maintenance mode — show overlay and stop normal rendering
    if (data.maintenance_mode) {
      showMaintenanceOverlay(data.drop_name, data.maintenance_message);
      return;
    }

    // Giveaway section visibility
    const giveawaySection = $("section-giveaway");
    if (giveawaySection) {
      giveawaySection.style.display = (data.giveaway_enabled === false) ? "none" : "";
    }

    // Donation section visibility
    const donationSection = $("section-donation");
    if (donationSection) {
      donationSection.style.display = (data.donation_enabled === false) ? "none" : "";
    }

    setText("stat-balance", formatGrin(data.wallet_balance));
    setText("stat-today",   String(data.claims_today));
    setText("stat-total",   String(data.claims_total));

    // Public stats (total given / received)
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
  } catch { /* stats failure is non-critical */ }
}

function formatGrin(n) {
  return (typeof n === "number" ? n : parseFloat(n) || 0).toFixed(3) + " GRIN";
}

function formatGrinShort(n) {
  const v = typeof n === "number" ? n : parseFloat(n) || 0;
  return v.toFixed(2) + " GRIN";
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

// ── Step management ───────────────────────────────────────────────────────────
function setStep(n) {
  [1, 2, 3].forEach(i => {
    const el = $("step-" + i);
    if (el) el.style.display = i === n ? "" : "none";
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

// ── Step 1 — Claim ────────────────────────────────────────────────────────────
async function submitClaim() {
  clearError("claim-error");
  const address = ($("claim-address")?.value || "").trim();
  if (!address) { showError("claim-error", "Please enter your Grin address."); return; }

  const btn = $("claim-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Requesting…"; }

  try {
    const data = await apiPost("/api/claim", { grin_address: address });
    _claimId = data.claim_id;

    // Show slatepack in step 2
    const sp = $("slatepack-text");
    if (sp) sp.textContent = data.slatepack;
    startCountdown(data.expires_at);
    setStep(2);
    loadStats();
  } catch (err) {
    if (err.status === 429) {
      showError("claim-error", "You already claimed recently. " + err.message);
    } else {
      showError("claim-error", "Error: " + err.message);
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Claim 2 GRIN"; }
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
    const data = await apiPost("/api/finalize", {
      claim_id:       _claimId,
      response_slate: response,
    });
    stopCountdown();

    setText("confirm-tx-id",  data.tx_slate_id || "(not available)");
    setText("confirm-amount", formatGrin(data.amount));
    setStep(3);
    loadStats();
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

// ── Donate section ─────────────────────────────────────────────────────────────
async function loadDonate() {
  try {
    const data = await apiGet("/api/status");
    const addr = data.wallet_address || "";
    const addrEl = $("donate-address");
    if (addrEl) addrEl.textContent = addr || "Not configured";

    const balEl = $("donate-balance");
    if (balEl) balEl.textContent = formatGrin(data.wallet_balance);

    // QR code — only show if address is set
    const qrEl = $("donate-qr");
    if (qrEl) qrEl.style.display = addr ? "" : "none";
  } catch { /* donate section is non-critical */ }
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
  // Default: activate first tab
  document.querySelector(".tab-btn")?.click();
}

// ── Auto-refresh stats ────────────────────────────────────────────────────────
let _statsTimer = null;
function startStatsRefresh() {
  loadStats();
  _statsTimer = setInterval(loadStats, REFRESH_SEC * 1000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setStep(1);
  startStatsRefresh();
  loadDonate();
  initTabs();

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

  $("copy-donate-addr-btn")?.addEventListener("click", () => {
    const el = $("donate-address");
    if (el) copyText(el.textContent, "copy-donate-addr-btn");
  });

  // Re-check next_claim_at when address is typed
  $("claim-address")?.addEventListener("blur", loadStats);
});
