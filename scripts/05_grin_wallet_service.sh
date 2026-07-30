#!/bin/bash
# =============================================================================
# 05_grin_wallet_service.sh — Grin Wallet Services Hub
# =============================================================================
#
#  Central launcher for all Grin wallet service scripts (051–053).
#  Each sub-script is fully self-contained — it manages its own wallet,
#  binary, nginx config, and systemd services independently.
#
#  Both mainnet and testnet can run on the same server simultaneously.
#  Each service is best run on its own dedicated server to avoid port
#  conflicts and security mixing between services.
#
#  ─── Sub-scripts ──────────────────────────────────────────────────────────
#   051  051_grin_private_web_wallet.sh   Personal browser wallet UI
#   052  052_grin_drop.sh                 Giveaway + donation portal
#   053  053_grin_woocommerce.sh          WooCommerce payment gateway
#   05C  (built into this hub)            CMD wallet quick setup — CLI / testing
#   (Grin Transporter moved to the Grin Connectivity Hub → scripts/092_grin_transporter.sh)
#
#  ─── Menu ordering rule ───────────────────────────────────────────────────
#  The KEY is positional — assigned top-to-bottom as rows are rendered. Because
#  the key is positional, no future product can put the keys out of order,
#  whatever number it is given (same rule as the 07 and 09 hubs).
#
#  Digits and letters are TWO independent ascending sequences: digits key the
#  numbered products, letters key hub-built utilities that have no script file of
#  their own. Each sequence ascends down the screen.
#
#  ─── Numbers are internal — the menu shows NAMES only ─────────────────────
#  051 / 052 / 053 / 05C are file and doc identity. They are NOT printed on the
#  menu rows: an operator picking a wallet does not care which integer its script
#  got, and two numbers per row ("A) 05C ·") read as a broken sequence.
#
#  The number IS printed on each product's own screen banner ("05C) GRIN WALLET
#  QUICK SETUP"), which is the toolkit-wide convention (01, 052, 091 …). That is
#  the one place it belongs — it tells you where you are after a clear — and it
#  is why the menu row can drop it without the number becoming unfindable.
#
#  Consequence for anything that prints to an operator: never name a product by
#  its number alone. Port-collision errors in the 07 libs say "the CMD Wallet
#  quick setup (hub 05)", not "05C" — the number is a hint in brackets, the name
#  is what the operator can actually find on a menu.
#
#  Within a group, rows are ordered by readiness: ✅ ready, then 🔧 building,
#  then planned. The first thing you see in a group is the thing that works.
#
#  ─── Planned — no number assigned yet ─────────────────────────────────────
#  Planned products get a KEYLESS dim row inside the category they will belong
#  to, so the menu shows where they are heading without reserving anything. They
#  gain a key at that position on the day they are built. Never give a planned
#  row a live key — a key that prints "coming soon" is the placeholder script we
#  deleted, in miniature.
#
#  Numbers are assigned when a build STARTS — the next free integer, nothing
#  more. Do NOT try to make the number encode the category: 051/052/053 are
#  already one-per-category, so no contiguous per-category band can exist without
#  renumbering, and a band scheme seals every group except the last one anyway.
#  Pre-assigning numbers to ideas is what made this menu read 1,5,C,3,4,6,2.
#
#   Payment Pro        Grin payment processor for platforms other than WooCommerce
#                      (Shopify, custom/headless APIs, subscription billing).
#                      Planned: generic REST API bridge, Shopify payment app,
#                      recurring GRIN payments, webhooks on confirmation,
#                      multi-wallet routing. Bridge ports 3008 main / 3009 test.
#                      Design starts after 053_grin_woocommerce.sh is complete.
#   Public Web Wallet  Client-side WASM wallet, no server-held keys.
#                      Design → docs/generated/script05_design.md (PART A)
#   GoblinPay          Receive-only merchant till (Nostr + slatepack), deploying
#                      github.com/2ro/GoblinPay the toolkit way.
#                      Design → docs/generated/script09_design.md (PART C)
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Logging helpers are defined BEFORE the libs are sourced: every lib guards its
# own fallbacks with `declare -F`, so defining ours first makes lib output adopt
# this script's colours instead of printing bare [INFO]/[OK] lines.
info()    { echo -e "  ${CYAN}[INFO]${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "  ${RED}[ERROR]${RESET} $*" >&2; }
success() { echo -e "  ${GREEN}[OK]${RESET}    $*"; }

# Shared node-secret resolver + self-heal (keeps grin-wallet.toml
# node_api_secret_path in sync with the live node after a node rebuild).
# shellcheck source=lib/grin_node_secrets.sh
source "$SCRIPT_DIR/lib/grin_node_secrets.sh"
# grin-wallet binary download + sha256 verification. This lib was factored OUT
# of the CMD-wallet download step below, but the copy here never got the
# checksum check back — so the hand-rolled version is gone and we call the lib.
# shellcheck source=lib/grin_wallet_install.sh
source "$SCRIPT_DIR/lib/grin_wallet_install.sh"
# gnc_get_pid_on_port / gnc_wait_for_port — listener port-collision guard.
# shellcheck source=lib/grin_node_control.sh
source "$SCRIPT_DIR/lib/grin_node_control.sh"

# =============================================================================
# INSTALLATION DETECTION
# =============================================================================

# 051 — installed if config.conf written by the script exists for either network
_051_installed() {
    [[ -f /opt/grin/webwallet/mainnet/config.conf ]] \
        || [[ -f /opt/grin/webwallet/testnet/config.conf ]]
}

# 051 — running if nginx sites-enabled symlink exists for either network
_051_status() {
    local mn="" tn=""
    [[ -L /etc/nginx/sites-enabled/web-wallet-main ]] && mn="mainnet"
    [[ -L /etc/nginx/sites-enabled/web-wallet-test ]] && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# 052 — installed if app dir exists for either network
_052_installed() {
    [[ -d /opt/grin/drop-main ]] || [[ -d /opt/grin/drop-test ]]
}

# 052 — running networks (systemd active)
_052_status() {
    local mn="" tn=""
    systemctl is-active --quiet grin-drop-main 2>/dev/null && mn="mainnet"
    systemctl is-active --quiet grin-drop-test 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# 053 — installed if bridge service file exists for either network
_053_installed() {
    [[ -f /etc/systemd/system/grin-wallet-bridge-main.service ]] \
        || [[ -f /etc/systemd/system/grin-wallet-bridge-test.service ]]
}

# 053 — running networks
_053_status() {
    local mn="" tn=""
    systemctl is-active --quiet grin-wallet-bridge-main 2>/dev/null && mn="mainnet"
    systemctl is-active --quiet grin-wallet-bridge-test 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# cmd wallet — installed if grin-wallet.toml exists
_cmd_installed() {
    [[ -f /opt/grin/cmdwallet/mainnet/grin-wallet.toml ]] \
        || [[ -f /opt/grin/cmdwallet/testnet/grin-wallet.toml ]]
}

# cmd wallet — listening if tmux session is active
_cmd_status() {
    local mn="" tn=""
    tmux has-session -t "grin_mainnet_cmd_wallet" 2>/dev/null && mn="mainnet"
    tmux has-session -t "grin_testnet_cmd_wallet" 2>/dev/null && tn="testnet"
    if [[ -n "$mn" && -n "$tn" ]]; then echo "mainnet + testnet"
    elif [[ -n "$mn" ]];           then echo "mainnet"
    elif [[ -n "$tn" ]];           then echo "testnet"
    else echo ""
    fi
}

# =============================================================================
# MAIN MENU
# =============================================================================

show_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} 05) GRIN WALLET & PAYMENT SERVICES${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${YELLOW}Tip:${RESET} ${DIM}Install each service on its own dedicated server.${RESET}"
    echo -e "  ${DIM}     Mixing services on one machine risks port conflicts,${RESET}"
    echo -e "  ${DIM}     config collisions, and harder security isolation.${RESET}"
    echo -e "  ${DIM}     Each server can run both mainnet and testnet together.${RESET}"
    echo ""

    # ── running / installed status ────────────────────────────────────────────
    local any_shown=0

    local s051_run; s051_run=$(_051_status)
    local s052_run; s052_run=$(_052_status)
    local s053_run; s053_run=$(_053_status)
    local s_cmd_run; s_cmd_run=$(_cmd_status)

    local s051_inst=0 s052_inst=0 s053_inst=0 s_cmd_inst=0
    _051_installed && s051_inst=1 || true
    _052_installed && s052_inst=1 || true
    _053_installed && s053_inst=1 || true
    _cmd_installed && s_cmd_inst=1 || true

    # Show only running or installed services — hide untouched ones
    if [[ -n "$s051_run" || $s051_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s051_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}Private Web Wallet${RESET}  ${GREEN}running${RESET}  ${DIM}($s051_run)${RESET}"
        else
            echo -e "  ${DIM}○ Private Web Wallet  installed · not running${RESET}"
        fi
    fi

    if [[ -n "$s052_run" || $s052_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s052_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}Grin Drop${RESET}           ${GREEN}running${RESET}  ${DIM}($s052_run)${RESET}"
        else
            echo -e "  ${DIM}○ Grin Drop           installed · not running${RESET}"
        fi
    fi

    if [[ -n "$s053_run" || $s053_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s053_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}WooCommerce${RESET}         ${GREEN}running${RESET}  ${DIM}($s053_run)${RESET}"
        else
            echo -e "  ${DIM}○ WooCommerce         installed · not running${RESET}"
        fi
    fi

    if [[ -n "$s_cmd_run" || $s_cmd_inst -eq 1 ]]; then
        any_shown=1
        if [[ -n "$s_cmd_run" ]]; then
            echo -e "  ${GREEN}●${RESET} ${BOLD}CMD Wallet${RESET}          ${GREEN}listening${RESET}  ${DIM}($s_cmd_run)${RESET}"
        else
            echo -e "  ${DIM}○ CMD Wallet          installed · not listening${RESET}"
        fi
    fi

    if [[ $any_shown -eq 0 ]]; then
        echo -e "  ${DIM}No wallet services installed yet.${RESET}"
    fi

    echo ""
    echo -e "  ${DIM}✅ ready   🔧 building   · keyless rows are planned, not built yet${RESET}"
    echo ""
    echo -e "${DIM}  ── Wallets ──────────── hold & spend your own GRIN${RESET}"
    echo ""
    echo -e "  ${GREEN}A${RESET}) CMD Wallet Quick Setup  ✅  ${DIM}download · init/recover · listen (CLI/testing)${RESET}"
    echo -e "  ${GREEN}1${RESET}) Private Web Wallet      🔧  ${DIM}browser UI, server-held keys${RESET}"
    echo -e "     ${DIM}Public Web Wallet           planned · client-side WASM, no custody${RESET}"
    echo ""
    echo -e "${DIM}  ── Giveaways & Donations ─ hand GRIN out${RESET}"
    echo ""
    echo -e "  ${GREEN}2${RESET}) Grin Drop               ✅  ${DIM}giveaway faucet + donation portal${RESET}"
    echo ""
    echo -e "${DIM}  ── Accept Payments ──── receive GRIN from customers${RESET}"
    echo ""
    echo -e "  ${GREEN}3${RESET}) WooCommerce Gateway     🔧  ${DIM}WordPress/WooCommerce plugin${RESET}"
    echo -e "     ${DIM}Payment Pro                 planned · Shopify / custom REST API${RESET}"
    echo -e "     ${DIM}GoblinPay                   planned · receive-only merchant till${RESET}"
    echo ""
    echo -e "  ${DIM}Grin Transporter moved → main menu 09 (Grin Connectivity Hub)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [A / 1-3 / 0]: ${RESET}"
}

run_sub() {
    local script="$SCRIPT_DIR/$1"
    if [[ ! -f "$script" ]]; then
        echo -e "\n${RED}[ERROR]${RESET}  Script not found: $script"
        echo -e "${DIM}Press Enter to return...${RESET}"
        read -r || true
        return
    fi
    bash "$script"
}

# =============================================================================
# CMD WALLET — QUICK SETUP
# =============================================================================
#
# ─── NO `-p` — the passphrase is fed on STDIN ────────────────────────────────
# grin-wallet 5.4.1 pins rpassword 4.0, whose read_password() reads STDIN (not
# /dev/tty) and takes an explicit non-TTY branch — "if we don't have a TTY, the
# input was piped so we bypass terminal hiding code" — falling back to
# stdin.read_line(). So every grin-wallet call here supplies the passphrase by
# redirecting stdin from a mode-600 file or a `printf` builtin pipe, and NOTHING
# ever lands in argv. `-p` (the old behaviour, and what the other wallet libs
# still do) exposes the passphrase in `ps aux` / /proc/<pid>/cmdline for the
# whole life of the process — for a 24/7 listener that is a permanent leak to
# every local user. grin-wallet has no env-var passphrase input, so stdin is the
# only argv-free channel; `--pass` is NOT the only option, despite the comments
# elsewhere in this repo.
#
# ─── Listener mode differs from solo/pool ON PURPOSE ─────────────────────────
# This wallet runs `grin-wallet listen` — the Foreign API on 3415/13415 — because
# it exists to RECEIVE slates. Solo mining (lib/07_solo_wallet.sh) and the public
# pool run `owner_api` with owner_api_include_foreign=true on 3420/13420 instead,
# because the node's stratum calls build_coinbase into them. Nothing calls
# build_coinbase here, so the combined-listener keys are deliberately not set.
# =============================================================================

# ─── Per-network resolvers ──────────────────────────────────────────────────
_cmd_dir()          { echo "/opt/grin/cmdwallet/${1:-mainnet}"; }
_cmd_net_flag()     { [[ "${1:-}" == "testnet" ]] && echo "--testnet" || echo ""; }
_cmd_net_label()    { [[ "${1:-}" == "testnet" ]] && echo "TESTNET"  || echo "MAINNET"; }
_cmd_node_port()    { [[ "${1:-}" == "testnet" ]] && echo 13413 || echo 3413; }
_cmd_foreign_port() { [[ "${1:-}" == "testnet" ]] && echo 13415 || echo 3415; }
_cmd_tmux_name()    { echo "grin_${1:-mainnet}_cmd_wallet"; }
_cmd_wallet_bin()   { echo "$(_cmd_dir "$1")/grin-wallet"; }
_cmd_toml()         { echo "$(_cmd_dir "$1")/grin-wallet.toml"; }
_cmd_pass_file()    { echo "$(_cmd_dir "$1")/${1:-mainnet}_pass_wallet.txt"; }
_cmd_seed_file()    { echo "$(_cmd_dir "$1")/${1:-mainnet}_seed.txt"; }
_cmd_launcher()     { echo "$(_cmd_dir "$1")/listen.sh"; }

# ─── grin-wallet.toml key setters ───────────────────────────────────────────
# Replace the key in place (commented or not); when absent, insert right after
# the [wallet] header. An EOF append — what this script used to do — lands the
# key under [logging]/[tor], where grin-wallet silently ignores it.
_cmd_set_toml_key() {
    local file="$1" key="$2" val="$3"
    [[ -f "$file" ]] || return 1
    if grep -qE "^[#[:space:]]*${key}[[:space:]]*=" "$file"; then
        # s/// replacement side: `&` means "the whole match", `\` escapes, and
        # `|` is the delimiter. Values here are paths and integers, but an
        # unescaped one would corrupt the toml silently rather than fail.
        local esc; esc=$(printf '%s' "$val" | sed -e 's/[\\&|]/\\&/g')
        sed -i -E "s|^[#[:space:]]*${key}[[:space:]]*=.*|${key} = ${esc}|" "$file"
    else
        # No [wallet] header → sed would match nothing and still exit 0, and the
        # caller would report a pin that never happened. Fail honestly instead.
        grep -q '^\[wallet\]' "$file" || return 1
        # The `a` command is NOT the replacement side: `&` and `|` are literal
        # there, so escaping them would insert the escape. Only `\` is special.
        local aesc; aesc=$(printf '%s' "$val" | sed -e 's/\\/\\\\/g')
        sed -i "/^\[wallet\]/a ${key} = ${aesc}" "$file"
    fi
}

# Replace-in-place ONLY; rc 1 when the key is absent. For keys that live outside
# [wallet] (log_max_files is under [logging]) — inserting those after [wallet]
# would put them in the wrong section. grin-wallet init always writes them, so
# the absent case only happens on a hand-edited toml, where leaving it alone is
# the right call.
_cmd_replace_toml_key() {
    local file="$1" key="$2" val="$3" esc
    [[ -f "$file" ]] || return 1
    grep -qE "^[#[:space:]]*${key}[[:space:]]*=" "$file" || return 1
    esc=$(printf '%s' "$val" | sed -e 's/[\\&|]/\\&/g')
    sed -i -E "s|^[#[:space:]]*${key}[[:space:]]*=.*|${key} = ${esc}|" "$file"
}

# ─── Register the wallet dir for Script 089 backups ─────────────────────────
# 089 collects wallet dirs by grepping `_WALLET_DIR="…"` out of this conf. Until
# now nothing registered the CMD wallet, so the one product that writes a
# plaintext mainnet seed to disk was the one the backup skipped.
_cmd_register_wallet_dir() {
    local net="$1" dir conf key
    dir=$(_cmd_dir "$net"); conf="/opt/grin/conf/grin_wallets_location.conf"
    key="CMDWALLET_$(_cmd_net_label "$net")_WALLET_DIR"
    mkdir -p /opt/grin/conf 2>/dev/null || return 1
    [[ -f "$conf" ]] || { : > "$conf"; chmod 600 "$conf" 2>/dev/null || true; }
    if grep -q "^${key}=" "$conf" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=\"$dir\"|" "$conf"
    else
        echo "${key}=\"$dir\"" >> "$conf"
    fi
}

# ─── Passphrase / address / node-link probes (all stdin-fed, no -p) ─────────
# `address` is a purely LOCAL keychain op — it needs no node. That is what makes
# it the right passphrase probe: it separates "wrong passphrase" from "node
# unreachable", which `info` cannot do.
_cmd_address() {
    local net="$1" pass="$2" dir bin flag out
    dir=$(_cmd_dir "$net"); bin=$(_cmd_wallet_bin "$net"); flag=$(_cmd_net_flag "$net")
    [[ -x "$bin" ]] || return 1
    out=$(printf '%s\n' "$pass" | ( cd "$dir" && "$bin" $flag address ) 2>/dev/null || true)
    grep -oE '\bt?grin1[a-z0-9]{40,}' <<<"$out" | head -1
}

_cmd_pass_ok() {
    local addr; addr=$(_cmd_address "$1" "$2" || true)
    [[ -n "$addr" ]]
}

# A running `listen` holds the wallet's LMDB lock, so any second grin-wallet
# call against the same dir blocks until it times out. Every probe below must
# check this first — otherwise re-running setup on a live wallet stalls the menu
# for the full `info` timeout and then reports a bogus failure.
_cmd_wallet_busy() {
    tmux has-session -t "$(_cmd_tmux_name "$1")" 2>/dev/null
}

# `info` refreshes outputs against the node's Foreign API, so it is the only
# cheap call that actually exercises wallet → node (CLAUDE.md link ②). The
# `get_version: Cannot parse response` seen during init proves nothing — this
# does. Capped: an unreachable node or a large wallet must never hang the menu.
_cmd_node_link_ok() {
    local net="$1" pass="$2" dir bin flag
    dir=$(_cmd_dir "$net"); bin=$(_cmd_wallet_bin "$net"); flag=$(_cmd_net_flag "$net")
    printf '%s\n' "$pass" | ( cd "$dir" && timeout 90 "$bin" $flag info ) >/dev/null 2>&1
}

# ─── Seed extraction ────────────────────────────────────────────────────────
# Find the mnemonic by SHAPE — one line of exactly 12 or 24 all-lowercase words.
# The previous `tail -6` was a guess at grin-wallet's output trailer: one extra
# line from a future release and it would silently save a truncated phrase, which
# you would only discover on recovery day.
_cmd_extract_seed() {
    local phrase
    phrase=$(awk 'NF==12 || NF==24 {
                      for (i = 1; i <= NF; i++) if ($i !~ /^[a-z]+$/) next
                      print; exit
                  }' "$1" 2>/dev/null || true)
    [[ -n "$phrase" ]] || return 1
    printf '%s\n' "$phrase"
}

# ─── Listener port guard ────────────────────────────────────────────────────
# NEVER auto-kill the holder — it may be another wallet with real funds.
_cmd_port_collision_check() {
    local net="$1" port tmux_name
    port=$(_cmd_foreign_port "$net"); tmux_name=$(_cmd_tmux_name "$net")
    gnc_get_pid_on_port "$port" >/dev/null 2>&1 || return 0   # free
    tmux has-session -t "$tmux_name" 2>/dev/null && return 0  # already ours
    error "Port $port is held by ANOTHER process (not '$tmux_name')."
    error "  Not touched automatically — it may be a wallet holding real funds."
    error "  Stop that listener first, or change api_listen_port in"
    error "  $(_cmd_toml "$net") and re-run."
    return 1
}

# ─── Listener launcher ──────────────────────────────────────────────────────
# Persistent by default: it reads the saved pass file every time it runs, so the
# session can be restarted forever (by hand, by tmux, by a future watchdog). The
# old launcher read a $$-named temp file that it deleted on first exec, which
# left an inert script on disk — after a crash or reboot, re-running the whole
# setup was the only way back.
#
#   <net> <stdin-source-file> <unlink:0|1>
# unlink=1 is the no-saved-passphrase path: fd 3 is opened on the temp copy, the
# file is unlinked immediately (the data stays reachable through the open fd),
# then grin-wallet execs with stdin on fd 3 — the secret leaves the filesystem
# before grin-wallet even starts and cannot outlive the process.
_cmd_write_launcher() {
    local net="$1" src="$2" unlink="${3:-0}" dir bin flag launcher
    dir=$(_cmd_dir "$net"); bin=$(_cmd_wallet_bin "$net")
    flag=$(_cmd_net_flag "$net"); launcher=$(_cmd_launcher "$net")
    mkdir -p "$dir"
    {
        echo '#!/bin/bash'
        echo "# GENERATED by 05_grin_wallet_service.sh — CMD wallet listener ($net)."
        echo "# The passphrase arrives on STDIN, never in argv (no -p): grin-wallet's"
        echo "# rpassword prompt reads stdin when stdin is not a TTY."
        echo "cd \"$dir\" || exit 1"
        if [[ "$unlink" == "1" ]]; then
            echo "exec 3< \"$src\" || exit 1"
            echo "rm -f \"$src\""
            echo "exec \"$bin\" $flag listen <&3"
        else
            echo "exec \"$bin\" $flag listen < \"$src\""
        fi
    } > "$launcher"
    chmod 700 "$launcher"
    # Pre-2026-07 launcher lived outside the per-net dir; drop the stale copy.
    rm -f "/opt/grin/cmdwallet/.$(echo "$net" | tr '[:upper:]' '[:lower:]')_listener.sh" 2>/dev/null || true
}

# ─── Interrupt guard for the seed capture ───────────────────────────────────
# .init_capture holds the MNEMONIC between `init -h` and the save prompt. Every
# normal exit path removes it, but Ctrl-C during that window does not — and the
# operator most likely to hit Ctrl-C there is the one who did NOT want a
# plaintext seed on the box. INT/TERM only: no EXIT trap, because this file is
# sourced by the hub and an EXIT trap would follow it out of this function.
#
# The handler only shreds the file and disarms itself — it deliberately does NOT
# `return`, whose meaning inside a signal handler differs between bash versions.
# Nothing downstream needs a special case: every later step is already guarded on
# `-f "$tmp_init"`, so a cleaned capture simply skips the seed-save prompt.
_CMD_TMP_INIT=""
_cmd_trap_cleanup() {
    [[ -n "$_CMD_TMP_INIT" ]] && rm -f "$_CMD_TMP_INIT" 2>/dev/null
    _CMD_TMP_INIT=""
    # Leaving the trap armed would follow us back into the hub menu, where INT
    # would run this no-op instead of interrupting.
    trap - INT TERM
    return 0
}

# Setup wallet for one network.
# Returns 0 = completed or skipped, 1 = user cancelled mid-flow.
_cmd_wallet_setup_for_net() {
    local net="$1"
    local net_flag net_label wallet_dir tmux_name
    net_flag=$(_cmd_net_flag "$net");   net_label=$(_cmd_net_label "$net")
    wallet_dir=$(_cmd_dir "$net");      tmux_name=$(_cmd_tmux_name "$net")
    local wallet_bin pass_file seed_file toml_file _node_port _listen_port
    wallet_bin=$(_cmd_wallet_bin "$net"); pass_file=$(_cmd_pass_file "$net")
    seed_file=$(_cmd_seed_file "$net");   toml_file=$(_cmd_toml "$net")
    _node_port=$(_cmd_node_port "$net");  _listen_port=$(_cmd_foreign_port "$net")

    # Step tracking for end summary
    local _did_download="no" _did_init="no" _saved_pass="no" _saved_seed="no"
    local _did_patch="no" _patch_node_dir="" _did_ports="no" _did_reg="no"
    # "skipped" (not "unknown") is the initial state — "unknown" now specifically
    # means the wallet would not open, which the no-passphrase path must not claim.
    local _addr="" _link="skipped"
    # Kept in memory only while the flow needs it; unset before returning.
    local wallet_pass="" know_pass=0 _need_pass=0

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} CMD Wallet Quick Setup — ${net_label}${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    [[ "$net" == "mainnet" ]] && \
        echo -e "  ${BOLD}${YELLOW}⚠  MAINNET — operates with real GRIN (monetary value)${RESET}\n"
    echo -e "  ${DIM}─── Setup target ─────────────────────────────────────${RESET}"
    echo ""
    echo -e "  Network      : ${BOLD}$net_label${RESET}"
    echo -e "  Node port    : ${DIM}$_node_port${RESET}"
    echo -e "  Listener     : ${DIM}grin-wallet listen — Foreign API $_listen_port${RESET}"
    echo -e "  Wallet dir   : ${DIM}$wallet_dir${RESET}"
    echo -e "  Binary       : ${DIM}$wallet_bin${RESET}"
    echo -e "  Pass file    : ${DIM}$pass_file${RESET}"
    echo -e "  Seed file    : ${DIM}$seed_file${RESET}"
    echo -e "  tmux session : ${DIM}$tmux_name${RESET}"
    echo ""

    # ── Step 1: Download (shared lib — verifies the sha256 when published) ────
    local had_bin=0 force_dl=0
    if [[ -x "$wallet_bin" ]]; then
        had_bin=1
        local ver; ver=$("$wallet_bin" --version 2>/dev/null | head -1 || echo "?")
        success "Binary already installed  ${DIM}($ver)${RESET}"
        echo -ne "  Re-download latest? [y/N/0 cancel]: "
        local redown; read -r redown || true
        [[ "$redown" == "0" ]] && return 1
        if [[ "${redown,,}" == "y" ]]; then force_dl=1; fi
    fi
    echo ""

    if [[ $had_bin -eq 0 || $force_dl -eq 1 ]]; then
        if ! gwi_install_grin_wallet "$wallet_dir" "$force_dl"; then
            error "grin-wallet install failed — nothing else was changed."
            echo -ne "\n  Press Enter..."; read -r || true; return 0
        fi
        _did_download="${GWI_INSTALLED_VERSION:-unknown}"
    fi
    echo ""

    # ── Step 2: Init or recover ──────────────────────────────────────────────
    local do_init=1 tmp_init=""
    if [[ -f "$toml_file" ]]; then
        warn "Wallet already initialized at $wallet_dir"
        echo -ne "  Re-initialize? ${RED}(destroys the existing wallet!)${RESET} [y/N/0 cancel]: "
        local reinit; read -r reinit || true
        [[ "$reinit" == "0" ]] && return 1
        if [[ "${reinit,,}" == "y" ]]; then
            # The saved pass/seed belong to the wallet about to be destroyed.
            # Leaving them was the worst failure mode in this script: the
            # listener would boot with a stale passphrase and fail, and
            # <net>_seed.txt would hold the mnemonic of a wallet that no longer
            # exists — a silent fund-loss trap on mainnet.
            if [[ -f "$pass_file" || -f "$seed_file" ]]; then
                rm -f "$pass_file" "$seed_file"
                warn "Removed the old $(basename "$pass_file") / $(basename "$seed_file") — they belong to the wallet being replaced."
            fi
        else
            do_init=0
            info "Existing wallet kept — config, checks and listener still run below."
            # Re-running on an existing wallet now re-applies the toml patches
            # too; it used to jump straight to the listener, so a wallet set up
            # before a node rebuild never got its config refreshed.
            if [[ -f "$pass_file" ]]; then
                wallet_pass=$(<"$pass_file"); know_pass=1
            else
                # No saved passphrase on an existing wallet: without this the
                # flow could never gain one — the checks below would be skipped
                # forever and the listener would fall back to a one-shot start
                # on every single run.
                _need_pass=1
            fi
        fi
    fi
    echo ""

    if [[ $do_init -eq 1 ]]; then
        echo -e "  ${DIM}Setup mode${RESET}"
        echo -e "    ${GREEN}1${RESET}) New wallet         ${DIM}init -h  — generates a fresh seed${RESET}"
        echo -e "    ${GREEN}2${RESET}) Recover from seed  ${DIM}init -hr — you type an existing phrase${RESET}"
        echo -ne "  Select [1/2/0 cancel]: "
        local mode; read -r mode || true
        [[ "$mode" == "0" || -z "$mode" ]] && return 1
        if [[ "$mode" != "1" && "$mode" != "2" ]]; then
            error "Invalid mode."; sleep 1; return 1
        fi
        mkdir -p "$wallet_dir"
        echo ""

        if [[ "$mode" == "2" ]]; then
            # RECOVER — stdin is deliberately NOT piped here. grin-wallet prompts
            # for the passphrase and the recovery phrase on the real terminal, so
            # the mnemonic is typed straight into grin-wallet and never passes
            # through this script or any file it controls.
            info "Running grin-wallet init -hr — enter your passphrase, then the recovery phrase."
            echo ""
            ( cd "$wallet_dir" && "$wallet_bin" $net_flag init -hr ) || true
            echo ""
            if [[ ! -f "$toml_file" ]]; then
                warn "Recovery did not complete — grin-wallet.toml not found."
                echo -e "         ${DIM}Check the output above.${RESET}"
                echo -ne "  Press Enter to return..."; read -r || true; return 0
            fi
            success "Wallet recovered from seed."
            _did_init="recovered"
        else
            # NEW — this script owns the passphrase, so collect it here and feed
            # it to init on STDIN. Two lines: grin-wallet asks to confirm, and a
            # spare line is harmless if a release ever stops asking twice.
            echo -e "  Enter a wallet passphrase  ${DIM}(0 at any prompt to cancel)${RESET}:"
            local pass2=""
            while true; do
                echo -ne "    Passphrase : "
                read -rs wallet_pass; echo ""
                [[ "$wallet_pass" == "0" ]] && { wallet_pass=""; return 1; }
                if [[ -z "$wallet_pass" ]]; then
                    warn "Passphrase cannot be empty."; continue
                fi
                echo -ne "    Confirm    : "
                read -rs pass2; echo ""
                [[ "$pass2" == "0" ]] && { wallet_pass=""; pass2=""; return 1; }
                if [[ "$wallet_pass" != "$pass2" ]]; then
                    error "Passphrases do not match."; pass2=""; continue
                fi
                pass2=""; break
            done
            know_pass=1
            echo ""
            info "Running grin-wallet init -h  ${DIM}(write the seed phrase down!)${RESET}"
            echo ""

            # Capture file holds the SEED PHRASE. Pre-create it 600 before tee
            # touches it — tee truncates but never changes an existing file's
            # mode. Kept inside the wallet dir rather than /tmp, so a tmp cleaner
            # can never race it and it inherits the same custody as the seed file.
            tmp_init="$wallet_dir/.init_capture"
            install -m 600 /dev/null "$tmp_init"
            _CMD_TMP_INIT="$tmp_init"
            trap '_cmd_trap_cleanup' INT TERM
            # printf is a bash BUILTIN — it forks no process, so the passphrase
            # never appears in any argv, unlike the -p this replaced.
            # Subshell for the cd: a bare cd here would leak into the menu loop's cwd.
            (
                cd "$wallet_dir" || exit 1
                printf '%s\n%s\n' "$wallet_pass" "$wallet_pass" \
                    | "$wallet_bin" $net_flag init -h
            ) 2>&1 | tee "$tmp_init" || true
            echo ""

            if [[ ! -f "$toml_file" ]]; then
                warn "Init may have failed — grin-wallet.toml not found."
                echo -e "         ${DIM}Check the output above.${RESET}"
                _cmd_trap_cleanup; wallet_pass=""
                echo -ne "  Press Enter to return..."; read -r || true; return 0
            fi
            success "Wallet initialized."
            _did_init="yes"
        fi
        echo ""
    fi

    # ── Step 3: Save passphrase (default YES) ─────────────────────────────────
    # Default Y: without the saved copy the listener cannot start unattended and
    # cannot be restarted after a crash, which is the normal expectation for a
    # wallet you left listening. Mode 600, root-owned, never leaves the box.
    if [[ $_need_pass -eq 1 ]] && _cmd_wallet_busy "$net"; then
        # Can't verify a passphrase against a wallet the listener has open, and
        # an unverified one saved to disk is exactly the stale-secret trap this
        # rewrite set out to remove.
        _need_pass=0
        info "Listener '$tmux_name' holds the wallet — stop it and re-run to save a passphrase."
    fi

    local _agreed_to_save=0
    if [[ "$_did_init" != "no" || $_need_pass -eq 1 ]]; then
        if [[ $know_pass -eq 0 ]]; then
            # Two ways to land here: recovery (grin-wallet took the passphrase
            # directly) and an existing wallet with no saved copy. Either way we
            # do not know it, so ask — and VERIFY it opens the wallet before
            # writing it, so a typo can never be saved as the listener's key.
            echo -ne "  Save the passphrase for unattended listener start? [Y/n]: "
            local want_pass; read -r want_pass || true
            if [[ "${want_pass,,}" != "n" ]]; then
                while true; do
                    echo -ne "    Wallet passphrase ${DIM}(0 to skip)${RESET}: "
                    read -rs wallet_pass; echo ""
                    if [[ "$wallet_pass" == "0" || -z "$wallet_pass" ]]; then wallet_pass=""; break; fi
                    if _cmd_pass_ok "$net" "$wallet_pass"; then
                        know_pass=1
                        # They already answered the save question to get here —
                        # asking a second time reads like the first answer did
                        # not register.
                        _agreed_to_save=1
                        break
                    fi
                    error "That passphrase does not open the wallet — try again."
                done
            fi
        fi

        if [[ $know_pass -eq 1 ]]; then
            local save_pass="y"
            if [[ $_agreed_to_save -eq 0 ]]; then
                echo -ne "  Save passphrase to ${BOLD}$(basename "$pass_file")${RESET}? [Y/n/0 cancel]: "
                read -r save_pass || true
            fi
            if [[ "$save_pass" == "0" ]]; then
                _cmd_trap_cleanup; wallet_pass=""; return 1
            fi
            if [[ "${save_pass,,}" != "n" ]]; then
                # umask before the redirect: chmod alone leaves a window where the
                # file exists at the default mode with the secret already in it.
                ( umask 077; printf '%s\n' "$wallet_pass" > "$pass_file" )
                chmod 600 "$pass_file"
                success "Saved → $pass_file  ${DIM}(mode 600)${RESET}"
                _saved_pass="yes"
            else
                info "Passphrase not saved — the listener will ask for it every start."
            fi
        fi
        echo ""

        # ── Step 4: Save seed phrase (default NO) ─────────────────────────────
        # Default N: a plaintext mnemonic sitting next to the wallet it unlocks
        # defeats the point of the passphrase. `init -h` already printed it for
        # you to write down — opt in only if you know why you want a copy here.
        if [[ "$_did_init" == "yes" && -n "$tmp_init" && -f "$tmp_init" ]]; then
            echo -ne "  Save seed phrase to ${BOLD}$(basename "$seed_file")${RESET}? ${DIM}(plaintext on this box)${RESET} [y/N/0 cancel]: "
            local save_seed; read -r save_seed || true
            if [[ "$save_seed" == "0" ]]; then
                _cmd_trap_cleanup; wallet_pass=""; return 1
            fi
            if [[ "${save_seed,,}" == "y" ]]; then
                local phrase=""
                if phrase=$(_cmd_extract_seed "$tmp_init"); then
                    ( umask 077; printf '%s\n' "$phrase" > "$seed_file" )
                    chmod 600 "$seed_file"; phrase=""
                    success "Saved → $seed_file  ${DIM}(mode 600)${RESET}"
                    _saved_seed="yes"
                else
                    # Never write a file that claims to hold the seed but doesn't.
                    error "Could not find a 12/24-word phrase in the init output."
                    error "  NOTHING was written — copy the phrase off the screen above NOW."
                    _saved_seed="failed"
                fi
            else
                info "Seed not saved — make sure you wrote it down."
            fi
        elif [[ "$_did_init" == "recovered" ]]; then
            info "Seed not saved — you recovered from a phrase you already hold."
        fi
        _cmd_trap_cleanup
        echo ""
    fi

    # ── Step 5: Patch grin-wallet.toml (silent — result shown in summary) ─────
    # Node dir/secret come from the SHARED resolvers (CLAUDE.md: "use these,
    # don't re-derive"). The old hand-rolled block sourced the instances conf
    # into this shell — leaking PRUNEMAIN_GRIN_DIR & friends as globals — and
    # preferred the pruned mainnet node, while every other consumer prefers the
    # running/archive one.
    local node_secret=""
    _patch_node_dir=$(grin_live_node_dir "$net" 2>/dev/null || true)
    node_secret=$(grin_node_secret_path "$net" foreign 2>/dev/null || true)
    if [[ -n "$node_secret" && -f "$node_secret" ]]; then
        _cmd_set_toml_key "$toml_file" "node_api_secret_path" "\"$node_secret\"" || true
        _did_patch="$node_secret"
    fi

    # Pin the Foreign listen port. grin-wallet init writes mainnet defaults into
    # the toml regardless of --testnet (052_lib_wallet.sh:709 records the same
    # for owner_api_listen_port, and the pool pins api_listen_port for exactly
    # this reason). This is the only product that actually runs `listen`, so an
    # unpinned 3415 in the testnet toml would make menu option 3 "Both" put two
    # listeners on one port.
    if _cmd_set_toml_key "$toml_file" "api_listen_port" "$_listen_port"; then
        _did_ports="$_listen_port"
    fi
    # 24/7 listener: grin-wallet's default of 32 rotated logs is more depth than
    # this ever needs. Replace-only — log_max_files lives under [logging].
    local _did_logs="no"
    if _cmd_replace_toml_key "$toml_file" "log_max_files" "5"; then _did_logs="yes"; fi

    # Register for Script 089 backups (this dir can hold a plaintext seed).
    if _cmd_register_wallet_dir "$net"; then _did_reg="yes"; fi

    # Enable box-wide secret self-heal so this wallet's node_api_secret_path is
    # auto-refreshed after a future node rebuild (idempotent; no-op without root).
    grin_install_secret_sync || true

    # ── Step 6: Verify — address (local) then node link (info) ────────────────
    # Ordered before the listener STARTS so nothing competes for the wallet db —
    # but on a re-run the listener is already up, and then both probes would sit
    # on the LMDB lock (up to the 90s `info` cap) only to report a failure that
    # says nothing about the wallet. Skip them instead of stalling the menu.
    if [[ $know_pass -eq 1 ]] && _cmd_wallet_busy "$net"; then
        _link="busy"
        info "Checks skipped — the '$tmux_name' listener already holds the wallet db."
    elif [[ $know_pass -eq 1 ]]; then
        _addr=$(_cmd_address "$net" "$wallet_pass" || true)
        if [[ -n "$_addr" ]]; then
            success "Wallet address: ${BOLD}$_addr${RESET}"
        else
            warn "Could not read the wallet address — wrong passphrase, or the wallet is damaged."
        fi
        if [[ -z "$_addr" ]]; then
            # The local `address` call already failed, so `info` cannot say
            # anything about the NODE — it would fail on the wallet for the same
            # reason, after burning the full 90s cap. Don't run it.
            _link="unknown"
        elif _cmd_node_link_ok "$net" "$wallet_pass"; then
            _link="ok"
            success "Wallet → node link verified (\`info\` refreshed against port $_node_port)."
        else
            _link="fail"
            warn "\`grin-wallet info\` failed — the wallet cannot reach the node on $_node_port."
            warn "  Check the node is running, and that node_api_secret_path in"
            warn "  $toml_file matches the live node's .foreign_api_secret."
        fi
    else
        info "Passphrase unknown to this script — skipping address + node-link checks."
    fi
    echo ""

    # ── Step 7: Start listener ───────────────────────────────────────────────
    _cmd_start_listener "$net" || true
    wallet_pass=""

    # Check listener state for summary
    local _did_listen="no"
    tmux has-session -t "$tmux_name" 2>/dev/null && _did_listen="yes" || true

    local _tick="${GREEN}✔${RESET}" _skip="${DIM}─${RESET}"
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN} Summary — ${net_label}${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}─── Steps ────────────────────────────────────────────${RESET}"
    echo ""
    if [[ "$_did_download" != "no" ]]; then
        echo -e "  $_tick  1. Binary installed     ${DIM}$wallet_bin  [$_did_download]${RESET}"
    else
        echo -e "  $_skip  1. Binary install        ${DIM}skipped — already installed${RESET}"
    fi
    case "$_did_init" in
        yes)       echo -e "  $_tick  2. Wallet initialized   ${DIM}$toml_file${RESET}" ;;
        recovered) echo -e "  $_tick  2. Wallet recovered     ${DIM}from seed → $toml_file${RESET}" ;;
        *)         echo -e "  $_skip  2. Init                  ${DIM}skipped — existing wallet kept${RESET}" ;;
    esac
    if [[ "$_saved_pass" == "yes" ]]; then
        echo -e "  $_tick  3. Passphrase saved     ${DIM}$pass_file${RESET}"
    else
        echo -e "  $_skip  3. Passphrase            ${DIM}not saved — listener needs it typed in${RESET}"
    fi
    case "$_saved_seed" in
        yes)    echo -e "  $_tick  4. Seed phrase saved    ${DIM}$seed_file${RESET}" ;;
        failed) echo -e "  ${RED}✘${RESET}  4. Seed phrase           ${RED}NOT saved — phrase not found in output${RESET}" ;;
        *)      echo -e "  $_skip  4. Seed phrase           ${DIM}not saved${RESET}" ;;
    esac
    if [[ "$_did_patch" != "no" ]]; then
        echo -e "  $_tick  5. Node secret patched  ${DIM}node_api_secret_path → $_did_patch${RESET}"
    else
        echo -e "  ${YELLOW}!${RESET}  5. Node secret           ${YELLOW}not found (node dir: ${_patch_node_dir:-unresolved}) — edit $toml_file${RESET}"
    fi
    if [[ "$_did_ports" != "no" ]]; then
        local _logs_note="log_max_files = 5"
        [[ "$_did_logs" == "yes" ]] || _logs_note="log_max_files unchanged"
        echo -e "  $_tick  6. Ports pinned         ${DIM}api_listen_port = $_did_ports, $_logs_note${RESET}"
    else
        echo -e "  ${YELLOW}!${RESET}  6. Ports                 ${YELLOW}could not patch $toml_file${RESET}"
    fi
    case "$_link" in
        ok)      echo -e "  $_tick  7. Checks               ${DIM}address read · wallet → node link OK${RESET}" ;;
        fail)    echo -e "  ${YELLOW}!${RESET}  7. Checks                ${YELLOW}node unreachable on $_node_port (\`info\` failed)${RESET}" ;;
        busy)    echo -e "  $_skip  7. Checks                ${DIM}skipped — listener already holds the wallet db${RESET}" ;;
        unknown) echo -e "  ${YELLOW}!${RESET}  7. Checks                ${YELLOW}wallet would not open — wrong passphrase?${RESET}" ;;
        *)       echo -e "  $_skip  7. Checks                ${DIM}skipped — passphrase not held${RESET}" ;;
    esac
    if [[ "$_did_listen" == "yes" ]]; then
        echo -e "  $_tick  8. Listener started     ${DIM}tmux: $tmux_name · Foreign API $_listen_port${RESET}"
    else
        echo -e "  $_skip  8. Listener              ${DIM}not started${RESET}"
    fi
    if [[ "$_did_reg" == "yes" ]]; then
        echo -e "  $_tick  9. Backup registered    ${DIM}089 will include $wallet_dir${RESET}"
    else
        echo -e "  ${YELLOW}!${RESET}  9. Backup registration   ${YELLOW}failed — 089 will NOT back this wallet up${RESET}"
    fi
    echo ""
    if [[ -n "$_addr" ]]; then
        echo -e "  ${DIM}─── Address ──────────────────────────────────────────${RESET}"
        echo ""
        echo -e "  ${BOLD}$_addr${RESET}"
        echo ""
    fi
    echo -e "  ${DIM}─── Quick reference ──────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${DIM}  cd $wallet_dir && ./grin-wallet $net_flag info${RESET}"
    echo -e "  ${DIM}  tmux attach -t $tmux_name${RESET}"
    if [[ "$_saved_pass" == "yes" ]]; then
        echo -e "  ${DIM}  restart listener:  tmux new -d -s $tmux_name $(_cmd_launcher "$net")${RESET}"
    fi
    echo ""
    echo -ne "  ${DIM}Press Enter to return to menu...${RESET}"
    read -r || true
    return 0
}

