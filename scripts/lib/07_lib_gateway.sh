# =============================================================================
# 07_lib_gateway.sh — GATEWAY deployment (sourced by 07_grin_mining_public_pool.sh)
# =============================================================================
# Multi-region mining pool — Model C GATEWAY role (replaces the old SATELLITE).
# Deploys a THIN stratum forwarder ONLY: no grin node, no wallet, no keys, no DB,
# no Node app, no npm. Miners connect to the public stratum port here; HAProxy
# forwards the raw stratum TCP — prefixed with a PROXY-protocol v2 header carrying
# the real miner IP — over a WireGuard tunnel to this region's internal port on the
# central pool box. The central stratum-server stamps the region from that port.
# See docs/generated/script07_implementation.md §8 (Multi-region — as built).
#
# Sourced, not executed — inherits colors/log helpers from the parent script
# (info/warn/success/error/log, $TOOLKIT_ROOT, _pool_pause, pool_mode_conflict_check).
# =============================================================================

GW_CONF="/opt/grin/conf/grin_gateway.json"
GW_DIR="/opt/grin/gateway"
GW_HAPROXY_CFG="$GW_DIR/haproxy.cfg"
GW_SERVICE="grin-gateway"               # dedicated HAProxy instance (does not touch system haproxy)
GW_LOG="/opt/grin/logs/grin-gateway.log"
GW_WG_IFACE="wg-grinpool"
GW_WG_CONF="/etc/wireguard/${GW_WG_IFACE}.conf"
# Hub-endpoint re-resolve (see gw_install_reresolve). Overridable only so a local
# harness can write the generated files into a scratch dir.
GW_RERESOLVE="grin-gateway-reresolve"
GW_RERESOLVE_BIN="${GW_RERESOLVE_BIN:-/usr/local/bin/${GW_RERESOLVE}}"
GW_SYSTEMD_DIR="${GW_SYSTEMD_DIR:-/etc/systemd/system}"
# HTTPS latency probe (menu 6, see gw_probe_enable). Its own haproxy instance + unit,
# never a frontend inside $GW_HAPROXY_CFG. GW_LE_DIR is overridable for the same harness reason.
GW_PROBE_SERVICE="grin-gateway-probe"
GW_PROBE_CFG="$GW_DIR/probe.cfg"
GW_PROBE_PEM="$GW_DIR/probe.pem"
GW_LE_DIR="${GW_LE_DIR:-/etc/letsencrypt}"
GW_PROBE_HOOK="$GW_LE_DIR/renewal-hooks/deploy/grin-gateway-probe.sh"

# ─── Config helpers (mirror the parent, targeting GW_CONF) ──────────────────────
# python3, NOT node: the gateway box deliberately has no Node.js (pure forwarder),
# so these must never shell out to `node` — that's what broke Configure with
# "node: command not found". python3 ships on every supported distro and is
# installed explicitly in gw_install as a safety net.
gw_read_conf() {
    local key="$1" default="${2:-}"
    [[ -f "$GW_CONF" ]] || { echo "$default"; return; }
    python3 - "$GW_CONF" "$key" "$default" 2>/dev/null << 'PY' || echo "$default"
import json, sys
path, key, default = sys.argv[1:4]
try:
    with open(path) as f:
        v = json.load(f).get(key)
    sys.stdout.write(default if v is None else str(v))
except Exception:
    sys.stdout.write(default)
PY
}

gw_write_conf_key() {
    local key="$1" val="$2"
    mkdir -p "$(dirname "$GW_CONF")"
    python3 - "$GW_CONF" "$key" "$val" << 'PY'
import json, os, sys
path, key, val = sys.argv[1:4]
NUMS = {'public_stratum_port'}
d = {}
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    pass
if key in NUMS:
    try:
        val = int(val)
    except ValueError:
        pass
d[key] = val
with open(path, 'w') as f:
    json.dump(d, f, indent=2)
os.chmod(path, 0o600)
PY
}

gw_ensure_defaults() {
    local -A defaults=(
        ["role"]="gateway"
        ["region"]=""
        ["public_stratum_port"]="3333"
        ["hub_endpoint"]=""        # central wg IP:port for THIS region, e.g. 10.66.66.1:3391
        ["wg_address"]=""          # this gateway's tunnel IP, e.g. 10.66.66.2/32
        ["wg_hub_pubkey"]=""       # central box's WireGuard public key
        ["wg_hub_endpoint"]=""     # central box's PUBLIC wg endpoint, e.g. 203.0.113.10:51820
        ["wg_hub_ip"]=""           # central box's tunnel IP (AllowedIPs), e.g. 10.66.66.1
    )
    local k
    for k in "${!defaults[@]}"; do
        local existing; existing=$(gw_read_conf "$k" "__MISSING__")
        [[ "$existing" == "__MISSING__" ]] && gw_write_conf_key "$k" "${defaults[$k]}"
    done
}

# ─── 1) Install ─────────────────────────────────────────────────────────────────
gw_install() {
    echo -e "\n${BOLD}Installing Regional Gateway (thin stratum forwarder + WireGuard)...${RESET}\n"

    # Defense-in-depth: refuse if a pool/Central Hub brain already occupies this box
    # (the selector guard may have been bypassed via a direct/non-interactive arg).
    pool_mode_conflict_check "gateway" || return 0

    info "Installing packages (haproxy + wireguard-tools)..."
    # NO node, NO npm, NO grin node, NO build tools — the edge is a pure forwarder.
    if command -v apt-get &>/dev/null; then
        # Refresh the package index first: a stale index 404s on fetch when the
        # mirror has since moved to a newer build (nothing else on this thin edge
        # runs apt-get update for us — the pool roles get it via NodeSource).
        apt-get update 2>&1 | tail -3 || warn "apt-get update failed — install may fetch stale package URLs."
        apt-get install -y haproxy wireguard-tools python3 2>&1 | tail -8
    elif command -v dnf &>/dev/null; then
        dnf install -y haproxy wireguard-tools python3 2>&1 | tail -8
    else
        error "No apt-get or dnf — install haproxy + wireguard-tools manually."
        return 1
    fi
    command -v haproxy &>/dev/null || { error "haproxy not installed."; return 1; }
    command -v wg      &>/dev/null || { error "wireguard-tools (wg) not installed."; return 1; }
    command -v python3 &>/dev/null || { error "python3 not installed (needed for gateway config read/write)."; return 1; }

    mkdir -p "$GW_DIR" "$(dirname "$GW_LOG")"
    chmod 700 "$GW_DIR"
    gw_ensure_defaults

    # Generate this gateway's WireGuard keypair once (idempotent).
    # -s, not -f (audit §J16-7): `> file` creates the file BEFORE wg genkey runs, so a
    # failed genkey leaves a zero-byte private key that -f reports as present forever —
    # the keypair is never regenerated, every pairing string is derived from an empty
    # public key, and the operator was told "Generated WireGuard keypair." The hub side
    # already learned this (07_lib_gwctl.sh init-server uses -s and repairs a missing
    # public half); the edge had the original bug. Guard both commands: this lib runs
    # with errexit suppressed (memory `project_lib_errexit_suppression`).
    if [[ ! -s "$GW_DIR/wg_private.key" ]]; then
        ( umask 077; wg genkey > "$GW_DIR/wg_private.key" ) \
            || { error "wg genkey failed — no WireGuard keypair."; return 1; }
        [[ -s "$GW_DIR/wg_private.key" ]] \
            || { error "wg genkey produced an empty key file ($GW_DIR/wg_private.key)."; return 1; }
        wg pubkey < "$GW_DIR/wg_private.key" > "$GW_DIR/wg_public.key" \
            || { error "wg pubkey failed — private key unreadable?"; return 1; }
        success "Generated WireGuard keypair."
    elif [[ ! -s "$GW_DIR/wg_public.key" ]]; then
        # Same repair the hub does: an interrupted first run (or a restore that brought
        # back only the private half) otherwise leaves the public key blank forever.
        wg pubkey < "$GW_DIR/wg_private.key" > "$GW_DIR/wg_public.key" \
            || { error "could not re-derive the gateway public key."; return 1; }
        success "Re-derived the gateway WireGuard public key."
    fi

    # Dedicated HAProxy instance bound to our config — never touches the distro's
    # default /etc/haproxy/haproxy.cfg or its service.
    local haproxy_bin; haproxy_bin=$(command -v haproxy 2>/dev/null || echo /usr/sbin/haproxy)
    cat > "/etc/systemd/system/$GW_SERVICE.service" << EOF
[Unit]
Description=Grin Pool Regional Gateway (HAProxy stratum forwarder)
After=network-online.target ${GW_WG_IFACE}.service wg-quick@${GW_WG_IFACE}.service
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=$haproxy_bin -c -f $GW_HAPROXY_CFG
ExecStart=$haproxy_bin -f $GW_HAPROXY_CFG -db
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
# Sandbox (audit §J16-3). haproxy itself drops to the unprivileged runtime account via
# the 'user'/'group' lines gw_render_forwarder writes into the global section; these are
# the second layer, covering the brief root window before that drop. NoNewPrivileges is
# safe here — unlike the hub unit, this service never shells out to sudo.
# ProtectSystem=full (not strict) and no PrivateDevices on purpose: the forwarder logs to
# /dev/log and this unit has never run on a box, so the hardening stops short of the two
# settings that could silently take logging or the config read away. §J17 should tighten
# to strict once a real gateway has been observed running.
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$GW_SERVICE" 2>/dev/null || true
    success "Systemd service $GW_SERVICE installed."

    # Open the public stratum port. Without this a box with an active firewall
    # completes the whole pairing — green tunnel, green status here — and still
    # refuses every miner, which reads as a pairing fault rather than a firewall
    # one. The hub opens its own wg port in init-server; this is the edge's half.
    gw_open_firewall

    echo ""
    echo -e "  ${BOLD}This gateway's WireGuard public key${RESET} (give it to the pool operator):"
    echo -e "    ${GREEN}$(cat "$GW_DIR/wg_public.key" 2>/dev/null)${RESET}"
    echo ""
    # Do NOT advertise 2) Configure as the next keypress: the pairing string it wants
    # does not exist yet, so an operator who goes straight there meets a form they
    # cannot fill and starts inventing values. The next action is on the OTHER box.
    echo -e "  ${BOLD}${YELLOW}STOP HERE — the next step is not on this box.${RESET}"
    echo -e "  Copy the key above to the pool operator. On the POOL box they either:"
    echo -e "    · admin panel → ${BOLD}Regions & Gateways${RESET} → New region, paste the key, Save"
    echo -e "    · or SSH → Script 07 → ${BOLD}W) Multi-region${RESET} → 2) Add a gateway peer"
    echo -e "  Both hand back one ${BOLD}GRINGW1|…${RESET} line."
    echo ""
    echo -e "  ${DIM}Come back here with that line and run 2) Configure → 3) Bring up tunnel${RESET}"
    echo -e "  ${DIM}→ 4) Service control. Nothing here works until you have it.${RESET}"
}

