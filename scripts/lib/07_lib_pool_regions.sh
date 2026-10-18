# =============================================================================
# 07_lib_pool_regions.sh — Regional gateways for the public pool script: WireGuard hub setup and gateway peers (menu W).
# =============================================================================
# Sourced by 07_grin_mining_public_pool.sh after the POOL_* constants; shares its globals and log/info/warn/error.
# Trap: runs with errexit off (callers guard with `|| true`); WireGuard state is written only by grin-gateway-ctl, whose result is parsed; the one pool.json write (wg_endpoint_host) is guarded, and the chown/chmod on pool.db sidecars is best-effort (`|| true`).

# ═══════════════════════════════════════════════════════════════════════════════
# W) MULTI-REGION — central WireGuard server + gateway peers (Model C)
# ═══════════════════════════════════════════════════════════════════════════════
# The central box accepts regional GATEWAYS (07_lib_gateway.sh) over a WireGuard
# tunnel. Each gateway forwards miner stratum (with a PROXY-v2 header carrying the
# real miner IP) to a per-region INTERNAL port here, bound to the tunnel interface
# only (never public). This menu sets up the wg server and adds gateway peers,
# assigning each a tunnel IP + a region listener port (written into region_ports).
# See docs/reference/script07_implementation.md §8 (Multi-region — as built).
# Per-network so a testnet pool's tunnel never collides with a mainnet one on the same box
# (iface kept ≤15 chars for Linux IFNAMSIZ — "wg-grinpool-tn").
if [[ "$POOL_NET" == "testnet" ]]; then
    WG_IFACE="wg-grinpool-tn"
    WG_DIR_CONF="/opt/grin/conf/wg-testnet"
    WG_TUNNEL_NET="10.66.67"        # /24; server = .1, gateways = .2, .3, ...
    WG_LISTEN_PORT=51821
    REGION_PORT_BASE=13391          # first per-region internal stratum port (testnet)
else
    WG_IFACE="wg-grinpool"
    WG_DIR_CONF="/opt/grin/conf/wg"
    WG_TUNNEL_NET="10.66.66"        # /24; server = .1, gateways = .2, .3, ...
    WG_LISTEN_PORT=51820
    REGION_PORT_BASE=3391           # first per-region internal stratum port
fi
WG_CONF="/etc/wireguard/${WG_IFACE}.conf"

# Public wg endpoint shown to operators / carried in pairing strings. Honors the
# optional wg_endpoint_host conf key (§13.10b): a DNS name here means a provider/IP
# change is just a DNS A-record update + `wg-quick` restart on each gateway —
# no re-pairing. Falls back to the ipify-resolved public IP.
_pool_wg_endpoint() {
    local host; host=$(pool_read_conf "wg_endpoint_host" "")
    if [[ -n "$host" ]]; then echo "${host}:${WG_LISTEN_PORT}"; return; fi
    echo "$(curl -s --max-time 4 https://api.ipify.org 2>/dev/null || echo '<server-public-ip>'):${WG_LISTEN_PORT}"
}

# Printed under every GRINGW1 line when no wg_endpoint_host is set. A gateway paired to
# a raw IP cannot follow a hub move: its re-resolve timer only re-reads DNS names.
# Informational only — pairing still proceeds. $1 = indent.
_pool_pairing_ip_warning() {
    [[ -n "$(pool_read_conf "wg_endpoint_host" "")" ]] && return 0
    echo -e "${1:-    }${DIM}⚠ This pairing carries a raw IP: a future hub move will need a manual edit on the gateway. Set W → 5 first.${RESET}"
}