# Start the Foreign listener for one network. Always rc 0 — declining a start or
# a restart is a normal outcome, not a cancel, so the summary below still prints.
_cmd_start_listener() {
    local net="$1" dir bin tmux_name pass_file port launcher
    dir=$(_cmd_dir "$net");            bin=$(_cmd_wallet_bin "$net")
    tmux_name=$(_cmd_tmux_name "$net"); pass_file=$(_cmd_pass_file "$net")
    port=$(_cmd_foreign_port "$net");   launcher=$(_cmd_launcher "$net")

    [[ -x "$bin" ]] || { error "No grin-wallet binary for $net — run setup first."; return 0; }

    # Passphrase source. Saved file → a PERSISTENT launcher that can be re-run
    # forever. No saved file → a one-shot temp copy the launcher unlinks as it
    # starts (see _cmd_write_launcher).
    local src="" one_shot=0
    if [[ -f "$pass_file" ]]; then
        src="$pass_file"
        info "Using the saved passphrase."
    else
        echo -ne "  Enter wallet passphrase to start the listener  ${DIM}(0 to skip)${RESET}: "
        local p=""; read -rs p; echo ""
        if [[ "$p" == "0" || -z "$p" ]]; then
            p=""; info "Listener not started."; return 0
        fi
        src="$dir/.listen_pass_$$"
        ( umask 077; printf '%s\n' "$p" > "$src" )
        chmod 600 "$src"; p=""
        one_shot=1
        warn "Passphrase not saved — this listener cannot be restarted unattended."
    fi

    # Port guard runs BEFORE the session is killed: once our own session is gone
    # the port it was holding looks like a foreign holder for a moment, and the
    # guard would abort a legitimate restart.
    if ! _cmd_port_collision_check "$net"; then
        [[ $one_shot -eq 1 ]] && rm -f "$src"
        return 0
    fi

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        warn "Session '${tmux_name}' is already running."
        echo -ne "  Kill and restart? [y/N/0 skip]: "
        local restart; read -r restart || true
        if [[ "$restart" == "0" || "${restart,,}" != "y" ]]; then
            # rc 0, not 1: this prompt is labelled "skip", and returning 1 made
            # the caller treat it as a cancel — discarding the whole summary,
            # including the address, for someone who only declined a restart.
            [[ $one_shot -eq 1 ]] && rm -f "$src"
            info "Listener left running as-is."
            return 0
        fi
        # Only "y" reaches here.
        tmux kill-session -t "$tmux_name" 2>/dev/null || true
        # Wait for the old listener to actually release the port, else the new
        # one binds nothing and exits.
        local _w=0
        while gnc_get_pid_on_port "$port" >/dev/null 2>&1 && [[ $_w -lt 10 ]]; do
            sleep 1; _w=$((_w + 1))
        done
    fi

    _cmd_write_launcher "$net" "$src" "$one_shot"
    tmux new-session -d -s "$tmux_name" "$launcher"

    if gnc_wait_for_port "$port" 15 1; then
        success "Listener up on $port  ${DIM}(tmux: $tmux_name)${RESET}"
        echo -e "         ${DIM}Attach: tmux attach -t $tmux_name${RESET}"
    elif tmux has-session -t "$tmux_name" 2>/dev/null; then
        warn "Session '$tmux_name' is alive but port $port is not listening yet."
        echo -e "         ${DIM}Check: tmux attach -t $tmux_name${RESET}"
    else
        [[ $one_shot -eq 1 ]] && rm -f "$src"
        warn "Listener exited immediately — usually a wrong passphrase."
        echo -e "         ${DIM}Run it in the foreground to see the error:${RESET}"
        echo -e "         ${DIM}  $launcher${RESET}"
    fi
    return 0
}

