#!/bin/bash
# =============================================================================
# 05_grin_wallet_service.sh — Grin Wallet Services Hub
# =============================================================================
#
#  Central launcher for all Grin wallet service scripts (051–055).
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
#   054  054_grin_payment_pro.sh          Payment Pro (coming soon)
#   055  055_grin_public_web_wallet.sh    Public WASM wallet (coming soon)
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

_CMD_GITHUB_API="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"

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
    echo -e "${BOLD}${CYAN} 05) GRIN WALLET SERVICES${RESET}"
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
    echo -e "${DIM}  ─── Launch ────────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Private Web Wallet"
    echo -e "     ${DIM}Personal browser UI — nginx + PHP + Basic Auth${RESET}"
    echo ""
    echo -e "  ${GREEN}2${RESET}) Grin Drop"
    echo -e "     ${DIM}Giveaway + donation portal — Flask + systemd${RESET}"
    echo ""
    echo -e "  ${GREEN}3${RESET}) WooCommerce Payment Gateway"
    echo -e "     ${DIM}Flask bridge + WordPress/WooCommerce plugin${RESET}"
    echo ""
    echo -e "  ${DIM}4) Payment Pro              (coming soon)${RESET}"
    echo -e "     ${DIM}   Shopify / custom API payment processor${RESET}"
    echo ""
    echo -e "  ${DIM}5) Public Web Wallet        (coming soon)${RESET}"
    echo -e "     ${DIM}   Client-side WASM wallet — no server keys${RESET}"
    echo ""
    echo -e "${DIM}  ─── Quick Tools ─────────────────────────────────────${RESET}"
    echo ""
    echo -e "  ${GREEN}C${RESET}) Grin Wallet Quick Setup"
    echo -e "     ${DIM}Download + init + listen — for direct CLI use or testing${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back to main menu"
    echo ""
    echo -ne "${BOLD}Select [1-5 / C / 0]: ${RESET}"
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

_cmd_patch_toml() {
    local toml="$1" key="$2" val="$3"
    if grep -q "^${key}\s*=" "$toml" 2>/dev/null; then
        sed -i "s|^${key}\s*=.*|${key} = ${val}|" "$toml"
    else
        echo "${key} = ${val}" >> "$toml"
    fi
}