# Parse one grin-gateway-ctl JSON reply. Prints "ERR <msg>" or
# "OK <existing> <replaced> <region> <peer_ip> <port> <synced>" + pairing on line 2.
_pool_gwctl_parse() {
    node -e '
let d = {};
try { d = JSON.parse(process.argv[1]); } catch (e) { console.log("ERR helper output was not JSON"); process.exit(0); }
if (!d.ok) { console.log("ERR " + (d.error || "unknown helper error")); process.exit(0); }
console.log(["OK", d.existing ? 1 : 0, d.replaced ? 1 : 0, d.region, d.peer_ip, d.region_port, d.synced === false ? 0 : 1].join(" "));
console.log(d.pairing || "");
' "$1" 2>/dev/null || echo "ERR helper output was not JSON"
}

# Thin caller over grin-gateway-ctl init-server (§13.5/§13.12) — package, keypair,
# /etc/wireguard conf, firewall, iface up+enabled and region_listen_host ALL live in
# the helper, so this menu option and the admin panel's "Enable multi-region" button
# do byte-identical work. A second implementation here is
# exactly how the hub key, tunnel net or listen port drift between the two paths.
pool_wg_setup_server() {
    info "Setting up the central WireGuard server..."
    # Regenerate the helper FIRST: a box installed before init-server existed has
    # an older copy on disk that would reject the subcommand.
    pool_gwctl_install || { error "Could not install $GWCTL_BIN."; return 1; }

    local out parsed
    out=$("$GWCTL_BIN" init-server --net "$POOL_NET" 2>&1 || true)
    parsed=$(node -e '
let d = {};
try { d = JSON.parse(process.argv[1]); } catch (e) { console.log("ERR helper output was not JSON"); process.exit(0); }
if (!d.ok) { console.log("ERR " + (d.error || "unknown helper error")); process.exit(0); }
console.log(["OK", d.config, d.keypair, d.interface, d.firewall, d.boot_enabled ? "boot" : "noboot"].join(" "));
console.log(d.hub_pubkey || "");
console.log(d.hub_endpoint || "");
console.log(d.hub_tunnel_ip || "");
' "$out" 2>/dev/null || echo "ERR helper output was not JSON")

    local head; head=$(sed -n 1p <<< "$parsed")
    if [[ "$head" == ERR* ]]; then error "${head#ERR }"; return 1; fi
    local _ conf_act key_act iface_act fw boot_act
    read -r _ conf_act key_act iface_act fw boot_act <<< "$head"
    local hub_pub hub_ep hub_ip
    hub_pub=$(sed -n 2p <<< "$parsed")
    hub_ep=$(sed -n 3p <<< "$parsed")
    hub_ip=$(sed -n 4p <<< "$parsed")

    if [[ "$key_act" == "generated" ]]; then
        success "Generated central WireGuard keypair."
    elif [[ "$key_act" == "repaired" ]]; then
        warn "The hub public key file was missing — re-derived it from the private key."
    fi
    if [[ "$conf_act" == "created" ]]; then
        success "Wrote $WG_CONF (${hub_ip}/24, UDP ${WG_LISTEN_PORT})."
    else
        info "$WG_CONF already exists — kept it (add peers with option 2)."
    fi
    case "$fw" in
        ufw)        info "ufw: opened ${WG_LISTEN_PORT}/udp." ;;
        firewalld)  info "firewalld: opened ${WG_LISTEN_PORT}/udp." ;;
        ufw-failed) warn "ufw is active but the ${WG_LISTEN_PORT}/udp rule failed — add it by hand." ;;
    esac
    if [[ "$iface_act" == "up" ]]; then
        success "Central tunnel up (${hub_ip})."
    else
        info "Tunnel ${WG_IFACE} was already up — config re-applied without dropping peers."
    fi
    # Only reachable when the helper ran somewhere that cannot write
    # /etc/systemd/system. From this menu it runs as root with no namespace, so
    # a failure here is a genuinely broken systemd, not the expected panel case.
    if [[ "$boot_act" == "noboot" ]]; then
        warn "Could not enable wg-quick@${WG_IFACE} at boot — the tunnel is up NOW but a reboot loses it."
        echo -e "  ${DIM}fix: systemctl enable wg-quick@${WG_IFACE}${RESET}"
    fi

    echo ""
    echo -e "  ${BOLD}Give each gateway operator these:${RESET}"
    echo -e "    central wg public key : ${GREEN}${hub_pub}${RESET}"
    echo -e "    central wg endpoint   : ${GREEN}${hub_ep}${RESET}"
    echo -e "    central tunnel IP     : ${GREEN}${hub_ip}${RESET}"
    echo ""
    echo -e "  ${DIM}Gateways can now also be paired from the admin panel (Regions & Gateways —${RESET}"
    echo -e "  ${DIM}paste the gateway's wg public key into the region form; no SSH needed).${RESET}"
    echo -e "  ${DIM}Tip: set a DNS name for this hub (option 5) so a future provider/IP change${RESET}"
    echo -e "  ${DIM}never strands your gateways.${RESET}"
}