cmd_wallet_run() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN} 05C) GRIN WALLET QUICK SETUP${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo ""
        echo -e "  ${DIM}Download, init or recover, then start the Foreign listener (3415/13415)${RESET}"
        echo -e "  ${DIM}— for direct CLI use or testing. The passphrase is fed on stdin, never${RESET}"
        echo -e "  ${DIM}via -p, so it never appears in ps/cmdline.${RESET}"
        echo -e "  ${DIM}Stored in /opt/grin/cmdwallet/<net>/ — independent of other services.${RESET}"
        echo ""

        # Status
        local _any=0
        for _net in mainnet testnet; do
            local _dir="/opt/grin/cmdwallet/$_net"
            local _tmux="grin_${_net}_cmd_wallet"
            if [[ -f "$_dir/grin-wallet.toml" ]]; then
                _any=1
                if tmux has-session -t "$_tmux" 2>/dev/null; then
                    echo -e "  ${GREEN}●${RESET} ${BOLD}${_net}${RESET}  ${GREEN}listening${RESET}  ${DIM}(tmux: $_tmux)${RESET}"
                else
                    echo -e "  ${DIM}○ ${_net}  installed · not listening${RESET}"
                fi
            fi
        done
        [[ $_any -eq 0 ]] && echo -e "  ${DIM}No cmd wallet installed yet.${RESET}"
        echo ""

        echo -e "  ${GREEN}1${RESET}) Mainnet  ${DIM}(real GRIN)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Testnet  ${DIM}(tGRIN — no monetary value)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Both"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1/2/3/0]: ${RESET}"

        local sel; read -r sel || true
        case "$sel" in
            1) _cmd_wallet_setup_for_net "mainnet" || true ;;
            2) _cmd_wallet_setup_for_net "testnet" || true ;;
            3)
                local _ok=0
                _cmd_wallet_setup_for_net "mainnet" && _ok=1 || true
                if [[ $_ok -eq 1 ]]; then
                    echo ""
                    echo -e "${DIM}  ─── Now setting up testnet... ──────────────────────${RESET}"
                    sleep 2
                    _cmd_wallet_setup_for_net "testnet" || true
                fi
                ;;
            0|"") return 0 ;;
            *) echo -e "\n  ${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main() {
    while true; do
        show_menu
        read -r choice || true
        case "$choice" in
            1) run_sub "051_grin_private_web_wallet.sh" || true ;;
            2) run_sub "052_grin_drop.sh"               || true ;;
            3) run_sub "053_grin_woocommerce.sh"        || true ;;
            # 'C' kept as a silent alias: it was the printed key for a long time,
            # and 05C is still this product's identity in docs and filenames.
            [Aa]|[Cc]) cmd_wallet_run || true           ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main "$@"
