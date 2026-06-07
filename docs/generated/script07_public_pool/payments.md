# GRINIUM — Payments (Tor + Slatepack)

**Updated:** 2026-06-06
**Status:** Design revised this round. **Supersedes** the old "Tor-only,
Slatepack deferred to Phase 2" decision.

This is the most security-sensitive part of the pool. Read it fully before
touching `withdrawal-scheduler.js`, `wallet.js`, or `wallet-tor.js`.

---

## Core insight: one transaction, two transports

Every Grin transaction is **interactive** (2-of-2: sender + receiver both build
it). "Tor" and "Slatepack" are **not two payment systems** — they're two
transports for the *same* slate round-trip. So GRINIUM builds **one withdrawal
state machine** with a `method` dimension; only the "deliver the slate" step
branches. Balance locking, retry, reversal, ledger, and audit are shared.

| Transport | What the miner does | Works if miner offline? | Pool calls |
|---|---|---|---|
| **Tor** | nothing — their wallet listener auto-signs | no | `init_send_tx` → post over Tor → `finalize_tx` |
| **Slatepack** | copy-paste: take S1, sign in wallet, paste S2 back | yes | `init_send_tx` (lazy) → miner returns S2 → `finalize_tx` |
| *Relay (future)* | nothing — relay delivers slate async | yes | ties into Grin Transporter / Script 056 |

The `method` column leaves room for `relay` later with no rework.

---

## Method selection (smooth UX, no accounts)

Both methods are available **from day one**, with no miner registration:

- **Manual withdrawal** (human on the account page): two buttons —
  **Auto-pay (Tor)** vs **Claim manually (Slatepack)**. Miner chooses.
- **Auto-payout** (6h scheduler, no human present): can only attempt the
  zero-interaction method → **Tor**. If Tor fails to reach an offline miner,
  the withdrawal becomes **Slatepack-claimable** instead of reversing. This is
  the only place "Tor-then-Slatepack fallback" applies.

This is strictly more robust than Tor-only: a miner whose wallet is offline for
days can always claim manually rather than having the payout reverse.

---

## Security model (read this — it corrects an earlier mistake)

For **Tor**, funds are safe because the slate is delivered to the address's own
Tor listener — it can't be redirected.

For **Slatepack**, the slate is *not* inherently address-bound: in Grin's flow
the **receiver supplies their own output** in S2, so whoever returns a valid S2
gets paid. A leaked slate/claim-link could therefore be completed by an attacker
paying *themselves*. Two controls close this:

1. **Claim token (anti-spam).** Each slatepack withdrawal mints a one-time
   secret token. The payout link is `pool.domain/claim/<id>?token=…`. Without it
   nobody can pull S1 — keeps randos from wasting pool resources.
2. **Payment proof (anti-theft) — the real guarantee.** Because the miner's
   identity *is* their Slatepack (ed25519) address, the pool calls `init_send_tx`
   with `payment_proof_recipient_address = <miner address>` and **refuses to
   finalize unless S2 carries a valid payment proof signed by that address's
   key.** An attacker can't forge it without the miner's wallet key, so funds
   reach the miner even if the token/slate leaks.

> Tor needs neither (listener is address-bound). Slatepack needs **both**.

### Anti-spam for withdrawal creation (public endpoint)

`POST /api/account/:addr/withdraw` is public (address-as-identity). Threats and
controls:

| Threat | Control |
|---|---|
| Create withdrawals for arbitrary/empty addresses | Require existing balance ≥ `min_withdrawal` → only real miners targetable |
| Repeatedly lock one miner's balance | **Max 1 pending withdrawal per address** (429 if exists) |
| High-volume mass creation | nginx rate-limit (30 r/m) on the endpoint |
| Lock stuck forever | Auto-expiry reverses the lock (≤ retry window) |
| **Slatepack-only:** mass creation exhausting the *pool* wallet's UTXOs | **Generate the slate lazily** — creation only locks the miner's balance + mints a token; `init_send_tx` (which locks pool UTXOs) runs only when the legit miner *starts* the claim |

Net: balance-lock griefing is no worse than the already-accepted Tor case, and
**no funds can be stolen** under either method.

---

## Balance model

Two columns on `miner_accounts`, always in sync (nanoGRIN integers):

- `balance` — spendable now
- `balance_locked` — held in a pending withdrawal

Invariant (checked in admin payment-stats):
```
SUM(balance + balance_locked) = SUM(shares.earned_grin) − SUM(confirmed withdrawals.amount+fee)
```

Transitions (each wrapped in an exclusive transaction, each logs `balance_log`):

| Event | balance | balance_locked |
|---|---|---|
| Create (CAS: only if balance ≥ amount+fee) | − (amount+fee) | + (amount+fee) |
| Confirm | — | − (amount+fee) |
| Permanent fail (retries exhausted) | + (amount+fee) | − (amount+fee) |
| Admin cancel | + (amount+fee) | − (amount+fee) |

Create is a compare-and-swap UPDATE `WHERE grin_address=? AND balance >=
amount+fee`; `rows_changed=0` → balance changed concurrently → **409**. Miner
pays **no fee** on a failed/cancelled withdrawal (full reversal). Fee is deducted
only on confirmed payouts and credited to `pool_fee_address`.

