# 07_solo_stats_page.sh — public stats page of the solo mining script (menu 3): nginx vhost, access lock, payout split, page deploy.
# Sourced by 07_grin_mining_solo.sh; shares its globals and log/info/warn/error.
# Moved as-is; callers reach these via `fn || …`, so errexit is off and file operations are not individually guarded.

# ═══════════════════════════════════════════════════════════════════════════════
# STATS WEB PAGE  (network-select ▸ 3)
# ═══════════════════════════════════════════════════════════════════════════════
# Deploys ONE static HTML page via nginx that polls BOTH nodes' Owner API every
# 10s and shows mainnet + testnet side by side. nginx injects the Basic Auth
# header per network so the secret never reaches the browser.

# Emit one nginx proxy location for a network's /api/status/<net> endpoint.
#   $1 = net key (main|test)   $2 = node API port   $3 = base64 of "grin:<secret>"
# Exact-match location: a request to a network we did NOT deploy falls through to
# `location /` and 404s, which the page reads as "not deployed" and greys out.
_solo_stats_proxy_location() {
    cat << EOF
    # Proxy → $1 node Owner API (auth injected here, never exposed to the browser)
    location = /api/status/$1 {
        limit_req zone=solo_stats_api burst=40 nodelay;
        proxy_pass         http://127.0.0.1:$2/v2/owner;
        proxy_method       POST;
        proxy_set_header   Content-Type "application/json";
        proxy_set_header   Authorization "Basic $3";
        proxy_set_body     '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}';
        proxy_read_timeout 10s;
    }
EOF
}

