// withdraw.js — 3-step slatepack withdrawal UI

const Withdraw = {
  _step:              1,
  _withdrawalId:      null,
  _slatepack:         null,
  _countdownInterval: null,

  init() {
    const btnSubmit   = document.getElementById('withdraw-btn');
    const btnCopy     = document.getElementById('copy-slate-btn');
    const btnFinalize = document.getElementById('finalize-btn');
    const btnNew      = document.getElementById('new-withdraw-btn');

    if (btnSubmit)   btnSubmit.addEventListener('click',   () => this.submit());
    if (btnCopy)     btnCopy.addEventListener('click',     () => this.copySlate());
    if (btnFinalize) btnFinalize.addEventListener('click', () => this.finalize());
    if (btnNew)      btnNew.addEventListener('click',      () => this.reset());

    this.showStep(1);
  },

  // ── Step 1 — Submit withdrawal request ────────────────────────────────────
  async submit() {
    const amountEl  = document.getElementById('withdraw-amount');
    const addrEl    = document.getElementById('withdraw-address');
    const errEl     = document.getElementById('withdraw-error');

    const amount  = parseFloat(amountEl?.value);
    const address = addrEl?.value?.trim();

    // Validate
    if (!amount || amount <= 0) {
      this._showErr(errEl, 'Please enter a valid amount greater than 0.');
      return;
    }
    if (!address) {
      this._showErr(errEl, 'Grin address is required.');
      return;
    }
    this._showErr(errEl, '');

    const btn = document.getElementById('withdraw-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }

    try {
      const data = await API.post('/api/user/withdraw', { amount, grin_address: address });
      this._withdrawalId = data.withdrawal_id;
      this._slatepack    = data.slatepack;

      // Populate step 2
      const slateEl = document.getElementById('slatepack-display');
      if (slateEl) slateEl.textContent = data.slatepack;

      if (data.expires_at) this.startCountdown(data.expires_at);

      this.showStep(2);
    } catch (err) {
      this._showErr(errEl, err.message || 'Withdrawal request failed.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Request Withdrawal'; }
    }
  },

  // ── Step 2 — Copy slatepack ────────────────────────────────────────────────
  copySlate() {
    if (!this._slatepack) return;
    navigator.clipboard.writeText(this._slatepack).then(() => {
      const btn = document.getElementById('copy-slate-btn');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = this._slatepack;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  },

  // ── Step 2 → 3 — Finalize ─────────────────────────────────────────────────
  async finalize() {
    const responseEl = document.getElementById('response-slate');
    const errEl      = document.getElementById('finalize-error');
    const responseSlate = responseEl?.value?.trim();

    if (!responseSlate) {
      this._showErr(errEl, 'Paste the response slatepack from your wallet.');
      return;
    }
    this._showErr(errEl, '');

    const btn = document.getElementById('finalize-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Finalizing…'; }

    try {
      const data = await API.post('/api/user/finalize', {
        withdrawal_id:   this._withdrawalId,
        response_slate:  responseSlate,
      });

      // Populate step 3
      const txEl = document.getElementById('success-tx-id');
      if (txEl) txEl.textContent = data.tx_slate_id || '—';

      if (this._countdownInterval) {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
      }
      this.showStep(3);
    } catch (err) {
      this._showErr(errEl, err.message || 'Finalization failed.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Finalize'; }
    }
  },

  // ── Countdown timer ────────────────────────────────────────────────────────
  startCountdown(expiresIso) {
    if (this._countdownInterval) clearInterval(this._countdownInterval);
    const el = document.getElementById('countdown-timer');

    const expiry = new Date(expiresIso).getTime();

    const tick = () => {
      const remaining = Math.max(0, expiry - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      if (el) el.textContent = mins + ':' + String(secs).padStart(2, '0');
      if (remaining <= 0) {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        this.reset();
      }
    };

    tick();
    this._countdownInterval = setInterval(tick, 1000);
  },

  // ── Show/hide step divs ────────────────────────────────────────────────────
  showStep(n) {
    this._step = n;
    [1, 2, 3].forEach(i => {
      const el = document.getElementById('step-' + i);
      if (el) el.style.display = (i === n) ? '' : 'none';
    });
  },

  // ── Resume existing withdrawal ─────────────────────────────────────────────
  async resumeWithdrawal(withdrawalId) {
    try {
      const data = await API.get('/api/user/withdrawal/' + withdrawalId + '/slatepack');
      this._withdrawalId = withdrawalId;
      this._slatepack    = data.slatepack;

      const slateEl = document.getElementById('slatepack-display');
      if (slateEl) slateEl.textContent = data.slatepack;

      if (data.expires_at) this.startCountdown(data.expires_at);
      this.showStep(2);
    } catch (err) {
      alert('Failed to resume withdrawal: ' + err.message);
    }
  },

  // ── Reset to step 1 ───────────────────────────────────────────────────────
  reset() {
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    this._withdrawalId = null;
    this._slatepack    = null;

    const amountEl   = document.getElementById('withdraw-amount');
    const addrEl     = document.getElementById('withdraw-address');
    const responseEl = document.getElementById('response-slate');
    const errEl1     = document.getElementById('withdraw-error');
    const errEl2     = document.getElementById('finalize-error');
    const slateEl    = document.getElementById('slatepack-display');

    if (amountEl)   amountEl.value   = '';
    if (addrEl)     addrEl.value     = '';
    if (responseEl) responseEl.value = '';
    if (errEl1)     errEl1.style.display = 'none';
    if (errEl2)     errEl2.style.display = 'none';
    if (slateEl)    slateEl.textContent  = '';

    this.showStep(1);
  },

  // ── Internal helpers ────────────────────────────────────────────────────────
  _showErr(el, msg) {
    if (!el) return;
    if (msg) {
      el.textContent    = msg;
      el.style.display  = '';
    } else {
      el.style.display = 'none';
    }
  },
};
