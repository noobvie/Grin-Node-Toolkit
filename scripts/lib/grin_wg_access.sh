# =============================================================================
# grin_wg_access.sh — Private access: WireGuard tunnel + DNS-01 certificates
# =============================================================================
#
#  Sourced, not executed. Provides `gwa_*` helpers for putting a toolkit web UI
#  behind a WireGuard tunnel while KEEPING a real, publicly-trusted Let's Encrypt
#  certificate for its normal domain name.
#
#  ─── Why the two halves belong together ──────────────────────────────────────
#  HTTP-01 proves domain control by CONNECTING to the host on port 80. That is
#  exactly the reachability we are removing, so HTTP-01 and a private listener
#  are mutually exclusive — one name cannot resolve both publicly and privately.
#
#  DNS-01 proves control by writing a TXT record instead. It never connects to
#  the host at all, so a service with zero public exposure can still hold a real
#  certificate. That is the whole mechanism:
#
#     Let's Encrypt ── reads _acme-challenge TXT ──▶ your DNS provider
#                      (no inbound connection, ever)
#
#     DNS: wallet.example.com  A → 10.9.0.1     (private IP, public record)
#
#     phone ══ UDP 51820 ══▶ wg0 ══▶ nginx listen 10.9.0.1:443 ══▶ 127.0.0.1:app
#
#  The browser gets a valid cert for the real name with no warning, because a
#  certificate's validity has nothing to do with how the host was reached.
#
#  ─── Deliberate non-goals ────────────────────────────────────────────────────
#   * NOT a general VPN. IP forwarding stays OFF and there are no NAT/PostUp
#     rules — the tunnel reaches THIS HOST and nothing else. Clients keep their
#     normal internet path (split tunnel, AllowedIPs = the WG subnet only).
#   * Never touches SSH. If everything here breaks, SSH is still the way in.
#   * Never closes 80/443 on its own — other toolkit vhosts may be sharing them.
#
#  ─── The trap this lib exists to prevent ─────────────────────────────────────
#  `listen 10.9.0.1:443` fails to bind when wg0 is down. nginx then refuses to
#  start AT ALL, taking down every other site on the box — a wallet change that
#  breaks the block explorer. Fixed with net.ipv4.ip_nonlocal_bind plus a
#  systemd ordering drop-in; see gwa_enable_nonlocal_bind().
#
# =============================================================================

# ─── Logging fallbacks ────────────────────────────────────────────────────────
# Callers (051) define these before sourcing. Guard so the lib is usable alone.
if ! declare -F info >/dev/null 2>&1; then
    info()    { echo "[INFO]  $*"; }
    success() { echo "[OK]    $*"; }
    warn()    { echo "[WARN]  $*"; }
    error()   { echo "[ERROR] $*"; }
fi

# ─── Constants ────────────────────────────────────────────────────────────────
GWA_DIR="/opt/grin/wireguard"
GWA_CLIENT_DIR="$GWA_DIR/clients"
GWA_IFACE="wg0"
GWA_WG_DIR="/etc/wireguard"
GWA_WG_CONF="$GWA_WG_DIR/${GWA_IFACE}.conf"
GWA_SERVER_KEY="$GWA_WG_DIR/${GWA_IFACE}.key"
GWA_SERVER_PUB="$GWA_WG_DIR/${GWA_IFACE}.pub"
GWA_NET_PREFIX="10.9.0"
GWA_SUBNET="${GWA_NET_PREFIX}.0/24"
GWA_SERVER_IP="${GWA_NET_PREFIX}.1"
GWA_PORT="51820"
GWA_SYSCTL="/etc/sysctl.d/99-grin-wg-nonlocal-bind.conf"
GWA_NGINX_DROPIN_DIR="/etc/systemd/system/nginx.service.d"
GWA_NGINX_DROPIN="$GWA_NGINX_DROPIN_DIR/10-grin-wg-order.conf"
GWA_ENDPOINT_FILE="$GWA_DIR/endpoint.conf"

# =============================================================================
# DEPENDENCIES
# =============================================================================

# The WireGuard kernel module. Missing on OpenVZ/LXC-based VPS, where the only
# option is a userspace implementation (boringtun / wireguard-go). Worth failing
# loudly here rather than in the middle of `wg-quick up`.
gwa_kernel_ok() {
    [[ -d /sys/module/wireguard ]] && return 0
    modprobe wireguard 2>/dev/null && return 0
    return 1
}