# ─── Firewall — the public stratum port ─────────────────────────────────────────
# Idempotent; safe to call from both Install and Configure (the port can change).
# No-op when no managed firewall is active, which is the common fresh-VPS case.
# ⚠ Test ufw with the ANCHORED '^Status: active'. A disabled ufw answers `ufw status`
# with "Status: inactive", and a bare `grep -q active` matches that word too. This ran
# with the bare form until 2026-09-20 (first live gateway): on a box whose ufw was never
# enabled it printed "ufw: opened 3333/tcp", Status then said "ufw is ACTIVE but :3333 is
# not allowed" no matter what was run (an inactive ufw lists no rules for the regex to
# find), and the operator re-ran Install and Configure chasing a ufw rule while the real
# block sat outside the box. Every other script in the repo already anchored this test.
gw_open_firewall() {
    local port; port=$(gw_read_conf public_stratum_port "3333")
    _gw_fw_open_tcp "$port" "miner stratum" "miners will be refused until you add it"
}

# One TCP port through whichever managed firewall is active. Shared by the stratum port
# (above) and the latency probe's 80/443 (gw_probe_enable), so both use the anchored test.
#   $1 = port, $2 = what it is for (shown in the success line), $3 = what breaks without it.
_gw_fw_open_tcp() {
    local port="$1" what="$2" breaks="$3"
    [[ "$port" =~ ^[0-9]+$ ]] || return 0
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
        if ufw allow "${port}/tcp" >/dev/null 2>&1; then
            info "ufw: opened ${port}/tcp (${what})."
        else
            warn "ufw is active but opening ${port}/tcp failed — ${breaks}."
        fi
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "firewalld: opened ${port}/tcp (${what})."
    else
        if command -v ufw &>/dev/null; then
            # Installed but disabled. A rule on an inactive ufw changes nothing today, but
            # record it so a later `ufw enable` does not cut every miner off in one keypress.
            ufw allow "${port}/tcp" >/dev/null 2>&1 || true
            info "ufw is installed but INACTIVE — it is not what blocks :${port}. (Allow rule recorded for if you enable it later.)"
        else
            info "No active ufw/firewalld detected — nothing to open for :${port}."
        fi
        _gw_unmanaged_filter_hint "$port" "    "
    fi
}

# Neither managed firewall is active, yet :port can still be refused by two things that
# no `ufw status` will ever show: raw iptables/nftables rules baked into the provider's
# image (Oracle Cloud's Ubuntu images ship a REJECT-all INPUT rule in /etc/iptables/rules.v4
# — the classic "ufw says inactive, port still dead"), and the provider's network firewall
# outside the VM (Hetzner/Vultr/DO cloud firewall, AWS security group, GCP rule, OCI
# security list), which is invisible from inside the box entirely. Say both, in that
# order, because the first is checkable from here and the second is not.
#   $1 = port, $2 = indent prefix (the Status screen nests deeper than Configure).
_gw_unmanaged_filter_hint() {
    local port="$1" ind="${2:-}"
    if iptables -S INPUT 2>/dev/null | grep -qE -- '^-P INPUT (DROP|REJECT)|-j (DROP|REJECT)'; then
        echo -e "${ind}${YELLOW}Raw iptables rules filter INPUT on this box (not ufw/firewalld) — :${port} may be rejected there.${RESET}"
        echo -e "${ind}${DIM}Inspect: iptables -S INPUT      Open: iptables -I INPUT -p tcp --dport ${port} -j ACCEPT${RESET}"
        echo -e "${ind}${DIM}then persist it (netfilter-persistent save, or edit /etc/iptables/rules.v4) or it is gone at reboot.${RESET}"
    fi
    echo -e "${ind}${DIM}If the pool's Port check still reads unreachable: allow TCP ${port} in your provider's${RESET}"
    echo -e "${ind}${DIM}network firewall (cloud console) — nothing on this box can see that one.${RESET}"
}