# Resolve the node's log file path so the block collector knows what to parse.
# Reads log_file_path from grin-server.toml (resolving a relative path against the
# node dir); falls back to <node_dir>/grin-server.log.
#   $1 = network (mainnet|testnet)  →  echoes an absolute log file path
_solo_node_log_path() {
    local net="$1" node_dir toml log=""
    node_dir=$(_solo_node_dir "$net")
    toml="$node_dir/grin-server.toml"
    if [[ -f "$toml" ]]; then
        log=$(grep -E '^[[:space:]]*log_file_path[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    log="${log:-grin-server.log}"
    [[ "$log" != /* ]] && log="$node_dir/$log"   # resolve relative paths
    echo "$log"
}

# Echo the stratum port a network's node binds (from stratum_server_addr in
# grin-server.toml), falling back to the toolkit default. Used by the setup page.
#   $1 = network (mainnet|testnet)  →  echoes a port number
_solo_stratum_port() {
    local net="$1" toml def addr port=""
    toml="$(_solo_node_dir "$net")/grin-server.toml"
    def=$STRATUM_PORT_MAINNET; [[ "$net" == "testnet" ]] && def=$STRATUM_PORT_TESTNET
    if [[ -f "$toml" ]]; then
        addr=$(grep -E '^[[:space:]]*stratum_server_addr[[:space:]]*=' "$toml" 2>/dev/null \
               | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
        port="${addr##*:}"
    fi
    [[ "$port" =~ ^[0-9]+$ ]] && echo "$port" || echo "$def"
}

# Echo the node's file_log_level (uppercased) so the deploy can warn when shares
# (logged at INFO) won't be captured. Empty if not found.
#   $1 = network (mainnet|testnet)
_solo_node_file_log_level() {
    local net="$1" toml lvl=""
    toml="$(_solo_node_dir "$net")/grin-server.toml"
    if [[ -f "$toml" ]]; then
        lvl=$(grep -E '^[[:space:]]*file_log_level[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    echo "${lvl^^}"
}

# Resolve the wallet Foreign API URL the node is configured to mine to, so the
# stats page can show whether that listener is up. Reads wallet_listener_url from
# the network's grin-server.toml; falls back to the toolkit default foreign port.
#   $1 = network (mainnet|testnet)  →  echoes a full http URL ending in /v2/foreign
_solo_wallet_listener_url() {
    # Fallback port is the combined listener's Owner port (owner_api_include_foreign
    # serves the Foreign API here) — matches the wallet on 3420/13420, not the old
    # 3415/13415 Foreign listener. The direct probe still needs the /v2/foreign path.
    local net="$1" default_port=3420 toml url=""
    [[ "$net" == "testnet" ]] && default_port=13420
    toml="$(_solo_node_dir "$net")/grin-server.toml"
    if [[ -f "$toml" ]]; then
        url=$(grep -E '^[[:space:]]*wallet_listener_url[[:space:]]*=' "$toml" 2>/dev/null \
              | head -1 | sed 's/.*=[[:space:]]*//' | tr -d '"' | xargs || true)
    fi
    # Normalise to the Foreign API endpoint. grin's native grin-server.toml stores
    # this as a BASE url (e.g. http://127.0.0.1:3415) with no path; an nginx
    # proxy_pass to a pathless url forwards the original request URI
    # (/api/wallet/<net>), which the wallet 404s → page shows "n/a". The Foreign
    # API the probe needs always lives at /v2/foreign, so append it when absent.
    url="${url:-http://127.0.0.1:${default_port}}"
    url="${url%/}"                                          # drop any trailing slash
    [[ "$url" != */v2/foreign ]] && url="$url/v2/foreign"
    echo "$url"
}

# Emit one nginx proxy location for a network's /api/wallet/<net> liveness probe.
#   $1 = net key (main|test)   $2 = wallet Foreign API URL
# No secret is injected: a 200 or 401 both prove the listener is up; only a
# connection error / 5xx (which nginx maps to 502) means it is down.
_solo_stats_wallet_location() {
    cat << EOF
    # Liveness probe → $1 wallet Foreign API (the listener the node builds coinbase from)
    location = /api/wallet/$1 {
        limit_req zone=solo_stats_api burst=40 nodelay;
        proxy_pass            $2;
        proxy_method          POST;
        proxy_set_header      Content-Type "application/json";
        proxy_set_body        '{"jsonrpc":"2.0","method":"check_version","params":[],"id":1}';
        proxy_connect_timeout 3s;
        proxy_read_timeout    5s;
        proxy_intercept_errors off;
    }
EOF
}

# Toggle the mainnet payout-split calculation (on/off — no names to pre-define).
# When ON, the collector splits matured coinbase across miners grouped BY NICKNAME
# — the text before the first dot in nickname.NN, so all of one miner's rigs
# (alpha.01, alpha.02, …) settle as one payee. Writes $PAYMENT_CONFIG as
# {"enabled":true}. Display-only: solo mining always pays ONE coinbase wallet;
# this just shows who earned what for manual settling, and never stores a Grin
# address. Called from the Stats web page deploy (network-select ▸ 3, mainnet
# detected).
_solo_prompt_payout_split() {
    # Enabled = file present AND not explicitly disabled (mirrors payout_split_enabled).
    local enabled=0
    if [[ -f "$PAYMENT_CONFIG" ]] && python3 -c 'import json,sys
try: c=json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
ok = isinstance(c,dict) and c.get("enabled") is not False
sys.exit(0 if ok else 1)' "$PAYMENT_CONFIG" 2>/dev/null; then
        enabled=1
    fi

    echo ""
    echo -e "${BOLD}Payout-split payment calculation (mainnet)${RESET}"
    echo -e "  ${DIM}Display-only split of matured coinbase across miners by work done,${RESET}"
    echo -e "  ${DIM}grouped automatically by nickname — the part of the worker name${RESET}"
    echo -e "  ${DIM}before the first dot (alpha.01, alpha.02 → alpha), nothing to${RESET}"
    echo -e "  ${DIM}pre-define. Solo mining always pays ONE coinbase wallet; this just${RESET}"
    echo -e "  ${DIM}shows who earned what so you can settle up manually, and stores no${RESET}"
    echo -e "  ${DIM}Grin addresses.${RESET}"

    local ans
    if [[ $enabled -eq 1 ]]; then
        echo -e "  Status: ${GREEN}currently ON${RESET}"
        echo -ne "  Keep payout split enabled? [Y/n]: "
        read -r ans
        if [[ "${ans,,}" == "n" ]]; then
            rm -f "$PAYMENT_CONFIG"
            success "Payout split disabled (config removed)."
        else
            info "Payout split stays enabled."
        fi
        return
    fi

    echo ""
    echo -e "  ${BOLD}${CYAN}┏━ WHEN IS THIS USEFUL? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  Turn this ON if you ${BOLD}share this solo private pool with trusted${RESET}"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  ${BOLD}friends${RESET}. The page tracks how much work each worker did,"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  so you can reconcile and ${BOLD}pay them out weekly${RESET} (or on any"
    echo -e "  ${BOLD}${CYAN}┃${RESET}  cadence you like) by hand. If you mine alone, leave it OFF."
    echo -e "  ${BOLD}${CYAN}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"
    echo ""
    echo -ne "  Enable payout-split calculation? [Y/n]: "
    read -r ans
    [[ "${ans,,}" == "n" ]] && { info "Payout split not enabled."; return; }

    mkdir -p "$(dirname "$PAYMENT_CONFIG")"
    printf '{"enabled":true}\n' > "$PAYMENT_CONFIG"
    chmod 644 "$PAYMENT_CONFIG"
    success "Payout split enabled → $PAYMENT_CONFIG"
    echo -e "  ${DIM}The page shows a per-nickname running balance (owed = matured-block${RESET}"
    echo -e "  ${DIM}earnings − payments). Record payouts in menu 7 so 'Owed' drops.${RESET}"
}

# Prompt for the optional index & setup pages access lock (HTTP Basic Auth over
# HTTPS). Writes an apr1 htpasswd (no apache2-utils needed — nginx reads apr1 natively) and echoes,
# via the named globals below, the nginx snippets the vhost writer injects:
#   _ACCESS_AUTH_BLOCK       server-level auth_basic + auth_basic_user_file (or "")
#   _ACCESS_PUBLIC_CARVEOUTS poolstats_*.json `auth_basic off` carve-outs (or "")
# Basic Auth is safe here because the Stats web page deploy always runs certbot + HTTP→HTTPS redirect, so
# credentials never travel over plain HTTP (the :80 block 301s before the prompt).
_ACCESS_AUTH_BLOCK=""

_ACCESS_PUBLIC_CARVEOUTS=""

_solo_prompt_access_lock() {
    _ACCESS_AUTH_BLOCK=""
    _ACCESS_PUBLIC_CARVEOUTS=""

    echo ""
    echo -e "${BOLD}Index & setup pages access lock (recommended for solo)${RESET}"
    echo -e "  ${DIM}Username/password gate (HTTP Basic Auth, served over HTTPS). With it ON, the${RESET}"
    echo -e "  ${DIM}index + setup pages go fully private: every visitor — search engines included${RESET}"
    echo -e "  ${DIM}— gets a 401 before any content, so the domain can't be crawled or indexed at${RESET}"
    echo -e "  ${DIM}all. A solo page shows your income (found blocks, hashrate, nicknames, owed),${RESET}"
    echo -e "  ${DIM}so locking it is the sensible default; the public miningpoolstats feed${RESET}"
    echo -e "  ${DIM}(poolstats_*.json) stays reachable. Without the lock, the pages are public${RESET}"
    echo -e "  ${DIM}(only a 'noindex' hint, which rogue bots ignore).${RESET}"

    local action="new"
    if [[ -f "$STATS_HTPASSWD" ]]; then
        echo -e "  Status: ${GREEN}currently protected${RESET}"
        echo -ne "  [K]eep / [C]hange / [R]emove? [K]: "
        read -r achoice
        case "${achoice,,}" in
            r) rm -f "$STATS_HTPASSWD"; success "Access lock removed (page is public again)."; return ;;
            c) action="change" ;;
            *) info "Keeping existing credentials."; action="keep" ;;
        esac
    else
        echo -ne "  Protect the index & setup pages with a username/password? [Y/n]: "
        read -r alk
        [[ "${alk,,}" == "n" ]] && { info "Access lock not enabled (pages stay public)."; return; }
    fi

    if [[ "$action" != "keep" ]]; then
        local auser apass apass2
        echo -ne "  Username: "
        read -r auser
        [[ -z "$auser" ]] && { warn "No username — access lock not enabled."; return; }
        echo -ne "  Password: ";        read -rs apass;  echo
        echo -ne "  Confirm password: "; read -rs apass2; echo
        if [[ -z "$apass" || "$apass" != "$apass2" ]]; then
            warn "Passwords empty or did not match — access lock not enabled."
            return
        fi
        local ahash
        ahash=$(openssl passwd -apr1 "$apass") || { error "openssl passwd failed."; return; }
        ( umask 077; printf '%s:%s\n' "$auser" "$ahash" > "$STATS_HTPASSWD" )
        # nginx worker must read it; keep it non-world-readable.
        local nuser
        nuser=$(ps -eo user=,comm= 2>/dev/null | awk '$2 ~ /nginx/ && $1 != "root" {print $1; exit}')
        [[ -z "$nuser" ]] && { id www-data >/dev/null 2>&1 && nuser=www-data || nuser=nginx; }
        chmod 640 "$STATS_HTPASSWD"
        chown "root:$nuser" "$STATS_HTPASSWD" 2>/dev/null || true
        success "Credentials written → $STATS_HTPASSWD"
    fi

    # Server-level auth (every location inherits unless it opts out below).
    _ACCESS_AUTH_BLOCK=$'\n    auth_basic           "Grin Solo Mining";\n    auth_basic_user_file '"$STATS_HTPASSWD"$';'

    # health.json is ALWAYS public (auth_basic off), independent of the poolstats
    # choice below. ONE file carries both networks: per-net booleans + counts only
    # (node/wallet/stratum up? + miners connected + blocks found 24h — no height/
    # difficulty/balance/hashrate), so an external uptime monitor can verify the
    # rig without the page password. An exact-match location beats the /data regex,
    # so it wins by location-priority.
    _ACCESS_PUBLIC_CARVEOUTS=$'    location = /data/health.json { auth_basic off; }\n'

    # poolstats_<net>.json is the machine-readable feed miningpoolstats.stream polls.
    # Default OFF: a freshly locked solo page keeps everything but health locked. Opt
    # in to expose just this one feed (auth_basic off carve-out) to list the pool.
    echo -e "  ${DIM}poolstats_*.json is the feed https://miningpoolstats.stream/grin polls to list a pool.${RESET}"
    echo -ne "  Publish it publicly so you can list this pool there (everything else stays locked)? [y/N]: "
    read -r pubmps
    if [[ "${pubmps,,}" == "y" ]]; then
        _ACCESS_PUBLIC_CARVEOUTS+=$'    location = /data/poolstats_main.json { auth_basic off; }\n    location = /data/poolstats_test.json { auth_basic off; }\n'
        info "poolstats feed published (public); everything but health + poolstats (incl. split_main.json) stays locked."
    else
        info "poolstats feed locked (no public miningpoolstats listing); only the sanitized health endpoint stays public."
    fi
    _ACCESS_PUBLIC_CARVEOUTS+=$'\n'   # blank line before the /data regex location
}

