# Script 053 — WooCommerce Grin Gateway — Security Audit

**Scope:** the Node.js bridge (`web/053_woocommerce/bridge/`) and the WooCommerce PHP plugin
(`web/053_woocommerce/plugin/`). Focus: merchant fund loss (0-conf / underpayment / replay),
AJAX auth, injection. **Payment Pro is unbuilt** — its `scripts/054_*.sh` "COMING SOON"
placeholder was deleted 2026-07-28 and the product holds no number until its build starts, so
there is nothing to audit there yet.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** The bridge is well-hardened and the
invoice flow binds the paid amount cryptographically (no underpayment vector). One real
payment-integrity issue: the interactive path completes orders at **0 confirmations**, ignoring
the operator's own "Confirmations Required" setting and a silently-failed broadcast.

---

## Findings

### F1 — [Medium] Interactive submit path marks orders paid at 0-conf, bypassing the confirmation policy
- **Evidence:** `ajax_submit_response()` calls the bridge `/api/finalize` and, on any non-`WP_Error`
  result, immediately calls `$order->payment_complete()`
  ([class-grinpay-gateway.php:333-356](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L333-L356)).
  It never checks on-chain confirmations. The `confirmations` operator setting (default 1) **is**
  enforced on the poll and cron paths ([:415](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L415),
  [:507](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L507)) but **not** here.
- **Compounding:** the bridge's `/api/finalize` treats a **failed broadcast as success** — `post_tx`
  is wrapped in its own try/catch and only logged as a WARN
  ([server.js:237-241](../../web/053_woocommerce/bridge/server.js#L237-L241)), so the bridge returns
  `{success:true, tx_id}` even when the tx was signed locally but never reached the network (node
  down / mempool reject).
- **Impact:** An order can flip to *processing/complete* (goods released) when the payment is at
  0 confirmations — or, in the compounded case, not broadcast at all. In Grin the amount itself is
  safe (see "Correct controls"), but the tx can still fail to confirm (mempool eviction, fee too
  low, node partition). This defeats the merchant's explicit confirmation policy for the one path a
  cooperating buyer actually uses.
- **Fix:** On the submit path, do **not** call `payment_complete` directly. Either (a) set a
  "broadcast / awaiting-confirmation" meta state and let the existing poll/cron confirm at
  `>= threshold`, or (b) re-query `api/tx_status` and require `status==='confirmed' && confirmations
  >= threshold` before completing — matching the poll/cron logic. Separately, have the bridge
  surface a broadcast failure (return `broadcast:false`) so the plugin never treats un-posted as paid.

### F2 — [Low] Bridge auth is fully optional and ships disabled
- **Evidence:** `GRINPAY_API_KEY` and `GRINPAY_HMAC_SECRET` are both optional; when unset the bridge
  logs a WARN and accepts all requests ([server.js:69-97](../../web/053_woocommerce/bridge/server.js#L69-L97),
  [374-375](../../web/053_woocommerce/bridge/server.js#L374-L375)).
- **Impact:** Low — the bridge binds `127.0.0.1` only, so exposure requires local code execution or
  another local service being tricked into calling it (SSRF from a co-hosted app). But an invoice/
  finalize endpoint with no auth on a shared host is a foot-gun.
- **Fix:** For self-hosted mode, generate and require the HMAC secret by default in the installer;
  keep "no auth" possible only behind an explicit opt-out.

### F3 — [Info] `sslverify => false` on the self-hosted bridge call
- [class-grinpay-gateway.php:551](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L551)
  and [class-grinpay-status.php:244](../../web/053_woocommerce/plugin/class-grinpay-status.php#L244)
  disable TLS verification. Acceptable because the target is `http://127.0.0.1` (no TLS to verify),
  but ensure this can never be pointed at a remote `http://` URL in self-hosted mode.

---

## Controls that are correct (no action)
- **No underpayment vector.** Payment uses the Grin **invoice flow**: `issue_invoice_tx` bakes the
  exact `amount` into the slate ([server.js:182-189](../../web/053_woocommerce/bridge/server.js#L182-L189)),
  and `finalize_tx` cryptographically rejects any buyer slate that doesn't fund that amount. So a
  buyer cannot pay less than the order total by tampering with the response slate — the amount is
  bound by consensus, not by a plugin-side comparison.
- **AJAX endpoints are gated.** Both `nopriv` handlers verify a WP nonce **and** the per-order
  `order_key` (`key_is_valid`) before acting
  ([:299-319](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L299-L319),
  [:378-390](../../web/053_woocommerce/plugin/class-grinpay-gateway.php#L378-L390)). Forcing
  completion without a valid signed slate is impossible — bridge `finalize` fails → `WP_Error` →
  no completion.
- **Idempotency.** Submit, poll, and cron all short-circuit if `_grinpay_status === 'confirmed'`
  before calling `payment_complete`, and each order's invoice `tx_id` is unique (no cross-order
  replay).
- **Bridge input hardening.** Amount regex `^\d+(\.\d{1,9})?$`, `SLATEPACK_RE`/`TXID_RE` validation,
  128 kB body cap, constant-time API-key + HMAC comparison, session token kept in memory only,
  `127.0.0.1` bind ([server.js:47-97](../../web/053_woocommerce/bridge/server.js#L47-L97),
  [168-257](../../web/053_woocommerce/bridge/server.js#L168-L257)).
- **PHP input handling.** `absint`/`sanitize_text_field`/`sanitize_textarea_field`/`wp_unslash` on
  all `$_POST`; output escaped in the thank-you render. Order meta via HPOS-safe CRUD.

---

## Priority for the operator
1. **F1** — align the interactive submit path with the confirmation policy (and fix the bridge's
   silent broadcast-failure) before taking mainnet orders where goods ship on "processing".
2. F2 — require the HMAC secret by default in self-hosted installs.
