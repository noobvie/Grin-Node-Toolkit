# =============================================================================
# lib/07_lib_pool_wallet.sh — Coinbase + payout wallet for the PUBLIC POOL
# =============================================================================
# ONE combined listener handles BOTH wallet APIs the pool needs, with NO
# passphrase on any long-running command line:
#
#   · `grin-wallet owner_api`  (Owner port 3420) started WITHOUT -p, with
#       `owner_api_include_foreign = true` in grin-wallet.toml so the Foreign
#       API (/v2/foreign, build_coinbase) is mounted on the SAME port. The
#       node's stratum calls wallet_listener_url = .../v2/foreign on 3420 to
#       build_coinbase when a miner finds a block → THIS is how the pool
#       receives block rewards. The pool backend opens its own ECDH session on
#       /v3/owner here to check balance + send Tor payouts.
#
# The passphrase is NEVER in `ps`: the listener boots locked, then the wallet
# is opened via `open_wallet` over ECDH (pool-wallet-unlock.js), reading the
# saved passphrase from a FILE (mode 600). A reboot wipes the decrypted seed
# from RAM, so the boot orchestrator + */5 watchdog re-run open_wallet after
# every (re)start — coinbase needs the seed in memory, which only the
# passphrase can restore. (See CLAUDE.md "Wallet ↔ Node" + the GitHub design
# discussion: build_coinbase is a local keychain op, so the seed must be open.)
#
#   pw_setup                install binary + init|recover + patch tomls + start
#   pw_listener_start       (re)start the combined listener in tmux + unlock
#   pw_listener_stop        stop it (and migrate-kill the legacy dual sessions)
#   pw_listener_status      one line: session/port + wallet_open state
#   pw_unlock               open_wallet over ECDH (passphrase from file)
#   pw_coinbase_probe       0=open 1=locked 2=unknown (build_coinbase probe)
#   pw_show_address         print the pool wallet's Grin address
#   pw_patch_node_toml      point the node's wallet_listener_url at 3420/v2/foreign
#   pw_autostart_enable / pw_autostart_disable / pw_autostart_status
#   pw_watchdog_install / pw_watchdog_remove / pw_watchdog_status
#
# Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_POOL_WALLET_SH_LOADED:-}" ]] && return 0
_GRIN_POOL_WALLET_SH_LOADED=1

_PW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=grin_wallet_install.sh
source "$_PW_LIB_DIR/grin_wallet_install.sh"
# shellcheck source=grin_node_control.sh
source "$_PW_LIB_DIR/grin_node_control.sh"

# ─── Constants (network-aware; env-overridable for testing) ──────────────────
# The pool supports testnet (see CLAUDE.md). $POOL_NET is set by the parent script
# (mainnet|testnet). Testnet uses the grin-wallet testnet owner port (13420), the
# `--testnet` CLI flag, the testnet node dir, and a `_testnet`-suffixed tmux/watchdog
# name so a testnet wallet never collides with a mainnet one on the same box.
# PW_FOREIGN_PORT is kept only to pin grin-wallet.toml api_listen_port (the canonical
# Foreign port if `grin-wallet listen` is ever run standalone) and for the parent
# menu's display — at runtime the Foreign API rides PW_OWNER_PORT via include_foreign.
_PW_NET="${POOL_NET:-mainnet}"
if [[ "$_PW_NET" == "testnet" ]]; then
    PW_FOREIGN_PORT="${PW_FOREIGN_PORT:-13415}"
    PW_OWNER_PORT="${PW_OWNER_PORT:-13420}"
    PW_NET_FLAG="--testnet"
    _PW_NODE_NET="testnet"
    PW_TMUX_WALLET="${PW_TMUX_WALLET:-grin_pubpoolwallet_testnet}"
    PW_WATCHDOG_BIN="${PW_WATCHDOG_BIN:-/usr/local/bin/grin-pubpool-wallet-watchdog-testnet}"
    PW_WATCHDOG_CRON="${PW_WATCHDOG_CRON:-/etc/cron.d/grin-pubpool-wallet-watchdog-testnet}"
    PW_WATCHDOG_STATE="${PW_WATCHDOG_STATE:-/opt/grin/pubpool/wallet-watchdog-testnet}"
    PW_WATCHDOG_LOG="${PW_WATCHDOG_LOG:-/opt/grin/logs/pubpool-wallet-watchdog-testnet.log}"
    PW_AUTOSTART_TAG="${PW_AUTOSTART_TAG:-# grin-node-toolkit: grin_pubpoolwallet_testnet_autostart}"
else
    PW_FOREIGN_PORT="${PW_FOREIGN_PORT:-3415}"
    PW_OWNER_PORT="${PW_OWNER_PORT:-3420}"
    PW_NET_FLAG=""
    _PW_NODE_NET="mainnet"
    PW_TMUX_WALLET="${PW_TMUX_WALLET:-grin_pubpoolwallet}"
    PW_WATCHDOG_BIN="${PW_WATCHDOG_BIN:-/usr/local/bin/grin-pubpool-wallet-watchdog}"
    PW_WATCHDOG_CRON="${PW_WATCHDOG_CRON:-/etc/cron.d/grin-pubpool-wallet-watchdog}"
    PW_WATCHDOG_STATE="${PW_WATCHDOG_STATE:-/opt/grin/pubpool/wallet-watchdog}"
    PW_WATCHDOG_LOG="${PW_WATCHDOG_LOG:-/opt/grin/logs/pubpool-wallet-watchdog.log}"
    PW_AUTOSTART_TAG="${PW_AUTOSTART_TAG:-# grin-node-toolkit: grin_pubpoolwallet_autostart}"
fi

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

