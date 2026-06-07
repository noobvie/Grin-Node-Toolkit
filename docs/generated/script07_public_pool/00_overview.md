# GRINIUM — Documentation Index & Project Overview

**Updated:** 2026-06-06
**Status:** Pre-launch. Codebase scaffolded, partially working, not production-ready.

This file is the entry point. The old `docs/design_specification.md` and the
4,300-line `flowcharts/pool_flow_refactor.txt` have been split into the topic
files below. Read them in this order if you're getting re-oriented.

| Doc | What it covers |
|---|---|
| [00_overview.md](00_overview.md) | This file — index, current real status, stack reality |
| [architecture.md](architecture.md) | System layers, request flow, DB schema, API catalog, multi-region |
| [backend.md](backend.md) | Node.js `lib/*` modules, mining core, rewards, wallet, scheduler |
| [payments.md](payments.md) | **Updated** payment design — Tor **and** Slatepack, unified state machine |
| [infrastructure.md](infrastructure.md) | Deploy, nginx, systemd, ports, **database choice + backup runbook** |
| [security.md](security.md) | Auth/JWT, rate limiting, XSS/CSP, admin re-auth, data-leak hardening |
| [ui-ux.md](ui-ux.md) | Frontend reality, themes, **theme/UX rework**, public pages, SEO |
| [build-plan.md](build-plan.md) | **The master tracker** — bug catalog, Group A–F build order, pre-launch checklist |

> The original `pool_flow_refactor.txt` is kept temporarily as the source of
> truth these files were distilled from. Once you've confirmed this split is
> good, it can be deleted — its content lives in `build-plan.md` (status/bugs)
> and the topic files (design).

---

## What GRINIUM is

A self-hostable **public mining pool for Grin**, extracted from the Grin Node
Toolkit's script 07. The toolkit deploys the node; this repo is the full pool
stack that runs on top of a running node + grin-wallet.

Three layers:

1. **Bash deploy** (`deploy/pool_deploy.sh`) — install, nginx, systemd, config.
2. **Node.js backend** (`web/back-end-pool/`) — stratum, shares, PPLNS rewards,
   wallet payouts, monitoring, admin API.
3. **Frontend** (`web/public_html/` + `back-end-pool/admin-panel/`) — public
   stats, miner account pages, admin dashboard.

**Model:** address-as-identity (a miner's Grin address *is* their login — no
miner accounts). PPLNS rewards. Admin-only authentication.

---

## Stack reality — read this before trusting any "Next.js" mention

The planning history contains a "v4" decision to rewrite everything in
**Next.js + Tailwind**. **That rewrite never happened.** The newest reality
check, the `README.md`, and the actual code all confirm the live stack is:

| Layer | What's actually in the repo |
|---|---|
| Backend framework | **Express** (`web/back-end-pool/index.js`), not Next.js |
| Frontend | **Static HTML + vanilla JS** (`public_html/*.html`, `js/*.js`), not React |
| Styling | **`public_html/css/pool.css` + `js/theme.js`** (CSS variables), not Tailwind |
| Database | **SQLite via `better-sqlite3`** ✓ (this part matches the plan) |
| Process mgr | **systemd** ✓ |

Anywhere the old doc says "Next.js / Tailwind / App Router / `app/api/route.ts`",
treat it as an **abandoned proposal**, not current design. The topic docs here
describe the Express + HTML reality. (If a Next.js migration is ever revived,
that's a deliberate future decision — not the current baseline.)

---

## Current real status (snapshot)

The backend was stubbed across all phases in parallel and never tested
end-to-end, then partially fixed afterward. Net result: **it looks complete but
has bugs at load-bearing connection points.** Some bugs in the old audit are
already fixed; others remain. See [build-plan.md](build-plan.md) for the
verified, per-bug status.

Quick read on the big pieces:

| Area | State |
|---|---|
| Stratum (Grin protocol) | Rewritten to real Grin `login/submit/getjobtemplate` — **was** Bitcoin, now fixed |
| Wallet Owner API v3 ECDH | Handshake implemented (`init_secure_api` + secp256k1) — improved since audit |
| Money precision | **Still stored as floating-point `REAL`** — must move to integer nanoGRIN |
| Frontend auth gate | **Still broken** — `isLoggedIn()` Promise not awaited |
| Block-finding → reward → payout | Pipeline wiring incomplete |
| Multi-region | Stats federation designed, share accounting not wired |
| Payments | Tor-only in code; **this doc set adds the Tor+Slatepack design** |

---

## Decisions locked in this round (2026-06-06)

These supersede older notes where they conflict:

1. **Payments: support Tor AND Slatepack from the start** (reverses the old
   "Tor-only, Slatepack deferred" decision). One state machine, a `method`
   dimension. Tor = zero-interaction default; Slatepack = claim-token + payment-
   proof flow, also the automatic fallback when Tor can't reach an offline
   miner. See [payments.md](payments.md).
2. **Database: stay on SQLite now.** Migrate to **PostgreSQL** only if true HA/
   failover or cross-machine multi-writer pressure appears. **Not MariaDB.**
   Multi-region is solved by satellite federation + share-forwarding, not a
   shared network DB. See [infrastructure.md](infrastructure.md).
3. **Money is integer nanoGRIN** (1 GRIN = 1e9), engine-independent. Fix now.
4. **Code path: salvage, don't rewrite.** The hard Grin-specific parts (stratum,
   ECDH) already work; remaining bugs are bounded and documented.
5. **Theme/UX: rework needed** — the current `grinium-v1-atomic` neon aesthetic
   is unsatisfactory; see [ui-ux.md](ui-ux.md) for the open redesign item.
