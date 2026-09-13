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
# the `user`/`group` lines gw_render_forwarder writes into the global section; these are
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
gw_open_firewall() {
    local port; port=$(gw_read_conf public_stratum_port "3333")
    [[ "$port" =~ ^[0-9]+$ ]] || return 0
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q active; then
        if ufw allow "${port}/tcp" >/dev/null 2>&1; then
            info "ufw: opened ${port}/tcp (miner stratum)."
        else
            warn "ufw is active but opening ${port}/tcp failed — miners will be refused until you add it."
        fi
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null; then
        firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        info "firewalld: opened ${port}/tcp (miner stratum)."
    else
        info "No active ufw/firewalld detected — nothing to open for :${port}."
        echo -e "    ${DIM}If your provider has its own network firewall, allow TCP ${port} there.${RESET}"
    fi
}

# ─── 2) Configure ───────────────────────────────────────────────────────────────
# Parse the one-line pairing string the central pool box prints on "Add a gateway
# peer" (and re-prints on "List gateways"):
#   GRINGW1|region|hub_wg_pubkey|hub_public_endpoint|hub_tunnel_ip|gw_tunnel_ip/32|region_port
# Returns 1 (writing nothing) unless the tag matches and all 6 fields are present.
gw_apply_pairing_string() {
    local tag region pub ep hubip gwip port
    IFS='|' read -r tag region pub ep hubip gwip port <<< "$1"
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
    [[ "$gwip" == */* ]] || gwip="${gwip}/32"
    gw_write_conf_key "region"          "$region"
    gw_write_conf_key "wg_hub_pubkey"   "$pub"
    gw_write_conf_key "wg_hub_endpoint" "$ep"
    gw_write_conf_key "wg_hub_ip"       "$hubip"
    gw_write_conf_key "wg_address"      "$gwip"
    gw_write_conf_key "hub_endpoint"    "${hubip}:${port}"
    success "Pairing applied: region '${region}', tunnel ${gwip} → hub ${hubip}:${port}."
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
    # The haproxy runtime account. It exists on every distro that ships the package
    # (Debian/Ubuntu and RHEL both create `haproxy`), but fall back to `nobody` rather
    # than emit a `user` line naming an account that does not exist — haproxy refuses
    # to start on an unknown user and ExecStartPre would fail the whole service.
    local hap_user="haproxy" hap_group="haproxy"
    id -u haproxy >/dev/null 2>&1 || { hap_user="nobody"; hap_group="nogroup"; }
    getent group "$hap_group" >/dev/null 2>&1 || hap_group="$(id -gn "$hap_user" 2>/dev/null || echo nogroup)"

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
    # applied: with no `user`/`group` here and no `User=` in the unit, haproxy stayed
    # root for its entire life. The stratum port is >1024, so nothing needs root after
    # startup. Chroot deliberately omitted: it would break `log /dev/log`.
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

# ─── 3) Bring up / refresh the WireGuard tunnel ─────────────────────────────────
gw_wireguard_up() {
    echo -e "\n${BOLD}Bring up WireGuard tunnel (${GW_WG_IFACE})${RESET}\n"
    [[ -f "$GW_WG_CONF" ]] || gw_render_wireguard || return 1
    # wg-quick down is a no-op-safe refresh; ignore failure when the iface isn't up yet.
    wg-quick down "$GW_WG_IFACE" 2>/dev/null || true
    if wg-quick up "$GW_WG_IFACE"; then
        systemctl enable "wg-quick@${GW_WG_IFACE}" 2>/dev/null || true
        success "Tunnel ${GW_WG_IFACE} is up."
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

    if systemctl is-active --quiet "$GW_SERVICE" 2>/dev/null; then
        echo -e "  ${BOLD}Forwarder${RESET} : ${GREEN}● active${RESET}"
    elif systemctl is-enabled --quiet "$GW_SERVICE" 2>/dev/null; then
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
        if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q active; then
            if ufw status 2>/dev/null | grep -qE "^${sp}(/tcp)?[[:space:]]+ALLOW"; then
                echo -e "              ${DIM}ufw: :$sp allowed${RESET}"
            else
                echo -e "              ${YELLOW}ufw is ACTIVE but :$sp is not allowed — miners will be refused${RESET}"
                echo -e "              ${DIM}fix: ufw allow ${sp}/tcp   (or re-run 2) Configure)${RESET}"
            fi
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
    echo -e "  ${GREEN}3${RESET}) Bring up tunnel    ${DIM}(wg-quick up ${GW_WG_IFACE})${RESET}"
    echo -e "  ${GREEN}4${RESET}) Service control    ${DIM}(start / stop / restart forwarder)${RESET}"
    echo -e "  ${GREEN}5${RESET}) Status"
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
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1; continue ;;
        esac
        # 4 (service control) is a submenu that self-manages its own feedback and
        # returns on its own 0) Back — skip here so Back doesn't double-prompt.
        case "${choice,,}" in
            4) ;;
            *) echo ""; echo "Press Enter to continue..."; read -r ;;
        esac
    done
}