# ─── Path resolvers (read live pool config when available) ──────────────────
# pool_read_conf / the POOL_* vars are defined by the parent pool script. When
# this lib is exercised standalone the env fallbacks keep the resolvers working.
pw_wallet_dir() {
    if declare -F pool_read_conf >/dev/null 2>&1; then
        pool_read_conf "grin_wallet_dir" "${POOL_WALLET_DIR:-/opt/grin/pubpoolwallet/$_PW_NET}"
    else
        echo "${POOL_WALLET_DIR:-/opt/grin/pubpoolwallet/$_PW_NET}"
    fi
}
pw_pass_file() {
    if declare -F pool_read_conf >/dev/null 2>&1; then
        pool_read_conf "wallet_pass_file" "${POOL_APP_DIR:-/opt/grin/pubpool/$_PW_NET}/.wallet_pass"
    else
        echo "${POOL_APP_DIR:-/opt/grin/pubpool/$_PW_NET}/.wallet_pass"
    fi
}
pw_bin()            { echo "$(pw_wallet_dir)/grin-wallet"; }
pw_toml()           { echo "$(pw_wallet_dir)/grin-wallet.toml"; }
pw_launcher()       { echo "$(pw_wallet_dir)/listen-wallet.sh"; }       # tmux payload (owner_api, no -p)
pw_unlock_helper()  { echo "$(pw_wallet_dir)/pool-wallet-unlock.js"; }  # ECDH open_wallet
pw_boot_script()    { echo "$(pw_wallet_dir)/pool-wallet-boot.sh"; }    # start + wait + unlock

