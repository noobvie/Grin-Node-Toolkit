# GRINIUM — Backend

**Updated:** 2026-06-06
Node.js / **Express**, single long-lived process per network, `better-sqlite3`
(synchronous). Entry point: `web/back-end-pool/index.js`. Bug references (BUG-NN)
point to [build-plan.md](build-plan.md).

---

## Module map (`web/back-end-pool/lib/`)

| Module | Responsibility | Key issues to fix |
|---|---|---|
| `config.js` | Load `pool.json`, defaults, `currency()` helper | jwt_secret must not auto-regenerate (BUG-37); fail-fast on bad config |
| `db.js` | Schema init, raw SQL, transactions | audit-log column shape (BUG-18); money → INTEGER nanoGRIN (BUG-16) |
| `auth.js` | bcrypt, JWT issue/verify, refresh, lockout | bcrypt rounds 12 (BUG-23); refresh revocation (BUG-21); lockout (BUG-22) |
| `auth-middleware.js` | `requireAdmin`, `requireFreshAuth(300)` | wire fresh-auth on retry/cancel |
| `rate-limiter.js` | Per-IP request limiting | use `req.ip` + trust proxy, not X-Forwarded-For (BUG-20) |
| `ip-filter.js` | Admin allow/deny lists | same trust-proxy fix (BUG-20) |
| `stratum-protocol.js` | Grin stratum message parse/format | now Grin (`login/submit/getjobtemplate`) — was Bitcoin, fixed |
| `stratum-server.js` | TCP server, sessions, jobs | per-socket recv buffer (BUG-08); jobId increment + Set (BUG-07) |
| `shares.js` | Accept/store shares | real timestamp, not `Date.parse(hash)` (BUG-06) |
| `miners.js` | Miner row lifecycle | single instance shared with stratum (BUG-40); `INSERT OR IGNORE` |
| `hashrate-tracker.js` | GPS from accepted-share difficulty | use accepted-share sum, not session target (BUG-39) |
| `grin-node.js` | Node Owner + Foreign API client | Foreign needs Basic Auth too (BUG-15); drop node-fetch (BUG-38) |
| `block-monitor.js` | Watch tip, confirm-depth, trigger distribution | block-finding pipeline missing (BUG-02); call distribute (BUG-04) |
| `rewards.js` | PPLNS distribution, fee routing | grinNode undefined (BUG-05); double-pay guard (BUG-03) |
| `orphan-detector.js` | Nonce-check confirmed blocks, reverse | exact-amount reversal from ledger (BUG-17) |
| `wallet.js` | grin-wallet Owner API v3 (ECDH) | v3 handshake present; use `init_send_tx`/`finalize_tx` (BUG-14) |
| `wallet-tor.js` | Tor send wrapper | command injection (BUG-11); Grin-address regex not .onion (BUG-12) |
| `withdrawal-scheduler.js` | Auto-payout + retry queue | atomic balance lock (BUG-09); enforce limits (BUG-10) |
| `pool-settings.js` | Runtime settings in DB | honor `value_type='json'` (BUG-25) |
| `alert-monitor.js` | Health checks → alerts | field/method mismatches (BUG-24); wire delivery (BUG-26) |
| `alert-delivery.js` | Email / Discord / Slack senders | invoked by alert-monitor, not stubbed |
| `asset-manager.js` | Admin logo/asset uploads | drop SVG (BUG-29); register static route (BUG-30); multer v2 (BUG-31) |
| `poolstats-reporter.js` | Push to miningpoolstats.stream | Phase 2+, low priority |

---

## Mining core

**Stratum (Grin Cuckatoo32).** Miners connect to the stratum TCP port and
authenticate with `grin_address.worker_name` (or bare `grin_address`) as the
login — address-as-identity, no registration. Protocol verbs: `login`,
`getjobtemplate`, `submit`, `status`, `keepalive`. Each `submit` carries
`{nonce, pow[42], edge_bits}`.

Hard requirements (pre-launch):
- **Per-socket receive buffer** — TCP fragmentation means a single
  `data.toString().split('\n')` loses partial lines. Buffer until newline.
- **Job id increments** per new job; track sockets in a `Set` (Node removed
  `server.connections`).
- **Worker-name validation** — `^grin1[a-z0-9]+(\.[a-z0-9]+)?$`; reject and
  disconnect on anything else (prevents XSS/injection via worker names).
- **`INSERT OR IGNORE`** miner auto-create on first connection (race-safe; never
  check-before-insert).
- **One `MinerManager`/`ShareValidator` instance** constructed in `index.js` and
  passed into the stratum server — not two competing instances.

**Hashrate.** Use the CLAUDE.md formula on accepted-share difficulty over the
window: `GPS = sumDiff × 42 / window_seconds / 16384`. Do **not** use the
assigned session target (that always reads ~0). Share weight is currently fixed
at 1.0 (the stratum log lines don't expose per-share difficulty; weighting is a
future improvement requiring TCP-stream parsing).

