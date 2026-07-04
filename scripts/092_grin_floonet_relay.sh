#!/bin/bash
# =============================================================================
# 092_grin_floonet_relay.sh — Floonet relay deployer
# =============================================================================
#
#  Member of the Grin Connectivity Hub (Script 09).
#
#  Deploys the community Grin-native Nostr relay stack (floonet-rs, by
#  github.com/2ro) the toolkit way: unprivileged service user + systemd +
#  nginx/certbot (replacing his Caddy) + firewall. We DEPLOY his software,
#  we do NOT fork it. Gaps found in his installer/docs → upstream PRs.
#
#  Package choice: floonet-rs (single Rust binary + config.toml + SQLite) over
#  floonet-strfry (C++ strfry + separate name-authority) — fewest moving parts.
#
#  Status: COMING SOON — this script is a placeholder.
#  Design: docs/generated/script09_design.md  (Part B — 092)
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
echo -e "${BOLD}${CYAN} 092) FLOONET RELAY${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${YELLOW}⚠  Coming soon — not yet implemented.${RESET}"
echo ""
echo -e "  ${BOLD}Deploy a Grin-native Nostr relay${RESET} ${DIM}(floonet-rs)${RESET}"
echo -e "  ${DIM}Join the P2P privacy network that carries encrypted slatepacks,${RESET}"
echo -e "  ${DIM}usernames (NIP-05) and marketplace events for Goblin-style wallets.${RESET}"
echo ""
echo -e "  ${BOLD}Planned deployer scope:${RESET}"
echo -e "  ${DIM}• Fetch prebuilt floonet-rs binary (or cargo build fallback)${RESET}"
echo -e "  ${DIM}• Unprivileged service user + hardened systemd unit${RESET}"
echo -e "  ${DIM}• nginx + certbot reverse proxy (wss://) — replaces his Caddy${RESET}"
echo -e "  ${DIM}• config.toml admin: event-kind whitelist, NIP-42 auth, name authority${RESET}"
echo -e "  ${DIM}• Optional Nym mixnet exit + GoblinPay paid-registration${RESET}"
echo -e "  ${DIM}• Day-2 admin: status/restart, SQLite backup, log view${RESET}"
echo ""
echo -e "  ${DIM}Upstream : https://github.com/2ro/floonet-rs  •  docs.floonet.dev${RESET}"
echo -e "  ${DIM}Design doc : docs/generated/script09_design.md${RESET}"
echo ""
echo -ne "${DIM}Press Enter to return to the hub...${RESET}"
read -r || true