# Resolve the wallet's own Owner/Foreign API secret files from grin-wallet.toml
# (the Basic-Auth secrets the listener serves), falling back to the default names.
pw_owner_secret_path() {
    local dir toml p; dir=$(pw_wallet_dir); toml=$(pw_toml)
    p=$(grep -E '^[[:space:]]*owner_api_secret_path[[:space:]]*=' "$toml" 2>/dev/null | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^"//; s/"[[:space:]]*$//')
    case "$p" in
        /*) echo "$p" ;;
        "") echo "$dir/.owner_api_secret" ;;
        *)  echo "$dir/$p" ;;
    esac
}
pw_foreign_secret_path() {
    local dir toml p; dir=$(pw_wallet_dir); toml=$(pw_toml)
    p=$(grep -E '^[[:space:]]*api_secret_path[[:space:]]*=' "$toml" 2>/dev/null | head -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^"//; s/"[[:space:]]*$//')
    case "$p" in
        /*) [[ -f "$p" ]] && { echo "$p"; return; } ;;
        ?*) [[ -f "$dir/$p" ]] && { echo "$dir/$p"; return; } ;;
    esac
    [[ -f "$dir/.foreign_api_secret" ]] && { echo "$dir/.foreign_api_secret"; return; }
    echo "$dir/.api_secret"
}

# ─── Passphrase reader (min 3 chars, confirm; "0" cancels → rc 1) ───────────
_pw_read_new_pass() {
    local pass pass2
    while true; do
        read -rs -p "  Passphrase (min 3 chars, 0 to cancel): " pass; echo "" >&2
        [[ "$pass" == "0" ]] && return 1
        if [[ ${#pass} -lt 3 ]]; then echo "  Too short." >&2; continue; fi
        read -rs -p "  Confirm passphrase: " pass2; echo "" >&2
        if [[ "$pass" != "$pass2" ]]; then echo "  Mismatch — try again." >&2; unset pass pass2; continue; fi
        unset pass2; break
    done
    printf '%s' "$pass"
}

# ─── Verify a passphrase actually opens the wallet seed ──────────────────────
# Runs the local `address` command (no node needed) — succeeds only if the seed
# decrypts. Used before saving a passphrase, so we never hand the listener a
# password that can't open the wallet. <dir> <bin> <pass>
_pw_verify_pass() {
    local d="$1" b="$2" p="$3" out
    out=$( cd "$d" && "$b" $PW_NET_FLAG --top_level_dir "$d" -p "$p" address 2>&1 )
    # Matches grin1… (mainnet) and tgrin1… (testnet — "tgrin1" contains "grin1").
    grep -qiE 'grin1[a-z0-9]{40,}|tor address' <<< "$out"
}

# ─── Archive an existing wallet dir aside as <dir>_ddmmyy ────────────────────
# grin-wallet refuses to `init` over an existing config dir ("Wallet
# configuration already exists"), so a fresh wallet must move the old one aside.
# Renamed, never deleted — the seed/passphrase stay recoverable. <dir>
_pw_archive_wallet_dir() {
    local d="$1" stamp archive
    stamp=$(date +%d%m%y)
    archive="${d}_${stamp}"
    [[ -e "$archive" ]] && archive="${d}_${stamp}-$(date +%H%M%S)"
    if mv "$d" "$archive"; then
        success "Old wallet archived → $archive (renamed, not deleted)."
        warn "Its seed + passphrase still live there — keep it until the new wallet is confirmed."
        return 0
    fi
    error "Could not move $d aside (→ $archive). Resolve manually and re-run."
    return 1
}

# ─── Port-collision guard ───────────────────────────────────────────────────
# 3420 is a grin-wallet default — another wallet service (05C, 051/055, a 052
# drop) may already hold it. NEVER auto-kill another service's wallet. Returns 0
# if free OR already held by OUR session; rc 1 if a foreign process holds it.
# <port> <our-tmux-name>
_pw_port_collision_check() {
    local port="$1" tmux_name="$2"
    gnc_get_pid_on_port "$port" >/dev/null 2>&1 || return 0   # free → OK
    if tmux has-session -t "$tmux_name" 2>/dev/null; then
        info "Port $port already served by our session '$tmux_name'."
        return 0
    fi
    error "Port $port is in use by ANOTHER process (not '$tmux_name')."
    error "  Likely 05C cmdwallet, 051/055 web wallet, or a 052 drop wallet."
    error "  Stop that service first, or move the pool wallet to a non-default"
    error "  port and update grin-wallet.toml + the backend config to match."
    return 1
}

# ─── Generated files: listener + ECDH unlock helper + boot orchestrator ──────
pw_write_launchers() {
    local dir bin pass_file lf uj boot node_bin osec
    dir=$(pw_wallet_dir); bin=$(pw_bin); pass_file=$(pw_pass_file)
    lf=$(pw_launcher); uj=$(pw_unlock_helper); boot=$(pw_boot_script)
    osec=$(pw_owner_secret_path)
    node_bin="$(command -v node 2>/dev/null || echo node)"
    mkdir -p "$dir"

    # 1) Long-running listener (tmux payload): combined Owner+Foreign API, NO -p.
    #    owner_api_include_foreign=true (set in grin-wallet.toml) mounts the
    #    Foreign API on this Owner port, so build_coinbase + payouts share one
    #    process. The passphrase is NOT in argv — pool-wallet-unlock.js opens the
    #    wallet afterwards over ECDH.
    cat > "$lf" <<EOF
#!/bin/bash
# GENERATED by 07_lib_pool_wallet.sh — combined Owner+Foreign listener (port $PW_OWNER_PORT, no passphrase in argv).
cd "$dir" || exit 1
exec "$bin" $PW_NET_FLAG --top_level_dir "$dir" owner_api
EOF
    chmod 700 "$lf"

    # 2) ECDH unlock helper (mirrors back-end-pool/lib/wallet.js ownerApiSession).
    #    Reads the owner secret + passphrase from FILES, never argv. open_wallet
    #    decrypts the seed into the listener's memory so build_coinbase works.
    #    The shared key is computeSecret() AS-IS — never sha256 it (see CLAUDE.md).
    cat > "$uj" <<'NODE'
const crypto = require('crypto'), fs = require('fs');
const [ownerPort, secFile, passFile] = process.argv.slice(2);
const ownerUrl = 'http://127.0.0.1:' + ownerPort + '/v3/owner';
const rf = f => fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
const headers = { 'Content-Type': 'application/json',
  Authorization: 'Basic ' + Buffer.from('grin:' + rf(secFile)).toString('base64') };
async function ecdh() {
  const e = crypto.createECDH('secp256k1'); e.generateKeys();
  const r = await fetch(ownerUrl, { method:'POST', headers,
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'init_secure_api',
      params:{ ecdh_pubkey: e.getPublicKey('hex','compressed') } }),
    signal: AbortSignal.timeout(10000) });
  const j = JSON.parse(await r.text());
  if (j.error) throw new Error('init_secure_api: ' + JSON.stringify(j.error));
  return e.computeSecret(Buffer.from(j.result.Ok || j.result, 'hex'));
}
async function enc(sk, method, params) {
  const n = crypto.randomBytes(12), nh = n.toString('hex');
  const inner = JSON.stringify({ jsonrpc:'2.0', id:nh, method, params });
  const c = crypto.createCipheriv('aes-256-gcm', sk, n);
  const be = Buffer.concat([c.update(inner,'utf8'), c.final(), c.getAuthTag()]).toString('base64');
  const r = await fetch(ownerUrl, { method:'POST', headers,
    body: JSON.stringify({ jsonrpc:'2.0', id:nh, method:'encrypted_request_v3',
      params:{ nonce:nh, body_enc:be } }), signal: AbortSignal.timeout(30000) });
  const j = JSON.parse(await r.text());
  if (j.error) throw new Error('encrypted_request_v3: ' + JSON.stringify(j.error));
  const o0 = j.result.Ok || j.result;
  const buf = Buffer.from(o0.body_enc, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', sk, Buffer.from(o0.nonce, 'hex'));
  d.setAuthTag(buf.slice(-16));
  const o = JSON.parse(Buffer.concat([d.update(buf.slice(0,-16)), d.final()]).toString('utf8'));
  if (o.error) throw new Error(method + ': ' + JSON.stringify(o.error));
  if (o.result && o.result.Err) throw new Error(method + ': ' + JSON.stringify(o.result.Err));
  return o.result && o.result.Ok !== undefined ? o.result.Ok : o.result;
}
(async () => {
  const sk = await ecdh();
  try { await enc(sk, 'open_wallet', { name:null, password: rf(passFile) }); console.log('OK opened'); }
  catch (e) { if (/already.*(open|unlock)/i.test(e.message)) { console.log('OK already open'); return; } throw e; }
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
NODE
    chmod 700 "$uj"

    # 3) Boot/relaunch orchestrator: (re)start the tmux listener, wait for the
    #    port, then unlock. Reused by @reboot autostart AND the watchdog so the
    #    wallet is re-opened after every restart (a reboot wipes the seed from RAM).
    cat > "$boot" <<EOF
#!/bin/bash
# GENERATED by 07_lib_pool_wallet.sh — start combined listener + open_wallet.
set -uo pipefail
TMUX_NAME="$PW_TMUX_WALLET"
LAUNCHER="$lf"
OWNER_PORT="$PW_OWNER_PORT"
UNLOCK_JS="$uj"
OWNER_SECRET="$osec"
PASS_FILE="$pass_file"
NODE_BIN="$node_bin"
EOF
    cat >> "$boot" <<'EOF'
port_up(){ (exec 3<>"/dev/tcp/127.0.0.1/$OWNER_PORT") 2>/dev/null; }
if ! tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
    SHELL=/bin/bash tmux new-session -d -s "$TMUX_NAME" "$LAUNCHER"
fi
for _ in $(seq 1 30); do port_up && break; sleep 1; done
port_up || { echo "[boot] owner_api port $OWNER_PORT not up"; exit 1; }
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node 2>/dev/null || echo node)"
"$NODE_BIN" "$UNLOCK_JS" "$OWNER_PORT" "$OWNER_SECRET" "$PASS_FILE"
EOF
    chmod 700 "$boot"
}

# ─── Unlock the running listener (open_wallet over ECDH) ─────────────────────
pw_unlock() {
    local out node_bin
    command -v node >/dev/null 2>&1 || { error "node not found — required to unlock the wallet (open_wallet ECDH)."; return 1; }
    node_bin="$(command -v node)"
    out=$("$node_bin" "$(pw_unlock_helper)" "$PW_OWNER_PORT" "$(pw_owner_secret_path)" "$(pw_pass_file)" 2>&1) || true
    if [[ "$out" == OK* ]]; then info "Wallet unlock: $out"; return 0; fi
    error "Wallet unlock failed: $out"; return 1
}

# ─── Coinbase liveness probe ────────────────────────────────────────────────
# build_coinbase only succeeds when the wallet is OPEN, so it doubles as the
# "is the seed in memory?" check. 0 = open (coinbase works), 1 = up but locked,
# 2 = unreachable / inconclusive.
pw_coinbase_probe() {
    local fsec cfg="" out
    fsec=$(pw_foreign_secret_path)
    # Pass the foreign Basic-Auth secret via a curl config on STDIN (-K -), never
    # on the command line, so it can't leak in `ps`/cmdline (the whole point here).
    [[ -f "$fsec" ]] && cfg="user = \"grin:$(cat "$fsec")\""
    out=$(printf '%s' "$cfg" | curl -s --max-time 10 -K - -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"build_coinbase","params":[{"fees":0,"height":0,"key_id":null}],"id":1}' \
        "http://127.0.0.1:${PW_OWNER_PORT}/v2/foreign" 2>/dev/null)
    [[ -z "$out" ]] && return 2
    grep -q '"output"' <<< "$out" && return 0
    grep -qiE 'not open|no wallet|lifecycle|open the wallet|NotOpen|doesn.t exist' <<< "$out" && return 1
    return 2
}

# ─── Listener start / stop / status ─────────────────────────────────────────
pw_listener_start() {
    [[ -f "$(pw_pass_file)" ]] || { error "No saved wallet password ($(pw_pass_file)) — run Setup wallet first."; return 1; }
    [[ -x "$(pw_bin)" ]] || { error "No grin-wallet binary at $(pw_bin) — run Setup wallet first."; return 1; }

    # Guarantee the combined-listener toggle is on — without it owner_api won't
    # serve /v2/foreign, so payouts would work but coinbase silently FAILS. Cheap
    # and idempotent; covers starting from the menu without re-running full setup.
    local _toml; _toml=$(pw_toml)
    if [[ -f "$_toml" ]] && ! grep -Eq '^[[:space:]]*owner_api_include_foreign[[:space:]]*=[[:space:]]*true' "$_toml"; then
        _pw_ensure_toml_key "$_toml" "owner_api_include_foreign" "true" "wallet"
        info "Enabled owner_api_include_foreign in grin-wallet.toml (coinbase via Owner port)."
    fi
    pw_write_launchers

    _pw_port_collision_check "$PW_OWNER_PORT" "$PW_TMUX_WALLET" || return 1
    if tmux has-session -t "$PW_TMUX_WALLET" 2>/dev/null && gnc_get_pid_on_port "$PW_OWNER_PORT" >/dev/null 2>&1; then
        info "Pool wallet listener already running (session '$PW_TMUX_WALLET')."
    else
        info "Starting combined pool wallet listener (Owner+Foreign) on $PW_OWNER_PORT..."
        SHELL=/bin/bash tmux new-session -d -s "$PW_TMUX_WALLET" "$(pw_launcher)" \
            || { error "Failed to start tmux session '$PW_TMUX_WALLET'."; return 1; }
        if ! gnc_wait_for_port "$PW_OWNER_PORT" 20 2; then
            error "Listener session started but port $PW_OWNER_PORT is NOT listening — port collision or wallet busy."
            error "  Check: tmux attach -t $PW_TMUX_WALLET"
            return 1
        fi
    fi

    info "Unlocking wallet (open_wallet over ECDH; passphrase read from file, not argv)..."
    if pw_unlock; then
        success "Pool wallet UP on $PW_OWNER_PORT and UNLOCKED — coinbase (Foreign) + payouts (Owner) ready."
    else
        error "Listener is up but the wallet could NOT be opened — coinbase will FAIL until it is."
        error "  Verify: node installed, passphrase correct, owner secret readable. tmux attach -t $PW_TMUX_WALLET"
        return 1
    fi
}

pw_listener_stop() {
    # Also migrate-kill the legacy dual-listener sessions from older deploys.
    local stopped=0 t
    for t in "$PW_TMUX_WALLET" \
             grin_pubpoolwallet_foreign grin_pubpoolwallet_owner \
             grin_pubpoolwallet_testnet_foreign grin_pubpoolwallet_testnet_owner; do
        if tmux has-session -t "$t" 2>/dev/null; then
            tmux kill-session -t "$t" 2>/dev/null || true
            success "Stopped listener (session '$t')."
            stopped=1
        fi
    done
    [[ "$stopped" -eq 1 ]] || info "No running pool wallet listener sessions."
}

pw_listener_status() {
    local up_sess="no" up_port="no" open="?" tag prc
    tmux has-session -t "$PW_TMUX_WALLET" 2>/dev/null && up_sess="yes"
    gnc_get_pid_on_port "$PW_OWNER_PORT" >/dev/null 2>&1 && up_port="yes"
    if [[ "$up_sess" == "yes" && "$up_port" == "yes" ]]; then
        prc=0; pw_coinbase_probe || prc=$?     # || form: tested → set -e won't abort the menu
        case "$prc" in
            0) open="yes";    tag="${GREEN:-}[RUNNING]${RESET:-}" ;;
            1) open="LOCKED"; tag="${YELLOW:-}[UP/LOCKED]${RESET:-}" ;;
            *) open="?";      tag="${YELLOW:-}[UP/?]${RESET:-}" ;;
        esac
    else
        tag="${RED:-}[DOWN]${RESET:-}"
    fi
    printf '%s %-22s session=%s port=%s(%s) wallet_open=%s\n' \
        "$tag" "Wallet(Owner+Foreign)" "$up_sess" "$PW_OWNER_PORT" "$up_port" "$open"
}

pw_show_address() {
    local dir bin pf
    dir=$(pw_wallet_dir); bin=$(pw_bin); pf=$(pw_pass_file)
    [[ -x "$bin" && -f "$pf" ]] || { error "Pool wallet not set up (binary/password missing)."; return 1; }
    ( cd "$dir" && "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "$(cat "$pf")" address 2>/dev/null ) \
        | grep -oE 't?grin1[a-z0-9]{40,}' | head -1 || warn "Could not read address."
}

# ─── Patch the node's grin-server.toml wallet_listener_url → our Foreign API ─
# The node's stratum sends every block's coinbase to wallet_listener_url. For a
# pool that MUST be the pool wallet's Foreign API (now served on the Owner port
# via include_foreign), or rewards go to the wrong wallet.
pw_patch_node_toml() {
    local node_dir toml wlu="http://127.0.0.1:${PW_OWNER_PORT}/v2/foreign"
    node_dir=$(gnc_resolve_node_dir "$_PW_NODE_NET" 2>/dev/null || true)
    if [[ -z "$node_dir" ]]; then
        local default_toml="/opt/grin/node/${_PW_NODE_NET}-prune/grin-server.toml"
        echo -ne "Path to the node's grin-server.toml [$default_toml]: "
        read -r toml; [[ -z "$toml" ]] && toml="$default_toml"
    else
        toml="$node_dir/grin-server.toml"
    fi
    if [[ ! -f "$toml" ]]; then
        warn "grin-server.toml not found ($toml) — set wallet_listener_url = \"$wlu\" manually."
        return 1
    fi
    cp -a "$toml" "${toml}.bak.$(date +%s)" 2>/dev/null && info "Backed up $toml"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*wallet_listener_url[[:space:]]*=" "$toml"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*wallet_listener_url[[:space:]]*=.*|wallet_listener_url = \"$wlu\"|" "$toml"
        success "Patched wallet_listener_url → $wlu in $toml"
        warn "Restart the Grin node for the coinbase change to take effect."
    else
        warn "wallet_listener_url not present in $toml — add it under [server.stratum_mining_config]:"
        warn "  wallet_listener_url = \"$wlu\""
    fi
}

# ─── Setup: install binary + init|recover + patch tomls + start listener ────
pw_setup() {
    local dir bin toml pass_file

    if [[ "$_PW_NET" == "testnet" ]]; then
        echo -e "\n${BOLD:-}Set up pool wallet (coinbase + payouts) — TESTNET${RESET:-}\n"
        warn "TESTNET — this wallet receives test tGRIN coinbase + sends test payouts (no real value)."
        warn "ONE combined listener (owner_api + include_foreign) on port ${PW_OWNER_PORT}; addresses are tgrin1…"
    else
        echo -e "\n${BOLD:-}Set up pool wallet (coinbase + payouts) — Mainnet${RESET:-}\n"
        warn "MAINNET — this wallet receives REAL GRIN coinbase and sends miner payouts."
        warn "ONE combined listener (owner_api + include_foreign) on port ${PW_OWNER_PORT}."
    fi

    # Wallet dir is asked here, not in 2) Configure — it's a wallet concern, and
    # every other pw_* path (binary, toml, launchers) derives from it. Must be
    # answered BEFORE the resolvers below run.
    if declare -F pool_write_conf_key >/dev/null 2>&1; then
        local cur_dir new_dir
        cur_dir=$(pw_wallet_dir)
        echo -ne "Wallet dir [$cur_dir]: "
        read -r new_dir || true
        if [[ -n "$new_dir" && "$new_dir" != "$cur_dir" ]]; then
            pool_write_conf_key "grin_wallet_dir" "$new_dir"
            info "Wallet dir set to $new_dir"
        fi
    fi

    dir=$(pw_wallet_dir); bin=$(pw_bin); toml=$(pw_toml); pass_file=$(pw_pass_file)

    # 1) Decide what to do when a wallet already exists. grin-wallet refuses to
    #    `init` over an existing config dir, so a NEW / RECOVERED wallet must move
    #    the old dir aside first (archived → <dir>_ddmmyy, never deleted). We only
    #    archive AFTER a valid new passphrase is in hand (step 3a), so a cancel at
    #    the passphrase prompt never disturbs the existing wallet.
    local action="new"          # new | existing | recover
    if [[ -f "$toml" ]]; then
        warn "Wallet already initialized at $dir."
        echo -e "  What do you want to do?"
        echo -e "    1) Use the EXISTING wallet  (you remember its passphrase)"
        echo -e "    2) Create a NEW wallet      (archive old dir → ${dir}_$(date +%d%m%y), then init)"
        echo -e "    3) Recover from seed        (archive old dir, then init -hr)"
        echo -ne "  Select [1/2/3/0]: "
        local choice; read -r choice || true
        case "$choice" in
            1) action="existing" ;;
            2) action="new" ;;
            3) action="recover" ;;
            *) info "Cancelled."; return 1 ;;
        esac
    fi

    mkdir -p "$dir"

    # 3a) NEW / RECOVERED wallet — read passphrase, (archive old), install, init.
    if [[ "$action" == "new" || "$action" == "recover" ]]; then
        echo ""
        echo -e "  ${YELLOW:-}This passphrase is SAVED to disk (mode 600). The listener starts WITHOUT${RESET:-}"
        echo -e "  ${YELLOW:-}the passphrase on its command line; the wallet is then opened via${RESET:-}"
        echo -e "  ${YELLOW:-}open_wallet (ECDH) reading this saved copy, so it auto-starts after a${RESET:-}"
        echo -e "  ${YELLOW:-}reboot/crash (boot autostart + */5 watchdog re-unlock).${RESET:-}"
        echo ""
        local pass; pass=$(_pw_read_new_pass) || { info "Cancelled."; return 1; }
        local init_flag="-h"; [[ "$action" == "recover" ]] && init_flag="-hr"

        # Archive the existing wallet only now — passphrase captured, so a cancel
        # above left the old wallet untouched. Confirm, then move it aside.
        if [[ -f "$toml" ]]; then
            echo ""
            warn "The existing wallet at $dir will be ARCHIVED (renamed), not deleted."
            echo -ne "  Proceed? [y/N]: "
            local cfm; read -r cfm || true
            [[ "${cfm,,}" == "y" ]] || { info "Cancelled."; unset pass; return 1; }
            _pw_archive_wallet_dir "$dir" || { unset pass; return 1; }
            mkdir -p "$dir"
        fi

        # Binary into the (now fresh) dir.
        gwi_install_grin_wallet "$dir" 0 || { error "grin-wallet install failed."; unset pass; return 1; }

        info "Running grin-wallet init ($init_flag) — follow any seed prompts..."
        # Security trade-off: -p exposes the passphrase in argv during init (one-shot only).
        ( cd "$dir" && "$bin" $PW_NET_FLAG --top_level_dir "$dir" -p "$pass" init $init_flag )
        local rc=$?
        if [[ $rc -ne 0 ]]; then error "grin-wallet init failed (rc=$rc)."; unset pass; return 1; fi

        # Confirm the seed decrypts with this passphrase before saving it — a
        # password the listener can't use is worse than no password.
        if ! _pw_verify_pass "$dir" "$bin" "$pass"; then
            error "The new wallet did not open with that passphrase — aborting setup."
            unset pass; return 1
        fi

        install -m 600 /dev/null "$pass_file" 2>/dev/null || true
        printf '%s' "$pass" > "$pass_file"; chmod 600 "$pass_file"; unset pass
        if declare -F pool_write_conf_key >/dev/null 2>&1; then
            pool_write_conf_key "wallet_pass_file" "$pass_file"
        fi
        success "Passphrase saved: $pass_file (mode 600) — enables unattended unlock."

    # 3b) EXISTING wallet — prompt for the passphrase and verify it opens the
    #     wallet before saving. We refuse to continue on a wrong passphrase, so
    #     the listener (and every later step) only ever sees a working one.
    else
        # Binary (shared download/verify lib) — no-op if already present.
        gwi_install_grin_wallet "$dir" 0 || { error "grin-wallet install failed."; return 1; }

        echo ""
        info "Using the existing wallet at $dir."
        echo -e "  Enter its passphrase so the listener can open it unattended:"
        local exist_pass
        while true; do
            read -rs -p "  Passphrase (0 to cancel): " exist_pass; echo ""
            [[ "$exist_pass" == "0" ]] && { info "Cancelled."; unset exist_pass; return 1; }
            if _pw_verify_pass "$dir" "$bin" "$exist_pass"; then break; fi
            error "That passphrase did not open the wallet — try again (0 to cancel)."
        done
        install -m 600 /dev/null "$pass_file" 2>/dev/null || true
        printf '%s' "$exist_pass" > "$pass_file"; chmod 600 "$pass_file"; unset exist_pass
        if declare -F pool_write_conf_key >/dev/null 2>&1; then
            pool_write_conf_key "wallet_pass_file" "$pass_file"
        fi
        success "Passphrase verified & saved: $pass_file (mode 600)."
    fi

    # 4) Patch grin-wallet.toml — pin the API ports + enable include_foreign +
    #    node foreign secret + log cap.
    if [[ -f "$toml" ]]; then
        _pw_set_toml_key "$toml" "api_listen_port"       "$PW_FOREIGN_PORT" && info "grin-wallet.toml api_listen_port → $PW_FOREIGN_PORT"
        _pw_set_toml_key "$toml" "owner_api_listen_port" "$PW_OWNER_PORT"   && info "grin-wallet.toml owner_api_listen_port → $PW_OWNER_PORT"
        # Combined listener: serve the Foreign API (build_coinbase) on the Owner
        # port so ONE `owner_api` process (started without -p) handles coinbase +
        # payouts. The node's wallet_listener_url points at :$PW_OWNER_PORT/v2/foreign.
        _pw_ensure_toml_key "$toml" "owner_api_include_foreign" "true" "wallet" \
            && info "grin-wallet.toml owner_api_include_foreign → true"
        _pw_set_toml_key "$toml" "log_max_files"         "5"

        local node_dir secret
        node_dir=$(gnc_resolve_node_dir "$_PW_NODE_NET" 2>/dev/null || true)
        if [[ -n "$node_dir" && -f "$node_dir/.foreign_api_secret" ]]; then
            secret="$node_dir/.foreign_api_secret"
            _pw_set_toml_key "$toml" "node_api_secret_path" "\"$secret\"" \
                && success "Patched node_api_secret_path → $secret" \
                || echo "node_api_secret_path = \"$secret\"" >> "$toml"
            # Enable box-wide secret self-heal so node_api_secret_path is
            # auto-refreshed after a future node rebuild (idempotent; needs root).
            declare -F grin_install_secret_sync >/dev/null 2>&1 && { grin_install_secret_sync || true; }
        else
            warn "Node ${_PW_NODE_NET} dir/.foreign_api_secret not found — set node_api_secret_path in"
            warn "  $toml manually if the node uses a foreign secret."
        fi
    fi

    # 5) Point the node's stratum coinbase at this wallet.
    echo ""
    pw_patch_node_toml || true

    # 6) Start the listener + unlock. The wallet MUST be up AND open before setup
    #    is considered done — a wrong passphrase, port collision, or missing node
    #    surfaces here, and the operator should NOT continue (start the service,
    #    accept miners) until it shows [RUNNING], or coinbase + payouts silently fail.
    echo ""
    pw_write_launchers
    if ! pw_listener_start; then
        error "Pool wallet listener is NOT up/unlocked — setup is incomplete."
        error "  Do NOT start the pool service yet. Fix the cause (passphrase, port"
        error "  collision, node missing) and re-run 5) Set up wallet until it shows [RUNNING]."
        return 1
    fi

    # 7) Record the pool's Grin address in the pool config — the backend uses it
    #    to login to the node's built-in stratum (node-stratum-client.js). It can
    #    only be read once the wallet exists, which is why it lives here and not
    #    in 2) Configure.
    if declare -F pool_write_conf_key >/dev/null 2>&1; then
        echo ""
        local pool_addr
        # t?grin1 — keep the leading 't' on testnet addresses (tgrin1…); a bare grin1
        # pattern would let grep -o strip the 't' and save a mainnet-format address.
        pool_addr=$( (pw_show_address 2>/dev/null || true) | grep -oiE 't?grin1[a-z0-9]{40,}' | head -1 || true)
        if [[ -n "$pool_addr" ]]; then
            pool_write_conf_key "pool_address" "$pool_addr"
            success "Pool Grin address saved to config: $pool_addr"
        else
            warn "Could not auto-detect the wallet address."
            echo -ne "  Pool Grin address (blank to skip): "
            local manual_addr; read -r manual_addr || true
            if [[ -n "$manual_addr" ]]; then
                pool_write_conf_key "pool_address" "$manual_addr"
                success "Pool Grin address saved to config."
            else
                warn "pool_address not set — the backend can't login to the node stratum"
                warn "  until it is set (re-run Setup wallet, or edit the pool config)."
            fi
        fi
        if declare -F pool_service_control >/dev/null 2>&1 \
           && systemctl is-active --quiet "${POOL_SERVICE:-}" 2>/dev/null; then
            info "Restarting ${POOL_SERVICE} to apply wallet config..."
            systemctl restart "$POOL_SERVICE" || true
        fi
    fi

    echo ""
    echo -e "  ${GREEN:-}${BOLD:-}✓  Passphrase is NO LONGER in the process list${RESET:-}"
    echo -e "  ${YELLOW:-}The listener runs 'grin-wallet owner_api' with NO -p; the wallet is opened${RESET:-}"
    echo -e "  ${YELLOW:-}via open_wallet (ECDH) over loopback. The passphrase still lives on disk${RESET:-}"
    echo -e "  ${YELLOW:-}($pass_file, mode 600) and is read by the unlock helper; it appears in argv${RESET:-}"
    echo -e "  ${YELLOW:-}only briefly during init/recover/address one-shots.${RESET:-}"
    echo -e "  ${YELLOW:-}→ Keep the hot balance low; sweep coinbase to a wallet on a box you control.${RESET:-}"
    echo ""
    info "Coinbase path : node stratum → wallet_listener_url http://127.0.0.1:${PW_OWNER_PORT}/v2/foreign"
    info "Payout path   : backend → Owner API http://127.0.0.1:${PW_OWNER_PORT}/v3/owner"
    info "Enable Auto-restart so the listener survives reboot/crash (it re-unlocks automatically)."
}