gwa_install_deps() {
    local missing=0
    for c in wg wg-quick qrencode; do
        command -v "$c" &>/dev/null || missing=1
    done

    if (( missing )); then
        info "Installing wireguard-tools + qrencode ..."
        if command -v apt-get &>/dev/null; then
            DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>/dev/null || true
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq wireguard wireguard-tools qrencode \
                || { error "Package install failed."; return 1; }
        elif command -v dnf &>/dev/null; then
            dnf install -y wireguard-tools qrencode >/dev/null 2>&1 \
                || { error "Package install failed."; return 1; }
        else
            error "No apt-get/dnf — install wireguard-tools and qrencode manually."
            return 1
        fi
    fi

    for c in wg wg-quick qrencode; do
        command -v "$c" &>/dev/null || { error "$c still missing after install."; return 1; }
    done

    if ! gwa_kernel_ok; then
        error "The WireGuard kernel module is not available on this host."
        warn  "Common on OpenVZ / LXC containers. A KVM VPS normally has it."
        warn  "Workaround: install boringtun (userspace) and set"
        warn  "  WG_QUICK_USERSPACE_IMPLEMENTATION=boringtun in /etc/default/wg-quick."
        return 1
    fi

    success "WireGuard tools + kernel module present."
    return 0
}

# =============================================================================
# SERVER
# =============================================================================

gwa_installed() { [[ -f "$GWA_WG_CONF" ]]; }
gwa_active()    { systemctl is-active --quiet "wg-quick@${GWA_IFACE}" 2>/dev/null; }
gwa_enabled()   { systemctl is-enabled --quiet "wg-quick@${GWA_IFACE}" 2>/dev/null; }

gwa_server_pubkey() { [[ -f "$GWA_SERVER_PUB" ]] && cat "$GWA_SERVER_PUB" || echo ""; }

# Best-effort public IP WITHOUT calling a third-party echo service: the source
# address the kernel would use for an outbound route is the public IP on any
# normally-provisioned VPS. Returns empty when that address is itself private
# (host behind NAT) so the caller can prompt instead of guessing wrong.
gwa_detect_public_ip() {
    local ip
    ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1 || true)
    [[ -z "$ip" ]] && { echo ""; return 0; }
    case "$ip" in
        10.*|127.*|192.168.*|169.254.*) echo "" ;;
        172.1[6-9].*|172.2[0-9].*|172.3[01].*) echo "" ;;
        # 100.64/10 is CGNAT. It looks routable but inbound UDP never arrives,
        # so treating it as "detected" would hand the operator a dead endpoint.
        100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) echo "" ;;
        *) echo "$ip" ;;
    esac
}

gwa_endpoint() {
    [[ -f "$GWA_ENDPOINT_FILE" ]] && cat "$GWA_ENDPOINT_FILE" || echo ""
}

gwa_set_endpoint() {
    mkdir -p "$GWA_DIR"; chmod 700 "$GWA_DIR"
    printf '%s' "$1" > "$GWA_ENDPOINT_FILE"
    chmod 600 "$GWA_ENDPOINT_FILE"
}

# Create the server interface. Idempotent: refuses to clobber an existing conf,
# because that would invalidate every provisioned client at once.
gwa_server_init() {
    local endpoint="${1:-}"

    if gwa_installed; then
        info "$GWA_WG_CONF already exists — leaving it alone."
        return 0
    fi
    [[ -z "$endpoint" ]] && { error "gwa_server_init: endpoint required."; return 1; }

    mkdir -p "$GWA_WG_DIR" "$GWA_CLIENT_DIR"
    chmod 700 "$GWA_WG_DIR" "$GWA_DIR" "$GWA_CLIENT_DIR"

    ( umask 077; wg genkey > "$GWA_SERVER_KEY" )
    wg pubkey < "$GWA_SERVER_KEY" > "$GWA_SERVER_PUB"
    chmod 600 "$GWA_SERVER_KEY"; chmod 644 "$GWA_SERVER_PUB"

    local priv; priv=$(cat "$GWA_SERVER_KEY")

    umask 077
    cat > "$GWA_WG_CONF" <<WGCONF
# Generated by grin_wg_access.sh — private access tunnel for toolkit web UIs.
#
# SaveConfig is deliberately OFF: with it on, wg-quick rewrites this file on
# every 'down' and strips the "# gwa-name" comments that identify each peer,
# after which the toolkit can no longer list or remove devices by name.
#
# There are no PostUp/PostDown NAT rules and IP forwarding stays off — this
# tunnel exists to reach THIS HOST, not to route traffic onward.

[Interface]
Address    = ${GWA_SERVER_IP}/24
ListenPort = ${GWA_PORT}
PrivateKey = ${priv}
SaveConfig = false
WGCONF
    umask 022
    chmod 600 "$GWA_WG_CONF"

    gwa_set_endpoint "$endpoint"

    systemctl enable "wg-quick@${GWA_IFACE}" >/dev/null 2>&1 || true
    if systemctl start "wg-quick@${GWA_IFACE}" 2>/dev/null; then
        success "WireGuard interface $GWA_IFACE up on ${GWA_SERVER_IP} (udp/${GWA_PORT})."
    else
        error "wg-quick@${GWA_IFACE} failed to start."
        warn  "Check: journalctl -u wg-quick@${GWA_IFACE} -n 30"
        return 1
    fi
    return 0
}