# Setup wallet for one network.
# Returns 0 = completed or skipped, 1 = user cancelled mid-flow.
_cmd_wallet_setup_for_net() {
    local net="$1"
    local net_flag="" net_label="" wallet_dir="" tmux_name=""
    if [[ "$net" == "mainnet" ]]; then
        net_flag=""; net_label="MAINNET"
        wallet_dir="/opt/grin/cmdwallet/mainnet"
        tmux_name="grin_mainnet_cmd_wallet"
    else
        net_flag="--testnet"; net_label="TESTNET"
        wallet_dir="/opt/grin/cmdwallet/testnet"
        tmux_name="grin_testnet_cmd_wallet"
    fi
    local wallet_bin="$wallet_dir/grin-wallet"
    local pass_file="$wallet_dir/${net}_pass_wallet.txt"
    local seed_file="$wallet_dir/${net}_seed.txt"
    local toml_file="$wallet_dir/grin-wallet.toml"

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN} CMD Wallet Quick Setup — ${net_label}${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${DIM}Directory : $wallet_dir${RESET}"
    echo -e "  ${DIM}Binary    : $wallet_bin${RESET}"
    echo ""

    # ── Step 1: Download ──────────────────────────────────────────────────────
    local needs_download=1
    if [[ -x "$wallet_bin" ]]; then
        local ver; ver=$("$wallet_bin" --version 2>/dev/null | head -1 || echo "?")
        echo -e "  ${GREEN}[OK]${RESET}  Binary already installed  ${DIM}($ver)${RESET}"
        echo -ne "  Re-download latest? [y/N/0 cancel]: "
        local redown; read -r redown || true
        [[ "$redown" == "0" ]] && return 1
        [[ "${redown,,}" == "y" ]] || needs_download=0
    fi
    echo ""

    if [[ $needs_download -eq 1 ]]; then
        echo -e "  ${CYAN}[INFO]${RESET}  Fetching latest release from GitHub..."
        local release_json
        release_json=$(curl -fsSL --max-time 30 "$_CMD_GITHUB_API") \
            || { echo -e "  ${RED}[ERROR]${RESET} Failed to reach GitHub API."; echo -ne "\n  Press Enter..."; read -r || true; return 0; }

        local version download_url
        version=$(echo "$release_json" | jq -r '.tag_name')
        download_url=$(echo "$release_json" \
            | jq -r '.assets[] | select(.name | test("linux-x86_64\\.tar\\.gz$"; "i")) | .browser_download_url' \
            | head -1)

        if [[ -z "$download_url" || "$download_url" == "null" ]]; then
            echo -e "  ${RED}[ERROR]${RESET} No linux-x86_64 asset found for $version."
            echo -ne "\n  Press Enter..."; read -r || true; return 0
        fi

        mkdir -p "$wallet_dir"
        local tmp_tar="/tmp/grin_cmdwallet_$$.tar.gz"
        local tmp_dir="/tmp/grin_cmdwallet_extract_$$"
        mkdir -p "$tmp_dir"

        echo -e "  ${CYAN}[INFO]${RESET}  Version : $version"
        echo -e "  ${CYAN}[INFO]${RESET}  Target  : $wallet_bin"
        echo ""
        wget -c --progress=bar:force -O "$tmp_tar" "$download_url" \
            || { echo -e "\n  ${RED}[ERROR]${RESET} Download failed."; rm -rf "$tmp_tar" "$tmp_dir"; echo -ne "  Press Enter..."; read -r || true; return 0; }

        tar -xzf "$tmp_tar" -C "$tmp_dir" \
            || { echo -e "  ${RED}[ERROR]${RESET} Extraction failed."; rm -rf "$tmp_tar" "$tmp_dir"; echo -ne "  Press Enter..."; read -r || true; return 0; }
        rm -f "$tmp_tar"

        local bin_src
        bin_src=$(find "$tmp_dir" -type f -name "grin-wallet" | head -1)
        if [[ -z "$bin_src" ]]; then
            echo -e "  ${RED}[ERROR]${RESET} grin-wallet binary not found in archive."
            rm -rf "$tmp_dir"; echo -ne "  Press Enter..."; read -r || true; return 0
        fi
        install -m 755 "$bin_src" "$wallet_bin"
        rm -rf "$tmp_dir"
        echo -e "\n  ${GREEN}[OK]${RESET}  grin-wallet $version installed."
    fi
    echo ""

    # ── Step 2: Init ──────────────────────────────────────────────────────────
    if [[ -f "$toml_file" ]]; then
        echo -e "  ${YELLOW}[WARN]${RESET}  Wallet already initialized at $wallet_dir"
        echo -ne "  Re-initialize? ${RED}(overwrites existing wallet!)${RESET} [y/N/0 cancel]: "
        local reinit; read -r reinit || true
        [[ "$reinit" == "0" ]] && return 1
        if [[ "${reinit,,}" != "y" ]]; then
            echo -e "  ${DIM}Skipping init — existing wallet kept.${RESET}"
            echo ""
            _cmd_start_listener "$wallet_dir" "$wallet_bin" "$net_flag" \
                                 "$tmux_name" "$net_label" "$pass_file" || return 1
            echo ""
            echo -e "  ${GREEN}${BOLD}Done for ${net_label}.${RESET}"
            echo ""
            echo -ne "  ${DIM}Press Enter to return to menu...${RESET}"
            read -r || true
            return 0
        fi
    fi

    echo -e "  Enter wallet password for init  ${DIM}(0 at any prompt to cancel)${RESET}:"
    local wallet_pass=""
    while true; do
        echo -ne "    Password : "
        read -rs wallet_pass; echo ""
        [[ "$wallet_pass" == "0" ]] && unset wallet_pass && return 1
        [[ -z "$wallet_pass" ]] && echo -e "  ${YELLOW}[WARN]${RESET}  Password cannot be empty." && continue
        echo -ne "    Confirm  : "
        local wallet_pass2; read -rs wallet_pass2; echo ""
        [[ "$wallet_pass2" == "0" ]] && unset wallet_pass wallet_pass2 && return 1
        if [[ "$wallet_pass" != "$wallet_pass2" ]]; then
            echo -e "  ${RED}[ERROR]${RESET} Passwords do not match."; unset wallet_pass2; continue
        fi
        unset wallet_pass2; break
    done
    echo ""
    echo -e "  ${CYAN}[INFO]${RESET}  Running grin-wallet init -h  ${DIM}(write down your seed phrase!)${RESET}"
    echo ""

    local tmp_init="/tmp/grin_cmd_init_${net}_$$"
    mkdir -p "$wallet_dir"
    cd "$wallet_dir" && "$wallet_bin" $net_flag -p "$wallet_pass" init -h \
        2>&1 | tee "$tmp_init" || true
    echo ""

    if [[ ! -f "$toml_file" ]]; then
        echo -e "  ${YELLOW}[WARN]${RESET}  Init may have failed — grin-wallet.toml not found."
        echo -e "         ${DIM}Check output above.${RESET}"
        rm -f "$tmp_init"; unset wallet_pass
        echo -ne "  Press Enter to return..."; read -r || true; return 0
    fi
    echo -e "  ${GREEN}[OK]${RESET}  Wallet initialized."
    echo ""

    # ── Step 3: Save passphrase ───────────────────────────────────────────────
    echo -ne "  Save passphrase to ${BOLD}$(basename "$pass_file")${RESET}? [y/N/0 cancel]: "
    local save_pass; read -r save_pass || true
    if [[ "$save_pass" == "0" ]]; then
        rm -f "$tmp_init"; unset wallet_pass; return 1
    fi
    if [[ "${save_pass,,}" == "y" ]]; then
        echo "$wallet_pass" > "$pass_file"
        chmod 600 "$pass_file"
        echo -e "  ${GREEN}[OK]${RESET}  Saved → $pass_file  ${DIM}(mode 600)${RESET}"
    else
        echo -e "  ${DIM}       Passphrase not saved.${RESET}"
    fi
    unset wallet_pass
    echo ""

    # ── Step 4: Save seed ─────────────────────────────────────────────────────
    echo -ne "  Save seed phrase to ${BOLD}$(basename "$seed_file")${RESET}? [y/N/0 cancel]: "
    local save_seed; read -r save_seed || true
    if [[ "$save_seed" == "0" ]]; then
        rm -f "$tmp_init"; return 1
    fi
    if [[ "${save_seed,,}" == "y" ]]; then
        tail -6 "$tmp_init" > "$seed_file"
        chmod 600 "$seed_file"
        echo -e "  ${GREEN}[OK]${RESET}  Saved → $seed_file  ${DIM}(mode 600)${RESET}"
    else
        echo -e "  ${DIM}       Seed not saved.${RESET}"
    fi
    rm -f "$tmp_init"
    echo ""

    # ── Step 5: Patch grin-wallet.toml ───────────────────────────────────────
    local instances_conf="/opt/grin/conf/grin_instances_location.conf"
    local node_dir=""
    if [[ -f "$instances_conf" ]]; then
        # shellcheck source=/dev/null
        source "$instances_conf" 2>/dev/null || true
        if [[ "$net" == "testnet" ]]; then
            node_dir="${PRUNETEST_GRIN_DIR:-}"
        else
            node_dir="${PRUNEMAIN_GRIN_DIR:-${FULLMAIN_GRIN_DIR:-}}"
        fi
    fi
    if [[ -z "$node_dir" || ! -d "$node_dir" ]]; then
        local _fallback="/opt/grin/node/$( [[ "$net" == "testnet" ]] && echo testnet-prune || echo mainnet-prune )"
        node_dir="$_fallback"
    fi
    if [[ -f "$node_dir/.foreign_api_secret" ]]; then
        _cmd_patch_toml "$toml_file" "node_api_secret_path" "\"$node_dir/.foreign_api_secret\""
        echo -e "  ${GREEN}[OK]${RESET}  Patched node_api_secret_path"
        echo -e "         ${DIM}→ $node_dir/.foreign_api_secret${RESET}"
    else
        echo -e "  ${YELLOW}[WARN]${RESET}  .foreign_api_secret not found at $node_dir"
        echo -e "         ${DIM}Edit node_api_secret_path in $toml_file if needed.${RESET}"
    fi
    echo ""

    # ── Step 6: Start listener ────────────────────────────────────────────────
    _cmd_start_listener "$wallet_dir" "$wallet_bin" "$net_flag" \
                         "$tmux_name" "$net_label" "$pass_file" || return 1

    echo ""
    echo -e "  ${GREEN}${BOLD}Setup complete for ${net_label}.${RESET}"
    echo ""
    echo -e "  ${DIM}Wallet dir : $wallet_dir${RESET}"
    echo -e "  ${DIM}Binary     : $wallet_bin${RESET}"
    [[ -f "$pass_file" ]] && echo -e "  ${DIM}Pass file  : $pass_file${RESET}"
    [[ -f "$seed_file" ]] && echo -e "  ${DIM}Seed file  : $seed_file${RESET}"
    echo -e "  ${DIM}tmux       : $tmux_name${RESET}"
    echo ""
    echo -e "  ${DIM}Direct commands:${RESET}"
    echo -e "  ${DIM}  cd $wallet_dir && ./grin-wallet $net_flag info${RESET}"
    echo -e "  ${DIM}  tmux attach -t $tmux_name${RESET}"
    echo ""
    echo -ne "  ${DIM}Press Enter to return to menu...${RESET}"
    read -r || true
    return 0
}