# Replace an existing key (commented or not) in a grin-wallet.toml; rc 1 if absent.
_pw_set_toml_key() {
    local file="$1" key="$2" val="$3"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=" "$file"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
        return 0
    fi
    return 1
}

# Ensure a key=val exists: replace if present (commented or not), else insert it
# under [<section>] (default [wallet]), else append a fresh line. Always rc 0.
_pw_ensure_toml_key() {
    local file="$1" key="$2" val="$3" section="${4:-wallet}"
    if grep -Eq "^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=" "$file"; then
        sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
    elif grep -qE "^\[${section}\]" "$file"; then
        sed -i -E "/^\[${section}\]/a ${key} = ${val}" "$file"
    else
        printf '\n%s = %s\n' "$key" "$val" >> "$file"
    fi
}

# =============================================================================
# REBOOT AUTOSTART (root crontab, tag-guarded) — starts the listener + unlocks
# =============================================================================
pw_autostart_status() {
    local cron; cron=$(crontab -l 2>/dev/null || true)
    if echo "$cron" | grep -qF "$PW_AUTOSTART_TAG"; then
        echo -e "${GREEN:-}[OK]${RESET:-} Pool wallet listener autostart ENABLED"
    else
        echo -e "${DIM:-}[--] Pool wallet listener autostart not set${RESET:-}"
    fi
}