# =============================================================================
# PEERS (devices)
# =============================================================================

gwa_valid_peer_name() {
    local n="${1:-}"
    [[ -n "$n" && "$n" =~ ^[A-Za-z0-9._-]{1,32}$ ]]
}

gwa_peer_names() {
    [[ -f "$GWA_WG_CONF" ]] || return 0
    grep -oE '^# gwa-name = .+$' "$GWA_WG_CONF" 2>/dev/null | sed 's/^# gwa-name = //' || true
}

gwa_peer_exists() {
    gwa_peer_names | grep -qxF "${1:-}" 2>/dev/null
}

# Lowest free host address in the subnet, starting at .2 (.1 is the server).
#
# Parsed with awk rather than a regex built from $GWA_NET_PREFIX: escaping the
# dots would need `${v//./\.}`, which does NOT escape in bash — it returns the
# string unchanged, leaving every dot as a regex wildcard.
gwa_next_ip() {
    local used i
    used=$(awk -F'[ =/]+' '/^AllowedIPs/ { split($2, o, "."); print o[4] }' \
           "$GWA_WG_CONF" 2>/dev/null || true)
    for (( i = 2; i <= 254; i++ )); do
        grep -qx "$i" <<< "$used" || { echo "${GWA_NET_PREFIX}.$i"; return 0; }
    done
    return 1
}

gwa_client_conf_path() { echo "$GWA_CLIENT_DIR/${1}.conf"; }

# Apply the on-disk conf to the running interface without dropping live peers.
# `wg syncconf` diffs rather than replacing, so existing handshakes survive —
# a restart would knock the operator's own phone off mid-provisioning.
gwa_sync() {
    gwa_active || return 0
    wg syncconf "$GWA_IFACE" <(wg-quick strip "$GWA_IFACE") 2>/dev/null \
        || { warn "wg syncconf failed — falling back to a restart."; \
             systemctl restart "wg-quick@${GWA_IFACE}" 2>/dev/null || return 1; }
    return 0
}