---

## Block → reward → payout pipeline

```
1. Pool wallet receives coinbase output for a block the pool found
2. block-monitor records it: blocks(status='pending', nonce, height, reward)
3. confirmation job (every 30s): tip_height - block.height >= confirm_depth ?
4. orphan-detector: is the block's nonce still in the chain (get_outputs)?
        no  → status='orphan', reverse exact credited amounts from balance_log
        yes → status='confirmed'  →  rewards.distributeRewards(blockId)
5. PPLNS distribution over the last-N-blocks share window
6. withdrawal-scheduler pays out when balance ≥ threshold (Tor/Slatepack)
```

**`confirm_depth` = 1441 blocks (mainnet, ~1 day) / 100 (testnet).** This is the
production-pool-validated value (matches Grin's `COINBASE_MATURITY = 1440`).
The old "10 blocks" note is wrong and superseded. Operator may lower it only if
they understand reorg risk.

**PPLNS (must-fix design):**
- Window = last N blocks' worth of shares (config).
- Each distributed share gets `paid_in_block_id` set inside the distribution
  transaction; `getSharesForDistribution()` filters `WHERE paid_in_block_id IS
  NULL`. Without this, two blocks within the window pay overlapping shares twice
  (BUG-03).
- `rewards.js` must receive `grinNode` in its constructor (passed from
  `index.js`) or blockchain verification is silently skipped (BUG-05).
- **Fee routing:** `fee = gross − net`; if `pool_fee_address` set, credit it as a
  normal `miner_accounts` row (auto-create) and log a `shares` row
  (`worker_name='pool_fee'`). Default `pool_fee_percent = 0`.
- **Orphan reversal** reads the *actual* credited amounts from `balance_log`
  (per `paid_in_block_id`) and reverses those exact values — including the pool
  fee credit. Refuses to push any balance below 0; flags for admin instead.

---

## Wallet integration

- **Owner API v3** with the ECDH session flow: `init_secure_api` → secp256k1
  key exchange → AES-256-GCM encrypted calls. Handshake is implemented in
  `wallet.js`. Sends use `init_send_tx` → `finalize_tx` (there is no `send`
  method on the Owner API).
- **Node Foreign API also requires Basic Auth** (`grin:<foreign_api_secret>`),
  not just the Owner API (BUG-15).
- **Drop `node-fetch`** — Node 18+ has global `fetch`; use `AbortController` for
  timeouts (node-fetch v2's timeout option silently doesn't work, BUG-38).
- **Tor sends** go through `grin-wallet` with `execFile(['grin-wallet', …])` —
  **never** `spawn('bash', ['-c', cmd])` with interpolated address/amount
  (command injection, BUG-11). grin-wallet handles Tor routing internally via
  its own SOCKS config; no raw `.onion` probing.
- **Idempotency (pre-launch):** determine whether `grin-wallet send` is
  idempotent on retry. If not, cache `withdrawals.txid` and reuse it on retry;
  verify via `get_tx(txid)`. Never allow two txids for one withdrawal.
- **stdout parsing fragility:** if relying on parsing `Send Command Result:
  <JSON>` from stdout, pin/verify the grin-wallet version and fall back to a
  `manual_review` DB flag on parse failure.

See [payments.md](payments.md) for the full withdrawal flow (Tor + Slatepack).

---

## Scheduler jobs (node-cron)

| Job | Cadence | Purpose |
|---|---|---|
| Block confirmation | 30s | promote pending blocks past confirm_depth → distribute |
| Orphan detection | 6h | nonce-check confirmed blocks; reverse orphans |
| Auto-payout | 6h | pay miners with balance ≥ threshold (if `auto_payout=true`) |
| Withdrawal retry | 30m | re-attempt `retry_scheduled` withdrawals past `next_retry_at` |
| Region aggregation | 60s | pull satellite `/api/pool/stats` → `hashrate_history` |
| Reconciliation | daily 03:00 | ledger-vs-balance check; alert on variance |
| miningpoolstats push | daily 02:00 | optional external leaderboard (Phase 2+) |

---

## Cross-cutting backend requirements

- **Graceful shutdown:** handle SIGTERM/SIGINT → stop scheduler → `server.close`
  → `db.close()`. systemd sends SIGTERM on stop; clean exit flushes the SQLite
  WAL.
- **Node ≥ 18 guard** in the bash installer (global `fetch` dependency).
- **Helmet** for security headers (defense-in-depth atop nginx); CSP left to
  nginx. See [security.md](security.md).
- **Single source for miner/session state** (BUG-40) so `/api/stratum/stats` and
  `/api/pool/stats` never disagree.
- **No hardcoded/fake metrics** in the dashboard route (BUG-33) — compute or omit.
- System metrics (load/mem) via built-in `os` module — no extra dependency.