pw_autostart_enable() {
    local delay="${1:-45}" cron boot
    [[ "$delay" =~ ^[0-9]+$ ]] || delay=45
    boot=$(pw_boot_script)
    [[ -x "$boot" ]] || pw_write_launchers
    [[ -f "$(pw_pass_file)" ]] || { error "No saved password — run Setup wallet first."; return 1; }

    # Boot delay larger than the node's (the listener + unlock need the node up first).
    # The boot script starts the tmux listener, waits for the port, then open_wallets.
    local line="@reboot sleep $delay && env SHELL=/bin/bash $boot >> $PW_WATCHDOG_LOG 2>&1 $PW_AUTOSTART_TAG"
    cron=$(crontab -l 2>/dev/null || true)
    echo "$cron" | grep -qF "$PW_AUTOSTART_TAG" && cron=$(echo "$cron" | grep -vF "$PW_AUTOSTART_TAG" || true)
    { echo "$cron"; echo "$line"; } | grep -v '^[[:space:]]*$' | crontab -
    success "Pool wallet listener autostart enabled (delay ${delay}s; starts + re-unlocks)."
}

pw_autostart_disable() {
    local cron; cron=$(crontab -l 2>/dev/null || true)
    [[ -z "$cron" ]] && { info "Crontab empty."; return 0; }
    cron=$(echo "$cron" | grep -vF "$PW_AUTOSTART_TAG" || true)
    echo "$cron" | grep -v '^[[:space:]]*$' | crontab - 2>/dev/null || crontab -r 2>/dev/null || true
    success "Pool wallet listener autostart disabled."
}

