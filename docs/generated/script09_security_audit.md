# Script 09 — Connectivity Hub (091 Transporter / 092 Floonet relay) — Security Audit

**Scope:** 091 Grin Transporter (store-and-forward slate relay) and 092 Floonet relay deployer.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** **Nothing to audit yet — both are
unimplemented placeholders.** `scripts/091_*.sh` and `scripts/092_*.sh` print "COMING SOON — not
yet implemented" and no `web/09*` backend exists. This doc records the security requirements to
verify **when they are built**, so the audit isn't skipped at implementation time.

---

## Status
- **091 Transporter** — placeholder ([091_…sh:17](../../scripts/091_grin_transporter.sh#L17)).
  Planned: Node + Express + SQLite behind nginx on `127.0.0.1:7456/7466`, encrypted slate queue
  keyed by slatepack address. Design: [script09_design.md](script09_design.md).
- **092 Floonet relay** — placeholder ([092_…sh:16](../../scripts/092_grin_floonet_relay.sh#L16)).
  It *deploys* 2ro's floonet-rs (nginx/certbot/wss + firewall) — we deploy, we don't fork.

---

## Security checklist to enforce when 091 is implemented
Distilled from the store-and-forward design and the money-handling patterns already validated in
052/07. Treat as the pre-merge gate.

1. **Ciphertext-only at rest.** The relay stores encrypted slates it cannot decrypt (armored
   slatepack / age-encrypted to the recipient address). The DB must never hold plaintext slates or
   any key material. Verify a DB dump reveals nothing spendable.
2. **Address-as-identity collection proof.** A slate is released only to a caller who proves
   control of the destination address (sign a server nonce / challenge with the address key) — not
   a guessable id. Do **not** reuse the pool's low-entropy IP-proof for this; a relay collection is
   a stronger action than min-payout. Throttle proof attempts (lockout), audit-log each.
3. **Enqueue abuse / DoS bounds.** Cap slate size, per-address queue depth, total queue size, and
   TTL-expire uncollected slates (mirror 052's invoice-expiry sweep). Rate-limit enqueue at nginx
   **and** in-app; the relay must not be a free spam/amplification store.
4. **No SSRF / no auto-finalize.** If the relay ever calls a wallet/node, target only configured
   localhost endpoints. Don't embed the server's Tor address in slates it forwards (the "ghost
   TxReceived" trap seen in 052/053) — keep it a dumb ciphertext store.
5. **Transport & exposure.** Bind `127.0.0.1`; nginx TLS (or Tor onion) only; `trust proxy`
   loopback + `req.ip`; strict body-size limit; parameterized SQLite (prepared statements).
6. **Pool/Drop rail caution.** Before wiring 091 as a payout rail for Script 07 or 052 (a stated
   goal), confirm the wallet actually supports relay-receive — the design doc flags this as
   unconfirmed. A payout rail that silently drops slates = stuck funds.

## Security checklist for 092 (deployer)
1. **TLS/wss enforced** (certbot) — never proxy the relay in cleartext; don't write an SSL vhost
   before the cert exists (the toolkit's Let's Encrypt bootstrap rule).
2. **Firewall scope** — only the public wss/HTTPS port open; the relay's own port stays loopback.
3. **We deploy upstream, unmodified** — pin the floonet-rs version/commit; verify the artifact
   (checksum/signature) before running it as a service; run it as an unprivileged service user.

---

When either script gains real code, replace this file's checklist with findings against that code.