# Thin caller over grin-gateway-ctl (§13.5) — ALL WireGuard/region_ports mutation
# logic lives in the helper, shared byte-for-byte with the admin panel path, so
# the two registries can never drift. This wrapper only prompts + pretty-prints.
pool_wg_add_peer() {
    [[ -f "$WG_CONF" ]] || { error "Run 1) Setup WireGuard server first."; return 1; }
    [[ -x "$GWCTL_BIN" ]] || pool_gwctl_install || return 1
    local region gwpub
    echo -ne "Region key for this gateway (airport-style code, e.g. nyc, sgn, ams): "; read -r region
    [[ -n "$region" ]] || { warn "Region key required."; return 1; }
    echo -ne "Gateway's WireGuard public key: "; read -r gwpub
    [[ -n "$gwpub" ]] || { warn "Gateway public key required."; return 1; }

    local out parsed head pairing
    out=$("$GWCTL_BIN" add-peer --net "$POOL_NET" --region "$region" --pubkey "$gwpub" 2>&1 || true)
    parsed=$(_pool_gwctl_parse "$out")
    head=$(head -n1 <<< "$parsed"); pairing=$(sed -n 2p <<< "$parsed")
    if [[ "$head" == ERR* ]]; then error "${head#ERR }"; return 1; fi
    local _ ex rep reg peer_ip port synced
    read -r _ ex rep reg peer_ip port synced <<< "$head"

    if [[ "$ex" == "1" ]]; then
        # Dup-pubkey guard (cryptokey-routing lesson): the helper wrote
        # NOTHING — the key keeps its existing tunnel IP/port; re-print the pairing.
        warn "This public key is ALREADY a gateway peer — keeping its existing tunnel IP/port."
        echo -e "  ${BOLD}Existing pairing string for this key (region '${reg}'):${RESET}"
        echo -e "    ${GREEN}${pairing}${RESET}"
        _pool_pairing_ip_warning "    "
        info "To re-pair from scratch, remove the peer first (4) — then add it again."
        return 0
    fi
    [[ "$synced" == "1" ]] || warn "wg syncconf failed — peer is in the config; run wg-quick down/up ${WG_IFACE} to apply."
    if [[ "$rep" == "1" ]]; then
        # Gateway box replacement: same region, new key — the helper swapped the key
        # in place, so tunnel IP + region port (hub_endpoint) are unchanged (§13.10d).
        success "Replaced the gateway key for region '${reg}' — tunnel IP + port kept."
    else
        success "Added gateway peer for region '${reg}'."

        # Create the admin → Regions card here too, so add and remove are symmetric:
        # remove-peer already DELETEs this row, and an add that only printed "remember
        # to declare it" is how a region ends up wired but invisible in the panel.
        # is_active = 0 on purpose — we have no stratum hostname to publish yet, and a
        # visible card with a NULL host would render a dead entry on the public connect
        # grid. The operator fills the host in the panel, which flips it visible.
        local _carded=""
        if [[ -f "$POOL_APP_DIR/pool.db" ]]; then
        _carded=$(node -e '
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  const r = db.prepare(
    "INSERT INTO pool_locations (region, is_active, updated_at) VALUES (?, 0, unixepoch()) " +
    "ON CONFLICT(region) DO NOTHING"
  ).run(process.argv[2]);
  process.stdout.write(String(r.changes));
} catch (e) {}
' "$POOL_APP_DIR/pool.db" "$reg" 2>/dev/null) || true
            # This runs as ROOT against a DB the de-rooted service owns. In WAL mode
            # SQLite creates pool.db-wal / -shm beside it; if the service happened to
            # be stopped, those are created root-owned and an unclean exit leaves them
            # behind — after which grinpool cannot open its own database. Hand them
            # back unconditionally (no-op when the service's connection already owns
            # them, and the -f guard above means the DB itself is never created here).
            if id grinpool >/dev/null 2>&1; then
                chown grinpool:grinpool "$POOL_APP_DIR"/pool.db "$POOL_APP_DIR"/pool.db-wal "$POOL_APP_DIR"/pool.db-shm 2>/dev/null || true
            fi
            # …and the MODE, not just the owner (audit §J8-1's shell half, item 3).
            # A root-created -wal lands 0644 under systemd's default umask and carries
            # the most recent writes verbatim; lib/db.js only tightens these at service
            # START, so between this root write and the next restart they sat readable
            # by every local account. Same three files, same 0600 as restrictDbFileModes.
            chmod 600 "$POOL_APP_DIR"/pool.db "$POOL_APP_DIR"/pool.db-wal "$POOL_APP_DIR"/pool.db-shm 2>/dev/null || true
        fi
        if [[ "$_carded" == "1" ]]; then
            info "Created a HIDDEN '${reg}' card in admin → Regions."
            echo -e "    ${DIM}Open it there, fill in the stratum hostname, tick ${BOLD}Active${RESET}${DIM} and Save${RESET}"
            echo -e "    ${DIM}to publish it on the connect grid.${RESET}"
        elif [[ -n "${_carded:-}" ]]; then
            info "Region '${reg}' already has a card in admin → Regions — left as is."
        fi

        # New region → the running pool must bind its tunnel listener. The panel's
        # pairing hot-binds inside the process; the CLI runs OUTSIDE it, so the only
        # lever here is a restart — which drops every miner on every region, not just
        # this one. Say so and let the operator choose the moment.
        if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
            echo ""
            warn "The pool must rebind its listeners to serve region '${reg}'."
            echo -e "  ${YELLOW}Restarting $POOL_SERVICE disconnects EVERY miner on EVERY region${RESET}"
            echo -e "  ${YELLOW}for a few seconds (they reconnect on their own; shares in flight are lost).${RESET}"
            echo -e "  ${DIM}Pairing from admin → Regions & Gateways binds the new listener in-process${RESET}"
            echo -e "  ${DIM}with no restart at all — prefer that page for the next one.${RESET}"
            echo -ne "Restart now? [y/N] (n = the region starts working at your next restart): "
            local _rs; read -r _rs
            if [[ "${_rs,,}" == "y" ]]; then
                if systemctl restart "$POOL_SERVICE"; then
                    info "Restarted $POOL_SERVICE (new region listener bound)."
                else
                    error "Restart failed — region '${reg}' is paired but not yet listening."
                fi
            else
                warn "Not restarted. Region '${reg}' will not accept miners until $POOL_SERVICE restarts."
            fi
        fi
    fi

    echo ""
    echo -e "  ${BOLD}Give this gateway operator:${RESET}"
    echo -e "    this gateway tunnel IP: ${GREEN}${peer_ip}${RESET}"
    echo -e "    central region port   : ${GREEN}${port}${RESET}  ${DIM}(hub_endpoint = ${WG_TUNNEL_NET}.1:${port})${RESET}"
    echo ""
    echo -e "  ${BOLD}ONE-LINE pairing string${RESET} ${DIM}(paste it at the gateway's 2) Configure to fill every${RESET}"
    echo -e "  ${DIM}tunnel field at once; re-printable via 3) List gateways or the admin panel):${RESET}"
    echo -e "    ${GREEN}${pairing}${RESET}"
    _pool_pairing_ip_warning "    "
    echo ""
    if [[ "$rep" == "1" ]]; then
        # Replacement: everything below is already done for this region — the only
        # remaining action is on the new gateway box.
        echo -e "  ${BOLD}One thing left:${RESET} on the NEW gateway box run 2) Configure (paste the"
        echo -e "  line above) → 3) Bring up tunnel → 4) Start. DNS and the region card are"
        echo -e "  unchanged, so nothing else moves."
        return 0
    fi
    echo -e "  ${BOLD}Two things left before miners can use region '${reg}':${RESET}"
    echo -e "    ${GREEN}1.${RESET} On the GATEWAY box: 2) Configure (paste the line above) → 3) Bring up"
    echo -e "       tunnel → 4) Start. Make sure its public stratum port is open there."
    echo -e "    ${GREEN}2.${RESET} DNS: point the hostname miners will dial (e.g. ${reg}.example.com) at the"
    echo -e "       ${BOLD}GATEWAY box's public IP${RESET} — not this box — then put that hostname in"
    echo -e "       admin → Regions & Gateways so the card goes visible on the connect grid."
    echo -e "  ${DIM}Until DNS resolves, the panel's Port check shows ✗ unreachable even when the${RESET}"
    echo -e "  ${DIM}tunnel is healthy — that is the DNS step, not a broken gateway.${RESET}"
}