# ─── 2) Configure ───────────────────────────────────────────────────────────────
# Parse the one-line pairing string the central pool box prints on "Add a gateway
# peer" (and re-prints on "List gateways"):
#   GRINGW1|region|hub_wg_pubkey|hub_public_endpoint|hub_tunnel_ip|gw_tunnel_ip/32|region_port[|public_stratum_port]
# Returns 1 (writing nothing) unless the tag matches and the first 6 fields are present.
# The 8th field (hubs emit it since 2026-09-20) is the POOL's public miner port. The pool
# advertises this region as <host>:<that port> and dials it for the Port check, so the
# gateway must listen there and nothing on this box can know the number — yet Configure
# used to ASK for it, echoing whatever was typed last time as the "default". First live
# pairing: haproxy on :13333, card on :3333, "✗ unreachable" beside a green tunnel. When
# the field is present it overwrites public_stratum_port; absent (older hub) → the saved
# value stands and the prompt below says where to copy it from.
gw_apply_pairing_string() {
    local tag region pub ep hubip gwip port pubport _rest
    # Strip CRs: the string is pasted, and the LAST field now carries a port that a
    # Windows clipboard would otherwise turn into "3333\r" and fail the shape check.
    IFS='|' read -r tag region pub ep hubip gwip port pubport _rest <<< "${1//$'\r'/}"
    [[ "$tag" == "GRINGW1" ]] || return 1
    if [[ -z "$region" || -z "$pub" || -z "$ep" || -z "$hubip" || -z "$gwip" || ! "$port" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    # Per-field shape checks (audit §J16-6). This string arrives out-of-band — pasted by
    # whoever told the gateway operator they were the pool — and every field lands verbatim
    # in the WireGuard config. Only `port` was ever checked. The field that matters is
    # `hubip`: it becomes `AllowedIPs = ${hubip}/32`, and wg accepts a comma-separated list,
    # so `0.0.0.0/0, 10.66.66.1` renders as a valid catch-all route and wg-quick then puts
    # the ENTIRE gateway box's egress inside a tunnel whose peer key (`pub`) and endpoint
    # (`ep`) came from the same line. The hub's own helper validates every one of its inputs
    # before touching anything (07_lib_gwctl.sh §13.2); the edge validated one.
    # Shapes mirror what grin-gateway-ctl actually emits.
    [[ "$region" =~ ^[a-z0-9-]{2,12}$ ]]        || { warn "pairing: region '$region' is not a region key."; return 1; }
    [[ "$pub"    =~ ^[A-Za-z0-9+/]{43}=$ ]]     || { warn "pairing: hub key is not a WireGuard public key."; return 1; }
    [[ "$ep"     =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || { warn "pairing: hub endpoint '$ep' is not host:port."; return 1; }
    [[ "$hubip"  =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
        || { warn "pairing: hub tunnel IP '$hubip' is not a single IPv4 address."; return 1; }
    [[ "$gwip"   =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/32)?$ ]] \
        || { warn "pairing: gateway tunnel IP '$gwip' is not a single IPv4 address."; return 1; }
    (( port >= 1 && port <= 65535 )) || { warn "pairing: region port '$port' is out of range."; return 1; }
    if [[ -n "$pubport" ]]; then
        if [[ ! "$pubport" =~ ^[0-9]+$ ]] || (( pubport < 1 || pubport > 65535 )); then
            warn "pairing: public stratum port '$pubport' is not a port."; return 1
        fi
    fi
    [[ "$gwip" == */* ]] || gwip="${gwip}/32"
    gw_write_conf_key "region"          "$region"
    gw_write_conf_key "wg_hub_pubkey"   "$pub"
    gw_write_conf_key "wg_hub_endpoint" "$ep"
    gw_write_conf_key "wg_hub_ip"       "$hubip"
    gw_write_conf_key "wg_address"      "$gwip"
    gw_write_conf_key "hub_endpoint"    "${hubip}:${port}"
    success "Pairing applied: region '${region}', tunnel ${gwip} → hub ${hubip}:${port}."
    if [[ -n "$pubport" ]]; then
        local was; was=$(gw_read_conf public_stratum_port "3333")
        gw_write_conf_key "public_stratum_port" "$pubport"
        if [[ "$was" != "$pubport" ]]; then
            info "Public stratum port set to :${pubport} from the pairing string (was :${was}) — the pool advertises this region on :${pubport}."
        fi
    fi
}

gw_configure() {
    echo -e "\n${BOLD}Configure Regional Gateway${RESET}\n"
    gw_ensure_defaults
    local val paired=0

    echo -e "  ${DIM}All tunnel values are assigned by the CENTRAL POOL BOX. To get them:${RESET}"
    echo -e "  ${DIM}  1. On this box: 1) Install printed this gateway's wg public key.${RESET}"
    echo -e "  ${DIM}  2. On the POOL box: menu W) Multi-region → 2) Add a gateway peer,${RESET}"
    echo -e "  ${DIM}     paste that public key there.${RESET}"
    echo -e "  ${DIM}  3. That step prints ONE line starting with GRINGW1| — it carries every${RESET}"
    echo -e "  ${DIM}     value this form needs. Paste it below to fill all fields at once.${RESET}"
    echo -e "  ${DIM}The GRINGW1 line does NOT exist until step 2 has been done on the pool${RESET}"
    echo -e "  ${DIM}box; after that it can be re-printed there via 3) List gateways.${RESET}"
    echo -ne "Paste GRINGW1|... pairing string (Enter = type each value manually): "
    read -r val
    if [[ -n "$val" ]]; then
        if gw_apply_pairing_string "$val"; then
            paired=1
        else
            warn "Not a valid GRINGW1|... pairing string — continuing with manual entry."
        fi
    fi

    if (( ! paired )); then
        echo ""
        echo -e "  ${DIM}(Region key — short airport-style code, must match the key the operator${RESET}"
        echo -e "  ${DIM} created in admin → Regions AND the key used when adding this peer on the pool box)${RESET}"
        echo -ne "Region key (e.g. nyc, sgn, ams) [$(gw_read_conf region "")]: "
        read -r val; [[ -n "$val" ]] && gw_write_conf_key "region" "$val"
    fi

    echo ""
    echo -e "  ${DIM}This must be the POOL's public miner port (3333 mainnet / 13333 testnet), not a${RESET}"
    echo -e "  ${DIM}port of your choosing: the pool advertises this region as <host>:<that port> and${RESET}"
    echo -e "  ${DIM}dials it for its Port check. A pairing string from a current pool fills it in;${RESET}"
    echo -e "  ${DIM}otherwise copy it from the pool box (admin → Regions shows 'Port :NNNN').${RESET}"
    echo -ne "Public stratum port (miners connect here) [$(gw_read_conf public_stratum_port "3333")]: "
    read -r val; [[ -n "$val" ]] && gw_write_conf_key "public_stratum_port" "$val"

    if (( ! paired )); then
        echo ""
        echo -e "  ${DIM}── WireGuard tunnel to the central pool box ──${RESET}"
        echo -e "  ${DIM}The operator gives you these after adding your public key as a peer${RESET}"
        echo -e "  ${DIM}(on the central box they also live in /etc/wireguard/wg-grinpool*.conf:${RESET}"
        echo -e "  ${DIM} Interface Address = central tunnel IP, your [Peer] AllowedIPs = your /32).${RESET}"

        echo -ne "Central wg public key        [$( [[ -n "$(gw_read_conf wg_hub_pubkey '')" ]] && echo '*** keep ***' || echo none)]: "
        read -r val; [[ -n "$val" ]] && gw_write_conf_key "wg_hub_pubkey" "$val"

        echo -ne "Central PUBLIC wg endpoint (ip:51820) [$(gw_read_conf wg_hub_endpoint "")]: "
        read -r val; [[ -n "$val" ]] && gw_write_conf_key "wg_hub_endpoint" "$val"

        echo -e "  ${DIM}(central is always .1 on the tunnel: 10.66.66.1 mainnet / 10.66.67.1 testnet)${RESET}"
        echo -ne "Central tunnel IP (e.g. 10.66.66.1) [$(gw_read_conf wg_hub_ip "")]: "
        read -r val; [[ -n "$val" ]] && gw_write_conf_key "wg_hub_ip" "$val"

        echo -e "  ${DIM}(NOT guessed — the pool box assigned this /32 when your peer was added;${RESET}"
        echo -e "  ${DIM} it prints it as 'this gateway tunnel IP' and inside the GRINGW1 line.${RESET}"
        echo -e "  ${DIM} First gateway is .2, second .3, ... Re-print: pool box W → 3) List gateways)${RESET}"
        echo -ne "This gateway's tunnel IP (e.g. 10.66.66.2/32) [$(gw_read_conf wg_address "")]: "
        read -r val; [[ -n "$val" ]] && gw_write_conf_key "wg_address" "$val"

        echo ""
        echo -e "  ${DIM}Central region port = this region's private stratum listener on the pool${RESET}"
        echo -e "  ${DIM}box, assigned when your peer was added (first is 3391 mainnet / 13391${RESET}"
        echo -e "  ${DIM}testnet; printed as 'central region port' and in the GRINGW1 line;${RESET}"
        echo -e "  ${DIM}re-print via pool box W → 3) List gateways). It is NOT the public miner${RESET}"
        echo -e "  ${DIM}port (3333) and NOT the grin node stratum (3416/13416). It combines with${RESET}"
        echo -e "  ${DIM}the central tunnel IP into hub_endpoint, e.g. 10.66.66.1:3391.${RESET}"
        local hub_ip; hub_ip=$(gw_read_conf wg_hub_ip "")
        echo -ne "Central region port (e.g. 3391) [$(gw_read_conf hub_endpoint "" | sed 's/.*://')]: "
        read -r val
        # hub_endpoint is composed from TWO answers. Silently dropping the port when
        # the hub IP is still blank leaves Configure looking successful while the
        # forwarder has nowhere to send miners — say what happened instead.
        if [[ -n "$val" && -n "$hub_ip" ]]; then
            gw_write_conf_key "hub_endpoint" "${hub_ip}:${val}"
        elif [[ -n "$val" && -z "$hub_ip" ]]; then
            warn "Region port ${val} NOT saved — it needs the central tunnel IP, which is still blank."
            echo -e "  ${DIM}Answer 'Central tunnel IP' above first, then re-run 2) Configure and${RESET}"
            echo -e "  ${DIM}enter the port again. Easier: paste the GRINGW1 line and skip both.${RESET}"
        fi
    fi

    gw_render_forwarder
    gw_render_wireguard
    # The stratum port may have just changed — re-assert the firewall rule for the
    # current value (idempotent; the old rule is harmless but is not cleaned up).
    gw_open_firewall

    if systemctl is-active --quiet "$GW_SERVICE" 2>/dev/null; then
        info "Reloading $GW_SERVICE to apply config..."
        systemctl restart "$GW_SERVICE"
    fi
    success "Gateway configured ($GW_CONF)."
    echo -e "  ${DIM}Run 3) Bring up tunnel, then 4) Service control → Start.${RESET}"
    echo ""
    echo -e "  ${BOLD}Don't forget DNS.${RESET} Miners dial a hostname, not this box's IP:"
    echo -e "    point the region's A record (e.g. $(gw_read_conf region 'nyc').example.com) at"
    echo -e "    ${BOLD}this gateway's public IP${RESET} — not the pool box's."
    echo -e "  ${DIM}The pool operator then sets that hostname on the region card. Until the${RESET}"
    echo -e "  ${DIM}record resolves their Port check reads ✗ unreachable even with a healthy tunnel.${RESET}"
}

# ─── Render the HAProxy forwarder config ────────────────────────────────────────
# The haproxy runtime account, as "user group". It exists on every distro that ships the
# package (Debian/Ubuntu and RHEL both create `haproxy`), but fall back to `nobody` rather
# than emit a `user` line naming an account that does not exist — haproxy refuses to start
# on an unknown user and ExecStartPre would fail the whole service. Shared by the forwarder
# and the latency probe (gw_render_probe), so both drop to the same account.
_gw_haproxy_account() {
    local u="haproxy" g="haproxy"
    id -u haproxy >/dev/null 2>&1 || { u="nobody"; g="nogroup"; }
    getent group "$g" >/dev/null 2>&1 || g="$(id -gn "$u" 2>/dev/null || echo nogroup)"
    echo "$u $g"
}

gw_render_forwarder() {
    local port hub_ep region
    port=$(gw_read_conf public_stratum_port "3333")
    hub_ep=$(gw_read_conf hub_endpoint "")
    region=$(gw_read_conf region "unset")
    if [[ -z "$hub_ep" ]]; then
        warn "hub_endpoint not set — run 2) Configure fully before starting."
        return 1
    fi
    mkdir -p "$GW_DIR"
    # mode tcp: HAProxy forwards the raw stratum byte stream. send-proxy-v2 prepends the
    # binary PROXY-protocol v2 header so the central box recovers the real miner IP.
    # stick-table conn-rate limit (Q5): blunt junk-login floods at the edge before the tunnel.
    local hap_user hap_group
    read -r hap_user hap_group <<< "$(_gw_haproxy_account)"

    cat > "$GW_HAPROXY_CFG" << EOF || { error "could not write $GW_HAPROXY_CFG"; return 1; }
# Grin pool regional gateway — region: ${region}
# Auto-generated by 07_lib_gateway.sh — edit via the gateway menu, not by hand.
global
    log /dev/log local0
    maxconn 8192
    # Drop privileges after the bind (audit §J16-3). This process terminates raw,
    # unauthenticated TCP from the public internet on :${port} and it holds the box that
    # holds the WireGuard private key for the tunnel into the pool — the same argument
    # pool_deroot() makes for the hub backend (design §13.9), which the edge had never
    # applied: with no 'user'/'group' here and no 'User=' in the unit, haproxy stayed
    # root for its entire life. The stratum port is >1024, so nothing needs root after
    # startup. Chroot deliberately omitted: it would break 'log /dev/log'.
    # (No backticks in this heredoc: it is unquoted for the variables, so a backtick is a
    # command substitution — this comment once ran 'user' and 'group' as shell commands.)
    user ${hap_user}
    group ${hap_group}

defaults
    mode tcp
    option  tcplog
    log     global
    timeout connect 10s
    timeout client  10m
    timeout server  10m

frontend grin_stratum_in
    bind :${port}
    # Per-source connection rate-limit (anti-flood). Tune if legit miners reconnect a lot.
    stick-table type ip size 100k expire 60s store conn_rate(10s),conn_cur
    tcp-request connection track-sc0 src
    tcp-request connection reject if { sc0_conn_rate gt 100 }
    default_backend grin_central

backend grin_central
    # send-proxy-v2 → real miner IP travels in the PROXY header to the central listener.
    server central ${hub_ep} send-proxy-v2
EOF
    info "Wrote $GW_HAPROXY_CFG (forward :${port} → ${hub_ep})."
}

# ─── Render the WireGuard edge config ───────────────────────────────────────────
gw_render_wireguard() {
    local addr hub_pub hub_ep hub_ip priv
    addr=$(gw_read_conf wg_address "")
    hub_pub=$(gw_read_conf wg_hub_pubkey "")
    hub_ep=$(gw_read_conf wg_hub_endpoint "")
    hub_ip=$(gw_read_conf wg_hub_ip "")
    if [[ -z "$addr" || -z "$hub_pub" || -z "$hub_ep" || -z "$hub_ip" ]]; then
        warn "WireGuard config incomplete — fill wg_address / wg_hub_pubkey / wg_hub_endpoint / wg_hub_ip in 2) Configure."
        return 1
    fi
    if [[ ! -f "$GW_DIR/wg_private.key" ]]; then
        error "Missing $GW_DIR/wg_private.key — run 1) Install first."
        return 1
    fi
    priv=$(cat "$GW_DIR/wg_private.key")
    # A blank private key renders a config wg-quick accepts the shape of but can never
    # handshake with, and the failure surfaces later as "no handshake" on the far box.
    [[ -n "$priv" ]] || { error "$GW_DIR/wg_private.key is empty — re-run 1) Install."; return 1; }
    mkdir -p "$(dirname "$GW_WG_CONF")" || { error "could not create $(dirname "$GW_WG_CONF")"; return 1; }
    ( umask 077; cat > "$GW_WG_CONF" << EOF
# Grin pool gateway tunnel — auto-generated by 07_lib_gateway.sh
[Interface]
PrivateKey = ${priv}
Address = ${addr}

[Peer]
PublicKey = ${hub_pub}
Endpoint = ${hub_ep}
AllowedIPs = ${hub_ip}/32
PersistentKeepalive = 25
EOF
    ) || { error "could not write $GW_WG_CONF"; return 1; }
    chmod 600 "$GW_WG_CONF" || { error "could not chmod 600 $GW_WG_CONF — refusing to leave a readable tunnel key."; return 1; }
    info "Wrote $GW_WG_CONF."
}

# ─── Hub-endpoint re-resolve timer (plan F1) ────────────────────────────────────
# WireGuard resolves a hostname Endpoint ONCE, at wg-quick up, and then keeps sending
# to that IP forever. So a hub move behind a DNS name (hub W → 5) still stranded every
# gateway on the old IP until someone ran 3) Bring up tunnel on each one. This installs
# the fix upstream ships as contrib/reresolve-dns: every 60 s, if the hub's handshake is
# stale, re-apply the configured host:port with `wg set`, which makes wg resolve it again.
#
# Source of truth is the rendered $GW_WG_CONF, not grin_gateway.json: it is what
# wg-quick actually loaded, it pairs each Endpoint with the peer key the interface
# knows, and it needs no python3 to read. (Configure re-renders both together, so they
# only differ between a Configure and the 3) that applies it — and then the conf is the
# newer, correct one anyway.)
#
# Unit sandbox — chosen against what `wg set` needs, because an over-tight unit here
# fails SILENTLY (the timer keeps firing and nothing ever moves):
#   · runs as root with CapabilityBoundingSet=CAP_NET_ADMIN only. wg talks to the kernel
#     over generic netlink, and WG_CMD_GET/SET_DEVICE need CAP_NET_ADMIN. The conf is
#     root:root 0600 and root is its OWNER, so reading it needs no CAP_DAC_OVERRIDE.
#   · RestrictAddressFamilies MUST keep AF_NETLINK (wg itself) and AF_INET/AF_INET6/AF_UNIX
#     (the DNS lookup wg does in userspace, via resolv.conf or systemd-resolved's socket).
#   · NO PrivateNetwork: a private netns has no wg-grinpool, and wg would answer "No such
#     device" — the exact silent no-op to avoid. NO PrivateDevices: logger writes /dev/log
#     (same reason the forwarder unit above skips it).
#   · ProtectSystem=strict is safe: the script writes nothing — it detects an IP change by
#     comparing wg's own endpoint before and after, so it keeps no state file.
gw_install_reresolve() {
    local bin="$GW_RERESOLVE_BIN" udir="$GW_SYSTEMD_DIR"
    local tmp="${bin}.tmp.$$"
    mkdir -p "$(dirname "$bin")" "$udir" || { error "could not create $(dirname "$bin") / $udir"; return 1; }

    # Header lines carry the baked values (printf %q); the body is a QUOTED heredoc so
    # nothing in it expands at install time.
    {
        printf '#!/bin/bash\n'
        printf '# %s — auto-generated by 07_lib_gateway.sh (gw_install_reresolve). Do not edit.\n' "$GW_RERESOLVE"
        printf '# Re-resolves the pool hub WireGuard Endpoint when its handshake goes stale,\n'
        printf '# so a hub IP change behind a DNS name needs no action on this gateway.\n'
        printf 'IFACE=%q\n' "$GW_WG_IFACE"
        printf 'CONF=%q\n' "$GW_WG_CONF"
        printf 'TAG=%q\n' "$GW_RERESOLVE"
        cat << 'RERESOLVE'
set -u
# 135 s = REKEY_AFTER_TIME (120) + REKEY_TIMEOUT (5) + margin: the upstream
# contrib/reresolve-dns threshold. A live tunnel with PersistentKeepalive re-handshakes
# every ~2 min, so a healthy peer never crosses it.
MAX_AGE=135

if [[ ! -r "$CONF" ]]; then
    echo "$TAG: $CONF is missing or unreadable - run the gateway menu 2) Configure, then 3) Bring up tunnel." >&2
    exit 1
fi
command -v wg >/dev/null 2>&1 || { echo "$TAG: wg (wireguard-tools) not found." >&2; exit 1; }
# Interface down = the tunnel is off on purpose (or wg-quick has not run yet). Nothing to
# steer; the gateway Status screen reports that case itself.
wg show "$IFACE" >/dev/null 2>&1 || exit 0

# Every [Peer] with an Endpoint, as "pubkey host:port".
peers=$(awk '
    /^[[:space:]]*\[/ {
        if (inpeer && pub != "" && ep != "") print pub, ep
        pub = ""; ep = ""
        inpeer = ($0 ~ /^[[:space:]]*\[Peer\]/)
        next
    }
    inpeer && /^[[:space:]]*PublicKey[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); pub = $0 }
    inpeer && /^[[:space:]]*Endpoint[[:space:]]*=/  { sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); ep = $0 }
    END { if (inpeer && pub != "" && ep != "") print pub, ep }
' "$CONF")

rc=0
now=$(date +%s)
while read -r pub ep; do
    [[ -n "$pub" && -n "$ep" ]] || continue
    host=${ep%:*}
    # An IP literal has nothing to re-resolve: IPv4 dotted quad, or bracketed IPv6.
    if [[ "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$host" == \[*\] ]]; then
        continue
    fi
    # Only steer a peer the running interface already has. "wg set ... peer <key>" on an
    # unknown key would ADD a peer with no allowed-ips - it happens when Configure wrote a
    # new hub key and 3) has not applied it yet.
    hs=$(wg show "$IFACE" latest-handshakes 2>/dev/null | awk -v k="$pub" '$1 == k { print $2; exit }')
    if [[ -z "$hs" ]]; then
        echo "$TAG: hub key in $CONF is not on $IFACE - run 3) Bring up tunnel to apply the config." >&2
        rc=1
        continue
    fi
    [[ "$hs" =~ ^[0-9]+$ ]] || hs=0
    if (( hs > 0 && now - hs <= MAX_AGE )); then
        continue
    fi
    before=$(wg show "$IFACE" endpoints 2>/dev/null | awk -v k="$pub" '$1 == k { print $2; exit }')
    if wg set "$IFACE" peer "$pub" endpoint "$ep"; then
        after=$(wg show "$IFACE" endpoints 2>/dev/null | awk -v k="$pub" '$1 == k { print $2; exit }')
        if [[ -n "$after" && "$after" != "$before" ]]; then
            msg="hub endpoint $ep re-resolved: ${before:-(none)} -> $after"
            if command -v logger >/dev/null 2>&1; then logger -t "$TAG" "$msg"; else echo "$TAG: $msg"; fi
        fi
    else
        echo "$TAG: could not resolve $ep (DNS failure?) - will retry on the next run." >&2
        rc=1
    fi
done <<< "$peers"
exit "$rc"
RERESOLVE
    } > "$tmp" || { error "could not write $tmp"; rm -f "$tmp"; return 1; }
    chmod 755 "$tmp"   || { error "could not chmod $tmp"; rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$bin" || { error "could not install $bin"; rm -f "$tmp"; return 1; }

    cat > "$udir/${GW_RERESOLVE}.service" << EOF || { error "could not write $udir/${GW_RERESOLVE}.service"; return 1; }
[Unit]
Description=Grin pool gateway - re-resolve the hub WireGuard endpoint
After=wg-quick@${GW_WG_IFACE}.service

[Service]
Type=oneshot
ExecStart=${bin}
# Sandbox: see gw_install_reresolve in 07_lib_gateway.sh for why each line is safe
# and why PrivateNetwork / PrivateDevices are deliberately absent.
CapabilityBoundingSet=CAP_NET_ADMIN
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
EOF
    # AccuracySec: systemd's default is 1 min, which would let a 60 s timer drift to 2.
    cat > "$udir/${GW_RERESOLVE}.timer" << EOF || { error "could not write $udir/${GW_RERESOLVE}.timer"; return 1; }
[Unit]
Description=Grin pool gateway - re-resolve the hub WireGuard endpoint every 60s

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload || { error "systemctl daemon-reload failed — re-resolve timer not active."; return 1; }
    systemctl enable --now "${GW_RERESOLVE}.timer" >/dev/null 2>&1 \
        || { error "could not enable ${GW_RERESOLVE}.timer — a hub IP change will need 3) here."; return 1; }
    success "Hub re-resolve timer active (${GW_RERESOLVE}.timer, every 60s)."
}

# Removes the timer, its service and the script. Idempotent; safe when never installed.
gw_remove_reresolve() {
    systemctl disable --now "${GW_RERESOLVE}.timer" >/dev/null 2>&1 || true
    rm -f "$GW_SYSTEMD_DIR/${GW_RERESOLVE}.timer" "$GW_SYSTEMD_DIR/${GW_RERESOLVE}.service" "$GW_RERESOLVE_BIN" \
        || { error "could not remove the ${GW_RERESOLVE} files"; return 1; }
    systemctl daemon-reload 2>/dev/null || true
}

# ─── 6) Latency probe — HTTPS /ping for the pool's connect page ─────────────────
# The connect page measures viewer→server latency from the visitor's browser. A browser
# cannot open raw TCP to stratum :3333, and the pool page is HTTPS, so a plain-http probe
# is mixed content and blocked. So each gateway answers https://<its stratum host>/ping
# with an empty 204, and the page times that.
#
# A SEPARATE haproxy instance (grin-gateway-probe, $GW_PROBE_CFG), never a frontend inside
# the forwarder's $GW_HAPROXY_CFG, because the probe must never be able to break stratum:
#   · the forwarder unit runs 'haproxy -c' over its WHOLE config as ExecStartPre, so a
#     probe frontend with a missing or corrupt pem would stop the forwarder from starting;
#   · the forwarder runs haproxy single-process in the foreground with no reload path, so
#     every certificate renewal (~60 days) would be a RESTART that drops every miner;
#   · turning the probe off is then "stop one unit", with nothing re-rendered on the forwarder.
# The cost is one more small haproxy process.
#
# Surface: :443 answers exactly one thing. GET/HEAD/OPTIONS /ping → 204 with no body, any
# other path → 404, and more than 30 requests in 10 s from one IP → 429. There is no backend,
# so nothing is proxied anywhere. There is no per-request log either (no proxy carries a 'log'
# line): the visitor IPs of a latency probe are exactly what the pool's IP-privacy rules say
# not to collect. :80 is used only by certbot --standalone, for a few seconds at issue and at
# each renewal. Nothing listens there otherwise, so the open rule answers with a RST.
#
# Certificate: certbot certonly --standalone, because haproxy never binds :80. The deploy
# hook concatenates fullchain+privkey into $GW_PROBE_PEM and restarts ONLY the probe unit.
# The pem is 0600 root, not group-readable by haproxy: haproxy loads 'crt' files while it is
# still root, before its user/group drop, so the runtime account never needs to read it.

# rc 0 when the installed haproxy can serve the probe: 2.2+ (for 'http-request return'),
# built with TLS. Prints what it found either way.
_gw_probe_haproxy_ok() {
    local v maj min
    command -v haproxy &>/dev/null || { error "haproxy is not installed — run 1) Install first."; return 1; }
    v=$(haproxy -v 2>/dev/null | head -1)
    if [[ "$v" =~ [Vv]ersion[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
        maj=${BASH_REMATCH[1]}; min=${BASH_REMATCH[2]}
    else
        error "Could not read the haproxy version (${v:-no output})."
        return 1
    fi
    if (( maj < 2 || (maj == 2 && min < 2) )); then
        error "haproxy ${maj}.${min} is too old: the probe needs 2.2 or newer ('http-request return')."
        echo -e "  ${DIM}Debian 11+, Ubuntu 22.04+ and RHEL/Rocky/Alma 9 ship 2.2 or newer.${RESET}"
        return 1
    fi
    if ! haproxy -vv 2>/dev/null | grep -qiE 'built with .*ssl'; then
        error "haproxy ${maj}.${min} was built without TLS support, so it cannot serve HTTPS."
        return 1
    fi
    info "haproxy ${maj}.${min}: OK for the probe."
}

# The listener line when something is bound to TCP <port>, else nothing.
_gw_port_listener() {
    ss -Htlnp 2>/dev/null | awk -v p=":$1" 'substr($4, length($4) - length(p) + 1) == p { print; exit }'
}

# A warning when <host> also has an AAAA record. This gateway listens on IPv4 only (stratum
# too), and Let's Encrypt prefers IPv6 for validation when an AAAA exists.
_gw_probe_aaaa_note() {
    local v6
    v6=$(getent ahostsv6 "$1" 2>/dev/null | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ { print $1 }' | sort -u | head -3)
    [[ -n "$v6" ]] || return 0
    warn "$1 also has an AAAA record (${v6//$'\n'/ }). This gateway listens on IPv4 only."
    echo -e "  ${DIM}Let's Encrypt validates over IPv6 first when an AAAA exists. Remove it unless it is this box.${RESET}"
}

# rc 0 when <host> has an A record pointing at this box. 1 = refuse (reason printed).
_gw_probe_dns_ok() {
    local host="$1" a_ips local_ips pub ip
    a_ips=$(getent ahostsv4 "$host" 2>/dev/null | awk '{ print $1 }' | sort -u)
    if [[ -z "$a_ips" ]]; then
        error "$host does not resolve here (no A record). Point it at this gateway's public IP first."
        return 1
    fi
    local_ips=$(ip -o -4 addr show 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1)
    for ip in $a_ips; do
        if grep -qxF "$ip" <<< "$local_ips"; then _gw_probe_aaaa_note "$host"; return 0; fi
    done
    # Behind 1:1 NAT (Oracle, AWS, GCP) the public address is on no interface — ask.
    pub=$(curl -4 -s --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [[ "$pub" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
        if grep -qxF "$pub" <<< "$a_ips"; then _gw_probe_aaaa_note "$host"; return 0; fi
        error "$host resolves to ${a_ips//$'\n'/ }, but this gateway's public IP is $pub."
        echo -e "  ${DIM}The record must point HERE and be DNS-only (no CDN proxy): stratum cannot pass a${RESET}"
        echo -e "  ${DIM}proxy, and a probe answered by a CDN edge would time the CDN, not this gateway.${RESET}"
        return 1
    fi
    warn "Could not learn this box's public IP to compare with $host → ${a_ips//$'\n'/ }."
    warn "  Continuing; certbot will fail below if the record points elsewhere."
    _gw_probe_aaaa_note "$host"
}

_gw_probe_ensure_certbot() {
    command -v certbot &>/dev/null && return 0
    info "Installing certbot..."
    if command -v apt-get &>/dev/null; then
        apt-get install -y certbot 2>&1 | tail -3
    elif command -v dnf &>/dev/null; then
        # RHEL/Rocky/Alma ship certbot in EPEL, not in the base repos.
        dnf install -y certbot 2>&1 | tail -3
        if ! command -v certbot &>/dev/null; then
            dnf install -y epel-release 2>&1 | tail -2
            dnf install -y certbot 2>&1 | tail -3
        fi
    fi
    command -v certbot &>/dev/null || { error "certbot is not installed and could not be installed."; return 1; }
}

# The certbot renewal timer that is active on this box, or nothing. Debian/Ubuntu enable
# certbot.timer from the package; RHEL-family ships certbot-renew.timer DISABLED; snap
# installs have their own.
_gw_probe_renew_timer() {
    local t
    for t in certbot.timer certbot-renew.timer snap.certbot.renew.timer; do
        if systemctl is-active --quiet "$t" 2>/dev/null; then echo "$t"; return 0; fi
    done
    return 1
}

_gw_probe_enable_renew_timer() {
    local t
    _gw_probe_renew_timer >/dev/null && return 0
    for t in certbot.timer certbot-renew.timer snap.certbot.renew.timer; do
        if systemctl cat "$t" >/dev/null 2>&1 && systemctl enable --now "$t" >/dev/null 2>&1; then
            info "Enabled $t (automatic certificate renewal)."
            return 0
        fi
    done
    warn "No certbot renewal timer found. The certificate expires in 90 days unless 'certbot renew' runs;"
    warn "  add a daily cron line: certbot renew -q"
    return 1
}

# certbot deploy hook. certbot runs EVERY file in renewal-hooks/deploy for EVERY renewed
# certificate, so the hook acts only on its own lineage. Header lines carry the baked values
# (printf %q); the body is a QUOTED heredoc, so nothing in it expands at install time.
_gw_probe_write_hook() {
    local host="$1" hook="$GW_PROBE_HOOK"
    local tmp="${hook}.tmp.$$"
    mkdir -p "$(dirname "$hook")" || { error "could not create $(dirname "$hook")"; return 1; }
    {
        printf '#!/bin/bash\n'
        printf '# grin-gateway-probe certbot deploy hook — auto-generated by 07_lib_gateway.sh\n'
        printf '# (gateway menu 6). Do not edit. Refreshes the latency probe pem after a renewal.\n'
        printf 'LINEAGE=%q\n' "$GW_LE_DIR/live/$host"
        printf 'PEM=%q\n' "$GW_PROBE_PEM"
        printf 'UNIT=%q\n' "$GW_PROBE_SERVICE"
        cat << 'HOOK'
set -u
[[ "${RENEWED_LINEAGE:-}" == "$LINEAGE" ]] || exit 0
if [[ ! -s "$LINEAGE/fullchain.pem" || ! -s "$LINEAGE/privkey.pem" ]]; then
    echo "grin-gateway-probe hook: $LINEAGE lacks fullchain.pem or privkey.pem" >&2
    exit 1
fi
# Build beside the target and rename over it, so haproxy never loads half a file.
tmp="$PEM.tmp.$$"
if ! ( umask 077; cat "$LINEAGE/fullchain.pem" "$LINEAGE/privkey.pem" > "$tmp" ); then
    rm -f "$tmp"
    echo "grin-gateway-probe hook: could not write $tmp" >&2
    exit 1
fi
if ! { chmod 600 "$tmp" && mv -f "$tmp" "$PEM"; }; then
    rm -f "$tmp"
    echo "grin-gateway-probe hook: could not install $PEM" >&2
    exit 1
fi
# try-restart acts only on a RUNNING unit, so a disabled probe stays off. The stratum
# forwarder (grin-gateway) is a different unit and is never touched here.
systemctl try-restart "$UNIT" >/dev/null 2>&1 || true
exit 0
HOOK
    } > "$tmp" || { error "could not write $tmp"; rm -f "$tmp"; return 1; }
    chmod 755 "$tmp"     || { error "could not chmod $tmp"; rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$hook" || { error "could not install $hook"; rm -f "$tmp"; return 1; }
}

# Writes $GW_PROBE_CFG. rc 0 written · 2 not rendered (the probe is off, or there is no pem
# yet, and the unit must then stay stopped) · 1 error. Never reads or writes $GW_HAPROXY_CFG.
gw_render_probe() {
    local host enabled hap_user hap_group
    host=$(gw_read_conf probe_host "")
    enabled=$(gw_read_conf probe_enabled "0")
    [[ "$enabled" == "1" && -n "$host" ]] || return 2
    if [[ ! -s "$GW_PROBE_PEM" ]]; then
        warn "Probe is enabled for $host but $GW_PROBE_PEM is missing: run 6) → 2) Renew now."
        return 2
    fi
    read -r hap_user hap_group <<< "$(_gw_haproxy_account)"
    mkdir -p "$GW_DIR" || { error "could not create $GW_DIR"; return 1; }
    # UNQUOTED heredoc (it needs the variables): no backticks anywhere in it, comments included.
    cat > "$GW_PROBE_CFG" << EOF || { error "could not write $GW_PROBE_CFG"; return 1; }
# Grin pool regional gateway — HTTPS latency probe for ${host}
# Auto-generated by 07_lib_gateway.sh (gw_render_probe). Edit via gateway menu 6), not by hand.
# A separate haproxy instance from the stratum forwarder, so this file can never stop it.
global
    log /dev/log local0
    maxconn 2000
    user ${hap_user}
    group ${hap_group}
    ssl-default-bind-options ssl-min-ver TLSv1.2
    tune.ssl.default-dh-param 2048

# No 'log' line in defaults or the frontend: this probe keeps no per-visitor access log.
defaults
    mode http
    option dontlognull
    timeout connect         5s
    timeout client          10s
    timeout server          5s
    timeout http-request    5s
    timeout http-keep-alive 10s

frontend grin_probe
    # http/1.1 only: the page takes its samples one after another on ONE kept-alive
    # connection, so the TLS handshake is paid once, by the warm-up request.
    bind :443 ssl crt ${GW_PROBE_PEM} alpn http/1.1
    maxconn 2000
    stick-table type ip size 50k expire 60s store http_req_rate(10s)
    http-request track-sc0 src
    http-request deny deny_status 429 if { sc0_http_req_rate gt 30 }
    # Timing-Allow-Origin lets the page read the request/response timestamps, so the
    # measurement excludes its own scheduling. Cross-origin, credential-free GET: the ACAO
    # wildcard is all CORS needs, and the body is empty.
    http-request return status 204 hdr Access-Control-Allow-Origin "*" hdr Timing-Allow-Origin "*" hdr Cache-Control "no-store" if { path /ping } { method GET HEAD OPTIONS }
    http-request return status 404
EOF
    chmod 600 "$GW_PROBE_CFG" || { error "could not chmod $GW_PROBE_CFG"; return 1; }
}

_gw_probe_write_unit() {
    local haproxy_bin; haproxy_bin=$(command -v haproxy 2>/dev/null || echo /usr/sbin/haproxy)
    cat > "$GW_SYSTEMD_DIR/$GW_PROBE_SERVICE.service" << EOF || { error "could not write $GW_PROBE_SERVICE.service"; return 1; }
[Unit]
Description=Grin Pool Regional Gateway - HTTPS latency probe (/ping on :443)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=$haproxy_bin -c -q -f $GW_PROBE_CFG
ExecStart=$haproxy_bin -f $GW_PROBE_CFG -db
Restart=on-failure
RestartSec=5
LimitNOFILE=8192
# Tighter than the forwarder unit, deliberately: a sandbox mistake here takes down only the
# probe, and 6) Enable proves it with a real HTTPS request instead of trusting the start.
# Root only long enough to bind :443 and load the crt; then haproxy drops to its account.
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
}

# rc 0 when https://<host>/ping, dialled on this box, answers 204 with a certificate the
# system trusts. That is the whole contract, so check the whole contract, not "unit active".
_gw_probe_selftest() {
    local host="$1" code i
    for i in 1 2 3 4 5 6; do
        [[ -n "$(_gw_port_listener 443)" ]] && break
        sleep 1
    done
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        --resolve "${host}:443:127.0.0.1" "https://${host}/ping" 2>/dev/null || true)
    if [[ "$code" == "204" ]]; then
        success "https://${host}/ping answers 204 with a trusted certificate."
        return 0
    fi
    error "https://${host}/ping did not answer 204 on this box (got '${code:-no answer}')."
    echo -e "  ${DIM}journalctl -u $GW_PROBE_SERVICE -n 30    ·    ss -tlnp | grep ':443 '${RESET}"
    return 1
}

gw_probe_enable() {
    echo -e "\n${BOLD}Latency probe: enable (HTTPS /ping on :443)${RESET}\n"
    echo -e "  ${DIM}The pool's connect page times https://<this region's stratum host>/ping from each${RESET}"
    echo -e "  ${DIM}visitor's browser. This adds a TLS-only :443 that answers /ping with an empty 204 and${RESET}"
    echo -e "  ${DIM}nothing else. The stratum forwarder is a separate process and is not restarted.${RESET}"
    echo ""
    [[ -f "$GW_SYSTEMD_DIR/$GW_SERVICE.service" ]] || { error "The gateway is not installed. Run 1) Install first."; return 1; }
    _gw_probe_haproxy_ok || return 1

    local old_host host val
    old_host=$(gw_read_conf probe_host "")
    echo -e "  ${DIM}Use the SAME hostname miners use for this region (the pool's region card shows it,${RESET}"
    echo -e "  ${DIM}e.g. hkg.example.com). The page probes https://<stratum host>/ping and no other name.${RESET}"
    echo -ne "This gateway's public hostname [${old_host:-none}]: "
    read -r val || val=""
    host="${val:-$old_host}"; host="${host,,}"; host="${host%.}"
    if [[ -z "$host" ]]; then
        warn "No hostname given. Nothing changed."
        return 1
    fi
    if [[ ! "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]; then
        error "'$host' is not a hostname."
        return 1
    fi
    _gw_probe_dns_ok "$host" || return 1

    # :80 must be free now and at every renewal (certbot --standalone binds it). :443 must be
    # free, or already this probe's (a re-run to change the hostname).
    local l80 l443
    l80=$(_gw_port_listener 80)
    if [[ -n "$l80" ]]; then
        error ":80 is in use on this box. certbot --standalone needs it now and at every renewal."
        echo -e "  ${DIM}${l80}${RESET}"
        return 1
    fi
    l443=$(_gw_port_listener 443)
    if [[ -n "$l443" ]] && ! systemctl is-active --quiet "$GW_PROBE_SERVICE" 2>/dev/null; then
        error ":443 is in use by something else. Browsers probe https://${host}/ping on 443, so the probe needs it."
        echo -e "  ${DIM}${l443}${RESET}"
        return 1
    fi

    _gw_fw_open_tcp 80  "certbot, issue and renewals" "Let's Encrypt cannot validate and renewals will fail"
    _gw_fw_open_tcp 443 "latency probe"               "visitors' browsers cannot reach /ping"
    _gw_probe_ensure_certbot || return 1

    # Hook first: from here on, any renewal of this lineage refreshes the pem.
    _gw_probe_write_hook "$host" || return 1

    local email rc
    local -a email_args
    echo -ne "Let's Encrypt email for expiry notices (Enter = none): "
    read -r email || email=""
    if [[ -n "$email" ]]; then email_args=(-m "$email"); else email_args=(--register-unsafely-without-email); fi

    info "Requesting a certificate for $host (certbot --standalone, on :80 for a few seconds)..."
    certbot certonly --standalone --preferred-challenges http -d "$host" --cert-name "$host" \
        --non-interactive --agree-tos "${email_args[@]}" 2>&1 | tail -6
    rc=${PIPESTATUS[0]}
    if (( rc != 0 )) || [[ ! -s "$GW_LE_DIR/live/$host/fullchain.pem" ]]; then
        error "certbot could not issue a certificate for $host. The probe stays off."
        echo -e "  ${DIM}Check: the A record points here · TCP 80 is open in the provider's network firewall${RESET}"
        echo -e "  ${DIM}(nothing on this box can see that one) · no AAAA record pointing elsewhere.${RESET}"
        return 1
    fi

    # Whether certbot runs renewal-hooks/deploy on a FIRST issue depends on its version, and a
    # kept (not-yet-due) certificate runs no hook at all. The hook is idempotent, so run it.
    RENEWED_LINEAGE="$GW_LE_DIR/live/$host" "$GW_PROBE_HOOK" \
        || { error "The deploy hook could not build $GW_PROBE_PEM."; return 1; }
    [[ -s "$GW_PROBE_PEM" ]] || { error "$GW_PROBE_PEM is missing after the deploy hook."; return 1; }

    gw_write_conf_key probe_host "$host"  || { error "could not save probe_host"; return 1; }
    gw_write_conf_key probe_enabled "1"   || { error "could not save probe_enabled"; return 1; }
    gw_render_probe
    rc=$?
    (( rc == 0 )) || { error "Probe config not rendered (rc $rc)."; return 1; }
    _gw_probe_write_unit || return 1
    systemctl daemon-reload || { error "systemctl daemon-reload failed."; return 1; }

    local out
    if ! out=$(haproxy -c -f "$GW_PROBE_CFG" 2>&1); then
        error "haproxy rejected $GW_PROBE_CFG:"
        echo "$out" | tail -8 | sed 's/^/    /'
        return 1
    fi
    systemctl enable "$GW_PROBE_SERVICE" >/dev/null 2>&1 \
        || warn "could not enable $GW_PROBE_SERVICE at boot."
    systemctl restart "$GW_PROBE_SERVICE" \
        || { error "$GW_PROBE_SERVICE did not start: journalctl -u $GW_PROBE_SERVICE -n 30"; return 1; }
    _gw_probe_selftest "$host" || return 1
    _gw_probe_enable_renew_timer || true

    # A changed hostname: stop renewing the old one, or certbot keeps binding :80 for it forever.
    if [[ -n "$old_host" && "$old_host" != "$host" ]]; then
        if certbot delete --cert-name "$old_host" --non-interactive >/dev/null 2>&1; then
            info "Removed the old certificate for $old_host."
        fi
    fi

    echo ""
    success "Latency probe live: https://${host}/ping"
    echo -e "  ${DIM}The pool's region card for this gateway must use ${host} as its stratum host;${RESET}"
    echo -e "  ${DIM}the connect page probes that name. Keep TCP 80 open: every renewal (~60 days) needs it.${RESET}"
}

# Renew now: a staging dry-run first (no Let's Encrypt rate limit spent), then a forced renewal.
gw_probe_renew() {
    echo -e "\n${BOLD}Latency probe: renew the certificate now${RESET}\n"
    local host rc a
    host=$(gw_read_conf probe_host "")
    if [[ -z "$host" || ! -d "$GW_LE_DIR/live/$host" ]]; then
        error "No probe certificate on this box. Run 1) Enable first."
        return 1
    fi
    if [[ -n "$(_gw_port_listener 80)" ]]; then
        error ":80 is in use, so certbot --standalone cannot renew: $(_gw_port_listener 80)"
        return 1
    fi
    info "Dry run against Let's Encrypt staging..."
    certbot renew --cert-name "$host" --dry-run 2>&1 | tail -4
    rc=${PIPESTATUS[0]}
    if (( rc != 0 )); then
        error "The dry run failed, so the real renewal would fail too. Nothing was renewed."
        echo -e "  ${DIM}Usually TCP 80 closed in the provider's firewall, or $host no longer points here.${RESET}"
        return 1
    fi
    echo -e "  ${DIM}Let's Encrypt issues at most 5 certificates for the same name per week.${RESET}"
    echo -ne "Dry run OK. Force a real renewal now? [y/N]: "
    read -r a || a=""
    if [[ "${a,,}" != "y" ]]; then
        info "Not renewed. The automatic renewal will use the same path the dry run just proved."
        return 0
    fi
    certbot renew --cert-name "$host" --force-renewal 2>&1 | tail -4
    rc=${PIPESTATUS[0]}
    (( rc == 0 )) || { error "certbot renew failed (rc $rc)."; return 1; }
    RENEWED_LINEAGE="$GW_LE_DIR/live/$host" "$GW_PROBE_HOOK" \
        || { error "The deploy hook could not rebuild $GW_PROBE_PEM."; return 1; }
    if systemctl is-active --quiet "$GW_PROBE_SERVICE" 2>/dev/null; then
        _gw_probe_selftest "$host" || return 1
    fi
    success "Certificate renewed."
}

# Non-interactive teardown: unit, config, pem, hook, and the certificate (so certbot stops
# binding :80 for it every renewal). Idempotent; safe when the probe was never enabled.
# Used by 6) → Disable and by the pool script's Cleanup. Firewall rules are left alone.
gw_probe_remove() {
    local host; host=$(gw_read_conf probe_host "")
    systemctl disable --now "$GW_PROBE_SERVICE" >/dev/null 2>&1 || true
    rm -f "$GW_SYSTEMD_DIR/$GW_PROBE_SERVICE.service" "$GW_PROBE_CFG" "$GW_PROBE_PEM" "$GW_PROBE_HOOK" \
        || { error "could not remove the probe files"; return 1; }
    systemctl daemon-reload 2>/dev/null || true
    if [[ -n "$host" ]] && command -v certbot &>/dev/null && [[ -d "$GW_LE_DIR/live/$host" ]]; then
        certbot delete --cert-name "$host" --non-interactive >/dev/null 2>&1 \
            || warn "could not delete the certificate for $host (certbot delete --cert-name $host)."
    fi
    if [[ -f "$GW_CONF" ]]; then
        gw_write_conf_key probe_enabled "0" || { error "could not save probe_enabled"; return 1; }
    fi
}

gw_probe_disable() {
    echo -e "\n${BOLD}Latency probe: disable${RESET}\n"
    local a
    echo -e "  ${DIM}Stops :443 here and deletes the probe certificate. Stratum is not affected. The pool's${RESET}"
    echo -e "  ${DIM}connect page falls back to its estimate for this region.${RESET}"
    echo -ne "Disable the latency probe? [y/N]: "
    read -r a || a=""
    if [[ "${a,,}" != "y" ]]; then
        info "Nothing changed."
        return 0
    fi
    gw_probe_remove || return 1
    success "Latency probe disabled."
    echo -e "  ${DIM}Firewall rules for 80/443 were left in place (nothing listens there now).${RESET}"
    echo -e "  ${DIM}Remove them yourself if nothing else on this box needs them.${RESET}"
}

# One status line (plus warnings). Used by 5) Status and the 6) screen.
_gw_probe_status_line() {
    local host en state lis exp_line="" end days
    host=$(gw_read_conf probe_host "")
    en=$(gw_read_conf probe_enabled "0")
    if [[ "$en" != "1" ]]; then
        echo -e "  ${BOLD}Probe${RESET}     : ${DIM}off (6) lets the pool's connect page measure latency to here)${RESET}"
        return 0
    fi
    if systemctl is-active --quiet "$GW_PROBE_SERVICE" 2>/dev/null; then
        state="${GREEN}● active${RESET}"
    else
        state="${YELLOW}enabled, not running${RESET}"
    fi
    lis=":443 not listening"
    [[ -n "$(_gw_port_listener 443)" ]] && lis=":443 listening"
    if [[ -s "$GW_PROBE_PEM" ]] && command -v openssl &>/dev/null; then
        end=$(openssl x509 -enddate -noout -in "$GW_PROBE_PEM" 2>/dev/null)
        end=${end#notAfter=}
        if [[ -n "$end" ]] && end=$(date -u -d "$end" +%s 2>/dev/null); then
            days=$(( (end - $(date -u +%s)) / 86400 ))
            exp_line="; cert until $(date -u -d "@$end" +%Y-%m-%d)"
        fi
    fi
    echo -e "  ${BOLD}Probe${RESET}     : ${state}  https://${host}/ping  ${DIM}(${lis}${exp_line})${RESET}"
    if [[ -n "${days:-}" ]] && (( days < 14 )); then
        echo -e "              ${YELLOW}certificate expires in ${days} days: renewal is failing.${RESET}"
        echo -e "              ${DIM}6) → 2) Renew now dry-runs first and says why (usually TCP 80 closed).${RESET}"
    fi
    if ! _gw_probe_renew_timer >/dev/null; then
        echo -e "              ${YELLOW}no active certbot renewal timer: re-run 6) → 1) Enable to set one up${RESET}"
    fi
}

gw_probe_menu() {
    echo -e "\n${BOLD}Latency probe (HTTPS /ping for the pool's connect page)${RESET}"
    _gw_probe_status_line
    echo ""
    echo -e "  ${GREEN}1${RESET}) Enable / change hostname"
    echo -e "  ${GREEN}2${RESET}) Renew certificate now   ${DIM}(dry-runs first)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Disable"
    echo -e "  ${DIM}0) Back${RESET}"
    echo -ne "Choice: "
    local c; read -r c || c=""
    case "$c" in
        1) gw_probe_enable  || true; _pool_pause ;;
        2) gw_probe_renew   || true; _pool_pause ;;
        3) gw_probe_disable || true; _pool_pause ;;
        *) ;;
    esac
}

# ─── 3) Bring up / refresh the WireGuard tunnel ─────────────────────────────────
gw_wireguard_up() {
    echo -e "\n${BOLD}Bring up WireGuard tunnel (${GW_WG_IFACE})${RESET}\n"
    [[ -f "$GW_WG_CONF" ]] || gw_render_wireguard || return 1
    # wg-quick down is a no-op-safe refresh; ignore failure when the iface isn't up yet.
    wg-quick down "$GW_WG_IFACE" 2>/dev/null || true
    if wg-quick up "$GW_WG_IFACE"; then
        systemctl enable "wg-quick@${GW_WG_IFACE}" 2>/dev/null || true
        success "Tunnel ${GW_WG_IFACE} is up."
        # Installed here, not in 1) Install, so gateways paired before it existed pick it
        # up the next time the operator runs 3). A failure is not fatal: the tunnel is up,
        # and only a future hub IP change would need a manual 3) again.
        gw_install_reresolve || warn "Re-resolve timer not installed — a hub IP change will need 3) here."
        echo ""
        wg show "$GW_WG_IFACE" 2>/dev/null | sed 's/^/  /'
    else
        error "wg-quick up failed — check $GW_WG_CONF and the central peer config."
        return 1
    fi
}

# ─── 4) Service control ─────────────────────────────────────────────────────────
gw_service_control() {
    echo -e "\n${BOLD}Service Control — $GW_SERVICE${RESET}"
    if systemctl is-active --quiet "$GW_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${GREEN}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc
        case "$sc" in
            1) systemctl stop "$GW_SERVICE" && success "Stopped." || error "Stop failed."; _pool_pause ;;
            2) systemctl restart "$GW_SERVICE" && success "Restarted." || error "Restart failed."; _pool_pause ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc
        # if-form: a trailing `[[ ]] &&` would make "0/back" return 1 → set -e kills the caller
        if [[ "$sc" == "1" ]]; then
            systemctl start "$GW_SERVICE" && success "Started." || error "Start failed."
            _pool_pause
        fi
    fi
}

# ─── 5) Status ──────────────────────────────────────────────────────────────────
gw_status() {
    echo -e "\n${BOLD}Regional Gateway Status${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"

    # "Installed" is the unit file, not is-enabled: a unit that exists but was disabled
    # used to read "not installed" here. Boot behaviour has its own line below.
    if systemctl is-active --quiet "$GW_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Forwarder${RESET} : ${GREEN}● active${RESET}"
    elif [[ -f "/etc/systemd/system/$GW_SERVICE.service" ]]; then
        echo -e "  ${BOLD}Forwarder${RESET} : ${YELLOW}installed, stopped${RESET}"
    else
        echo -e "  ${BOLD}Forwarder${RESET} : ${DIM}not installed${RESET}"
    fi

    local sp; sp=$(gw_read_conf public_stratum_port "3333")
    if ss -tlnp 2>/dev/null | grep -q ":$sp "; then
        echo -e "  ${BOLD}Stratum${RESET}   : ${GREEN}:$sp listening${RESET}"
        # Listening is not the same as reachable. A firewall DROP in front of this
        # port looks identical from here AND looks identical to a pairing fault on
        # the pool's Port-check column, so report the rule state right beside it.
        # Anchored '^Status: active' — see gw_open_firewall for the "inactive" trap;
        # this line cried wolf on the first live gateway because of it.
        if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
            # `ufw allow in on eth0 to any port N` lists as "N/tcp on eth0  ALLOW" — accept that too.
            if ufw status 2>/dev/null | grep -qE "^${sp}(/tcp)?([[:space:]]+on[[:space:]]+[^[:space:]]+)?[[:space:]]+ALLOW"; then
                echo -e "              ${DIM}ufw: :$sp allowed${RESET}"
            else
                echo -e "              ${YELLOW}ufw is ACTIVE but :$sp is not allowed — miners will be refused${RESET}"
                echo -e "              ${DIM}fix: ufw allow ${sp}/tcp   (or re-run 2) Configure)${RESET}"
            fi
        elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
            if firewall-cmd --query-port="${sp}/tcp" &>/dev/null; then
                echo -e "              ${DIM}firewalld: :$sp allowed${RESET}"
            else
                echo -e "              ${YELLOW}firewalld is running but :$sp is not open — miners will be refused${RESET}"
                echo -e "              ${DIM}fix: re-run 2) Configure   (or firewall-cmd --permanent --add-port=${sp}/tcp; firewall-cmd --reload)${RESET}"
            fi
        else
            # Say it outright: a blank here used to read as "nothing to worry about", while
            # the box could still be filtered by raw iptables or the provider's firewall.
            echo -e "              ${DIM}host firewall: none active (ufw/firewalld) — not what blocks :$sp${RESET}"
            _gw_unmanaged_filter_hint "$sp" "              "
        fi
    else
        echo -e "  ${BOLD}Stratum${RESET}   : ${DIM}:$sp not listening${RESET}"
    fi

    echo -e "  ${BOLD}Region${RESET}    : $(gw_read_conf region '(unset)')"
    echo -e "  ${BOLD}Forwards${RESET}  : :$sp → $(gw_read_conf hub_endpoint '(unset)')  ${DIM}(over ${GW_WG_IFACE})${RESET}"

    # WireGuard tunnel liveness — last handshake age is the truest "is the link alive" signal.
    if wg show "$GW_WG_IFACE" &>/dev/null; then
        local hs; hs=$(wg show "$GW_WG_IFACE" latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)
        if [[ -n "$hs" && "$hs" != "0" ]]; then
            local age=$(( $(date +%s) - hs ))
            echo -e "  ${BOLD}Tunnel${RESET}    : ${GREEN}● up${RESET}  ${DIM}(last handshake ${age}s ago)${RESET}"
        else
            echo -e "  ${BOLD}Tunnel${RESET}    : ${YELLOW}up, no handshake yet${RESET}"
            local _ep _hip
            _ep=$(gw_read_conf wg_hub_endpoint "(unset)")
            _hip=$(gw_read_conf wg_hub_ip "(central tunnel IP)")
            echo -e "    ${DIM}No handshake = the central box never answered. Check, in order:${RESET}"
            echo -e "    ${DIM} 1. The pool box added THIS gateway's public key as a peer${RESET}"
            echo -e "    ${DIM}    (pool menu W → 2 Add a gateway peer — key shown below).${RESET}"
            echo -e "    ${DIM} 2. Endpoint ${_ep} is the pool box's PUBLIC ip:wg-port${RESET}"
            echo -e "    ${DIM}    (51820 mainnet / 51821 testnet) and that UDP port is open there.${RESET}"
            echo -e "    ${DIM} 3. Re-run 3) Bring up tunnel here, then: ping ${_hip}${RESET}"
            echo -e "    ${DIM}    (handshake appears within ~25s once both sides are correct).${RESET}"
        fi
    else
        echo -e "  ${BOLD}Tunnel${RESET}    : ${DIM}${GW_WG_IFACE} not up${RESET}"
    fi

    # Hub move readiness (plan F1). The timer only helps a DNS-name endpoint; an IP
    # literal pins this gateway to one hub address until someone edits it here.
    if systemctl is-active --quiet "${GW_RERESOLVE}.timer" 2>/dev/null; then
        echo -e "  ${BOLD}Re-resolve${RESET}: ${GREEN}● timer active${RESET}  ${DIM}(re-reads the hub DNS name when the handshake goes stale)${RESET}"
    elif [[ -f "$GW_SYSTEMD_DIR/${GW_RERESOLVE}.timer" ]]; then
        echo -e "  ${BOLD}Re-resolve${RESET}: ${YELLOW}installed, timer not active${RESET}  ${DIM}— run 3) Bring up tunnel${RESET}"
    else
        echo -e "  ${BOLD}Re-resolve${RESET}: ${YELLOW}not installed${RESET}  ${DIM}— run 3) Bring up tunnel${RESET}"
    fi
    local _hep _hhost; _hep=$(gw_read_conf wg_hub_endpoint "")
    _hhost="${_hep%:*}"
    if [[ "$_hhost" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$_hhost" == \[*\] ]]; then
        echo -e "              ${YELLOW}hub endpoint is an IP — a hub move needs 2) Configure here;${RESET}"
        echo -e "              ${DIM}pair with a DNS name (hub W → 5) to make moves automatic.${RESET}"
    fi

    _gw_probe_status_line

    # Boot persistence. Two units, enabled by two DIFFERENT menu steps (1) Install →
    # grin-gateway, 3) Bring up tunnel → wg-quick@), each with `|| true`. A gateway that
    # is missing one comes back from a reboot in the worst state there is: :$sp listens
    # with nothing behind it, so the pool's Port check reads ✓ while no share ever
    # arrives. Nothing else on this screen can tell that apart from a healthy box.
    local fw_boot="enabled" tn_boot="enabled"
    systemctl is-enabled --quiet "$GW_SERVICE" 2>/dev/null            || fw_boot="NOT enabled"
    systemctl is-enabled --quiet "wg-quick@${GW_WG_IFACE}" 2>/dev/null || tn_boot="NOT enabled"
    if [[ "$fw_boot" == "enabled" && "$tn_boot" == "enabled" ]]; then
        echo -e "  ${BOLD}On reboot${RESET} : ${GREEN}forwarder and tunnel start automatically${RESET}"
    else
        echo -e "  ${BOLD}On reboot${RESET} : ${YELLOW}forwarder ${fw_boot} · tunnel ${tn_boot}${RESET}"
        [[ "$fw_boot" == "enabled" ]] || echo -e "              ${DIM}fix: systemctl enable ${GW_SERVICE}   (1) Install does this)${RESET}"
        [[ "$tn_boot" == "enabled" ]] || echo -e "              ${DIM}fix: systemctl enable wg-quick@${GW_WG_IFACE}   (3) Bring up tunnel does this)${RESET}"
    fi

    if [[ -f "$GW_DIR/wg_public.key" ]]; then
        echo -e "\n  ${DIM}This gateway's wg public key:${RESET} $(cat "$GW_DIR/wg_public.key")"
    fi
}

# ─── Menu / loop ────────────────────────────────────────────────────────────────
gw_menu() {
    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  GRINIUM — Regional Gateway (thin forwarder)${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${DIM}  Miners :$(gw_read_conf public_stratum_port 3333)  ->  central $(gw_read_conf hub_endpoint '(unset)') over ${GW_WG_IFACE}${RESET}"
    echo -e "${DIM}  No node, no wallet, no DB — pure stratum forwarder.${RESET}"
    echo ""
    echo -e "  ${GREEN}1${RESET}) Install            ${DIM}(haproxy + wireguard; generate keypair)${RESET}"
    echo -e "  ${GREEN}2${RESET}) Configure          ${DIM}(region, central endpoint, tunnel keys)${RESET}"
    echo -e "  ${GREEN}3${RESET}) Bring up tunnel    ${DIM}(wg-quick up ${GW_WG_IFACE} + hub re-resolve timer; re-run once to add it)${RESET}"
    echo -e "  ${GREEN}4${RESET}) Service control    ${DIM}(start / stop / restart forwarder)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Status"
    echo -e "  ${GREEN}6${RESET}) Latency probe      ${DIM}(HTTPS /ping so the pool's connect page can time this gateway)${RESET}"
    echo ""
    echo -e "  ${RED}0${RESET}) Back"
    echo ""
    echo -ne "${BOLD}Select: ${RESET}"
}

pool_gateway_loop() {
    while true; do
        gw_menu
        read -r choice
        # ||-guarded dispatch: a failing step must return to this menu, not kill
        # the whole script via set -e.
        case "${choice,,}" in
            "")       continue ;;
            1)        gw_install || true ;;
            2)        gw_configure || true ;;
            3)        gw_wireguard_up || true ;;
            4)        gw_service_control || true ;;
            5)        gw_status || true ;;
            6)        gw_probe_menu || true ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1; continue ;;
        esac
        # 4 (service control) and 6 (latency probe) are submenus that self-manage their own
        # feedback and return on their own 0) Back — skip here so Back doesn't double-prompt.
        case "${choice,,}" in
            4|6) ;;
            *) echo ""; echo "Press Enter to continue..."; read -r ;;
        esac
    done
}
