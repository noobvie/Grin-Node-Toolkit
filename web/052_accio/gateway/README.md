# `grin-accio-gateway` — our Node service (empty until S3)

One service, four jobs. It exists because a browser tab can neither open a listening socket
nor answer a CORS preflight, so **both directions of a browser wallet need a server**.

| Job | Replaces | Packet |
|---|---|---|
| `/tor/<url>` forwarder — HTTP → Tor SOCKS5 `127.0.0.1:9050` | `SOCKS-Proxy` nginx module (MIT) | **S3** |
| SSRF destination allowlist on `/tor/` | `Block-Access` nginx module (MIT) | **S3** |
| Response-header allowlist (a hostile onion must not inject headers) | `Allow-Headers` nginx module (MIT) | **S3** |
| `/listen` WebSocket + `/wallet/<id>/v2/foreign` inbound URL | `WebSocket-Listener` — **unlicensed, cannot be shipped** | **S4a** spec → **S4b** build |

Collapsing the three nginx modules into this service is the point: they build as `.so`
against the exact installed nginx, so an `apt upgrade nginx` makes `load_module` fail and
nginx then refuses to start **at all**, taking every other vhost on the box down with it.
Stock nginx, no modules, no apt-hold.

**Ground rules for whoever writes this**

- It never touches a key. The seed is in the tab; this service moves ciphertext and bytes.
- Node + Express + SQLite, per the toolkit stack. **093 Transporter is the same shape** — a
  store-and-forward slate queue — so reuse its lib patterns rather than inventing new ones.
- Bind `127.0.0.1` only; nginx and Tor front it.
- **The onion gets its own local port** (7580/7590, vs 7480/7490 for nginx). nginx and Tor
  both arrive on `127.0.0.1`, so peer address cannot distinguish them — and a Tor client
  controls its own headers, so it could forge `X-Forwarded-For` and mint a fresh identity per
  request, voiding every per-client limit. Classify by `socket.localPort` and honour
  forwarding headers on the nginx port only.
- `docs/upstream-nginx.conf.reference` is the behavioural spec for the routes being replaced
  (the `/tor/` regex, the header allowlists, upstream's gateway on `:9000`). Read it; do not
  deploy it.

S8 audits this service specifically: the `/tor/` forwarder as an SSRF surface (we own this
guard outright now — more auditable, but no longer a battle-tested filter, so test it hard),
per-wallet URL authorisation, and response-header leakage from hostile onions.
