# Script 09 — Connectivity Hub (091 Floonet relay / 092 Transporter) — Security Audit

**Scope:** 091 Floonet relay deployer and 092 Grin Transporter (store-and-forward slate relay).
*(Numbers swapped 2026-07-10: Floonet relay is now 091 / build priority; Transporter is 092 /
deferred.)*

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** **Nothing to audit yet — both are
unimplemented placeholders.** `scripts/091_*.sh` and `scripts/092_*.sh` print "COMING SOON — not
yet implemented" and no `web/09*` backend exists. This doc records the security requirements to
verify **when they are built**, so the audit isn't skipped at implementation time.

---

## Status
- **091 Floonet relay** — placeholder ([091_…sh](../../scripts/091_grin_floonet_relay.sh)).
  It *deploys* 2ro's floonet-rs (nginx/certbot/wss + firewall) — we deploy, we don't fork.
- **092 Transporter** — placeholder ([092_…sh](../../scripts/092_grin_transporter.sh)), DEFERRED.
  Planned: Node + Express + SQLite behind nginx on `127.0.0.1:7456/7466`, encrypted slate queue
  keyed by slatepack address. Design: [script09_design.md](script09_design.md).

---

## Security checklist for 091 (deployer)
1. **TLS/wss enforced** (certbot) — never proxy the relay in cleartext; don't write an SSL vhost
   before the cert exists (the toolkit's Let's Encrypt bootstrap rule).
2. **Firewall scope** — only the public wss/HTTPS port open; the relay's own port stays loopback
   (upstream default is already `127.0.0.1:8080` — keep it).
3. **We deploy upstream, unmodified** — pin the floonet-rs version/commit; verify the artifact
   (checksum/signature — note: no prebuilt releases as of 2026-07-10, so pin the git commit the
   source build uses) before running it as a service; run it as an unprivileged service user.
4. **Keep upstream's hardened unit** — `deploy/floonet-rs.service` ships DynamicUser,
   ProtectSystem=strict, syscall filtering; do not weaken it when adapting (e.g. if switching to
   a stable `User=floonet` for backups, keep every other hardening directive).
5. **Secrets handling** — `goblinpay.api_token` belongs in a 0600 `EnvironmentFile`
   (`FLOONET_GOBLINPAY_TOKEN`), never on argv or in a world-readable config.

## Security checklist to enforce when 092 is implemented
Distilled from the store-and-forward design and the money-handling patterns already validated in
059/07. Treat as the pre-merge gate.

1. **Ciphertext-only at rest.** The relay stores encrypted slates it cannot decrypt (armored
   slatepack / age-encrypted to the recipient address). The DB must never hold plaintext slates or
   any key material. Verify a DB dump reveals nothing spendable.
2. **Address-as-identity collection proof.** A slate is released only to a caller who proves
   control of the destination address (sign a server nonce / challenge with the address key) — not
   a guessable id. Do **not** reuse the pool's low-entropy IP-proof for this; a relay collection is
   a stronger action than min-payout. Throttle proof attempts (lockout), audit-log each.
3. **Enqueue abuse / DoS bounds.** Cap slate size, per-address queue depth, total queue size, and
   TTL-expire uncollected slates (mirror 059's invoice-expiry sweep). Rate-limit enqueue at nginx
   **and** in-app; the relay must not be a free spam/amplification store.
4. **No SSRF / no auto-finalize.** If the relay ever calls a wallet/node, target only configured
   localhost endpoints. Don't embed the server's Tor address in slates it forwards (the "ghost
   TxReceived" trap seen in 059/053) — keep it a dumb ciphertext store.
5. **Transport & exposure.** Bind `127.0.0.1`; nginx TLS (or Tor onion) only; `trust proxy`
   loopback + `req.ip`; strict body-size limit; parameterized SQLite (prepared statements).
6. **Pool/Drop rail caution.** Before wiring 092 as a payout rail for Script 07 or 059 (a stated
   goal), confirm the wallet actually supports relay-receive — the design doc flags this as
   unconfirmed (B.9 #6, the reason 092 is deferred). A payout rail that silently drops slates =
   stuck funds.

---

When either script gains real code, replace this file's checklist with findings against that code.
