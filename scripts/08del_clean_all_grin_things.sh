#!/bin/bash
# =============================================================================
# 08del_clean_all_grin_things.sh - Full Grin Node Cleanup (Nuclear Option)
# =============================================================================
# Removes EVERYTHING Grin-related from this server:
#   · Running Grin node/wallet processes and tmux sessions
#   · nginx web root directories referenced by Grin configs
#   · nginx domain and reverse-proxy configuration files
#   · Grin binary install directories (/grin*, /usr/local/bin/grin*)
#   · Chain data and wallet files ($HOME/.grin/)
#   · Grin toolkit log files
#
# Each step requires individual confirmation before executing.
# This script CANNOT be undone. Back up wallet seeds before running.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ─── Logging ──────────────────────────────────────────────────────────────────
LOG_DIR="$SCRIPT_DIR/../log"
LOG_FILE="$LOG_DIR/grin_full_cleanup_$(date +%Y%m%d_%H%M%S).log"
mkdir -p "$LOG_DIR"

log()     { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; log "[INFO]  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; log "[OK]    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; log "[WARN]  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; log "[ERROR] $*"; }

# ─── Helpers ──────────────────────────────────────────────────────────────────
confirm_step() {
    # Returns 0 (true) if user types exactly 'y', else 1 (false)
    local prompt="$1"
    echo ""
    echo -ne "${BOLD}${YELLOW}▶ $prompt [y/N]: ${RESET}"
    read -r ans
    [[ "${ans,,}" == "y" ]]
}

section() {
    echo ""
    echo -e "${BOLD}${CYAN}── $* ──${RESET}"
    echo ""
}

# =============================================================================
# STEP 1 — Stop all Grin processes
# =============================================================================
step_stop_processes() {
    section "STEP 1: Stop All Grin Processes"

    local found_ports=()
    for port in 3414 13414 3415 13415; do
        local pid
        pid=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
        [[ -n "$pid" ]] && found_ports+=("$port:$pid")
    done

    local tmux_sessions=""
    tmux_sessions=$(tmux ls -F '#{session_name}' 2>/dev/null | grep '^grin_' || true)

    if [[ ${#found_ports[@]} -eq 0 && -z "$tmux_sessions" ]]; then
        success "No Grin processes or tmux sessions running. Skipping."
        log "[STEP 1] Nothing to stop."
        return
    fi

    info "Detected running Grin processes:"
    for entry in "${found_ports[@]}"; do
        local port="${entry%%:*}" pid="${entry##*:}"
        echo -e "  ${YELLOW}→${RESET} Port $port  (PID $pid)"
    done
    if [[ -n "$tmux_sessions" ]]; then
        while IFS= read -r sess; do
            echo -e "  ${YELLOW}→${RESET} tmux session: $sess"
        done <<< "$tmux_sessions"
    fi

    if confirm_step "Stop all Grin processes and close Grin tmux sessions?"; then
        local stop_timeout=30
        for entry in "${found_ports[@]}"; do
            local port="${entry%%:*}" pid="${entry##*:}"
            info "PID $pid on port $port — sending SIGTERM..."
            kill -TERM "$pid" 2>/dev/null || true
            local elapsed=0
            while ps -p "$pid" >/dev/null 2>&1 && [[ $elapsed -lt $stop_timeout ]]; do
                sleep 2; elapsed=$((elapsed + 2))
                [[ $((elapsed % 10)) -eq 0 ]] && info "Waiting for PID $pid... (${elapsed}s)"
            done
            if ps -p "$pid" >/dev/null 2>&1; then
                warn "PID $pid still alive after ${stop_timeout}s — sending SIGKILL..."
                kill -KILL "$pid" 2>/dev/null || true
                sleep 1
            fi
            success "Process on port $port stopped."
            log "[STEP 1] Stopped port $port PID $pid"
        done

        if [[ -n "$tmux_sessions" ]]; then
            while IFS= read -r sess; do
                tmux kill-session -t "$sess" 2>/dev/null \
                    && success "tmux session '$sess' closed." \
                    || warn "Could not close tmux session '$sess'."
                log "[STEP 1] Killed tmux session: $sess"
            done <<< "$tmux_sessions"
        fi
    else
        info "Skipped — processes still running. Some later steps may fail."
        log "[STEP 1] SKIPPED by user."
    fi
}

# =============================================================================
# STEP 2 — Remove nginx web directories
# =============================================================================
step_remove_web_dirs() {
    section "STEP 2: Remove nginx Web Root Directories"

    if [[ ! -d /etc/nginx/sites-available ]]; then
        info "nginx not installed. Skipping."
        log "[STEP 2] nginx not found. Skipped."
        return
    fi

    # Collect unique root dirs from configs with 'grin' in name OR path
    local -a web_dirs=()
    local seen=""

    while IFS= read -r conf; do
        local root_dir
        root_dir=$(grep -oP '(?<=root\s)[^;]+' "$conf" 2>/dev/null | head -1 | xargs 2>/dev/null || true)
        [[ -z "$root_dir" || ! -d "$root_dir" ]] && continue
        # Only include dirs that look Grin-related
        if [[ "$root_dir" == *grin* || "$conf" == *grin* ]]; then
            [[ "$seen" == *"|$root_dir|"* ]] && continue
            seen+="|$root_dir|"
            web_dirs+=("$root_dir")
        fi
    done < <(find /etc/nginx/sites-available -type f 2>/dev/null || true)

    if [[ ${#web_dirs[@]} -eq 0 ]]; then
        info "No Grin web directories found in nginx configs. Skipping."
        log "[STEP 2] No web dirs found. Skipped."
        return
    fi

    info "Web directories referenced in Grin nginx configs:"
    for d in "${web_dirs[@]}"; do
        local sz
        sz=$(du -sh "$d" 2>/dev/null | awk '{print $1}' || echo "?")
        echo -e "  ${YELLOW}→${RESET} $d  ${DIM}($sz)${RESET}"
    done

    if confirm_step "Permanently delete all web directories listed above?"; then
        for d in "${web_dirs[@]}"; do
            info "Removing $d ..."
            rm -rf "$d"
            success "Removed: $d"
            log "[STEP 2] DELETED web dir: $d"
        done
    else
        info "Skipped — web directories kept."
        log "[STEP 2] SKIPPED by user."
    fi
}

# =============================================================================
# STEP 3 — Remove all Grin nginx configs (fileserver + reverse proxy)
# =============================================================================
step_remove_nginx_configs() {
    section "STEP 3: Remove Grin nginx Configuration Files"

    if [[ ! -d /etc/nginx/sites-available ]]; then
        info "nginx not installed. Skipping."
        log "[STEP 3] nginx not found. Skipped."
        return
    fi

    # Known proxy config names (from script 04)
    local -a known_proxy=(
        "grin-node-api"
        "grin-node-api-testnet"
        "grin-wallet"
        "grin-wallet-testnet"
    )

    local -a found_confs=()
    local seen=""

    # Scan sites-available for anything named *grin*
    while IFS= read -r conf; do
        [[ "$seen" == *"|$conf|"* ]] && continue
        seen+="|$conf|"
        found_confs+=("$conf")
    done < <(find /etc/nginx/sites-available -name '*grin*' -type f 2>/dev/null || true)

    # Also check the known proxy names even if not named *grin* (shouldn't happen, but safe)
    for name in "${known_proxy[@]}"; do
        local path="/etc/nginx/sites-available/$name"
        [[ -f "$path" && "$seen" != *"|$path|"* ]] && found_confs+=("$path") && seen+="|$path|"
    done

    # Check conf.d for bandwidth map files
    local -a confds=()
    while IFS= read -r f; do
        confds+=("$f")
    done < <(find /etc/nginx/conf.d -name '*grin*' -type f 2>/dev/null || true)

    if [[ ${#found_confs[@]} -eq 0 && ${#confds[@]} -eq 0 ]]; then
        info "No Grin nginx configs found. Skipping."
        log "[STEP 3] No nginx configs found. Skipped."
        return
    fi

    info "Found Grin nginx config files:"
    for c in "${found_confs[@]}"; do
        local symlink="/etc/nginx/sites-enabled/$(basename "$c")"
        local enabled_label="${DIM}disabled${RESET}"
        [[ -L "$symlink" ]] && enabled_label="${GREEN}enabled${RESET}"
        echo -e "  ${YELLOW}→${RESET} $c  ($enabled_label)"
    done
    for c in "${confds[@]}"; do
        echo -e "  ${YELLOW}→${RESET} $c  ${DIM}(conf.d)${RESET}"
    done

    if confirm_step "Remove all Grin nginx configs and reload nginx?"; then
        for c in "${found_confs[@]}"; do
            local name
            name="$(basename "$c")"
            rm -f "/etc/nginx/sites-enabled/$name"
            rm -f "$c"
            success "Removed nginx config: $name"
            log "[STEP 3] DELETED nginx config: $c"
        done
        for c in "${confds[@]}"; do
            rm -f "$c"
            info "Removed conf.d file: $(basename "$c")"
            log "[STEP 3] DELETED conf.d: $c"
        done

        if nginx -t 2>/dev/null; then
            systemctl reload nginx 2>/dev/null \
                && success "nginx reloaded." \
                || warn "nginx reload failed — check manually."
            log "[STEP 3] nginx reloaded."
        else
            warn "nginx config test failed — check /etc/nginx manually before reloading."
            log "[STEP 3] nginx -t failed after removal."
        fi
    else
        info "Skipped — nginx configs kept."
        log "[STEP 3] SKIPPED by user."
    fi
}

# =============================================================================
# STEP 4 — Remove Grin binary / install directories
# =============================================================================
step_remove_install_dirs() {
    section "STEP 4: Remove Grin Binary and Install Directories"

    # Known locations script 01 creates
    local -a candidates=(
        "/grinwallettest"
        "/grinwalletmain"
        "/grinprunemain"
        "/grinprunetest"
        "/grinfullmain"
        "/grin"
        "/grin-wallet"
        "/usr/local/bin/grin"
        "/usr/local/bin/grin-wallet"
        "/opt/grin"
        "/opt/grin-wallet"

    )

    local -a found=()
    for c in "${candidates[@]}"; do
        [[ -e "$c" ]] && found+=("$c")
    done

    # Shallow scan of common install roots for anything named grin* not already found
    local seen="|${found[*]:-}|"
    while IFS= read -r d; do
        [[ "$seen" == *"|$d|"* ]] && continue
        found+=("$d")
        seen+="|$d|"
    done < <(
        find /opt /usr/local/bin /usr/bin -maxdepth 1 -name 'grin*' 2>/dev/null \
        | grep -v -E '(sites-available|nginx|log)' || true
    )

    if [[ ${#found[@]} -eq 0 ]]; then
        info "No Grin install paths found. Skipping."
        log "[STEP 4] Nothing found. Skipped."
        return
    fi

    info "Found Grin installation paths:"
    for f in "${found[@]}"; do
        local sz
        sz=$(du -sh "$f" 2>/dev/null | awk '{print $1}' || echo "?")
        echo -e "  ${YELLOW}→${RESET} $f  ${DIM}($sz)${RESET}"
    done

    if confirm_step "Remove all Grin install directories and binaries?"; then
        for f in "${found[@]}"; do
            rm -rf "$f"
            success "Removed: $f"
            log "[STEP 4] DELETED: $f"
        done
    else
        info "Skipped — install directories kept."
        log "[STEP 4] SKIPPED by user."
    fi
}

# =============================================================================
# STEP 5 — Remove $HOME/.grin (chain data + wallets)
# =============================================================================
step_remove_home_grin() {
    section "STEP 5: Remove \$HOME/.grin  (chain data and wallet files)"

    local grin_home="$HOME/.grin"

    if [[ ! -d "$grin_home" ]]; then
        info "\$HOME/.grin not found. Skipping."
        log "[STEP 5] $grin_home not found. Skipped."
        return
    fi

    local sz
    sz=$(du -sh "$grin_home" 2>/dev/null | awk '{print $1}' || echo "?")

    echo -e "  ${RED}${BOLD}WARNING: This deletes all chain data, wallet files, and API secrets.${RESET}"
    echo -e "  ${RED}         Wallet seed phrases will be PERMANENTLY LOST if not backed up.${RESET}"
    echo ""
    echo -e "  ${YELLOW}→${RESET} $grin_home  ${DIM}($sz)${RESET}"

    if confirm_step "Permanently delete \$HOME/.grin? (wallets WILL be lost)"; then
        rm -rf "$grin_home"
        success "Removed: $grin_home"
        log "[STEP 5] DELETED: $grin_home"
    else
        info "Skipped — \$HOME/.grin kept."
        log "[STEP 5] SKIPPED by user."
    fi
}

# =============================================================================
# STEP 6 — Remove toolkit log files
# =============================================================================
step_remove_logs() {
    section "STEP 6: Remove Grin Toolkit Log Files"

    local -a log_files=()

    # System-level logs
    while IFS= read -r f; do
        log_files+=("$f")
    done < <(find /var/log -maxdepth 1 \( -name 'grin*.log' -o -name 'grin_*.log' \) -type f 2>/dev/null || true)

    # Toolkit log directory
    local toolkit_logs="$SCRIPT_DIR/../log"
    if [[ -d "$toolkit_logs" ]]; then
        while IFS= read -r f; do
            # Skip the current run's log
            [[ "$f" == "$LOG_FILE" ]] && continue
            log_files+=("$f")
        done < <(find "$toolkit_logs" -type f -name '*.log' 2>/dev/null || true)
    fi

    if [[ ${#log_files[@]} -eq 0 ]]; then
        info "No Grin log files found. Skipping."
        log "[STEP 6] Nothing found. Skipped."
        return
    fi

    local total_sz
    total_sz=$(du -shc "${log_files[@]}" 2>/dev/null | tail -1 | awk '{print $1}' || echo "?")
    info "${#log_files[@]} log file(s) found, total: $total_sz"
    for f in "${log_files[@]}"; do
        echo -e "  ${DIM}→ $f${RESET}"
    done

    if confirm_step "Delete all Grin log files?"; then
        for f in "${log_files[@]}"; do
            rm -f "$f"
        done
        success "${#log_files[@]} log file(s) removed."
        log "[STEP 6] DELETED ${#log_files[@]} log files."
    else
        info "Skipped — logs kept."
        log "[STEP 6] SKIPPED by user."
    fi
}

# =============================================================================
# Main
# =============================================================================
main() {
    clear
    echo ""
    echo -e "${BOLD}${RED}╔══════════════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}║        FULL GRIN CLEANUP  —  THIS CANNOT BE UNDONE                  ║${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}╠══════════════════════════════════════════════════════════════════════╣${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}║  This script will PERMANENTLY remove:                               ║${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}║    1.  All running Grin node / wallet processes                      ║${RESET}"
    echo -e "${BOLD}${RED}║    2.  nginx web root directories for Grin                          ║${RESET}"
    echo -e "${BOLD}${RED}║    3.  All Grin nginx configuration files                           ║${RESET}"
    echo -e "${BOLD}${RED}║    4.  Grin binary and install directories (/grin*, /opt/grin*)     ║${RESET}"
    echo -e "${BOLD}${RED}║    5.  Chain data and wallet files  (\$HOME/.grin/)                  ║${RESET}"
    echo -e "${BOLD}${RED}║    6.  Grin toolkit log files                                       ║${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}║  Wallet seed phrases will be LOST if not backed up beforehand.      ║${RESET}"
    echo -e "${BOLD}${RED}║                                                                      ║${RESET}"
    echo -e "${BOLD}${RED}╚══════════════════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -ne "${BOLD}${RED}Type exactly  DESTROY  to begin, or press Enter to abort: ${RESET}"
    read -r gate

    if [[ "$gate" != "DESTROY" ]]; then
        echo ""
        info "Aborted. No changes made."
        echo ""
        return
    fi

    log "=== FULL GRIN CLEANUP STARTED by $(whoami) ==="

    step_stop_processes
    step_remove_web_dirs
    step_remove_nginx_configs
    step_remove_install_dirs
    step_remove_home_grin
    step_remove_logs

    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  Cleanup complete.${RESET}"
    echo -e "${BOLD}${GREEN}  Review log: $LOG_FILE${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""

    log "=== FULL GRIN CLEANUP COMPLETE ==="

    echo "Press Enter to return..."
    read -r
}

main "$@"
