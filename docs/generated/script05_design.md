# Script 05 hub — designs for planned wallet/payment products

Designs for products the Script 05 hub will launch **once they are built**. They live under
the hub's number `05` on purpose: an unbuilt product has **no number of its own**, and naming
a design doc `script055_*` would reserve `055` — the habit that scrambled the hub menu in the
first place. A product gets its own number the day its first file is created (see the "Menu
ordering rule" block in `scripts/05_grin_wallet_service.sh`), and its design moves to
`script<num>_design.md` then. Same pattern as GoblinPay living in `script09_design.md` PART C.

Contents:

- **PART A — Accio, the public web wallet** (below)
- PART B — Payment Pro: not designed yet; the feature sketch is in the hub script header.

---

# PART A — Accio, the Grin public web wallet (design)

**Status: PLANNED — not implemented, no script file.** This preserves the design that lived in
the header of `scripts/055_grin_public_web_wallet.sh`, a placeholder "coming soon" screen
removed 2026-07-29 when the hub menu stopped listing unbuilt products.

## Concept

A self-custodial, client-side web wallet for Grin — serving any number of users without
holding their keys.

Inspired by mwcwallet.com / MWC-Wallet-Standalone (NicolasFlamel1). MWC shares the same
MimbleWimble protocol as Grin, so their approach is the blueprint:

- All cryptography runs in the browser (WebAssembly or pure JS)
- Private keys never leave the user's device
- `wallet_data` stored in browser IndexedDB (or exported as a file)
- Server only serves static files — zero knowledge of any user's funds
- Scales to any number of concurrent users with no extra server load

## Architecture

```
User's Browser
  ├── grin-wallet-wasm.js / grin-wallet-wasm.wasm
  │     ↑ Grin crypto compiled to WASM (key gen, tx building, slatepack)
  ├── IndexedDB
  │     ↑ Encrypted wallet_data per user (seed stays in browser only)
  └── Connects to → Grin node Foreign API (your node or a public one)

Your Server
  └── nginx serves /var/www/grin-public-wallet/ (static HTML/JS/CSS/WASM)
        no grin-wallet process, no per-user ports, no custody
```

## Planned web source directory

```
web/<num>_public_wallet/
  public_html/
    index.html
    css/
    js/
      grin-wallet-wasm.js      ← compiled from Rust (grin-wallet crate)
      grin-wallet-wasm.wasm
      wallet-ui.js
      slatepack.js
    wasm/                      ← raw WASM build artefacts
```

## Key technical work required (not bash)

1. **Build WASM bindings from the grin-wallet Rust crate**
   ```
   cargo install wasm-pack
   wasm-pack build --target web grin-wallet-wasm/
   ```
   Exposes: `keygen`, `init_wallet`, `create_tx`, `finalize_tx`, `slatepack_encode`,
   `slatepack_decode`, `get_address`.

2. **Browser wallet-data encryption** — AES-GCM via Web Crypto API, key derived from the
   user passphrase (PBKDF2). Encrypted blob stored in IndexedDB per wallet.

3. **Slatepack interactive tx flow (browser-side)**
   - Send: browser creates slate → user copies slatepack → sends to payee
   - Receive: user pastes response slatepack → browser finalises → broadcasts

4. **Node connection** — connects to the Grin Foreign API (default: your node on port 3413).
   User can override with any public or private node URL.

## Planned deploy menu

```
1) Install dependencies    (nginx, certbot — no php, no wallet binary)
2) Build WASM              (requires Rust + wasm-pack on build machine)
3) Deploy web files        (web/<num>_public_wallet/ → /var/www/grin-public-wallet/)
4) Configure nginx         (static site — no fastcgi, no reverse proxy)
5) Setup SSL               (Let's Encrypt or Cloudflare Origin Cert)
6) Configure node URL      (which Grin node to connect to by default)
7) Status
0) Back
```

## Nginx serving model

- No Basic Auth — this is public
- CORS header for node API calls (if proxying node requests through nginx)
- Strong CSP: `script-src 'self'; connect-src 'self' <node-url>`
- WASM files served with `Content-Type: application/wasm`

## Deploy paths

| | |
|---|---|
| Web root | `/var/www/grin-public-wallet/` |
| nginx conf | `/etc/nginx/sites-available/grin-public-wallet` |
| Server-side wallet dirs | none — nothing under `/opt/grin/` |

## Prerequisite

Design begins after MWC-Wallet-Standalone is studied and Grin-specific crypto differences
are mapped (if any).

## Reference

- https://github.com/NicolasFlamel1/MWC-Wallet-Standalone
- https://mwcwallet.com/
- https://github.com/mimblewimble/grin-wallet (Rust crate — WASM source)