gwa_peer_add() {
    local name="${1:-}"
    gwa_valid_peer_name "$name" || { error "Invalid device name (letters, digits, . _ - ; max 32)."; return 1; }
    gwa_installed || { error "WireGuard is not set up yet."; return 1; }
    gwa_peer_exists "$name" && { error "A device named '$name' already exists."; return 1; }

    local endpoint; endpoint=$(gwa_endpoint)
    [[ -z "$endpoint" ]] && { error "Server endpoint unknown — re-run setup."; return 1; }

    local ip; ip=$(gwa_next_ip) || { error "No free addresses left in $GWA_SUBNET."; return 1; }

    local cpriv cpub psk spub
    cpriv=$(wg genkey)
    cpub=$(wg pubkey <<< "$cpriv")
    # Pre-shared key: a symmetric layer on top of the normal handshake. Cheap,
    # and it is what keeps a recorded session from being decryptable later if
    # the asymmetric primitives are ever broken.
    psk=$(wg genpsk)
    spub=$(gwa_server_pubkey)

    # Append the peer to the server config.
    umask 077
    cat >> "$GWA_WG_CONF" <<PEER

[Peer]
# gwa-name = ${name}
# gwa-added = $(date -u '+%Y-%m-%dT%H:%M:%SZ')
PublicKey    = ${cpub}
PresharedKey = ${psk}
AllowedIPs   = ${ip}/32
PEER

    # Write the client config.
    #
    # AllowedIPs is the WG subnet ONLY — a split tunnel. The device keeps its
    # normal internet path and only wallet traffic enters the tunnel. It also
    # means the endpoint IP can never fall inside AllowedIPs, which would route
    # the tunnel through itself and kill the link the moment it came up.
    local cconf; cconf=$(gwa_client_conf_path "$name")
    cat > "$cconf" <<CLIENT
# WireGuard client config — device "${name}"
# Generated $(date -u '+%Y-%m-%d %H:%M:%S UTC') by grin_wg_access.sh
#
# Split tunnel: only ${GWA_SUBNET} goes through the VPN.

[Interface]
PrivateKey = ${cpriv}
Address    = ${ip}/32

[Peer]
PublicKey    = ${spub}
PresharedKey = ${psk}
Endpoint     = ${endpoint}:${GWA_PORT}
AllowedIPs   = ${GWA_SUBNET}
# Mobile carriers and home routers drop idle UDP mappings within a minute or
# two. Without a keepalive the tunnel looks "connected" but the first request
# after a pause hangs until the client happens to re-handshake.
PersistentKeepalive = 25
CLIENT
    chmod 600 "$cconf"
    umask 022

    gwa_sync || true
    success "Device '$name' added — ${ip}"
    return 0
}

# Stream $GWA_WG_CONF with the named [Peer] block removed.
_gwa_strip_peer_stream() {
    local name="$1"
    local in_peer=0 buf="" drop=0 line trimmed
    while IFS= read -r line || [[ -n "$line" ]]; do
        trimmed="${line//[$'\t\r ']/}"
        if [[ "$trimmed" == "[Peer]" ]]; then
            if (( in_peer )) && (( ! drop )); then printf '%s' "$buf"; fi
            in_peer=1; buf="$line"$'\n'; drop=0; continue
        fi
        if (( in_peer )); then
            buf+="$line"$'\n'
            [[ "$line" == "# gwa-name = $name" ]] && drop=1
        else
            printf '%s\n' "$line"
        fi
    done
    if (( in_peer )) && (( ! drop )); then printf '%s' "$buf"; fi
}