# =============================================================================
# LISTENER WATCHDOG (*/5) — relaunch if the port drops, re-unlock if it locks
# =============================================================================
_pw_write_watchdog_bin() {
    mkdir -p "$(dirname "$PW_WATCHDOG_BIN")"
    local lf boot uj osec fsec pass_file node_bin
    lf=$(pw_launcher); boot=$(pw_boot_script); uj=$(pw_unlock_helper)
    osec=$(pw_owner_secret_path); fsec=$(pw_foreign_secret_path); pass_file=$(pw_pass_file)
    node_bin="$(command -v node 2>/dev/null || echo node)"
    cat > "$PW_WATCHDOG_BIN" <<EOF
#!/bin/bash
# grin-pubpool-wallet-watchdog — GENERATED by 07_lib_pool_wallet.sh. Do not edit.
STATE_DIR="$PW_WATCHDOG_STATE"
LOG_FILE="$PW_WATCHDOG_LOG"
OWNER_PORT="$PW_OWNER_PORT"
TMUX_NAME="$PW_TMUX_WALLET"
LAUNCHER="$lf"
BOOT="$boot"
UNLOCK_JS="$uj"
OWNER_SECRET="$osec"
FOREIGN_SECRET="$fsec"
PASS_FILE="$pass_file"
NODE_BIN="$node_bin"
EOF
    cat >> "$PW_WATCHDOG_BIN" <<'EOF'
set -uo pipefail
mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true
wlog() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE" 2>/dev/null || true; }
port_listening() {
    if command -v ss &>/dev/null; then ss -tlnp 2>/dev/null | grep -q ":$OWNER_PORT " && return 0; fi
    command -v lsof &>/dev/null && lsof -tni :"$OWNER_PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# Only manage a wallet that has been set up (launcher + boot + saved pass present).
[[ -x "$LAUNCHER" && -x "$BOOT" && -f "$PASS_FILE" ]] || exit 0
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node 2>/dev/null || echo node)"

if ! port_listening; then
    # Listener down → relaunch (start + unlock) via the boot script. Cooldown:
    # at most one relaunch per 10 min to avoid a flap loop.
    state="$STATE_DIR/wallet.state"; now=$(date -u +%s)
    last=$(cat "$state" 2>/dev/null || echo 0); [[ "$last" =~ ^[0-9]+$ ]] || last=0
    if (( now - last < 600 )); then wlog "listener down on $OWNER_PORT but in cooldown — skipping."; exit 0; fi
    wlog "wallet listener DOWN on $OWNER_PORT — running boot (start + unlock)."
    "$BOOT" >> "$LOG_FILE" 2>&1 && wlog "boot issued." || wlog "boot FAILED."
    echo "$now" > "$state"
    exit 0
fi

# Up — make sure the wallet is actually OPEN (coinbase needs the seed in RAM).
# Pass the foreign secret via curl config on STDIN (-K -), never argv, so it does
# not leak in `ps` every 5 min.
cfg=""; [[ -f "$FOREIGN_SECRET" ]] && cfg="user = \"grin:$(cat "$FOREIGN_SECRET")\""
probe=$(printf '%s' "$cfg" | curl -s --max-time 10 -K - -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"build_coinbase","params":[{"fees":0,"height":0,"key_id":null}],"id":1}' \
    "http://127.0.0.1:$OWNER_PORT/v2/foreign" 2>/dev/null)
[[ -z "$probe" ]] && exit 0                         # API not answering yet — leave it
grep -q '"output"' <<< "$probe" && exit 0           # open — nothing to do
# Re-unlock ONLY on a clear "wallet locked" signal; ignore auth/other errors so we
# don't open_wallet-spam every 5 min on an unrelated failure.
grep -qiE 'not open|no wallet|lifecycle|open the wallet|NotOpen|doesn.t exist' <<< "$probe" || exit 0
wlog "listener up on $OWNER_PORT but wallet LOCKED — re-running open_wallet."
"$NODE_BIN" "$UNLOCK_JS" "$OWNER_PORT" "$OWNER_SECRET" "$PASS_FILE" >> "$LOG_FILE" 2>&1 \
    && wlog "re-unlock OK." || wlog "re-unlock FAILED."
exit 0
EOF
    chmod 750 "$PW_WATCHDOG_BIN"
    info "Wrote pool wallet watchdog: $PW_WATCHDOG_BIN"
}

