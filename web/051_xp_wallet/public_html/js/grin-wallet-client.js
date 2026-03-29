/**
 * Grin Wallet Client — XP Edition
 *
 * Identical to the standard wallet client except API paths use /wallet/api/
 * because this app is deployed as an iframe at /wallet/ under the XP shell.
 */

class GrinWallet {
    constructor() {
        // Deployed under /wallet/ — API lives at /wallet/api/
        this.baseUrl   = `${window.location.protocol}//${window.location.host}/wallet/api/proxy.php`;
        this.csrfToken = null;
    }

    async init() {
        await this.fetchCsrfToken();
        this.refreshStatus();
        this.showWalletQr();
    }

    async fetchCsrfToken() {
        try {
            const res  = await fetch('/wallet/api/csrf.php', { credentials: 'same-origin' });
            const data = await res.json();
            this.csrfToken = data.csrfToken || null;
        } catch (e) {
            console.error('[Wallet] CSRF fetch failed:', e);
        }
    }

    async apiCall(method, params = {}) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
            const response = await fetch(this.baseUrl, {
                method:      'POST',
                credentials: 'same-origin',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Math.random() })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            const data = await response.json();
            if (data.error) throw new Error(data.error.message || 'API error');
            return data.result;
        } catch (error) {
            console.error(`[Wallet] API error (${method}):`, error);
            throw error;
        }
    }

    async refreshStatus() {
        const statusEl = document.getElementById('status');
        statusEl.innerHTML = '<p class="loading">Connecting to wallet...</p>';
        try {
            const info = await this.apiCall('get_info');
            if (info) {
                statusEl.className = 'status-content success';
                statusEl.innerHTML = `
                    <p><strong>Connected</strong> &mdash; Height: <code>${this.escapeHtml(String(info.height))}</code>
                    &nbsp;|&nbsp; Network: <strong>${this.escapeHtml(String(info.network))}</strong></p>
                `;
            }
            await this.refreshBalance();
            await this.refreshTransactions();
        } catch (error) {
            statusEl.className = 'status-content error';
            statusEl.innerHTML = `
                <p><strong>Connection Failed</strong></p>
                <p><small>${this.escapeHtml(error.message)}</small></p>
                <p style="margin-top:6px;font-size:10px;color:var(--text-muted);">
                    Ensure the wallet listener is running (Script 05 &rarr; option c).
                </p>
            `;
        }
    }

    async refreshBalance() {
        try {
            const info = await this.apiCall('get_balance');
            if (info) {
                document.getElementById('balanceSpendable').textContent = this.formatGrin(info.amount_currently_spendable);
                document.getElementById('balancePending').textContent   = this.formatGrin(info.amount_awaiting_confirmation);
                document.getElementById('balanceImmature').textContent  = this.formatGrin(info.amount_immature);
            }
        } catch (e) {
            console.error('[Wallet] Balance refresh failed:', e);
        }
    }

    async refreshTransactions() {
        const txsEl = document.getElementById('transactionsList');
        txsEl.innerHTML = '<p class="loading">Loading transactions...</p>';
        try {
            const txs = await this.apiCall('retrieve_txs');
            if (!txs || txs.length === 0) {
                txsEl.innerHTML = '<p class="info">No transactions yet.</p>';
                return;
            }
            let html = '';
            txs.slice(0, 10).forEach(tx => {
                const statusClass = tx.confirmed ? 'confirmed' : 'pending';
                const statusText  = tx.confirmed ? 'Confirmed'  : 'Pending';
                const fee         = tx.fee != null ? this.formatGrin(tx.fee) : '—';
                const createdAt   = tx.creation_ts     ? new Date(tx.creation_ts).toLocaleString()     : '—';
                const confirmedAt = tx.confirmation_ts ? new Date(tx.confirmation_ts).toLocaleString() : '—';
                const kernel      = tx.kernel_excess
                    ? `<code class="tx-kernel">${this.escapeHtml(tx.kernel_excess)}</code>` : '—';
                html += `
                    <details class="transaction-item">
                        <summary class="tx-summary">
                            <div class="tx-info">
                                <h4>${this.escapeHtml(tx.tx_type || 'Transaction')}</h4>
                                <p>ID: <code>${this.escapeHtml(String(tx.id))}</code></p>
                            </div>
                            <div class="tx-amount">${tx.amount > 0 ? '+' : ''}${this.formatGrin(Math.abs(tx.amount))}</div>
                            <div class="tx-status ${statusClass}">${statusText}</div>
                        </summary>
                        <div class="tx-details">
                            <p><strong>Created:</strong> ${createdAt}</p>
                            <p><strong>Confirmed:</strong> ${confirmedAt}</p>
                            <p><strong>Fee:</strong> ${fee}</p>
                            <p><strong>Inputs / Outputs:</strong> ${tx.num_inputs ?? '—'} / ${tx.num_outputs ?? '—'}</p>
                            <p><strong>Kernel:</strong> ${kernel}</p>
                        </div>
                    </details>
                `;
            });
            txsEl.innerHTML = html;
        } catch (e) {
            console.error('[Wallet] Transactions refresh failed:', e);
            txsEl.innerHTML = '<p class="error">Failed to load transactions.</p>';
        }
    }

    async estimateFee(amount) {
        try {
            const amountNgrin = BigInt(Math.floor(parseFloat(amount) * 1e9));
            const result      = await this.apiCall('estimate_fee', {
                amount: amountNgrin.toString(),
                minimum_confirmations: 10,
                max_outputs: 500,
                num_change_outputs: 1,
                selection_strategy_is_use_all: false
            });
            return result && result.fee ? this.formatGrin(result.fee.toString()) : 'calculating…';
        } catch (e) {
            return '(unavailable)';
        }
    }

    validateRecipientUrl(url) {
        let parsed;
        try { parsed = new URL(url); } catch { return false; }
        if (parsed.protocol !== 'https:') return false;
        const h = parsed.hostname.toLowerCase();
        const privateRanges = [
            'localhost', '127.', '10.', '192.168.', '169.254.', '::1', '[::1]',
            '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
            '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
            '172.28.', '172.29.', '172.30.', '172.31.'
        ];
        return !privateRanges.some(r => h === r || h.startsWith(r));
    }

    async sendTransaction() {
        const amount    = document.getElementById('sendAmount').value;
        const method    = document.getElementById('sendMethod').value;
        const recipient = document.getElementById('sendRecipient').value.trim();
        const resultEl  = document.getElementById('sendResult');

        if (!amount || parseFloat(amount) <= 0) { this.showResultError(resultEl, 'Please enter a valid amount.'); return; }
        if (method === 'http' && recipient && !this.validateRecipientUrl(recipient)) {
            this.showResultError(resultEl, 'Recipient URL must be HTTPS and cannot be a private/local address.');
            return;
        }

        resultEl.style.display = 'block';
        resultEl.className     = 'result-box';
        resultEl.innerHTML     = '<p class="loading">Estimating fee…</p>';

        try {
            const estimatedFee = await this.estimateFee(amount);
            resultEl.innerHTML = `<p class="info">Est. fee: <strong>${this.escapeHtml(estimatedFee)}</strong></p><p class="loading">Initializing transaction…</p>`;

            const amountNgrin = BigInt(Math.floor(parseFloat(amount) * 1e9));
            const baseParams  = {
                amount: amountNgrin.toString(),
                minimum_confirmations: 10,
                max_outputs: 500,
                num_change_outputs: 1,
                selection_strategy_is_use_all: false,
                message: null
            };

            if (method === 'http' && recipient) {
                resultEl.innerHTML = '<p class="loading">Sending to recipient via server…</p>';
                await this.apiCall('send_http', { recipient_url: recipient, send_params: baseParams });
                resultEl.className = 'result-box success';
                resultEl.innerHTML = `
                    <p><strong>Transaction Sent</strong></p>
                    <p>Amount: <strong>${this.escapeHtml(this.formatGrin(amountNgrin.toString()))}</strong></p>
                    <p>Status: Pending confirmation</p>
                `;
                document.getElementById('sendForm').reset();
            } else {
                const initResult = await this.apiCall('init_send_tx', baseParams);
                const slate      = (initResult && initResult.slate) ? initResult.slate : initResult;
                const slateStr   = typeof slate === 'string' ? slate : JSON.stringify(slate, null, 2);
                resultEl.className = 'result-box success';
                resultEl.innerHTML = `
                    <p><strong>Slatepack Generated — share with recipient:</strong></p>
                    <textarea readonly id="sendSlateText" class="slate-input">${this.escapeHtml(slateStr)}</textarea>
                    <button onclick="wallet.copyToClipboard(document.getElementById('sendSlateText').value,'sendClipMsg')" class="btn btn-outline btn-sm mt-6">Copy</button>
                    <span id="sendClipMsg" class="clip-msg" style="margin-left:8px;"></span>
                `;
            }
            setTimeout(() => this.refreshBalance(), 2000);
        } catch (error) {
            this.showResultError(resultEl, error.message);
        }
    }

    async processIncomingSlate() {
        const slateText = document.getElementById('receiveSlateInput').value.trim();
        const resultEl  = document.getElementById('receiveResult');
        if (!slateText) { this.showResultError(resultEl, "Paste the sender's Slatepack first."); return; }
        if (!slateHandler.isValidSlatepack(slateText)) { this.showResultError(resultEl, 'Invalid Slatepack — must start with BEGINSLATEPACK.'); return; }
        resultEl.style.display = 'block';
        resultEl.className     = 'result-box';
        resultEl.innerHTML     = '<p class="loading">Processing Slatepack…</p>';
        try {
            const result        = await this.apiCall('receive_tx', { slate: slateText, dest_acct_name: null, message: null });
            const responseSlate = (result && result.slate) ? result.slate : result;
            const slateStr      = typeof responseSlate === 'string' ? responseSlate : JSON.stringify(responseSlate, null, 2);
            resultEl.className = 'result-box success';
            resultEl.innerHTML = `
                <p><strong>Processed — send this response Slatepack back to the sender:</strong></p>
                <textarea readonly id="responseSlateText" class="slate-input">${this.escapeHtml(slateStr)}</textarea>
                <button onclick="wallet.copyToClipboard(document.getElementById('responseSlateText').value,'receiveClipMsg')" class="btn btn-outline btn-sm mt-6">Copy</button>
                <span id="receiveClipMsg" class="clip-msg" style="margin-left:8px;"></span>
            `;
        } catch (error) {
            this.showResultError(resultEl, error.message);
        }
    }

    async finalizeTransaction() {
        const slateText = document.getElementById('finalizeSlateInput').value.trim();
        const resultEl  = document.getElementById('finalizeResult');
        if (!slateText) { this.showResultError(resultEl, "Paste the receiver's Slatepack first."); return; }
        if (!slateHandler.isValidSlatepack(slateText)) { this.showResultError(resultEl, 'Invalid Slatepack — must start with BEGINSLATEPACK.'); return; }
        resultEl.style.display = 'block';
        resultEl.className     = 'result-box';
        resultEl.innerHTML     = '<p class="loading">Finalizing and broadcasting…</p>';
        try {
            await this.apiCall('finalize_tx', { slate: slateText, post_tx: true, fluff: false });
            resultEl.className = 'result-box success';
            resultEl.innerHTML = '<p><strong>Transaction finalized and broadcast to the network.</strong></p>';
            document.getElementById('finalizeSlateInput').value = '';
            setTimeout(() => this.refreshBalance(), 3000);
            setTimeout(() => this.refreshTransactions(), 5000);
        } catch (error) {
            this.showResultError(resultEl, error.message);
        }
    }

    showWalletQr() {
        const url    = window.location.origin;
        const qrImg  = document.getElementById('walletQrImg');
        const qrNote = document.getElementById('walletQrError');
        if (!qrImg) return;
        qrImg.src     = `/wallet/api/qr.php?data=${encodeURIComponent(url)}`;
        qrImg.alt     = 'Wallet URL QR Code';
        qrImg.onerror = () => {
            qrImg.style.display = 'none';
            if (qrNote) qrNote.style.display = 'block';
        };
        qrImg.style.display = 'block';
    }

    formatGrin(nGrin) {
        if (typeof nGrin === 'string') nGrin = BigInt(nGrin);
        else if (typeof nGrin === 'number') nGrin = BigInt(Math.floor(nGrin));
        const grin = parseFloat(nGrin.toString()) / 1e9;
        return grin.toFixed(9).replace(/0+$/, '').replace(/\.$/, '') + ' ∩';
    }

    escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    showResultError(el, message) {
        el.style.display = 'block';
        el.className     = 'result-box error';
        el.innerHTML     = `<p><strong>Error:</strong> ${this.escapeHtml(message)}</p>`;
    }

    copyToClipboard(text, msgId) {
        navigator.clipboard?.writeText(text).then(() => {
            const msg = document.getElementById(msgId);
            if (msg) {
                msg.textContent = 'Copied!';
                msg.className   = 'clip-msg';
                setTimeout(() => { msg.textContent = ''; }, 2000);
            }
        }).catch(err => console.error('[Wallet] Copy failed:', err));
    }
}

const wallet = new GrinWallet();
