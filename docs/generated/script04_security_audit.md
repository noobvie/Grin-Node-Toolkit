# Script 04 — Node Foreign API Exposure — Security Audit

**Scope:** how Script 04 publishes the Grin node's API to the world — MODE A (raw TCP firewall
port), MODE B (nginx HTTPS reverse proxy), and the Tor onion variant. Focus: over-exposure of
management endpoints, transport privacy, rate-limiting.

**Date:** 2026-07-10 · **Auditor:** Claude · **Verdict:** MODE B (nginx) is well-designed —
path-restricted to `/v2/foreign`, TLS, rate-limited, `/v2/owner` explicitly blocked. **MODE A
is materially riskier than the UI conveys:** it binds the node's *whole* API server to
`0.0.0.0` in cleartext, which also exposes the `/v2/owner` management path and sends secrets
over plaintext HTTP.

---

## Findings

### F1 — [Medium] MODE A (raw TCP) exposes the Owner/management API path and is cleartext
- **Evidence:** `_enable_raw_tcp()` binds the node API to `0.0.0.0:$port` and opens the firewall
  ([04_grin_node_foreign_api.sh:1529-1543](../../scripts/04_grin_node_foreign_api.sh#L1529-L1543)).
  The node serves **both** `/v2/foreign` **and** `/v2/owner` on that single port (path-based, per
  CLAUDE.md), so a raw TCP bind cannot filter by path the way MODE B's nginx does
  ([:719-720](../../scripts/04_grin_node_foreign_api.sh#L719-L720) blocks `/v2/owner` — MODE A has
  no equivalent). The header advertises MODE A as "No SSL" but does not warn that the **owner
  endpoint becomes internet-reachable**.
- **Impact:** In MODE A, `http://host:$port/v2/owner` (compact_chain, validate_chain, get_status,
  peer management, etc.) is reachable from the internet, defended **only** by the `.api_secret`.
  And because there is no TLS, the HTTP Basic secret and every request/response travel in
  cleartext — interceptable on any hop, and any tx pushed via `push_transaction` is observable
  (a deanonymization concern for a privacy coin). This is strictly more exposed than MODE B.
- **Fix:** (a) Recommend MODE B (nginx) as the default and document MODE A as "advanced / trusted
  network only." (b) In the MODE A flow, warn explicitly that `/v2/owner` is exposed and require a
  strong `.api_secret`. (c) If a raw public node is genuinely wanted, prefer binding only the
  foreign listener, or front it with a path-filtering proxy even without a domain.

### F2 — [Low] No TLS on MODE A → cleartext Basic-auth secret
- Covered above; called out separately because even on a trusted LAN, shipping the node API
  secret as cleartext HTTP Basic auth is a foot-gun if the "LAN" is a shared VPS segment. Prefer
  the onion variant or nginx+TLS for any non-loopback exposure.

---

## Controls that are correct (no action)
- **MODE B nginx proxy** exposes only `location /v2/foreign`, returns 403 on everything else
  including `/v2/owner`, terminates TLS (Let's Encrypt), and rate-limits via the shared `grin_api`
  zone (`burst=200 nodelay`) — [04_grin_node_foreign_api.sh:687-720](../../scripts/04_grin_node_foreign_api.sh#L687-L720).
  CORS `*` is acceptable for a read-only public JSON-RPC endpoint.
- **Optional `/rest/*.json`** helper endpoints are also rate-limited and directory-listing is 403'd
  ([:438-447](../../scripts/04_grin_node_foreign_api.sh#L438-L447)).
- **Tor onion variant** proxies only `/v2/foreign` and 403s the rest
  ([:1079-1091](../../scripts/04_grin_node_foreign_api.sh#L1079-L1091)) — same path discipline as
  MODE B, with Tor providing transport privacy.
- Rate-limit zone is created via the shared helper (`grin_api`, shared with Script 06), never
  inline — consistent with the toolkit's nginx conventions.

---

## Priority for the operator
1. **F1** — treat MODE A as trusted-network-only; use MODE B or the onion variant for any real
   public exposure so `/v2/owner` stays unreachable and traffic is encrypted. Ensure a strong
   `.api_secret` regardless.
