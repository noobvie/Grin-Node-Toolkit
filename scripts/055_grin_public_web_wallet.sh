#!/bin/bash
# =============================================================================
# 055_grin_public_web_wallet.sh — Grin Public Web Wallet
# =============================================================================
#
#  A self-custodial, client-side web wallet for Grin — serving any number of
#  users without holding their keys.
#
#  Inspired by: mwcwallet.com / MWC-Wallet-Standalone (NicolasFlamel1)
#  Since MWC shares the same MimbleWimble protocol as Grin, their approach
#  is the blueprint:
#
#    • All cryptography runs in the browser (WebAssembly or pure JS)
#    • Private keys never leave the user's device
#    • wallet_data stored in browser IndexedDB (or exported as a file)
#    • Server only serves static files — zero knowledge of any user's funds
#    • Scales to any number of concurrent users with no extra server load
#
#  ─── Architecture ────────────────────────────────────────────────────────────
#
#    User's Browser
#      ├── grin-wallet-wasm.js / grin-wallet-wasm.wasm
#      │     ↑ Grin crypto compiled to WASM (key gen, tx building, slatepack)
#      ├── IndexedDB
#      │     ↑ Encrypted wallet_data per user (seed stays in browser only)
#      └── Connects to → Grin node Foreign API (your node or a public one)
#
#    Your Server
#      └── nginx serves /var/www/grin-public-wallet/ (static HTML/JS/CSS/WASM)
#            no grin-wallet process, no per-user ports, no custody
#
#  ─── Planned web source directory ─────────────────────────────────────────
#    web/055_public_wallet/
#      public_html/
#        index.html
#        css/
#        js/
#          grin-wallet-wasm.js      ← compiled from Rust (grin-wallet crate)
#          grin-wallet-wasm.wasm
#          wallet-ui.js
#          slatepack.js
#        wasm/                      ← raw WASM build artefacts
#
#  ─── Key technical work required (not bash) ──────────────────────────────
#    1. Build WASM bindings from grin-wallet Rust crate
#         cargo install wasm-pack
#         wasm-pack build --target web grin-wallet-wasm/
#       → Exposes: keygen, init_wallet, create_tx, finalize_tx,
#                  slatepack_encode, slatepack_decode, get_address
#
#    2. Browser wallet-data encryption
#         AES-GCM via Web Crypto API — key derived from user passphrase (PBKDF2)
#         Encrypted blob stored in IndexedDB per wallet
#
#    3. Slatepack interactive tx flow (browser-side)
#         Send:    browser creates slate → user copies slatepack → sends to payee
#         Receive: user pastes response slatepack → browser finalises → broadcasts
#
#    4. Node connection
#         Connects to Grin Foreign API (default: your node on port 3413)
#         User can override with any public or private node URL
#
#  ─── Planned deploy menu ─────────────────────────────────────────────────
#   1) Install dependencies    (nginx, certbot — no php, no wallet binary)
#   2) Build WASM              (requires Rust + wasm-pack on build machine)
#   3) Deploy web files        (web/055_public_wallet/ → /var/www/grin-public-wallet/)
#   4) Configure nginx         (static site — no fastcgi, no reverse proxy)
#   5) Setup SSL               (Let's Encrypt or Cloudflare Origin Cert)
#   6) Configure node URL      (which Grin node to connect to by default)
#   7) Status
#   0) Back
#
#  ─── Nginx serving model ─────────────────────────────────────────────────
#   No Basic Auth — this is public
#   CORS header for node API calls (if proxying node requests through nginx)
#   Strong CSP: script-src 'self'; connect-src 'self' <node-url>
#   WASM files served with: Content-Type: application/wasm
#
#  ─── Deploy path ─────────────────────────────────────────────────────────
#   Web root:    /var/www/grin-public-wallet/
#   nginx conf:  /etc/nginx/sites-available/grin-public-wallet
#   No /opt/grin/ wallet directories — nothing server-side
#
#  Status: COMING SOON — WASM build layer not yet implemented.
#  Design will begin after MWC-Wallet-Standalone is studied and Grin-specific
#  crypto differences are mapped (if any).
#
#  Reference:
#    https://github.com/NicolasFlamel1/MWC-Wallet-Standalone
#    https://mwcwallet.com/
#    https://github.com/mimblewimble/grin-wallet  (Rust crate — WASM source)
#
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

clear
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${CYAN} 055) GRIN PUBLIC WEB WALLET${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${YELLOW}Coming soon — not yet implemented.${RESET}"
echo ""
echo -e "  ${BOLD}Concept:${RESET}"
echo -e "  ${DIM}Self-custodial web wallet where all crypto runs in the user's${RESET}"
echo -e "  ${DIM}browser via WebAssembly. The server holds no keys, no wallet${RESET}"
echo -e "  ${DIM}processes — just static files. Scales to any number of users.${RESET}"
echo ""
echo -e "  ${BOLD}Inspired by:${RESET}"
echo -e "  ${DIM}• mwcwallet.com (MimbleWimble Coin client-side wallet)${RESET}"
echo -e "  ${DIM}• MWC-Wallet-Standalone by NicolasFlamel1 (GitHub)${RESET}"
echo -e "  ${DIM}• Same MimbleWimble protocol → approach is directly applicable${RESET}"
echo ""
echo -e "  ${BOLD}Planned features:${RESET}"
echo -e "  ${DIM}• Grin-wallet Rust crate compiled to WASM (wasm-pack)${RESET}"
echo -e "  ${DIM}• Keys stored encrypted in browser IndexedDB (AES-GCM / PBKDF2)${RESET}"
echo -e "  ${DIM}• Full slatepack send/receive flow in-browser${RESET}"
echo -e "  ${DIM}• Connect to any Grin node (default: your own)${RESET}"
echo -e "  ${DIM}• Exportable wallet backup file${RESET}"
echo -e "  ${DIM}• No registration, no accounts, no server custody${RESET}"
echo ""
echo -e "  ${BOLD}Server role:${RESET}  ${DIM}nginx static file host — nothing else${RESET}"
echo -e "  ${BOLD}Web source:${RESET}   ${DIM}web/055_public_wallet/public_html/${RESET}"
echo -e "  ${BOLD}Deploy path:${RESET}  ${DIM}/var/www/grin-public-wallet/${RESET}"
echo ""
echo -ne "${DIM}Press Enter to return to main menu...${RESET}"
read -r || true