solo_deploy_stats_page() {
    # LAN mode (SOLO_NET_MODE=lan) serves the SAME page over plain HTTP on a chosen
    # LAN IP:port — no domain, no certbot, no Basic Auth. Only the bind + publish
    # tail differs; the page build (HTML/config/collector/proxy blocks) is shared.
    local lan_mode=0
    [[ "${SOLO_NET_MODE:-public}" == "lan" ]] && lan_mode=1

    clear
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Deploy Mining Stats Page${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  Deploys ${BOLD}one unified stats page${RESET} showing mainnet + testnet side by side."
    echo -e "  nginx proxies /api/status/<net> → each node's Owner API with Basic Auth."
    echo -e "  Auto-detects which nodes exist; missing networks grey out on the page."
    echo -e "  No Node.js, no database, no systemd service needed."
    if [[ $lan_mode -eq 1 ]]; then
        echo ""
        echo -e "  ${BOLD}LAN mode:${RESET} served over ${BOLD}plain HTTP on this server's LAN address${RESET} —"
        echo -e "  ${DIM}no domain, no SSL, no certbot, no Basic Auth. For a trusted internal network.${RESET}"
    fi
    echo ""

    if [[ ! -f "$STATS_WEB_SRC" ]]; then
        error "Stats page not found: $STATS_WEB_SRC"
        return 1
    fi

    # ── Auto-detect available networks ──────────────────────────────────────────
    # ONE unified page/vhost serves both networks. We add a proxy location only for
    # each node whose .api_secret exists; the page greys out any missing network.
    local conf_name="$STATS_BASENAME"
    local web_dir="/var/www/$conf_name"
    local nginx_conf="/etc/nginx/sites-available/$conf_name"
    # Resolved per network — an archive mainnet node lives in mainnet-full, and
    # assuming "-prune" here aborts the deploy outright with "No node
    # .api_secret found for either network" on a perfectly healthy box.
    local mn_secret_path tn_secret_path
    mn_secret_path=$(_solo_node_secret mainnet owner)
    tn_secret_path=$(_solo_node_secret testnet owner)

    local have_main=0 have_test=0
    [[ -f "$mn_secret_path" ]] && have_main=1
    [[ -f "$tn_secret_path" ]] && have_test=1

    if [[ $have_main -eq 0 && $have_test -eq 0 ]]; then
        error "No node .api_secret found for either network."
        echo -e "  Looked for: $mn_secret_path"
        echo -e "              $tn_secret_path"
        echo -e "  ${DIM}Build a node first (Script 01), then re-run S.${RESET}"
        return 1
    fi

    local detected=""
    [[ $have_main -eq 1 ]] && detected+=" Mainnet"
    [[ $have_test -eq 1 ]] && detected+=" Testnet"
    info "Detected node secret(s) for:${detected}  ·  vhost: $conf_name"
    echo ""

    # nginx + certbot must exist before we write the htpasswd, the vhost, or run
    # `nginx -t`. On a bare node /etc/nginx does not exist yet, which is why the
    # htpasswd write failed ("No such file or directory") and nginx_enable_site
    # reported "nginx: command not found". Install up front so both succeed.
    if ! command -v nginx >/dev/null 2>&1; then
        info "nginx not installed — installing nginx + certbot first..."
    fi
    nginx_install_with_certbot || { error "Could not install nginx/certbot — aborting deploy."; return 1; }

    # $subdomain doubles as the page "host" + nginx server_name. In public mode it
    # is an FQDN; in LAN mode it is the chosen private IP. $lan_ip/$lan_port are only
    # set (and only referenced later) in LAN mode.
    local subdomain lan_ip lan_port lan_port_in c lan_url=""
    if [[ $lan_mode -eq 1 ]]; then
        # ── LAN mode: bind to a private IP:port — no domain, DNS, or certbot ─────
        local lan_default; lan_default=$(_detect_lan_ipv4)
        echo -e "Serve the stats page on this server's ${BOLD}LAN address${RESET}."
        echo -e "  ${DIM}Browsers/miners on the same network reach it at http://<ip>:<port>/.${RESET}"
        echo ""
        while true; do
            if [[ -n "$lan_default" ]]; then
                echo -ne "LAN IP to serve on [${lan_default}] (Enter=accept · type to override · 0=return): "
            else
                echo -ne "LAN IP to serve on (type the private IP · 0=return): "
            fi
            read -r lan_ip
            [[ "$lan_ip" == "0" ]] && { info "Cancelled — returning."; return 1; }
            [[ -z "$lan_ip" ]] && lan_ip="$lan_default"
            if [[ ! "$lan_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
                error "Not a valid IPv4 — try again."; continue
            fi
            if ! _is_private_ipv4 "$lan_ip"; then
                echo -ne "  ${YELLOW}$lan_ip is not a private/LAN address. Bind it anyway? [y/N]: ${RESET}"
                read -r c
                [[ "$c" =~ ^[Yy]$ ]] || continue
            fi
            break
        done
        # Default to 80 so a bare http://<ip> URL just works — nothing for LAN users
        # to remember. (A LAN-only solo box almost never has anything else on :80;
        # the toolkit's other web features are Internet-mode and need a domain.) If
        # :80 on this IP is taken, nginx -t below rejects the vhost and we bail
        # cleanly — pick a free port like 8099 then. Avoid 8080 (public pool API).
        lan_port=80
        echo -ne "HTTP port for the stats page [80] ${DIM}(80 = bare-IP URL, no port to type)${RESET}: "
        read -r lan_port_in
        [[ -n "$lan_port_in" ]] && lan_port="$lan_port_in"
        if [[ ! "$lan_port" =~ ^[0-9]+$ ]] || (( 10#$lan_port < 1 || 10#$lan_port > 65535 )); then
            error "Invalid port: $lan_port"; return 1
        fi
        lan_port=$(( 10#$lan_port ))   # normalise any leading zeros (e.g. 080 → 80)
        subdomain="$lan_ip"
        # Display URL hides the :80 (browsers imply it) so the bare-IP URL reads clean.
        lan_url="http://${lan_ip}"
        [[ "$lan_port" -ne 80 ]] && lan_url="http://${lan_ip}:${lan_port}"
        info "LAN stats page will bind ${BOLD}${lan_ip}:${lan_port}${RESET} (plain HTTP, no SSL)."
    else
        echo ""
        echo -e "${BOLD}${YELLOW}┏━━ CLOUDFLARE / DNS NOTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${RESET}"
        echo -e "${BOLD}${YELLOW}┃${RESET}  If this domain is on Cloudflare, set the A record to"
        echo -e "${BOLD}${YELLOW}┃${RESET}  ${BOLD}\"DNS only\" (grey cloud)${RESET} — ${BOLD}NOT proxied (orange cloud)${RESET}."
        echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}A proxied record blocks miners from reaching the stratum${RESET}"
        echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}port via the domain — they'd have to use the raw server IP${RESET}"
        echo -e "${BOLD}${YELLOW}┃${RESET}  ${DIM}(e.g. iPollo G1 mini: Pool name with real IP instead).${RESET}"
        echo -e "${BOLD}${YELLOW}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${RESET}"
        echo ""

        echo -e "Subdomain for the stats page  ${DIM}(suggestion: solo.yourdomain.com)${RESET}"
        echo -ne "Enter subdomain ${DIM}(0 = return)${RESET}: "
        read -r subdomain
        [[ -z "$subdomain" || "$subdomain" == "0" ]] && { info "Cancelled — returning."; return 1; }

        if ! nginx_validate_domain "$subdomain"; then
            error "Invalid domain name: $subdomain"
            return 1
        fi

        # DNS pre-check — certbot's HTTP-01 challenge needs this name pointing here.
        if ! getent hosts "$subdomain" >/dev/null 2>&1; then
            warn "$subdomain does not currently resolve in DNS."
            echo -e "  ${DIM}certbot will fail unless an A/AAAA record points $subdomain at this server.${RESET}"
            echo -ne "Continue anyway (deploy HTTP now, retry SSL later)? [y/N/0]: "
            read -r dns_go
            [[ "${dns_go,,}" != "y" ]] && { info "Cancelled — set DNS first, then re-run S."; return 1; }
        fi
    fi

    # ── Build per-network proxy blocks for whichever nodes exist ────────────────
    # Each network contributes a node-status proxy (/api/status/<net>) and a wallet
    # liveness proxy (/api/wallet/<net>) so the page can flag a down wallet listener.
    local proxy_blocks=""
    if [[ $have_main -eq 1 ]]; then
        local mn_secret; mn_secret=$(cat "$mn_secret_path")
        local mn_b64;    mn_b64=$(printf 'grin:%s' "$mn_secret" | base64 -w 0)
        local mn_wallet; mn_wallet=$(_solo_wallet_listener_url "mainnet")
        proxy_blocks+=$(_solo_stats_proxy_location "main" "$NODE_API_PORT_MAINNET" "$mn_b64")
        proxy_blocks+=$'\n\n'
        proxy_blocks+=$(_solo_stats_wallet_location "main" "$mn_wallet")
        proxy_blocks+=$'\n\n'
    fi
    if [[ $have_test -eq 1 ]]; then
        local tn_secret; tn_secret=$(cat "$tn_secret_path")
        local tn_b64;    tn_b64=$(printf 'grin:%s' "$tn_secret" | base64 -w 0)
        local tn_wallet; tn_wallet=$(_solo_wallet_listener_url "testnet")
        proxy_blocks+=$(_solo_stats_proxy_location "test" "$NODE_API_PORT_TESTNET" "$tn_b64")
        proxy_blocks+=$'\n\n'
        proxy_blocks+=$(_solo_stats_wallet_location "test" "$tn_wallet")
        proxy_blocks+=$'\n\n'
    fi

    info "Deploying stats page to $web_dir..."
    mkdir -p "$web_dir"
    cp "$STATS_WEB_SRC" "$web_dir/index.html"
    chmod 644 "$web_dir/index.html"
    if [[ -f "$STATS_SETUP_SRC" ]]; then
        cp "$STATS_SETUP_SRC" "$web_dir/setup-solo-mining.html"
        chmod 644 "$web_dir/setup-solo-mining.html"
    else
        warn "Setup page not found ($STATS_SETUP_SRC) — Miner Setup link will 404."
    fi
    if [[ -f "$STATS_SHOT_SRC" ]]; then
        cp "$STATS_SHOT_SRC" "$web_dir/pool-config-example.png"
        chmod 644 "$web_dir/pool-config-example.png"
    fi
    if [[ -f "$STATS_LOGO_SRC" ]]; then
        cp "$STATS_LOGO_SRC" "$web_dir/logo.svg"
        chmod 644 "$web_dir/logo.svg"
    else
        warn "Logo not found ($STATS_LOGO_SRC) — page will show a broken icon."
    fi
    success "index.html + setup page deployed."

    # ── Page config: stratum host/ports (setup page) + optional slogan ──────────
    # Always written to data/config.json so the setup page shows real connection
    # details. Editable any time without re-deploying.
    mkdir -p "$web_dir/data"
    echo -ne "Custom header slogan (Enter to keep default): "
    read -r solo_slogan
    local slogan_json=""
    if [[ -n "$solo_slogan" ]]; then
        local esc_slogan="${solo_slogan//\\/\\\\}"; esc_slogan="${esc_slogan//\"/\\\"}"
        slogan_json="\"slogan\":\"$esc_slogan\","
    fi

    # Pool display name shown in the public poolstats feed (poolstats_<net>.json →
    # "pool":{"name"}). The stats collector reads it from this config.json, so it
    # can be changed any time by editing config.json — no redeploy needed (the next
    # 5-min collector run picks it up). Pre-fill from the existing config so a
    # redeploy keeps the operator's chosen name unless they type a new one.
    local existing_name=""
    if [[ -f "$web_dir/data/config.json" ]]; then
        existing_name=$(grep -oP '"pool_name"\s*:\s*"\K(\\.|[^"\\])*' \
            "$web_dir/data/config.json" 2>/dev/null || true)
    fi
    echo -ne "Pool display name for stats feed [${existing_name:-Grin Solo (Node Toolkit)}]: "
    read -r solo_pool_name
    [[ -z "$solo_pool_name" ]] && solo_pool_name="$existing_name"
    local pool_name_json=""
    if [[ -n "$solo_pool_name" ]]; then
        local esc_name="${solo_pool_name//\\/\\\\}"; esc_name="${esc_name//\"/\\\"}"
        pool_name_json="\"pool_name\":\"$esc_name\","
    fi
    local nets_json=""
    if [[ $have_main -eq 1 ]]; then
        nets_json+="\"main\":{\"stratum_port\":$(_solo_stratum_port mainnet)}"
    fi
    if [[ $have_test -eq 1 ]]; then
        [[ -n "$nets_json" ]] && nets_json+=","
        nets_json+="\"test\":{\"stratum_port\":$(_solo_stratum_port testnet)}"
    fi

    # Public IPv4 → the setup page shows it as the PRIMARY stratum target. Stratum is
    # raw TCP straight to the node (never proxied through nginx), so the IP always
    # reaches it, while the domain only works if its A record points straight at this
    # box — DNS-only; a Cloudflare-proxied (orange-cloud) record breaks raw-TCP
    # stratum. Prefer a freshly detected IP; fall back to one already in config.json
    # so a redeploy on a host where detection fails keeps the operator's value.
    local existing_ip=""
    if [[ -f "$web_dir/data/config.json" ]]; then
        existing_ip=$(grep -oP '"public_ip"\s*:\s*"\K[0-9.]+' \
            "$web_dir/data/config.json" 2>/dev/null || true)
    fi
    local pub_ip
    if [[ $lan_mode -eq 1 ]]; then
        # On a LAN there is no public IP — the stratum target the setup page shows IS
        # the LAN address miners point their rigs at (raw TCP to <lan_ip>:<stratum>).
        pub_ip="$lan_ip"
    else
        pub_ip=$(_confirm_public_ipv4 "$existing_ip")
    fi
    local public_ip_json=""
    [[ -n "$pub_ip" ]] && public_ip_json="\"public_ip\":\"$pub_ip\","

    # Off-box port-check service → the setup page turns each stratum URL into a live
    # "🟢 reachable / 🔴 unreachable" pill. MUST be a host OTHER than this node (e.g. the
    # public Office Tools checker), otherwise probing our own public IP can hairpin
    # through the local stack and report a false "open". The page calls
    # <base>/api/portcheckbatch?host=&ports= — a public CORS-open endpoint, so no
    # per-domain setup is needed on the checker. Defaults to the canonical public
    # Office Tools instance so the pills work out of the box; the operator can paste
    # a self-hosted Office Tools base URL instead, or type "-" to disable the live
    # pills (the static recommended/optional chips are kept). Existing config wins
    # as the prefill so a re-run does not silently revert a custom/disabled choice.
    local solo_pcapi="" portcheck_api_json=""
    if [[ $lan_mode -eq 1 ]]; then
        # LAN: an off-box (internet) checker can't reach a private LAN IP, so the live
        # reachability pills are meaningless here — leave them off (page keeps the
        # static recommended/optional chips). solo_pcapi="" also drops the external
        # origin from connect-src below, keeping the CSP pure 'self'.
        info "LAN mode — live off-box port-check pills disabled (can't reach private IPs)."
    else
        local default_pcapi="https://tools.grin.money/tools-api"
        local existing_pcapi=""
        if [[ -f "$web_dir/data/config.json" ]]; then
            existing_pcapi=$(grep -oP '"portcheck_api"\s*:\s*"\K(\\.|[^"\\])*' \
                "$web_dir/data/config.json" 2>/dev/null || true)
        fi
        # Prefill: a value already in config (even when re-running) else the canonical default.
        local prefill_pcapi="${existing_pcapi:-$default_pcapi}"
        echo -ne "External API the miner setup page uses to live-check your stratum ports' reachability (Enter to accept, '-' to disable) [$prefill_pcapi]: "
        read -r solo_pcapi
        [[ -z "$solo_pcapi" ]] && solo_pcapi="$prefill_pcapi"
        [[ "$solo_pcapi" == "-" ]] && solo_pcapi=""   # explicit opt-out → omit the key, page falls back to chips
        if [[ -n "$solo_pcapi" ]]; then
            local esc_pcapi="${solo_pcapi//\\/\\\\}"; esc_pcapi="${esc_pcapi//\"/\\\"}"
            portcheck_api_json="\"portcheck_api\":\"$esc_pcapi\","
        fi
    fi

    # ── Optional Google Analytics 4 (public mode only) ──────────────────────────
    # Opt-in GA4 Measurement ID (G-XXXXXXXXXX) so an operator can track visits to the
    # public stats + setup pages. Default OFF — empty omits the key, the pages load
    # zero third-party script, and the CSP below stays pure 'self' for scripts. LAN
    # mode serves an internal network, so global-traffic analytics is meaningless
    # there → not offered (and the CSP is never widened to Google in LAN mode). The
    # key is editable in config.json, but TOGGLING it on/off needs a re-run of S so
    # the CSP is regenerated to allow (or re-deny) Google's domains. $solo_ga4 is
    # also read by the CSP block further down to widen script/connect/img-src.
    local solo_ga4="" ga4_json=""
    if [[ $lan_mode -eq 0 ]]; then
        local existing_ga4=""
        if [[ -f "$web_dir/data/config.json" ]]; then
            existing_ga4=$(grep -oP '"ga4_id"\s*:\s*"\K[A-Za-z0-9-]+' \
                "$web_dir/data/config.json" 2>/dev/null || true)
        fi
        echo -ne "Google Analytics 4 Measurement ID for the stats page (e.g. G-XXXXXXXXXX · Enter to ${existing_ga4:+keep '$existing_ga4'}${existing_ga4:-skip} · '-' to disable): "
        read -r solo_ga4
        [[ -z "$solo_ga4" ]] && solo_ga4="$existing_ga4"
        [[ "$solo_ga4" == "-" ]] && solo_ga4=""
        if [[ -n "$solo_ga4" ]]; then
            if [[ "$solo_ga4" =~ ^G-[A-Za-z0-9]+$ ]]; then
                ga4_json="\"ga4_id\":\"$solo_ga4\","
                info "GA4 enabled ($solo_ga4) — CSP will allow Google Analytics domains."
            else
                warn "\"$solo_ga4\" is not a GA4 Measurement ID (expected G-XXXXXXXXXX) — analytics skipped."
                solo_ga4=""
            fi
        fi
    fi

    printf '{%s%s"host":"%s",%s%s%s"networks":{%s}}\n' "$slogan_json" "$pool_name_json" "$subdomain" "$public_ip_json" "$portcheck_api_json" "$ga4_json" "$nets_json" \
        > "$web_dir/data/config.json"
    chmod 644 "$web_dir/data/config.json"
    [[ -n "$solo_slogan" ]] && success "Slogan + connection config written (edit $web_dir/data/config.json to change)." \
        || success "Connection config written (edit $web_dir/data/config.json for slogan/ports)."

    # Quiet-hours banner feed: if the energy-saver wrapper is installed, publish the
    # current schedule/state (data/quiet.json) now so a fresh page deploy shows the
    # banner immediately instead of waiting for the next cron window edge. Regenerate
    # the wrapper first (idempotent) so a pre-quiet.json install gets the publisher.
    if [[ -x "$SQ_WRAPPER" ]]; then
        _sq_write_wrapper
        "$SQ_WRAPPER" enforce >/dev/null 2>&1 || true
    fi

    # ── Payout split (mainnet only) ─────────────────────────────────────────────
    # Optional on/off toggle. Writes $PAYMENT_CONFIG ({"enabled":true}); the
    # collector then splits by worker name automatically. Done before the initial
    # collector run below so split_main.json appears immediately when enabled.
    if [[ $have_main -eq 1 ]]; then
        _solo_prompt_payout_split
    fi

    # ── Mining stats collector ──────────────────────────────────────────────────
    # Parses each detected node's log for "Solution Found for block <h>" (found
    # blocks) and "Got share … submitted by <worker>" (per-miner hashrate), and
    # writes rolling JSON: blocks_<net>.json, miners_<net>.json, poolstats_<net>.json.
    # Runs every 5 min via cron.d (matches the watchdog pattern).
    local data_dir="$web_dir/data"
    mkdir -p "$data_dir" "$BLOCK_COLLECTOR_STATE_DIR"
    if [[ -f "$BLOCK_COLLECTOR_SRC" ]]; then
        info "Installing mining stats collector..."
        cp "$BLOCK_COLLECTOR_SRC" "$BLOCK_COLLECTOR_BIN"
        chmod 755 "$BLOCK_COLLECTOR_BIN"

        # Wrapper runs the collector once per detected network.
        {
            echo '#!/bin/bash'
            echo '# Generated by 07_grin_mining_solo.sh — solo mining stats collector.'
            echo 'set -uo pipefail'
            if [[ $have_main -eq 1 ]]; then
                printf '%q --net mainnet --log %q --state-dir %q --out-dir %q --payment-config %q || true\n' \
                    "$BLOCK_COLLECTOR_BIN" "$(_solo_node_log_path mainnet)" \
                    "$BLOCK_COLLECTOR_STATE_DIR" "$data_dir" "$PAYMENT_CONFIG"
            fi
            if [[ $have_test -eq 1 ]]; then
                printf '%q --net testnet --log %q --state-dir %q --out-dir %q || true\n' \
                    "$BLOCK_COLLECTOR_BIN" "$(_solo_node_log_path testnet)" \
                    "$BLOCK_COLLECTOR_STATE_DIR" "$data_dir"
            fi
        } > "$BLOCK_COLLECTOR_WRAPPER"
        chmod 755 "$BLOCK_COLLECTOR_WRAPPER"

        cat > "$BLOCK_COLLECTOR_CRON" << CRON
# Grin solo mining stats collector — every 5 min. Managed by 07_grin_mining_solo.sh
*/5 * * * * root $BLOCK_COLLECTOR_WRAPPER >/dev/null 2>&1
CRON
        chmod 644 "$BLOCK_COLLECTOR_CRON"

        # Initial run so the page has data immediately.
        "$BLOCK_COLLECTOR_WRAPPER" || warn "Initial collection errored (cron will retry)."

        # Feedback + log-level check per network. Per-miner hashrate needs INFO-level
        # logging (shares log at INFO); found blocks log at WARN so they always work.
        local net lvl
        for net in mainnet testnet; do
            [[ "$net" == "mainnet" && $have_main -ne 1 ]] && continue
            [[ "$net" == "testnet" && $have_test -ne 1 ]] && continue
            "$BLOCK_COLLECTOR_BIN" --net "$net" --log "$(_solo_node_log_path "$net")" \
                --dry-run 2>/dev/null | tail -1 | sed "s/^/  $net: /" || true
            lvl="$(_solo_node_file_log_level "$net")"
            if [[ -n "$lvl" && "$lvl" != "INFO" && "$lvl" != "DEBUG" && "$lvl" != "TRACE" ]]; then
                warn "  $net file_log_level=$lvl — per-miner hashrate needs INFO. Found blocks still work."
                echo -e "  ${DIM}Set file_log_level = \"INFO\" in $(_solo_node_log_path "$net" | xargs dirname)/grin-server.toml and restart the node.${RESET}"
            fi
        done

        success "Mining stats collector installed (cron every 5 min) → $data_dir"
        if [[ $lan_mode -eq 1 ]]; then
            echo -e "  ${DIM}poolstats endpoint(s): ${lan_url}/data/poolstats_<net>.json${RESET}"
        else
            echo -e "  ${DIM}miningpoolstats endpoint(s): https://$subdomain/data/poolstats_<net>.json${RESET}"
        fi
        echo -e "  ${DIM}If a scan shows 0 block matches after finding a block, the log wording may${RESET}"
        echo -e "  ${DIM}differ on your node version — adjust FOUND_RE/SHARE_RE in $BLOCK_COLLECTOR_BIN.${RESET}"
    else
        warn "Collector not found ($BLOCK_COLLECTOR_SRC) — blocks + miner stats disabled."
    fi

    # ── Optional access lock (HTTP Basic Auth) ──────────────────────────────────
    # Sets $_ACCESS_AUTH_BLOCK + $_ACCESS_PUBLIC_CARVEOUTS, injected into the vhost
    # below. Safe over the certbot HTTPS redirect (creds never cross plain HTTP).
    # LAN mode has no auth path at all (plain HTTP only) — clear the blocks so the
    # vhost carries no auth_basic lines, and skip the prompt.
    if [[ $lan_mode -eq 1 ]]; then
        _ACCESS_AUTH_BLOCK=""
        _ACCESS_PUBLIC_CARVEOUTS=""
    else
        _solo_prompt_access_lock
    fi

    # Dedicated zone (NOT the shared grin_api 30r/m used by scripts 04/06): each page
    # load fires 4 proxied /api/* calls, and the page's initial-load fast-retry can
    # re-fire them a few times to self-heal a transient blank load. The 90r/m rate is
    # ample for steady state (the page polls only every 120s); the burst (set to 40 on
    # the /api/* locations below) is what absorbs the per-load fan-out + those retries
    # and several rapid hard-refreshes without 503-ing the panels.
    nginx_ensure_rate_limit_zone "solo_stats_api" "90r/m" "10m" "script07-solo-stats"

    # Abuse guards for the PUBLIC surface that had none. /api/* is already throttled
    # by solo_stats_api above; the static page + /data/*.json and raw connections were
    # unprotected. Sizing note: the guard protects against a genuine flood, but each
    # ordinary PAGE LOAD is itself a burst — one load fires ~13 requests against this
    # one server-level bucket (index.html + logo + config.json + 8 polled data JSON +
    # price + split; the 4 /api/* calls use solo_stats_api, not this zone). Steady
    # state is trivial (the page polls only every 120s ≈ 6 req/min/viewer), so the
    # RATE is generous; the value that matters is BURST, which must swallow several
    # rapid full reloads. burst=60 ≈ ~4–5 back-to-back loads before throttling — a fast
    # refresh no longer 503s the HTML document, while a sustained >3/s flood still bites.
    # solo_conn caps concurrent connections per IP to blunt slowloris. Dedicated
    # script07- zones — unique names, no collision with 04/05/06.
    nginx_ensure_rate_limit_zone "solo_static" "180r/m" "10m" "script07-solo-static"
    nginx_ensure_conn_limit_zone "solo_conn" "10m" "script07-solo-conn"

    # Write an HTTP-only vhost FIRST. Referencing letsencrypt certs that do not
    # exist yet would make `nginx -t` fail. certbot --nginx injects the 443
    # server block + SSL directives afterward (and manages options-ssl-nginx.conf).
    # ── Content-Security-Policy ─────────────────────────────────────────────────
    # Locks the pages to same-origin resources. BOTH pages use inline <style> and
    # <script> blocks (plus inline style="" attributes), so style-src/script-src
    # MUST allow 'unsafe-inline' — drop it and the layout + all live polling break.
    # connect-src needs 'self' (the same-origin /api/* and /data/*.json fetches)
    # PLUS the off-box port-check origin the setup page calls for its reachability
    # pills; we derive that origin (scheme://host[:port], path stripped) from the
    # operator-chosen portcheck_api so the pills keep working. Checker disabled →
    # only 'self'. No external fonts/CDN, logo is same-origin → img/font-src 'self'.
    # Applied at server level; it inherits into every location because none of them
    # set their own add_header (the /data location uses `expires`, not add_header,
    # precisely to keep this inheritance).
    local csp_connect="'self'"
    if [[ "${solo_pcapi:-}" =~ ^https?:// ]]; then
        local pc_origin; pc_origin=$(printf '%s' "$solo_pcapi" | sed -E 's#^(https?://[^/]+).*#\1#')
        [[ -n "$pc_origin" ]] && csp_connect="'self' $pc_origin"
    fi
    # When GA4 is enabled, widen ONLY the directives gtag.js needs: the script host
    # (googletagmanager), the collect/beacon endpoints (google-analytics +
    # analytics.google.com regional hosts), and img-src for GA's pixel fallback.
    # Untouched when GA4 is off → the CSP stays pure 'self' for scripts.
    local csp_script="'self' 'unsafe-inline'"
    # img-src also allows data: so the stats page's per-chart PNG export can rasterise
    # its inline SVG through a canvas (the <img> loads a self-generated data: URI — no
    # external host). Harmless for the rest of the page (all real images are same-origin).
    local csp_img="'self' data:"
    if [[ -n "${solo_ga4:-}" ]]; then
        csp_script="$csp_script https://www.googletagmanager.com"
        csp_connect="$csp_connect https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com"
        csp_img="$csp_img https://www.google-analytics.com https://*.google-analytics.com"
    fi
    local csp_value="default-src 'self'; script-src $csp_script; style-src 'self' 'unsafe-inline'; img-src $csp_img; connect-src $csp_connect; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

    # Bind/server_name differ by mode: public listens on :80 (certbot then adds 443);
    # LAN binds only to the chosen private IP:port and never gets a 443 block.
    local listen_line server_name_line vhost_ssl_note
    if [[ $lan_mode -eq 1 ]]; then
        listen_line="listen ${lan_ip}:${lan_port};"
        server_name_line="server_name ${lan_ip} _;"
        vhost_ssl_note="# LAN mode: plain HTTP only, bound to ${lan_ip}:${lan_port} — no SSL/certbot."
    else
        listen_line="listen 80;"
        server_name_line="server_name $subdomain;"
        vhost_ssl_note="# SSL is added in-place by certbot --nginx (do not hand-add a 443 block here)."
    fi

    # umask 077 so the conf (which holds the base64 auth token(s)) is never
    # group/world readable, even momentarily, before the explicit chmod below.
    info "Writing nginx vhost (HTTP): $nginx_conf"
    mkdir -p "$(dirname "$nginx_conf")"
    ( umask 077; cat > "$nginx_conf" << EOF
# Grin Solo Mining Stats (unified mainnet + testnet) — generated by 07_grin_mining_solo.sh
# Rate/conn zones live in /etc/nginx/conf.d/script07-solo-{stats,static,conn}.conf
$vhost_ssl_note

server {
    $listen_line
    $server_name_line

    root $web_dir;
    index index.html;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "$csp_value" always;

    # Abuse guards (zones in script07-solo-static.conf / script07-solo-conn.conf).
    # Server-level so they are inherited by location / and the /data JSON location.
    # The /api/* locations define their own limit_req (solo_stats_api) so per nginx
    # inheritance rules they keep that and are NOT also bound to solo_static; they
    # do inherit limit_conn (they declare none of their own). limit_conn 50 leaves
    # ample headroom for NAT'd/multi-tab viewers (HTTP/2 multiplexes to ~1 conn per
    # tab) while stopping a single IP from holding the worker pool open. Raise it
    # here if a large shared-NAT audience hits spurious 503s.
    # burst=60: each page load is a ~13-request burst (see zone note above), so a small
    # burst 503s the HTML document itself on a fast refresh. 60 swallows ~4–5 rapid
    # reloads; nodelay serves them immediately rather than queuing.
    limit_req  zone=solo_static burst=60 nodelay;
    limit_conn solo_conn 50;
$_ACCESS_AUTH_BLOCK

$proxy_blocks$_ACCESS_PUBLIC_CARVEOUTS    location ~ ^/data/.+\.json\$ {
        # The page re-fetches these collector outputs every 10s. A short cache
        # lets browsers / any CDN absorb repeat + flood hits with no staleness.
        # Uses expires (NOT add_header) so the server-level security headers and
        # the inherited limit_req/limit_conn are preserved (add_header here would
        # reset header inheritance for this location). Exact-match carve-outs above
        # (= /data/poolstats_*.json) still win by location-priority.
        expires 10s;
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }

    access_log /var/log/nginx/${conf_name}-access.log;
    error_log  /var/log/nginx/${conf_name}-error.log;
}
EOF
    )
    chmod 600 "$nginx_conf"

    # nginx_enable_site (shared lib): ensures the sites-enabled include, symlinks,
    # then runs nginx -t + reload. Returns non-zero on failure.
    if ! nginx_enable_site "$nginx_conf" "$conf_name"; then
        error "nginx rejected the config — check $nginx_conf"
        return 1
    fi
    local page_https=0
    if [[ $lan_mode -eq 1 ]]; then
        # LAN mode: no domain → no certbot (HTTP-01 can't validate a private IP) and
        # no auth (decided: LAN page is unauthenticated). The page is intentionally
        # plain HTTP, reachable only on the LAN it is bound to.
        success "nginx serving ${lan_url}/ (LAN only)"
        success "Stats page deployed: ${lan_url}/"
        echo -e "  ${DIM}Bound to ${lan_ip} — only reachable from this network. Make sure your${RESET}"
        echo -e "  ${DIM}firewall allows TCP ${lan_port} from the LAN, and does NOT expose it to the internet.${RESET}"
        echo ""
        echo -e "  ${BOLD}Opening it:${RESET} browse to ${BOLD}${lan_url}/${RESET} from any device on this LAN."
        echo -e "  ${DIM}It's plain HTTP, so browsers show a grey \"Not secure\" label (no padlock) — that is${RESET}"
        echo -e "  ${DIM}normal and harmless on a private network; the page still loads. If it will NOT load,${RESET}"
        echo -e "  ${DIM}the browser is forcing HTTPS — turn off Firefox \"HTTPS-Only Mode\" / Chrome \"Always${RESET}"
        echo -e "  ${DIM}use secure connections\", or add an HTTP exception for ${lan_ip}, then reload.${RESET}"
    else
        success "nginx serving http://$subdomain"

        echo ""
        echo -ne "Run certbot for SSL on $subdomain (recommended)? [Y/n/0]: "
        read -r do_ssl
        if [[ "${do_ssl,,}" != "n" && "$do_ssl" != "0" ]]; then
            # nginx_run_certbot (shared lib) handles the certbot --nginx --redirect call.
            if nginx_run_certbot "$subdomain" "admin@$subdomain" --redirect; then
                # certbot rewrote the conf in place — re-tighten perms (token still inside).
                chmod 600 "$nginx_conf"
                nginx_test_reload "reload after certbot" || true
                page_https=1
                success "Stats page deployed: https://$subdomain"
            else
                warn "certbot failed — page is live over HTTP only."
                echo -e "  Fix DNS so $subdomain points here, then re-run S (or run certbot manually)."
                success "Stats page deployed: http://$subdomain"
            fi
        else
            info "Skipped SSL — page is live over HTTP only at http://$subdomain"
        fi

        # Guardrail: never serve Basic Auth over plain HTTP. If a lock was configured
        # but the page ended up HTTP-only (SSL skipped or certbot failed), strip the
        # auth_basic lines now. The htpasswd file is kept; re-run S once SSL is up.
        if [[ -n "$_ACCESS_AUTH_BLOCK" && $page_https -eq 0 ]]; then
            sed -i '/^[[:space:]]*auth_basic/d' "$nginx_conf"
            nginx_test_reload "reload after disabling HTTP-only auth lock" || true
            warn "Access lock NOT active: refusing to serve Basic Auth over plain HTTP."
            echo -e "  ${DIM}Credentials saved at $STATS_HTPASSWD — re-run S after SSL succeeds to enable the lock.${RESET}"
        fi
    fi

    echo -e "  Page polls ${BOLD}/api/status/<net>${RESET} + ${BOLD}/api/wallet/<net>${RESET} every 10s — both networks side by side."
    echo -e "  ${DIM}Wallet Listener row flags whether the coinbase listener is up.${RESET}"
    echo -e "  ${DIM}Only the network(s) detected at deploy time are wired; others grey out.${RESET}"
    echo -e "  Uptime monitor: ${BOLD}/data/health.json${RESET} ${DIM}— both networks, sanitized node/wallet/stratum liveness${RESET}"
    echo -e "  ${DIM}(per-net booleans + miners-connected + blocks-found-24h; top-level ok = all nets; stays public${RESET}"
    echo -e "  ${DIM}even with the access lock on; refreshed every 5 min).${RESET}"
}