pool_wg_list() {
    echo -e "\n${BOLD}Multi-region — gateways & tunnel${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"
    if [[ ! -f "$WG_CONF" ]]; then
        echo -e "  ${DIM}WireGuard server not set up (run option 1).${RESET}"
        return 0
    fi
    [[ -x "$GWCTL_BIN" ]] || pool_gwctl_install || true

    # One helper call carries everything: region → listener map, pairing strings,
    # per-region handshake age (helper `list` + `status`, same data the panel shows).
    local list_json status_json
    list_json=$("$GWCTL_BIN" list --net "$POOL_NET" 2>/dev/null || echo '{}')
    status_json=$("$GWCTL_BIN" status --net "$POOL_NET" 2>/dev/null || echo '{}')
    node -e '
let l = {}, s = {};
try { l = JSON.parse(process.argv[1]); } catch (e) {}
try { s = JSON.parse(process.argv[2]); } catch (e) {}
const host = process.argv[3];
const hs = {};
for (const g of (s.gateways || [])) hs[g.region] = g;
const gws = l.gateways || [];
console.log("  Region → central listener (tunnel-only host:port each gateway forwards to):");
if (!gws.length) console.log("    (none yet — option 2 or the admin panel assigns each gateway a host:port here)");
for (const g of gws) {
  const h = hs[g.region];
  const age = h && h.handshake_age != null ? "handshake " + h.handshake_age + "s ago" : "no handshake yet";
  console.log("    " + g.region + "  ->  " + host + ":" + (g.region_port || "?") + "   [" + age + "]");
}
console.log("");
console.log("  Pairing strings (paste into the matching gateway 2) Configure):");
if (!gws.length) console.log("    (no gateway peers yet — add one with option 2)");
for (const g of gws) console.log("    " + g.pairing);
' "$list_json" "$status_json" "${WG_TUNNEL_NET}.1" 2>/dev/null \
        || echo "    (could not read gateway list — is the helper installed and node present?)"
    _pool_pairing_ip_warning "    "

    # UX guard: a region wired here (region_ports) but NOT declared in admin → Regions
    # (pool_locations) still mines + credits fine — but shows on the public connect grid
    # only as an unlabelled card derived from live shares. Warn so the operator can add
    # the label/country. Uses node:sqlite (always present); stays SILENT when the DB is
    # absent/unreadable (can't verify → don't cry wolf), matching _pool_db_scalar.
    local _wg_unmatched
    _wg_unmatched=$(node -e '
const fs = require("fs");
let d = {}; try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(0); }
const regions = Object.keys(d.region_ports || {});
if (!regions.length) process.exit(0);
const have = new Set();
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[2]);
  for (const r of db.prepare("SELECT region FROM pool_locations").all()) have.add(r.region);
} catch (e) { process.exit(0); }   // DB missing / table not created yet → cannot verify
const missing = regions.filter(r => !have.has(r));
if (missing.length) process.stdout.write(missing.join(" "));
' "$POOL_CONF" "$POOL_APP_DIR/pool.db" 2>/dev/null || true)
    if [[ -n "$_wg_unmatched" ]]; then
        warn "Region(s) wired but not declared in admin → Regions: ${_wg_unmatched}"
        echo -e "  ${DIM}They mine + credit fine, but show as unlabelled cards on the public${RESET}"
        echo -e "  ${DIM}connect grid until you add them in the admin panel → Regions.${RESET}"
    fi
    echo ""
    if wg show "$WG_IFACE" &>/dev/null; then
        echo -e "  ${BOLD}Live tunnel (${WG_IFACE}):${RESET}"
        echo -e "    central wg endpoint: ${GREEN}$(_pool_wg_endpoint)${RESET}  ${DIM}(what each gateway dials from outside)${RESET}"
        wg show "$WG_IFACE" 2>/dev/null | sed 's/^/    /'
    else
        echo -e "  ${DIM}Tunnel ${WG_IFACE} not up.${RESET}"
    fi
}