gwa_peer_remove() {
    local name="${1:-}"
    gwa_peer_exists "$name" || { error "No device named '$name'."; return 1; }

    # Pull the public key out before rewriting, so the live interface can be
    # updated too — a peer removed only from the file keeps working until reboot.
    local pub
    pub=$(awk -v n="# gwa-name = $name" '
        $0 == n { found = 1 }
        found && /^PublicKey/ { print $3; exit }
    ' "$GWA_WG_CONF" 2>/dev/null || true)

    local tmp; tmp=$(mktemp)
    _gwa_strip_peer_stream "$name" < "$GWA_WG_CONF" > "$tmp"
    cat "$tmp" > "$GWA_WG_CONF"     # preserve the original mode/owner
    rm -f "$tmp"
    chmod 600 "$GWA_WG_CONF"

    [[ -n "$pub" ]] && gwa_active && wg set "$GWA_IFACE" peer "$pub" remove 2>/dev/null || true

    local cconf; cconf=$(gwa_client_conf_path "$name")
    [[ -f "$cconf" ]] && shred -u "$cconf" 2>/dev/null || rm -f "$cconf" 2>/dev/null || true

    success "Device '$name' revoked."
    return 0
}

gwa_peer_qr() {
    local name="${1:-}" cconf
    cconf=$(gwa_client_conf_path "$name")
    if [[ ! -f "$cconf" ]]; then
        error "No stored config for '$name'."
        warn  "The QR can only be produced from the client PRIVATE key, which is"
        warn  "not recoverable once deleted. Revoke and re-add the device instead."
        return 1
    fi
    command -v qrencode &>/dev/null || { error "qrencode not installed."; return 1; }
    echo ""
    qrencode -t ansiutf8 < "$cconf"
    echo ""
    return 0
}

# Storing the client private key server-side is what makes QR provisioning
# possible, but it is also a copy of the device's identity sitting on the box.
# Offer to drop it once the QR has been scanned.
gwa_peer_forget_conf() {
    local name="${1:-}" cconf
    cconf=$(gwa_client_conf_path "$name")
    [[ -f "$cconf" ]] || return 0
    shred -u "$cconf" 2>/dev/null || rm -f "$cconf"
    success "Stored config for '$name' deleted (the device keeps working)."
}

# Last handshake per peer, as "name  ip  age".
gwa_peer_list() {
    gwa_installed || { echo ""; return 0; }
    local name pub ip hs now age
    now=$(date +%s)
    while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        pub=$(awk -v n="# gwa-name = $name" '
            $0 == n { f = 1 } f && /^PublicKey/ { print $3; exit }' "$GWA_WG_CONF" 2>/dev/null || true)
        ip=$(awk -v n="# gwa-name = $name" '
            $0 == n { f = 1 } f && /^AllowedIPs/ { print $3; exit }' "$GWA_WG_CONF" 2>/dev/null || true)
        hs=""
        if gwa_active && [[ -n "$pub" ]]; then
            hs=$(wg show "$GWA_IFACE" latest-handshakes 2>/dev/null | awk -v p="$pub" '$1 == p { print $2 }' || true)
        fi
        if [[ -z "$hs" || "$hs" == "0" ]]; then
            age="never"
        else
            local d=$(( now - hs ))
            if   (( d < 120 ));  then age="${d}s ago"
            elif (( d < 7200 )); then age="$(( d / 60 ))m ago"
            else                      age="$(( d / 3600 ))h ago"
            fi
        fi
        printf '%s\t%s\t%s\n' "$name" "${ip%%/*}" "$age"
    done < <(gwa_peer_names)
}

# Has ANY device ever completed a handshake? This is the gate that stands
# between the operator and locking themselves out of their own wallet: never
# move a listener onto the tunnel until the tunnel is proven to carry traffic.
gwa_handshake_seen() {
    gwa_active || return 1
    local hs
    hs=$(wg show "$GWA_IFACE" latest-handshakes 2>/dev/null | awk '$2 != 0 { print $2 }' | head -1 || true)
    [[ -n "$hs" ]]
}

# =============================================================================
# HOST PLUMBING
# =============================================================================

gwa_firewall_open() {
    if command -v ufw &>/dev/null; then
        if ufw allow "${GWA_PORT}/udp" >/dev/null 2>&1; then
            success "UFW: udp/${GWA_PORT} opened."
        else
            warn "ufw could not add the rule — open udp/${GWA_PORT} manually."
        fi
    elif command -v iptables &>/dev/null; then
        iptables -C INPUT -p udp --dport "$GWA_PORT" -j ACCEPT 2>/dev/null \
            || iptables -I INPUT -p udp --dport "$GWA_PORT" -j ACCEPT
        success "iptables: udp/${GWA_PORT} opened."
        warn "iptables rules are not persistent — use iptables-persistent to save them."
    else
        warn "No ufw/iptables found. Open udp/${GWA_PORT} manually."
    fi
    return 0
}

# Two independent guards against the same failure: nginx cannot bind
# 10.9.0.1:443 while wg0 is down, and an nginx that cannot bind does not start
# AT ALL — every other vhost on the box goes down with it.
#
#   1. ip_nonlocal_bind lets nginx bind an address that does not exist yet.
#      This is the one that matters, because it also survives wg0 being taken
#      down at RUNTIME, long after boot ordering stopped being relevant.
#   2. The ordering drop-in just makes the normal boot path tidy.
#
# Honest cost: ip_nonlocal_bind is SYSTEM-WIDE, not per-service. Every local
# process may then bind any IPv4 address, including ones this host does not own.
# On a single-tenant VPS where only root runs listeners that is close to free;
# on a shared or multi-user box it is a real (if small) loosening, and the
# alternative is to accept that nginx dies with the tunnel.
gwa_enable_nonlocal_bind() {
    mkdir -p "$(dirname "$GWA_SYSCTL")"
    cat > "$GWA_SYSCTL" <<SYSCTL
# Written by grin_wg_access.sh
#
# nginx binds ${GWA_SERVER_IP}:443 (the WireGuard address). Without this, a boot
# where wg0 comes up after nginx — or any later 'wg-quick down' — makes nginx
# fail to start and takes EVERY vhost on this host offline, not just the wallet.
net.ipv4.ip_nonlocal_bind = 1
SYSCTL
    sysctl -q -w net.ipv4.ip_nonlocal_bind=1 2>/dev/null || true

    mkdir -p "$GWA_NGINX_DROPIN_DIR"
    cat > "$GWA_NGINX_DROPIN" <<DROPIN
# Written by grin_wg_access.sh — start the tunnel before nginx binds to it.
# Wants= (not Requires=) on purpose: a broken tunnel must not stop nginx from
# serving every other site.
[Unit]
After=wg-quick@${GWA_IFACE}.service
Wants=wg-quick@${GWA_IFACE}.service
DROPIN
    systemctl daemon-reload 2>/dev/null || true
    success "Non-local bind enabled; nginx ordered after wg-quick@${GWA_IFACE}."
}

# =============================================================================
# DNS-01 CERTIFICATES
# =============================================================================
#
# Provider metadata. Each certbot DNS plugin ships its own package, its own
# credentials key and its own CLI flag prefix, so there is no generic path.

gwa_dns01_providers() { echo "cloudflare digitalocean"; }

_gwa_dns01_pkg()      { case "$1" in cloudflare) echo "python3-certbot-dns-cloudflare";;   digitalocean) echo "python3-certbot-dns-digitalocean";;   esac; }
_gwa_dns01_snap()     { case "$1" in cloudflare) echo "certbot-dns-cloudflare";;           digitalocean) echo "certbot-dns-digitalocean";;           esac; }
_gwa_dns01_credkey()  { case "$1" in cloudflare) echo "dns_cloudflare_api_token";;         digitalocean) echo "dns_digitalocean_token";;             esac; }
gwa_dns01_credfile()  { echo "/etc/letsencrypt/dns-${1}.ini"; }