Config: `min_withdrawal` default 10 GRIN (single enforcement point; server
refuses to boot if missing/≤0). `withdrawal_fee` default 0.

---

## State machine

```
                         ┌──────────────┐
       create ──────────▶│ created      │ (balance locked, token minted if slatepack)
                         └──────┬───────┘
              method=tor        │        method=slatepack
        ┌───────────────────────┴───────────────────────┐
        ▼                                                ▼
  tor_checking                                    slate_pending
  (listener reachable?)                           (waiting for miner to claim)
     │ yes        │ no                               │ miner pulls S1 (token)
     ▼            ▼                                  ▼  init_send_tx (lazy)
 tor_sending   retry_scheduled ◀── backoff      slate_created
 (finalize)    (6/12/24/48h)                        │ miner returns S2
     │ fail ─────▶│  retry_count≥4                  ▼  verify payment proof
     │            ▼                              slate_returned
     │        tor_failed  ──(scheduler offers)─▶ (auto-converts to slatepack-claimable)
     │            │                                  │ finalize_tx
     ▼            ▼                                  ▼
  confirmed ◀─────┴──────────────────────────────  confirmed
  (balance_locked released, total_paid += amount, txid stored)

  admin (requireFreshAuth): retry → re-enter checking ;  cancel → cancelled (reversal)
```

**Status values:** `created | tor_checking | tor_sending | retry_scheduled |
slate_pending | slate_created | slate_returned | confirmed | tor_failed |
cancelled`. Any transition not on this diagram → 500 + alert.

**Tor retry backoff:** retry_count 0→6h, 1→12h, 2→24h, 3→48h, ≥4 → permanent
fail (full reversal). No TCP port-probe before send (probing leaks Tor circuit
identity — best-effort send instead).

**Slatepack expiry:** a `slate_pending`/`slate_created` withdrawal unclaimed past
its TTL (e.g. 7 days) reverses the balance lock, same as Tor exhaustion.

**Cancel:** admin-only, valid only from `retry_scheduled | tor_failed |
slate_pending`. Cannot cancel an in-flight `tor_sending`/`slate_returned` or a
`confirmed` withdrawal. Requires `requireFreshAuth` + audit log.

---

## Endpoints

```
POST /api/account/:addr/withdraw   { amount, method? }   public, address=identity
     validate: valid addr · amount ≥ min · amount+fee ≤ balance · no pending → 429
     method defaults to 'tor'; 'slatepack' mints claim_token, returns claim link

GET  /api/claim/:id?token=…                 slatepack: lazily init_send_tx, return S1
POST /api/claim/:id?token=…  { slatepack_s2 } slatepack: verify proof, finalize, confirm
GET  /api/account/:addr/tor-check           probe listener (rate-limited per addr)

POST /api/admin/withdrawals/:id/retry   [requireAdmin, requireFreshAuth(300)]
POST /api/admin/withdrawals/:id/cancel  [requireAdmin, requireFreshAuth(300)]
GET  /api/admin/withdrawals/:id/events
```

---

## Schema deltas (vs the base `withdrawals` table)

```sql
ALTER TABLE withdrawals ADD COLUMN method      TEXT NOT NULL DEFAULT 'tor';     -- tor | slatepack
ALTER TABLE withdrawals ADD COLUMN claim_token TEXT DEFAULT NULL;               -- one-time, slatepack
ALTER TABLE withdrawals ADD COLUMN txid        TEXT DEFAULT NULL;               -- idempotency
-- slate payloads (S1/S2) may live in a side table or transient store, never logged in cleartext
```
Money columns are **INTEGER nanoGRIN** (see [architecture.md](architecture.md)
schema; current code still uses REAL — BUG-16). `balance_log` and
`withdrawal_events` tables back the ledger and transition history.

---

## Admin payment-stats page

A dedicated admin page surfaces money health (`GET /api/admin/payment-stats`):

1. **Reconciliation card** — `total_credited − total_paid_out − total_in_balances
   − total_locked` must equal 0; red alert otherwise. (Withdrawal fees live in
   `pool_fee_address`'s balance, already inside `total_in_balances` — don't
   subtract twice.)
2. **Frequency (7d)** — withdrawals/day by status; Tor success rate; retry
   success rate; avg retries; avg time-to-confirm; 24h fail rate (flag > 10%).
3. **Anomaly flags** — ≥3 fails/7d per address; rapid creates (>2/h/addr); large
   withdrawal (> `alert_large_withdrawal`, default 100); reconciliation variance.
4. **Per-address drill-down** — full `balance_log` with running-balance
   validation; consistency OK/MISMATCH.
5. **Admin action history** — from `admin_audit_log`, filterable, CSV export.

---

## Reference

GaeaPool (`https://gaeapool.com/#/`) is a working Slatepack-withdrawal pool —
useful reference for the interactive flow. The old plan pointed miners there as
a stopgap "until Slatepack ships"; with this design, Slatepack ships in v1.