_cmd_start_listener() {
    local wallet_dir="$1" wallet_bin="$2" net_flag="$3" \
          tmux_name="$4" net_label="$5" pass_file="$6"

    local pass_arg=""
    if [[ -f "$pass_file" ]]; then
        pass_arg=$(<"$pass_file")
        echo -e "  ${CYAN}[INFO]${RESET}  Using saved passphrase."
    else
        echo -ne "  Enter wallet password to start listener  ${DIM}(0 to skip)${RESET}: "
        read -rs pass_arg; echo ""
        if [[ "$pass_arg" == "0" || -z "$pass_arg" ]]; then
            echo -e "  ${DIM}Listener not started.${RESET}"; return 0
        fi
    fi

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        echo -e "  ${YELLOW}[WARN]${RESET}  Session '${tmux_name}' already running."
        echo -ne "  Kill and restart? [y/N/0 skip]: "
        local restart; read -r restart || true
        if [[ "$restart" == "0" ]]; then unset pass_arg; return 1; fi
        if [[ "${restart,,}" == "y" ]]; then
            tmux kill-session -t "$tmux_name" 2>/dev/null || true
            sleep 1
        else
            echo -e "  ${DIM}Listener not restarted.${RESET}"; unset pass_arg; return 0
        fi
    fi

    # Write launcher script to avoid embedding the password in the tmux command string
    local launcher="/opt/grin/cmdwallet/.${net_label,,}_listener.sh"
    local pass_tmp="/opt/grin/cmdwallet/.${net_label,,}_pass_tmp_$$"
    mkdir -p /opt/grin/cmdwallet
    echo "$pass_arg" > "$pass_tmp"
    chmod 600 "$pass_tmp"
    unset pass_arg
    cat > "$launcher" << LAUNCHER_EOF
#!/bin/bash
cd "$wallet_dir"
_p=\$(cat "$pass_tmp" 2>/dev/null || echo "")
rm -f "$pass_tmp"
exec "$wallet_bin" $net_flag -p "\$_p" listen
LAUNCHER_EOF
    chmod 700 "$launcher"
    tmux new-session -d -s "$tmux_name" "$launcher"
    sleep 1

    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        echo -e "  ${GREEN}[OK]${RESET}  Listener started  ${DIM}(tmux: $tmux_name)${RESET}"
        echo -e "         ${DIM}Attach: tmux attach -t $tmux_name${RESET}"
    else
        rm -f "$pass_tmp"
        echo -e "  ${YELLOW}[WARN]${RESET}  Session not found after start — may have exited immediately."
        echo -e "         ${DIM}Try manually: tmux new -s $tmux_name${RESET}"
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
        echo -e "  ${DIM}Download, init, and start listener — for direct CLI use or testing.${RESET}"
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
            1) run_sub "051_grin_private_web_wallet.sh" ;;
            2) run_sub "052_grin_drop.sh"               ;;
            3) run_sub "053_grin_woocommerce.sh"        ;;
            4) run_sub "054_grin_payment_pro.sh"        ;;
            5) run_sub "055_grin_public_web_wallet.sh"  ;;
            [Cc]) cmd_wallet_run || true                ;;
            0) break ;;
            "") continue ;;
            *) echo -e "\n${RED}Invalid option.${RESET}"; sleep 1 ;;
        esac
    done
}

main "$@"