gwa_dns01_token_help() {
    case "$1" in
        cloudflare)
            echo "  Cloudflare dashboard → My Profile → API Tokens → Create Token"
            echo "  Use the \"Edit zone DNS\" template, scoped to THIS ZONE only."
            echo "  Permissions needed: Zone → DNS → Edit.  Nothing else."
            ;;
        digitalocean)
            echo "  DigitalOcean → API → Tokens → Generate New Token (read + write)."
            echo "  DigitalOcean tokens are account-wide — they cannot be scoped to"
            echo "  one domain, so treat this one as more sensitive than a CF token."
            ;;
    esac
}

# Install the plugin. certbot's own installer is a snap, in which case the
# plugin must be a snap too — an apt plugin is invisible to a snap certbot.
gwa_dns01_install_plugin() {
    local provider="$1"
    local pkg snap_name
    pkg=$(_gwa_dns01_pkg "$provider")
    snap_name=$(_gwa_dns01_snap "$provider")

    if certbot plugins 2>/dev/null | grep -q "dns-${provider}"; then
        success "certbot dns-${provider} plugin already available."
        return 0
    fi

    if command -v snap &>/dev/null && snap list certbot >/dev/null 2>&1; then
        info "certbot is a snap — installing the plugin as a snap too."
        snap set certbot trust-plugin-with-root=ok >/dev/null 2>&1 || true
        snap install "$snap_name" >/dev/null 2>&1 \
            || { error "snap install $snap_name failed."; return 1; }
    elif command -v apt-get &>/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" \
            || { error "apt install $pkg failed."; return 1; }
    elif command -v dnf &>/dev/null; then
        dnf install -y "$pkg" >/dev/null 2>&1 \
            || { error "dnf install $pkg failed (EPEL may be required)."; return 1; }
    else
        error "No snap/apt-get/dnf — install $pkg manually."
        return 1
    fi

    certbot plugins 2>/dev/null | grep -q "dns-${provider}" \
        || { error "Plugin installed but certbot still does not list dns-${provider}."; return 1; }
    success "certbot dns-${provider} plugin installed."
    return 0
}

gwa_dns01_write_credentials() {
    local provider="$1" token="$2" file key
    file=$(gwa_dns01_credfile "$provider")
    key=$(_gwa_dns01_credkey "$provider")
    mkdir -p /etc/letsencrypt
    ( umask 077; printf '%s = %s\n' "$key" "$token" > "$file" )
    chmod 600 "$file"
    success "Credentials written → $file (mode 600)"
}