pw_watchdog_install() {
    mkdir -p "$PW_WATCHDOG_STATE" "$(dirname "$PW_WATCHDOG_LOG")" 2>/dev/null || true
    _pw_write_watchdog_bin
    cat > "$PW_WATCHDOG_CRON" <<EOF
# grin-node-toolkit: pool wallet listener watchdog (every 5 min).
SHELL=/bin/bash
*/5 * * * * root $PW_WATCHDOG_BIN >/dev/null 2>&1
EOF
    chmod 644 "$PW_WATCHDOG_CRON"
    success "Pool wallet watchdog installed (*/5) — relaunches + re-unlocks the combined listener (Owner+Foreign $PW_OWNER_PORT) if it drops or locks."
}

pw_watchdog_remove() {
    rm -f "$PW_WATCHDOG_CRON" "$PW_WATCHDOG_BIN"
    success "Pool wallet watchdog removed."
}

pw_watchdog_status() {
    if [[ -f "$PW_WATCHDOG_CRON" && -x "$PW_WATCHDOG_BIN" ]]; then
        success "Pool wallet watchdog: INSTALLED ($PW_WATCHDOG_CRON)"
    else
        warn "Pool wallet watchdog: NOT installed."
    fi
    [[ -f "$PW_WATCHDOG_LOG" ]] && { info "Recent log:"; tail -n 6 "$PW_WATCHDOG_LOG" 2>/dev/null || true; }
}