# Thin caller over grin-gateway-ctl remove-peer (§13.5) — this wrapper keeps the
# interactive parts (peer listing, liveness guard, typed confirmation) and lets the
# helper do the mutation (drop [Peer] + syncconf + region_ports), exactly as the
# panel's "also remove the WireGuard peer" delete flow does.
pool_wg_remove_peer() {
    [[ -f "$WG_CONF" ]] || { error "WireGuard server not set up ($WG_CONF missing) — nothing to remove."; return 1; }
    [[ -x "$GWCTL_BIN" ]] || pool_gwctl_install || return 1

    # Show the real peers (+ handshake age) so the operator picks an existing region key.
    local list_json status_json peers
    list_json=$("$GWCTL_BIN" list --net "$POOL_NET" 2>/dev/null || echo '{}')
    status_json=$("$GWCTL_BIN" status --net "$POOL_NET" 2>/dev/null || echo '{}')
    peers=$(node -e '
let l = {}, s = {};
try { l = JSON.parse(process.argv[1]); } catch (e) {}
try { s = JSON.parse(process.argv[2]); } catch (e) {}
const hs = {};
for (const g of (s.gateways || [])) hs[g.region] = g;
for (const g of (l.gateways || [])) {
  const h = hs[g.region];
  const age = h && h.handshake_age != null ? "handshake " + h.handshake_age + "s ago" : "no handshake";
  console.log("    " + g.region + "  " + g.peer_ip + "  [" + age + "]");
}' "$list_json" "$status_json" 2>/dev/null) || true
    if [[ -z "$peers" ]]; then
        info "No gateway peers in $WG_CONF — nothing to remove."
        return 0
    fi
    echo -e "  ${BOLD}Current gateway peers:${RESET}"
    echo "$peers"
    echo ""
    local region
    echo -ne "Region key of the gateway to REMOVE: "; read -r region
    [[ -n "$region" ]] || { warn "Region key required."; return 1; }

    # Liveness guard: a fresh wg handshake means the tunnel is up and miners may be
    # routed through this gateway right now — same signal the admin Regions page uses.
    local age
    age=$(node -e '
let s = {}; try { s = JSON.parse(process.argv[1]); } catch (e) {}
const g = (s.gateways || []).find(g => g.region === process.argv[2]);
if (g && g.handshake_age != null) process.stdout.write(String(g.handshake_age));
' "$status_json" "$region" 2>/dev/null) || true
    if [[ "$age" =~ ^[0-9]+$ ]] && (( age < 180 )); then
        warn "This gateway's tunnel handshook ${age}s ago — it looks LIVE (miners may be on it)."
    fi
    echo -e "  ${YELLOW}This removes: the wg peer (key revoked), region '${region}' port mapping in${RESET}"
    echo -e "  ${YELLOW}pool.json, and the '${region}' card in admin → Regions (pool.db).${RESET}"
    echo -e "  ${DIM}Share/credit history for the region is kept; its internal port is never reused.${RESET}"
    local confirm
    echo -ne "Type the region key again to confirm removal: "; read -r confirm
    [[ "$confirm" == "$region" ]] || { warn "Confirmation mismatch — nothing removed."; return 1; }

    # 1+2) The helper drops the [Peer] block, applies it live (syncconf, without
    #      touching other tunnels), and deletes region_ports[region]. Freed ports
    #      are NOT reused (add-peer assigns max+1), so a stale gateway config can
    #      never collide with a future peer.
    local out parsed
    out=$("$GWCTL_BIN" remove-peer --net "$POOL_NET" --region "$region" 2>&1 || true)
    parsed=$(node -e '
let d = {}; try { d = JSON.parse(process.argv[1]); } catch (e) { console.log("ERR helper output was not JSON"); process.exit(0); }
console.log(d.ok ? ("OK " + (d.synced === false ? 0 : 1)) : ("ERR " + (d.error || "unknown helper error")));
' "$out" 2>/dev/null || echo "ERR helper output was not JSON")
    if [[ "$parsed" == ERR* ]]; then error "${parsed#ERR }"; return 1; fi
    if [[ "$parsed" == "OK 1" ]]; then
        info "Revoked peer on the live tunnel."
    else
        warn "wg syncconf failed — peer removed from config; run wg-quick down/up ${WG_IFACE} to apply."
    fi

    # 3) Drop the admin → Regions card (pool_locations is display metadata; shares
    #    keep their region tag). Silent when the DB/table doesn't exist yet.
    local _deleted
    _deleted=$(node -e '
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  const r = db.prepare("DELETE FROM pool_locations WHERE region = ?").run(process.argv[2]);
  process.stdout.write(String(r.changes));
} catch (e) {}
' "$POOL_APP_DIR/pool.db" "$region" 2>/dev/null) || true
    if [[ "$_deleted" == "1" ]]; then
        info "Deleted the '${region}' card from admin → Regions."
    else
        info "No '${region}' card in admin → Regions (nothing to delete there)."
    fi

    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        systemctl restart "$POOL_SERVICE" && info "Restarted $POOL_SERVICE (region listener unbound)."
    fi

    echo ""
    success "Gateway '${region}' removed — wg key revoked, port mapping + admin card deleted."
    echo -e "  ${DIM}The gateway box itself still has its local config; it can no longer reach${RESET}"
    echo -e "  ${DIM}the pool. Power it off or repurpose it. Re-adding later: option 2 (it gets${RESET}"
    echo -e "  ${DIM}a NEW tunnel IP + port — re-pair the gateway with the new pairing string).${RESET}"
}

# §13.10b — carry a DNS name (not the raw IP) in pairing strings, so a hub
# provider/IP change becomes: update the DNS A record → each gateway's re-resolve
# timer (07_lib_gateway.sh gw_install_reresolve, installed by its 3) Bring up tunnel)
# follows within ~2-3 min. Existing IP-paired gateways: one-field edit in their 2) Configure.
pool_wg_endpoint_host() {
    local cur host
    cur=$(pool_read_conf "wg_endpoint_host" "")
    echo -e "\n${BOLD}Hub endpoint DNS name${RESET} ${DIM}(carried in pairing strings instead of the raw IP)${RESET}"
    echo -e "  ${DIM}After a provider/IP change, update the A record: each gateway follows within${RESET}"
    echo -e "  ${DIM}~2-3 min on its own (re-resolve timer, installed by its 3) Bring up tunnel) — no re-pair.${RESET}"
    echo -e "  Current: ${GREEN}${cur:-"(unset — pairing strings carry the public IP)"}${RESET}"
    echo -ne "New DNS name (e.g. hub.example.com; '-' to clear, Enter to keep): "
    read -r host
    [[ -z "$host" ]] && { info "Unchanged."; return 0; }
    if [[ "$host" == "-" ]]; then
        pool_write_conf_key "wg_endpoint_host" "" \
            || { error "Could not write wg_endpoint_host to ${POOL_CONF} — not cleared."; return 1; }
        success "Cleared — pairing strings carry the public IP again."
        return 0
    fi
    if ! [[ "$host" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$host" == *.* ]]; then
        warn "'$host' does not look like a hostname — nothing changed."
        return 1
    fi
    pool_write_conf_key "wg_endpoint_host" "$host" \
        || { error "Could not write wg_endpoint_host to ${POOL_CONF} — not set."; return 1; }
    success "Hub endpoint host set: ${host}:${WG_LISTEN_PORT} (used by new/re-printed pairing strings)."
    echo -e "  ${DIM}Point a DNS A record for '${host}' at this box's public IP. Already-paired${RESET}"
    echo -e "  ${DIM}gateways keep working on the raw IP; to migrate one, edit its 2) Configure${RESET}"
    echo -e "  ${DIM}wg_hub_endpoint field (or paste a re-printed pairing string).${RESET}"
}

pool_wireguard_menu() {
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Multi-region — WireGuard + gateways${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${YELLOW}${BOLD}OPTIONAL — you do NOT need this for a normal pool.${RESET}"
        echo -e "  ${DIM}Your pool already serves all your miners on :$(pool_read_conf stratum_port 3333) as region \"main\".${RESET}"
        echo -e "  ${DIM}Use this ONLY when you add a regional gateway server in ANOTHER zone/${RESET}"
        echo -e "  ${DIM}continent (a separate box near distant miners, to cut their latency).${RESET}"
        echo -e "  ${DIM}One server = skip this menu entirely. This whole menu is now an SSH/offline${RESET}"
        echo -e "  ${DIM}FALLBACK: the ADMIN PANEL (Regions & Gateways) does 1) with its 'Enable${RESET}"
        echo -e "  ${DIM}multi-region' button and 2)/3)/4) from the region rows — and pairing there${RESET}"
        echo -e "  ${DIM}binds the new listener WITHOUT the service restart option 2 needs here.${RESET}"
        echo -e "  ${DIM}Both paths run the same grin-gateway-ctl helper, so they cannot drift.${RESET}"
        echo ""
        echo -e "${DIM}  Central accepts thin regional gateways over a wg tunnel.${RESET}"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Setup WireGuard server   ${DIM}(install, keys, tunnel, firewall, pairing helper)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Add a gateway peer       ${DIM}(assign tunnel IP + region port)${RESET}"
        echo -e "  ${GREEN}3${RESET}) List gateways / regions"
        echo -e "  ${GREEN}4${RESET}) Remove a gateway        ${DIM}(revoke wg key, free port mapping, drop admin card)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Hub endpoint DNS name   ${DIM}(survive a provider/IP change without re-pairing)${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select: ${RESET}"
        read -r wgc
        case "${wgc,,}" in
            "")       continue ;;
            1)        pool_wg_setup_server || true; _pool_pause ;;
            2)        pool_wg_add_peer || true; _pool_pause ;;
            3)        pool_wg_list || true; _pool_pause ;;
            4)        pool_wg_remove_peer || true; _pool_pause ;;
            5)        pool_wg_endpoint_host || true; _pool_pause ;;
            0|q|exit) break ;;
            *)        warn "Invalid option."; sleep 1 ;;
        esac
    done
}