# Issue (or renew) via DNS-01.
#
# certonly, never --nginx: the installer would rewrite the vhost and undo the
# private bind address. The vhost is written by the calling script.
#
# --deploy-hook is stored in the renewal config, so every future unattended
# renewal reloads nginx too. Without it the cert renews and nginx keeps serving
# the old one until something else happens to reload it.
#
# --force-renewal is REQUIRED when a lineage already exists, and this is the
# whole point of the call: the normal path here is an operator who already has a
# working HTTP-01 certificate from step 5 and now wants the SAME name renewed by
# DNS-01 instead. certbot treats that as "identical certificate request" and,
# because the cert is nowhere near expiry, tries to ask whether to keep or
# replace it — a question --non-interactive cannot answer, so certbot aborts.
# The authenticator in the renewal conf is only rewritten by a successful
# issuance, so without this the switch gate (which reads that conf) would refuse
# forever and every error certbot printed would point at the wrong cause.
gwa_dns01_issue() {
    local provider="$1" domain="$2" email="$3" propagation="${4:-30}"
    local credfile; credfile=$(gwa_dns01_credfile "$provider")

    [[ -f "$credfile" ]] || { error "Credentials file $credfile missing."; return 1; }

    local -a force=()
    if [[ -f "/etc/letsencrypt/renewal/${domain}.conf" ]]; then
        # The renewal conf is named after the lineage, so its existence also
        # tells us the lineage name to pin — without --cert-name certbot could
        # start a parallel "<domain>-0001" lineage that nothing else looks at.
        force=( --cert-name "$domain" --force-renewal )
        info "An existing certificate for $domain will be re-issued via DNS-01."
        warn "Forced re-issues count against Let's Encrypt's duplicate-certificate"
        warn "limit (5 per name per week). Fine once; don't loop on it."
    fi

    info "Requesting certificate for $domain via DNS-01 (${provider}) ..."
    info "Waiting ${propagation}s for DNS propagation on each challenge."

    if certbot certonly \
        "--dns-${provider}" \
        "--dns-${provider}-credentials" "$credfile" \
        "--dns-${provider}-propagation-seconds" "$propagation" \
        -d "$domain" \
        "${force[@]}" \
        --non-interactive --agree-tos -m "$email" \
        --deploy-hook "systemctl reload nginx"
    then
        if gwa_dns01_renewal_uses_dns "$domain"; then
            success "Certificate issued for $domain — renewal is now DNS-01."
            return 0
        fi
        # certbot exited 0 without rewriting the authenticator. That means it
        # kept the existing certificate rather than issuing one, so renewal
        # still depends on port 80 even though this looked like it worked.
        error "certbot reported success but $domain still renews via HTTP-01."
        warn "The certificate was kept, not re-issued. Check:"
        warn "  grep authenticator /etc/letsencrypt/renewal/${domain}.conf"
        return 1
    fi

    error "certbot failed."
    warn "Most common causes, in order:"
    warn "  1. Token lacks DNS edit permission on this zone."
    warn "  2. The zone is not actually hosted at ${provider}."
    warn "  3. Propagation too slow — retry with a higher wait (60-120s)."
    warn "Full log: /var/log/letsencrypt/letsencrypt.log"
    return 1
}

gwa_dns01_cert_expiry() {
    local domain="$1" pem="/etc/letsencrypt/live/${1}/fullchain.pem"
    [[ -f "$pem" ]] || { echo ""; return 0; }
    openssl x509 -enddate -noout -in "$pem" 2>/dev/null | sed 's/notAfter=//' || echo ""
}

gwa_dns01_renewal_uses_dns() {
    local domain="$1" conf="/etc/letsencrypt/renewal/${1}.conf"
    [[ -f "$conf" ]] && grep -q 'authenticator *= *dns-' "$conf" 2>/dev/null
}

# =============================================================================
# DIAGNOSTICS
# =============================================================================

# What a public resolver returns for the wallet name. Expected to be the WG IP.
gwa_resolve() {
    local host="$1" out=""
    if command -v getent &>/dev/null; then
        out=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    fi
    if [[ -z "$out" ]] && command -v dig &>/dev/null; then
        out=$(dig +short A "$host" 2>/dev/null | tr '\n' ' ' || true)
    fi
    echo "${out% }"
}

gwa_status_lines() {
    if ! gwa_installed; then
        echo "not configured"
        return 0
    fi

    local state peers hs
    if gwa_active; then state="up"; else state="DOWN"; fi
    peers=$(gwa_peer_names | grep -c . || true)
    if gwa_handshake_seen; then hs="handshake seen"; else hs="no handshake yet"; fi
    echo "${state}, ${peers} device(s), ${hs}"
}
