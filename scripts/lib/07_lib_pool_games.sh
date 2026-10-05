# =============================================================================
# 07_lib_pool_games.sh — /play/ games service for the PUBLIC POOL (menu P)
# =============================================================================
# Design: docs/generated/script07_design.md §19 (the contract; §19.12 = this lib).
# Installs, deploys, fronts and removes grin-games[-testnet]: a SEPARATE Node process,
# OS user (grinplay) and SQLite DB (grinium-games.db) beside the pool, so nothing the
# games do can slow, restart or endanger mining (§19.2).
#
# ⚠ THE ONE RULE OF THIS FILE: nothing here restarts, stops or reloads grin-pool-manager.
#   · The pool reads the link secret through its PRIMARY group (grinpool) and re-reads it
#     by mtime, so creating or rotating it needs no pool restart (D6).
#   · pool.json gains games_port + games_link_secret_file only when absent, and both
#     equal lib/config.js's own defaults, so the running pool already uses those values.
#   · nginx is RELOADED (never restarted), which does not touch the pool process.
#   Every systemctl call that changes state names $PGS_SERVICE. POOL_SERVICE appears only
#   in nginx file/zone NAMES, unit-file reads, and read-only `systemctl show` (P → 5
#   prints the pool's NRestarts so the operator can prove this rule on the box).
#
# Paths (per network, mirroring the POOL_* block in the parent):
#   code   /opt/grin/pubgames/<net>/             root:grinplay 750/640 — rsync --delete'd
#   data   /opt/grin/pubgames-data/<net>/        grinplay 700, DB 600 — NEVER under code (D3)
#   web    /var/www/grin-play[-testnet]/         www-data, outside the pool docroot (D4)
#   link   /opt/grin/conf/grin_pubgames_link_<net>   grinplay:grinpool 0440 (D6)
#   log    /opt/grin/logs/grin-games[-testnet].log   written by systemd (append:), copytruncate
#
# Sourced by 07_grin_mining_public_pool.sh AFTER the POOL_* constants are set. pool_*
# helpers (pool_read_conf, pool_write_conf_key, pool_setup_nginx, _pool_step_done) are
# referenced at CALL time. Convention: sourced lib → NO shebang / NO `set -e`, and every
# create/copy/move/delete carries its own guard — a function called as `fn || true` runs
# with errexit off for its whole body (memory project_lib_errexit_suppression).
# =============================================================================

[[ -n "${_GRIN_POOL_GAMES_SH_LOADED:-}" ]] && return 0
_GRIN_POOL_GAMES_SH_LOADED=1

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi
if ! declare -F _pool_pause >/dev/null 2>&1; then _pool_pause() { echo ""; echo "Press Enter to continue..."; read -r || true; }; fi

# ─── Constants (POOL_NET / POOL_SERVICE / TOOLKIT_ROOT come from the parent) ──
PGS_USER="grinplay"
PGS_SRC="${TOOLKIT_ROOT:-/nonexistent}/web/07_mining_pool_public/play"
PGS_SERVER_SRC="$PGS_SRC/server"
PGS_SHELL_SRC="$PGS_SRC/shell"
PGS_GAMES_SRC="$PGS_SRC/games"
if [[ "${POOL_NET:-mainnet}" == "testnet" ]]; then
    PGS_SERVICE="grin-games-testnet"
    PGS_WEB_DIR="/var/www/grin-play-testnet"
    PGS_PORT=8091
else
    PGS_SERVICE="grin-games"
    PGS_WEB_DIR="/var/www/grin-play"
    PGS_PORT=8081
fi
PGS_APP_DIR="/opt/grin/pubgames/${POOL_NET:-mainnet}"
PGS_DATA_DIR="/opt/grin/pubgames-data/${POOL_NET:-mainnet}"
PGS_DB="$PGS_DATA_DIR/grinium-games.db"
PGS_LINK="/opt/grin/conf/grin_pubgames_link_${POOL_NET:-mainnet}"
PGS_LOG="/opt/grin/logs/${PGS_SERVICE}.log"
PGS_UNIT="/etc/systemd/system/${PGS_SERVICE}.service"
PGS_LOGROTATE="/etc/logrotate.d/${PGS_SERVICE}"
PGS_VACUUM_BIN="/usr/local/bin/${PGS_SERVICE}-vacuum"
PGS_CRON_VACUUM="/etc/cron.d/${PGS_SERVICE}-vacuum"
# nginx: the zones file and the locations snippet. The pool vhost pulls the snippet in
# through a GLOB include of script07-<svc>-games-*.conf (pool_setup_nginx). The pool's own
# header snippets are script07-<svc>-headers.conf etc., which that glob cannot match, and a
# mainnet glob cannot match a testnet file (the "-games-" must follow the service name).
PGS_ZONE_BASENAME="script07-${POOL_SERVICE:-grin-pool-manager}-games"
PGS_ZONE_CONF="/etc/nginx/conf.d/${PGS_ZONE_BASENAME}.conf"
PGS_NGINX_SNIPPET="/etc/nginx/snippets/script07-${POOL_SERVICE:-grin-pool-manager}-games-locations.conf"
PGS_ZONE_API="${POOL_SERVICE:-grin-pool-manager}_games"
PGS_ZONE_LOGIN="${POOL_SERVICE:-grin-pool-manager}_gamelogin"
# Guest sign-up (design §19.17.3, games Part C5): the challenge GET and the sign-up POST share it.
PGS_ZONE_SIGNUP="${POOL_SERVICE:-grin-pool-manager}_gamesignup"
# A game folder name. The same charset the games registry accepts for an id; anything
# else in play/games/ is skipped by the deploy, never copied.
PGS_GAME_ID_RE='^[a-z0-9][a-z0-9_-]{0,31}$'

pgs_installed() { [[ -f "$PGS_UNIT" ]]; }

# ─── pool.json is the source of truth for where the pool expects the games ────
# The pool's admin proxy and probe dial games_port and read games_link_secret_file
# (lib/config.js). If an operator set either by hand, the games unit must follow it,
# not this lib's default. A value the pool itself would reject (games-link.js attach())
# is refused here too, instead of installing a service the pool cannot reach.
_pgs_resolve_conf() {
    declare -F pool_read_conf >/dev/null 2>&1 || return 0
    local p f pool_port
    p=$(pool_read_conf "games_port" "")
    f=$(pool_read_conf "games_link_secret_file" "")
    pool_port=$(pool_read_conf "service_port" "${POOL_PORT:-8080}")
    [[ "$pool_port" =~ ^[0-9]+$ ]] || pool_port="${POOL_PORT:-8080}"
    PGS_POOL_PORT="$pool_port"
    if [[ -n "$p" ]]; then
        if [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1024 && p <= 65535 )) && [[ "$p" != "$pool_port" ]]; then
            PGS_PORT="$p"
        else
            error "games_port in $POOL_CONF is '$p' — the pool disables the games link on that value."
            error "  Set it to an unused port 1024-65535 other than the pool's ($pool_port), or delete the key."
            return 1
        fi
    fi
    if [[ -n "$f" ]]; then
        if [[ "$f" == /* && "$f" != *$'\n'* && "$f" != *' '* ]]; then
            PGS_LINK="$f"
        else
            error "games_link_secret_file in $POOL_CONF is '$f' — it must be an absolute path."
            return 1
        fi
    fi
    return 0
}

_pgs_node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null
}

# ─── Users + groups (§19.3, D5, D6) ───────────────────────────────────────────
# grinplay: nologin, own primary group, and NOT in grinpool or grinsecret — file
# permissions are what keep the games away from pool.db, the pool config and the node
# secrets. There is no shared link group: the link file is owner grinplay, group grinpool,
# and the pool reads it through its PRIMARY group, which a running process always has.
_pgs_ensure_user() {
    if ! id "$PGS_USER" >/dev/null 2>&1; then
        # -U fails when a group of that name is left over from an earlier install; reuse it.
        local -a gopt=(-U)
        getent group "$PGS_USER" >/dev/null 2>&1 && gopt=(-g "$PGS_USER")
        useradd -r "${gopt[@]}" -s /usr/sbin/nologin -d /nonexistent -M "$PGS_USER" 2>/dev/null \
            || useradd -r "${gopt[@]}" -s /sbin/nologin -d /nonexistent -M "$PGS_USER" 2>/dev/null \
            || { error "Could not create the $PGS_USER service user."; return 1; }
        info "Created service user $PGS_USER."
    fi
    local g
    for g in grinpool grinsecret; do
        if id -nG "$PGS_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$g"; then
            gpasswd -d "$PGS_USER" "$g" >/dev/null 2>&1 \
                || { error "$PGS_USER is in group $g and could not be removed — it could read pool files."; return 1; }
            warn "Removed $PGS_USER from group $g (the games must not read pool files)."
        fi
    done
    # The link file relies on grinpool being the pool unit's PRIMARY group (D6). A pool
    # installed by an older toolkit that made grinpool a member of some other primary group
    # would read the file as "other" and get EACCES — every internal call would 503.
    local pg; pg=$(id -gn grinpool 2>/dev/null || true)
    if [[ "$pg" != "grinpool" ]]; then
        error "The pool user grinpool has primary group '${pg:-?}', not 'grinpool'."
        error "  The link secret is group-readable by grinpool only; the pool could not read it."
        return 1
    fi
    if grep -q '^Group=' "/etc/systemd/system/${POOL_SERVICE}.service" 2>/dev/null \
       && ! grep -q '^Group=grinpool$' "/etc/systemd/system/${POOL_SERVICE}.service" 2>/dev/null; then
        error "The pool unit sets a Group= other than grinpool — it could not read the link secret."
        return 1
    fi
    return 0
}

# ─── Directories + modes ──────────────────────────────────────────────────────
# grinplay needs TRAVERSE (o+x) on /opt/grin, /opt/grin/conf (to reach its link file) and
# /opt/grin/logs is not needed at all (systemd opens the log as root). o+x never grants
# listing, and every file under conf/ keeps its own restrictive mode.
_pgs_ensure_dirs() {
    install -d -m 755 -o root -g root /opt/grin/pubgames /opt/grin/pubgames-data 2>/dev/null \
        || { error "Could not create /opt/grin/pubgames{,-data}."; return 1; }
    install -d -m 750 -o root -g "$PGS_USER" "$PGS_APP_DIR" 2>/dev/null \
        || { error "Could not create $PGS_APP_DIR."; return 1; }
    install -d -m 700 -o "$PGS_USER" -g "$PGS_USER" "$PGS_DATA_DIR" 2>/dev/null \
        || { error "Could not create $PGS_DATA_DIR."; return 1; }
    # A DB restored before this install (P was not set up yet) is root-owned: hand it over.
    chown -R "$PGS_USER:$PGS_USER" "$PGS_DATA_DIR" 2>/dev/null \
        || { error "Could not chown $PGS_DATA_DIR to $PGS_USER."; return 1; }
    find "$PGS_DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} + 2>/dev/null || true
    mkdir -p "$(dirname "$PGS_LINK")" "$(dirname "$PGS_LOG")" 2>/dev/null \
        || { error "Could not create $(dirname "$PGS_LINK") / $(dirname "$PGS_LOG")."; return 1; }
    chmod o+x /opt/grin "$(dirname "$PGS_LINK")" 2>/dev/null \
        || { error "Could not give $PGS_USER traverse on /opt/grin and $(dirname "$PGS_LINK")."; return 1; }
    return 0
}

# ─── Link secret (§19.3) ──────────────────────────────────────────────────────
# 48 random bytes, base64 = 64 characters. Written to a temp file in the SAME directory
# (so the final mv is an atomic rename), given its owner and mode BEFORE the rename, then
# renamed over the old one. The secret travels only openssl → file: never argv, never an
# environment variable, never echoed. $1 = "rotate" to replace an existing one.
_pgs_link_ok() {
    [[ -f "$PGS_LINK" ]] || return 1
    local n; n=$(tr -d '[:space:]' < "$PGS_LINK" 2>/dev/null | wc -c)
    [[ "$n" -ge 32 ]]
}

_pgs_write_link() {
    local mode="${1:-create}" dir tmp n
    if [[ "$mode" != "rotate" ]] && _pgs_link_ok; then
        # Our own file: re-asserting its owner/mode is safe (unlike a node secret).
        chown "$PGS_USER:grinpool" "$PGS_LINK" 2>/dev/null \
            || { error "Could not chown $PGS_LINK to $PGS_USER:grinpool."; return 1; }
        chmod 0440 "$PGS_LINK" 2>/dev/null || { error "Could not chmod $PGS_LINK."; return 1; }
        info "Link secret already present — kept ($PGS_LINK)."
        return 0
    fi
    command -v openssl >/dev/null 2>&1 || { error "openssl not found — cannot generate the link secret."; return 1; }
    dir=$(dirname "$PGS_LINK")
    tmp=$(mktemp "$dir/.grin_pubgames_link.XXXXXX" 2>/dev/null) \
        || { error "mktemp in $dir failed — link secret not written."; return 1; }
    if ! ( umask 077; openssl rand -base64 48 > "$tmp" ) 2>/dev/null; then
        rm -f "$tmp"; error "openssl rand failed — link secret not written."; return 1
    fi
    n=$(tr -d '[:space:]' < "$tmp" | wc -c)
    if [[ "$n" -lt 32 ]]; then rm -f "$tmp"; error "Generated secret is too short ($n) — not written."; return 1; fi
    chown "$PGS_USER:grinpool" "$tmp" 2>/dev/null \
        || { rm -f "$tmp"; error "Could not chown the new link secret — not written."; return 1; }
    chmod 0440 "$tmp" 2>/dev/null || { rm -f "$tmp"; error "Could not chmod the new link secret — not written."; return 1; }
    mv -f "$tmp" "$PGS_LINK" 2>/dev/null \
        || { rm -f "$tmp"; error "Could not move the new link secret into place ($PGS_LINK)."; return 1; }
    if [[ "$mode" == "rotate" ]]; then success "Link secret rotated ($PGS_LINK)."; else success "Link secret created ($PGS_LINK)."; fi
    return 0
}

# pool.json keys (§19.3, §19.15 Part 2 #1): written ONLY when absent. Both values equal
# the pool's built-in defaults, so the running pool already uses them — no restart.
_pgs_write_pool_keys() {
    declare -F pool_write_conf_key >/dev/null 2>&1 || return 0
    if [[ "$(pool_read_conf "games_port" "__MISSING__")" == "__MISSING__" ]]; then
        pool_write_conf_key "games_port" "$PGS_PORT" \
            || { error "Could not write games_port to $POOL_CONF."; return 1; }
    fi
    if [[ "$(pool_read_conf "games_link_secret_file" "__MISSING__")" == "__MISSING__" ]]; then
        pool_write_conf_key "games_link_secret_file" "$PGS_LINK" \
            || { error "Could not write games_link_secret_file to $POOL_CONF."; return 1; }
    fi
    return 0
}

# ─── Deploy (§19.12) ──────────────────────────────────────────────────────────
# Both trees are assembled in a staging dir first, then mirrored with ONE rsync --delete
# each. No --exclude on the code dir, deliberately: nothing the service writes lives there
# (the DB is in PGS_DATA_DIR, the log is written by systemd), and games/config.js refuses to
# start with a GAMES_DB inside the code dir. Contrast pool_deploy_code, whose app dir holds
# pool.db and needs an exclude per runtime file — the trap D3 designed out.
#   code stage: server/**  +  games/<id>/{manifest.json,rules.js}
#   web  stage: shell/**   +  games/<id>/{frame/**,rules.js}  +  version.js
_pgs_stage_trees() { # <stage dir>
    local st="$1" g id
    mkdir -p "$st/app/games" "$st/web/games" 2>/dev/null || { error "Could not create the deploy stage."; return 1; }
    cp -a "$PGS_SERVER_SRC/." "$st/app/" 2>/dev/null || { error "Could not stage $PGS_SERVER_SRC."; return 1; }
    rm -rf "$st/app/node_modules" 2>/dev/null || true   # zero-dependency service; a stray local install must not ship
    if [[ -d "$PGS_SHELL_SRC" ]]; then
        cp -a "$PGS_SHELL_SRC/." "$st/web/" 2>/dev/null || { error "Could not stage $PGS_SHELL_SRC."; return 1; }
    fi
    if [[ -d "$PGS_GAMES_SRC" ]]; then
        for g in "$PGS_GAMES_SRC"/*/; do
            [[ -d "$g" ]] || continue
            id=$(basename "$g")
            if [[ ! "$id" =~ $PGS_GAME_ID_RE ]]; then warn "Skipping game folder '$id' (not a valid game id)."; continue; fi
            [[ -f "$g/manifest.json" ]] || { warn "Skipping game '$id' (no manifest.json)."; continue; }
            mkdir -p "$st/app/games/$id" "$st/web/games/$id" 2>/dev/null \
                || { error "Could not stage game '$id'."; return 1; }
            cp -p "$g/manifest.json" "$st/app/games/$id/" 2>/dev/null \
                || { error "Could not stage $id/manifest.json."; return 1; }
            if [[ -f "$g/rules.js" ]]; then
                cp -p "$g/rules.js" "$st/app/games/$id/" 2>/dev/null \
                    && cp -p "$g/rules.js" "$st/web/games/$id/" 2>/dev/null \
                    || { error "Could not stage $id/rules.js."; return 1; }
            fi
            if [[ -d "$g/frame" ]]; then
                cp -a "$g/frame" "$st/web/games/$id/" 2>/dev/null \
                    || { error "Could not stage $id/frame/."; return 1; }
            fi
        done
    fi
    # Asset version stamp: a short hash of everything deployed (both trees), so a changed
    # file changes it. The shell loads /play/version.js and appends it to its asset URLs,
    # which busts any Cloudflare-cached copy (memory project_office_tools_cloudflare_cache).
    local ver
    ver=$(cd "$st" && find . -type f ! -path ./web/version.js -print0 | LC_ALL=C sort -z \
            | xargs -0 -r sha256sum 2>/dev/null | sha256sum | cut -c1-12)
    [[ "$ver" =~ ^[0-9a-f]{12}$ ]] || { error "Could not compute the asset version stamp."; return 1; }
    printf '/* Generated by Script 07 (pgs_deploy_code). Do not edit. */\nwindow.GRIN_PLAY_VERSION = "%s";\n' "$ver" \
        > "$st/web/version.js" 2>/dev/null || { error "Could not write version.js."; return 1; }
    # Stamp the asset URLs. The shell and every game frame refer to their own scripts and
    # styles as ?v=__GRIN_PLAY_VERSION__ (design §19.15 Part 6): a static tag stays parser-
    # inserted — ordered, and render-blocking for CSS — which a JS loader reading version.js
    # could not give. Done AFTER the hash, so the stamp is the hash of the unstamped trees.
    local f
    while IFS= read -r -d '' f; do
        sed -i "s/__GRIN_PLAY_VERSION__/$ver/g" "$f" 2>/dev/null \
            || { error "Could not stamp the asset version into $f."; return 1; }
    done < <(find "$st/web" -type f -name '*.html' -print0 2>/dev/null)
    PGS_DEPLOYED_VERSION="$ver"
    return 0
}

_pgs_fix_app_perms() {
    chown -R "root:$PGS_USER" "$PGS_APP_DIR" 2>/dev/null || { error "Could not chown $PGS_APP_DIR."; return 1; }
    find "$PGS_APP_DIR" -type d -exec chmod 750 {} + 2>/dev/null || { error "Could not chmod dirs in $PGS_APP_DIR."; return 1; }
    find "$PGS_APP_DIR" -type f -exec chmod 640 {} + 2>/dev/null || { error "Could not chmod files in $PGS_APP_DIR."; return 1; }
    return 0
}

# Same normalisation as pool_fix_web_perms: nginx reads, nobody else writes.
_pgs_fix_web_perms() {
    [[ -d "$PGS_WEB_DIR" ]] || return 0
    chown -R www-data:www-data "$PGS_WEB_DIR" 2>/dev/null || true
    find "$PGS_WEB_DIR" -type d -exec chmod 755 {} + 2>/dev/null || true
    find "$PGS_WEB_DIR" -type f -exec chmod 644 {} + 2>/dev/null || true
}

# $1 = "norestart" (used by install, which starts the service itself).
pgs_deploy_code() {
    local mode="${1:-}"
    echo -e "\n${BOLD}Games — deploy code (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    [[ -f "$PGS_SERVER_SRC/index.js" ]] || { error "Games source not found: $PGS_SERVER_SRC (pull the checkout)."; return 1; }
    [[ -d "$PGS_APP_DIR" ]] || { error "Games not installed ($PGS_APP_DIR missing) — run P → 1 first."; return 1; }
    _pgs_resolve_conf || return 1
    command -v rsync >/dev/null 2>&1 || { error "rsync not found — install it and retry."; return 1; }
    # D3, enforced at the only place that could break it: a --delete into a dir that holds
    # the DB. The constants make this impossible today; this line keeps it impossible.
    case "$PGS_DATA_DIR/" in
        "$PGS_APP_DIR"/*|"$PGS_WEB_DIR"/*) error "Refusing to deploy: the games data dir is inside a deploy target."; return 1 ;;
    esac

    local st; st=$(mktemp -d /tmp/grin_pubgames_deploy_XXXXXX 2>/dev/null) \
        || { error "mktemp failed — nothing deployed."; return 1; }
    if ! _pgs_stage_trees "$st"; then rm -rf "$st"; return 1; fi

    info "Refreshing games code → $PGS_APP_DIR ..."
    if ! rsync -a --delete "$st/app/" "$PGS_APP_DIR/" 2>/dev/null; then
        rm -rf "$st"; error "rsync to $PGS_APP_DIR failed — the service may hold a partial tree; re-run P → 2."; return 1
    fi
    # rsync -a carries the staging copy's owner (root) and the checkout's modes.
    if ! _pgs_fix_app_perms; then rm -rf "$st"; return 1; fi

    info "Refreshing /play/ web files → $PGS_WEB_DIR ..."
    mkdir -p "$PGS_WEB_DIR" 2>/dev/null || { rm -rf "$st"; error "Could not create $PGS_WEB_DIR."; return 1; }
    if ! rsync -a --delete "$st/web/" "$PGS_WEB_DIR/" 2>/dev/null; then
        rm -rf "$st"; error "rsync to $PGS_WEB_DIR failed."; return 1
    fi
    _pgs_fix_web_perms
    rm -rf "$st"
    [[ -d "$PGS_SHELL_SRC" ]] || warn "No shell at $PGS_SHELL_SRC — /play/ will have no page (pull the checkout)."
    success "Games code deployed (asset version $PGS_DEPLOYED_VERSION)."

    if [[ "$mode" != "norestart" ]]; then
        if systemctl is-active --quiet "$PGS_SERVICE" 2>/dev/null; then
            info "Restarting $PGS_SERVICE (games only — the pool is not touched)..."
            systemctl restart "$PGS_SERVICE" 2>/dev/null \
                || { error "Restart failed — check: journalctl -u $PGS_SERVICE -n 50 / $PGS_LOG"; return 1; }
            _pgs_wait_health 10 || warn "The games service did not answer its health check yet — see P → 6 Logs."
        else
            info "$PGS_SERVICE is not running — start it via P → 4."
        fi
    fi
    return 0
}

# ─── systemd unit + logrotate (D16, §19.15 Part 1 #2/#3/#12) ─────────────────
# Only KNOWN variables are set: games/config.js refuses any unknown GAMES_* key. The link
# SECRET is not here — only its path; an Environment= line is readable by `systemctl show`.
# RestartPreventExitStatus=78: exit 78 is a bad config, which a restart loop cannot fix.
# No Requires=/BindsTo= on the pool unit, in either direction: games must never be able to
# pull the pool down, and the pool restarting must not bounce the games.
# stdout/stderr are appended by systemd itself (it opens the file as root), so the service
# needs no write access to /opt/grin/logs — ReadWritePaths is the data dir alone.
_pgs_write_unit() {
    local node_bin; node_bin=$(command -v node 2>/dev/null || echo /usr/bin/node)
    local tmp; tmp=$(mktemp "/etc/systemd/system/.${PGS_SERVICE}.XXXXXX" 2>/dev/null) \
        || { error "mktemp in /etc/systemd/system failed."; return 1; }
    cat > "$tmp" << EOF || { rm -f "$tmp"; error "Could not write the unit."; return 1; }
# Generated by Script 07 (07_lib_pool_games.sh, P → 1). Re-run Install to change it.
[Unit]
Description=GRINIUM games service /play/ (${POOL_NET_LABEL:-$POOL_NET}) — design §19
After=network.target

[Service]
Type=simple
User=$PGS_USER
Group=$PGS_USER
WorkingDirectory=$PGS_APP_DIR
Environment="NODE_ENV=production"
Environment="GAMES_NET=${POOL_NET:-mainnet}"
Environment="GAMES_PORT=$PGS_PORT"
Environment="GAMES_DB=$PGS_DB"
Environment="GAMES_LINK_SECRET_FILE=$PGS_LINK"
Environment="GAMES_GAMES_DIR=$PGS_APP_DIR/games"
Environment="POOL_INTERNAL_URL=http://127.0.0.1:${PGS_POOL_PORT:-${POOL_PORT:-8080}}"
ExecStart=$node_bin --disable-warning=ExperimentalWarning $PGS_APP_DIR/index.js
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
StandardOutput=append:$PGS_LOG
StandardError=append:$PGS_LOG
MemoryMax=384M
CPUWeight=20
IOWeight=20
Nice=10
TasksMax=64
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=-$PGS_DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$tmp" 2>/dev/null || { rm -f "$tmp"; error "Could not chmod the unit."; return 1; }
    mv -f "$tmp" "$PGS_UNIT" 2>/dev/null || { rm -f "$tmp"; error "Could not install $PGS_UNIT."; return 1; }
    systemctl daemon-reload 2>/dev/null || { error "systemctl daemon-reload failed."; return 1; }
    return 0
}

# copytruncate: the games service has no log-reopen signal (the pool's USR2 hook does
# not exist here), and systemd holds the append: descriptor, so a rename would keep it
# writing into the rotated file.
_pgs_write_logrotate() {
    cat > "$PGS_LOGROTATE" << EOF || { error "Could not write $PGS_LOGROTATE."; return 1; }
$PGS_LOG {
    daily
    rotate 10
    size 20M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
    return 0
}

# Poll /play/api/health on the loopback port: rc 0 once it answers {"ok":true,...}.
_pgs_health_json() {
    curl -s --max-time 2 "http://127.0.0.1:$PGS_PORT/play/api/health" 2>/dev/null || true
}
_pgs_wait_health() { # [seconds]
    local n="${1:-10}" i body
    for (( i = 0; i < n; i++ )); do
        body=$(_pgs_health_json)
        if [[ "$body" == *'"ok":true'* ]]; then return 0; fi
        sleep 1
    done
    return 1
}

# ─── 1) Install / repair ──────────────────────────────────────────────────────
pgs_install() {
    echo -e "\n${BOLD}Games — install / repair (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "  ${DIM}Separate service, user and database. The pool keeps running throughout.${RESET}\n"

    if [[ ! -d "$POOL_APP_DIR" || ! -f "/etc/systemd/system/${POOL_SERVICE}.service" ]]; then
        error "The pool is not installed on this box — run 1) Install first."
        return 1
    fi
    id grinpool >/dev/null 2>&1 || { error "The grinpool user does not exist — re-run 1) Install (de-root)."; return 1; }
    _pgs_node_ok || { error "Node.js >= 24 not found — run 1) Install (it installs Node 24 for the pool)."; return 1; }
    [[ -f "$PGS_SERVER_SRC/index.js" ]] || { error "Games source not found: $PGS_SERVER_SRC"; return 1; }
    command -v curl >/dev/null 2>&1 || warn "curl not found — the health checks below will be skipped."
    _pgs_resolve_conf || return 1

    _pgs_ensure_user   || return 1
    _pgs_ensure_dirs   || return 1
    _pgs_write_link    || return 1
    _pgs_write_pool_keys || return 1
    pgs_deploy_code norestart || return 1

    if [[ ! -f "$PGS_LOG" ]]; then
        install -m 640 -o root -g root /dev/null "$PGS_LOG" 2>/dev/null \
            || { error "Could not create $PGS_LOG."; return 1; }
    fi
    _pgs_write_unit      || return 1
    _pgs_write_logrotate || return 1
    systemctl enable "$PGS_SERVICE" >/dev/null 2>&1 || warn "Could not enable $PGS_SERVICE at boot."
    # restart, not start: a repair must pick up a changed unit and code.
    if ! systemctl restart "$PGS_SERVICE" 2>/dev/null; then
        error "$PGS_SERVICE failed to start — check: journalctl -u $PGS_SERVICE -n 50 / $PGS_LOG"
        return 1
    fi
    if _pgs_wait_health 15; then
        success "$PGS_SERVICE is up on 127.0.0.1:$PGS_PORT (health ok)."
    else
        warn "$PGS_SERVICE started but /play/api/health did not answer yet — see P → 6 Logs."
        warn "  Exit status 78 means a bad configuration: systemctl status $PGS_SERVICE"
    fi

    # The daily backup wrapper is generated once, so a box that scheduled it before the
    # games existed would never archive the games DB. Regenerate it when it is on.
    if [[ -f "${PBK_CRON:-/nonexistent}" ]] && declare -F _pbk_write_wrapper >/dev/null 2>&1; then
        pbk_load_conf 2>/dev/null || true
        _pbk_write_wrapper && info "Daily backup wrapper refreshed — it now includes the games DB."
    fi

    echo ""
    success "Games installed. The pool was not restarted."
    echo -e "  Next: ${BOLD}P → 3 Nginx${RESET}, then try /play/ by its direct URL."
    echo -e "  ${DIM}A new games DB starts in PREVIEW: /play/ works, the pool's menu does not show it.${RESET}"
    echo -e "  ${DIM}When it works: admin panel → Games → Overview → ${RESET}${BOLD}Go live${RESET}${DIM}. If /play/ answers 404, the${RESET}"
    echo -e "  ${DIM}pool's switch is off: admin panel → Settings → Games (design §19.17.2).${RESET}"
    return 0
}

# ─── 3) nginx (§19.12) ────────────────────────────────────────────────────────
# Writes the zones + the locations snippet, makes sure the pool vhost carries the glob
# include, tests, reloads, and then CHECKS the routes on the listener (a clean
# `nginx -t` + reload proves the config parses, not that /play/ is served).
_pgs_write_snippet() { # <dest>
    local dest="$1"
    local hdr_common="/etc/nginx/snippets/script07-${POOL_SERVICE}-headers.conf"
    # UNQUOTED heredoc (it needs the paths). No backticks anywhere below, comments included:
    # each one would run as a command (memory reference_bash_unquoted_heredoc_backticks).
    cat > "$dest" << EOF || return 1
# Generated by Script 07 (07_lib_pool_games.sh, pool menu P → 3). DO NOT EDIT — re-run P → 3.
# /play/ locations for the pool vhost's :443 server block (design §19.12). Pulled in by the
# vhost's glob include of script07-${POOL_SERVICE}-games-*.conf; zones in $PGS_ZONE_CONF.
# Every location here uses ^~ so no regex location of the pool vhost can take a /play/ URL.

location = /play { return 301 https://\$host/play/; }

# Login: its own strict zone (20 r/m per IP) and a 4 KB body cap. The games service also
# limits per IP and per address before it asks the pool to check a proof (D7).
location ^~ /play/api/login {
    limit_req zone=${PGS_ZONE_LOGIN} burst=5 nodelay;
    client_max_body_size 4k;
    proxy_pass         http://127.0.0.1:$PGS_PORT;
    proxy_set_header   Host \$host;
    proxy_set_header   X-Real-IP \$remote_addr;
    proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
    proxy_read_timeout 30s;
}

# Guest sign-up (design 19.17.3): /signup/challenge and /signup share one strict zone, 6 r/m
# per IP, before the app's own limits (a proof-of-work per attempt, 6 attempts an hour and 3
# sign-ups a day per /24). Guest LOGIN is /play/api/login/guest, so the login location above
# already covers it (prefix match): 20 r/m and the 4 KB cap.
location ^~ /play/api/signup {
    limit_req zone=${PGS_ZONE_SIGNUP} burst=4 nodelay;
    client_max_body_size 4k;
    proxy_pass         http://127.0.0.1:$PGS_PORT;
    proxy_set_header   Host \$host;
    proxy_set_header   X-Real-IP \$remote_addr;
    proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
    proxy_read_timeout 30s;
}

# The games API. JSON errors come from the app, a dead app is nginx's 502 — the shell
# treats any non-JSON answer as "games are offline". No add_header here, so the server
# level security headers apply; the app sends Cache-Control: no-store itself.
location ^~ /play/api/ {
    limit_req zone=${PGS_ZONE_API} burst=40 nodelay;
    client_max_body_size 64k;
    proxy_pass         http://127.0.0.1:$PGS_PORT;
    proxy_set_header   Host \$host;
    proxy_set_header   X-Real-IP \$remote_addr;
    proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto \$scheme;
    proxy_read_timeout 30s;
}

# Game frames (D13): loaded ONLY in <iframe sandbox="allow-scripts"> by the shell.
# ⚠ This location deliberately does NOT include $hdr_common: that snippet
# sends X-Frame-Options DENY, which would stop the shell from framing its own games. The
# three headers below are the ones it would have sent, minus that one — keep them in step
# with it. frame-ancestors 'self' is what limits framing here. The CSP's sandbox directive
# repeats the iframe attribute, so a frame opened directly in a tab is sandboxed too.
# connect-src 'none': a frame cannot call /play/api/ or anything else (the shell does).
# Classic scripts only: a module script from an opaque origin needs CORS and would fail.
location ^~ /play/games/ {
    alias $PGS_WEB_DIR/games/;
    limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; sandbox allow-scripts" always;
    add_header Cache-Control "no-cache" always;
    index index.html;
}

# The shell page. Common headers + its own CSP: NO 'unsafe-inline' in script-src (the shell
# has no inline script), no analytics hosts, frame-src 'self' for the game frames.
# no-cache on every file, as the pool's own pages: revalidate, 304 when unchanged.
# index + alias and NO try_files: alias with try_files is a long-standing nginx quirk.
location ^~ /play/ {
    alias $PGS_WEB_DIR/;
    limit_req zone=${POOL_SERVICE}_static burst=100 nodelay;
    include $hdr_common;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';" always;
    add_header Cache-Control "no-cache" always;
    index index.html;
}
EOF
    return 0
}

# HTTP status of one URL on THIS box's :443 listener. --resolve keeps the real SNI/Host
# while bypassing DNS, so a CDN in front (Cloudflare) cannot answer in the origin's place.
_pgs_local_status() { # <domain> <path>
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        --resolve "$1:443:127.0.0.1" "https://$1$2" 2>/dev/null || echo "000"
}

pgs_setup_nginx() {
    echo -e "\n${BOLD}Games — nginx (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    command -v nginx >/dev/null 2>&1 || { error "nginx not found — run 4) Setup nginx first."; return 1; }
    local domain; domain=$(pool_read_conf "subdomain" "")
    if [[ -z "$domain" || ! -f "$POOL_NGINX_CONF" ]] || ! grep -q "listen 443" "$POOL_NGINX_CONF" 2>/dev/null; then
        error "The pool's HTTPS vhost is not set up yet — run 4) Setup nginx first."
        return 1
    fi
    _pgs_resolve_conf || return 1
    local hdr_common="/etc/nginx/snippets/script07-${POOL_SERVICE}-headers.conf"
    [[ -f "$hdr_common" ]] || { error "Missing $hdr_common — re-run 4) Setup nginx first."; return 1; }

    # Zones: same helper as every toolkit zone. It is a no-op when the file exists; the
    # snippet references all three names, so a file missing any of them (a box set up before
    # the sign-up zone existed) is regenerated.
    if [[ -f "$PGS_ZONE_CONF" ]] && { ! grep -q "zone=${PGS_ZONE_API}[: ]" "$PGS_ZONE_CONF" \
                                      || ! grep -q "zone=${PGS_ZONE_LOGIN}[: ]" "$PGS_ZONE_CONF" \
                                      || ! grep -q "zone=${PGS_ZONE_SIGNUP}[: ]" "$PGS_ZONE_CONF"; }; then
        rm -f "$PGS_ZONE_CONF" || { error "Could not remove the stale $PGS_ZONE_CONF."; return 1; }
    fi
    nginx_ensure_rate_limit_zones "$PGS_ZONE_BASENAME" "${PGS_ZONE_API}:600r/m" "${PGS_ZONE_LOGIN}:20r/m" \
        "${PGS_ZONE_SIGNUP}:6r/m" \
        || { error "Could not write the games rate-limit zones."; return 1; }

    # Snippet: written to a temp file and renamed in, keeping the previous one aside so a
    # failed test can put it back. The backup lives OUTSIDE /etc/nginx: a copy in
    # snippets/ would still be matched by the vhost's glob if its name ended in .conf.
    local prev="" new
    mkdir -p "$(dirname "$PGS_NGINX_SNIPPET")" 2>/dev/null || { error "Could not create $(dirname "$PGS_NGINX_SNIPPET")."; return 1; }
    new=$(mktemp /tmp/grin_pubgames_snippet_XXXXXX 2>/dev/null) || { error "mktemp failed."; return 1; }
    if ! _pgs_write_snippet "$new"; then rm -f "$new"; error "Could not write the games snippet."; return 1; fi
    if [[ -f "$PGS_NGINX_SNIPPET" ]]; then
        prev=$(mktemp /tmp/grin_pubgames_snippet_prev_XXXXXX 2>/dev/null) \
            && cp -p "$PGS_NGINX_SNIPPET" "$prev" 2>/dev/null \
            || { rm -f "$new" "$prev"; error "Could not keep a copy of the current snippet — nothing changed."; return 1; }
    fi
    chmod 644 "$new" 2>/dev/null || true
    mv -f "$new" "$PGS_NGINX_SNIPPET" 2>/dev/null \
        || { rm -f "$new" "$prev"; error "Could not install $PGS_NGINX_SNIPPET."; return 1; }

    # The include lives in the pool vhost (pool_setup_nginx). A vhost written before this
    # feature has neither line: regenerate it through 4) — which reloads nginx, never the pool.
    if ! grep -qF "script07-${POOL_SERVICE}-games-*.conf" "$POOL_NGINX_CONF" 2>/dev/null; then
        warn "The pool vhost predates /play/ — it has no include for the games snippet."
        echo -ne "  Regenerate the pool vhost now (same as 4) Setup nginx; nginx reload only)? [Y/n]: "
        local a; read -r a || a="n"
        if [[ "${a,,}" == "n" || "${a,,}" == "no" ]]; then
            warn "Left as is. The snippet is in place but not included — run 4) Setup nginx later."
            rm -f "$prev"
            return 0
        fi
        if ! pool_setup_nginx; then
            error "4) Setup nginx failed — see above."
            _pgs_snippet_rollback "$prev"
            return 1
        fi
    elif nginx -t >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null \
            || { error "nginx reload failed."; _pgs_snippet_rollback "$prev"; return 1; }
    else
        error "nginx -t failed with the games snippet:"
        nginx -t 2>&1 | tail -5
        _pgs_snippet_rollback "$prev"
        return 1
    fi
    rm -f "$prev"
    success "Games nginx locations live ($PGS_NGINX_SNIPPET)."
    pgs_check_routes "$domain"
    return 0
}

# Put the previous snippet back (or remove the new one) and reload, so the vhost is never
# left failing `nginx -t` — the next reboot or certbot renewal would take every site down.
_pgs_snippet_rollback() { # <prev copy or "">
    local prev="$1"
    if [[ -n "$prev" && -f "$prev" ]]; then
        mv -f "$prev" "$PGS_NGINX_SNIPPET" 2>/dev/null || rm -f "$PGS_NGINX_SNIPPET"
        warn "Previous games snippet restored."
    else
        rm -f "$PGS_NGINX_SNIPPET"
        warn "Games snippet removed again."
    fi
    if nginx -t >/dev/null 2>&1; then
        systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
        info "nginx is back on its previous working config."
    else
        error "nginx -t STILL fails without the games snippet — fix it before any reboot:"
        nginx -t 2>&1 | tail -5
    fi
}

# The three answers checkpoint A needs (§19.12), from the listener itself.
pgs_check_routes() { # [domain]
    local domain="${1:-$(pool_read_conf "subdomain" "")}"
    command -v curl >/dev/null 2>&1 || { warn "curl not found — route checks skipped."; return 0; }
    [[ -n "$domain" ]] || { warn "No pool domain — route checks skipped."; return 0; }
    local s_play s_health s_int s_intg
    s_play=$(_pgs_local_status "$domain" "/play/")
    s_health=$(_pgs_local_status "$domain" "/play/api/health")
    s_int=$(_pgs_local_status "$domain" "/internal/x")
    s_intg=$(_pgs_local_status "$domain" "/internal/games/config")
    echo -e "  ${BOLD}Route check${RESET} ${DIM}(https://$domain via 127.0.0.1)${RESET}"
    case "$s_play" in
        200) echo -e "    /play/                  ${GREEN}200${RESET}" ;;
        403|404) echo -e "    /play/                  ${YELLOW}$s_play${RESET} ${DIM}(no shell page yet — expected before design §19 Part 6)${RESET}" ;;
        *)   echo -e "    /play/                  ${RED}$s_play${RESET}" ;;
    esac
    case "$s_health" in
        200) echo -e "    /play/api/health        ${GREEN}200${RESET}" ;;
        502) echo -e "    /play/api/health        ${YELLOW}502${RESET} ${DIM}(games service not running — P → 4)${RESET}" ;;
        *)   echo -e "    /play/api/health        ${RED}$s_health${RESET}" ;;
    esac
    local ok_int=1
    [[ "$s_int" == "404" && "$s_intg" == "404" ]] || ok_int=0
    if (( ok_int )); then
        echo -e "    /internal/x, /internal/games/config  ${GREEN}404${RESET}"
    else
        echo -e "    /internal/x ${RED}$s_int${RESET}  /internal/games/config ${RED}$s_intg${RESET}  ${RED}(must both be 404)${RESET}"
        error "An /internal/ path is answering through nginx. Re-run 4) Setup nginx and check again."
        return 1
    fi
    return 0
}

# ─── 4) Service control ───────────────────────────────────────────────────────
pgs_service_menu() {
    pgs_installed || { error "Games not installed — run P → 1 first."; return 1; }
    echo -e "\n${BOLD}Games service — ${POOL_NET_LABEL:-$POOL_NET} ($PGS_SERVICE)${RESET}"
    echo -e "  ${DIM}Only the games service. Stopping it never affects mining or the pool site.${RESET}"
    local sc
    if systemctl is-active --quiet "$PGS_SERVICE" 2>/dev/null; then
        echo -e "  Status: ${GREEN}● running${RESET}"
        echo -e "  ${GREEN}1${RESET}) Stop    ${GREEN}2${RESET}) Restart    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc || sc=0
        case "$sc" in
            1) systemctl stop "$PGS_SERVICE" 2>/dev/null && success "$PGS_SERVICE stopped." || error "Failed to stop $PGS_SERVICE." ;;
            2) if systemctl restart "$PGS_SERVICE" 2>/dev/null; then
                   success "$PGS_SERVICE restarted."
                   _pgs_wait_health 10 || warn "No health answer yet — see P → 6 Logs."
               else
                   error "Failed to restart $PGS_SERVICE."
               fi ;;
        esac
    else
        echo -e "  Status: ${RED}● stopped${RESET}"
        echo -e "  ${GREEN}1${RESET}) Start    ${DIM}0) Back${RESET}"
        echo -ne "Choice: "; read -r sc || sc=0
        if [[ "$sc" == "1" ]]; then
            if systemctl start "$PGS_SERVICE" 2>/dev/null; then
                success "$PGS_SERVICE started."
                _pgs_wait_health 10 || warn "No health answer yet — see P → 6 Logs."
            else
                error "Failed to start $PGS_SERVICE."
            fi
        fi
    fi
    return 0
}

# ─── 5) Status ────────────────────────────────────────────────────────────────
# Mode comes from the pool's own /internal/games/config, called by node so the secret is
# read from the file inside the process: never argv, never a shell variable, never printed.
# The node script prints one word (or "ERR:<status>"). A second call WITHOUT the header
# must be refused (401): that is impact-budget check 2, locally.
_pgs_pool_config_probe() {
    node -e '
const fs = require("fs"), http = require("http");
const [file, port] = process.argv.slice(1);
let secret = "";
try { const st = fs.statSync(file); if (st.size <= 4096) secret = fs.readFileSync(file, "utf8").trim(); } catch (e) {}
function get(withSecret) {
  return new Promise((res) => {
    const headers = withSecret ? { "X-Games-Link": secret } : {};
    const req = http.get({ host: "127.0.0.1", port: Number(port), path: "/internal/games/config", headers, timeout: 3000 }, (r) => {
      let b = ""; r.setEncoding("utf8"); r.on("data", (c) => { if (b.length < 4096) b += c; });
      r.on("end", () => res({ status: r.statusCode, body: b }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => res({ status: 0, body: "" }));
  });
}
(async () => {
  const anon = await get(false);
  let out = "anon=" + anon.status + " ";
  if (!secret) { process.stdout.write(out + "mode=ERR:no_secret_file"); return; }
  const r = await get(true);
  try {
    const j = JSON.parse(r.body);
    if (r.status === 200 && j && typeof j.mode === "string") {
      out += "mode=" + j.mode.replace(/[^a-z]/g, "") + " chat=" + (j.chat_enabled === true ? "on" : "off");
    } else out += "mode=ERR:" + r.status + (j && j.error ? ":" + String(j.error).replace(/[^a-z_]/g, "") : "");
  } catch (e) { out += "mode=ERR:" + r.status; }
  process.stdout.write(out);
})();
' "$PGS_LINK" "${PGS_POOL_PORT:-${POOL_PORT:-8080}}" 2>/dev/null || echo "mode=ERR:node"
}

# Scalar read of the games DB AS grinplay, read-only. As root, opening a WAL database can
# create root-owned -wal/-shm sidecars the service then cannot write (the pool's §J16-8
# trap); as grinplay, anything created belongs to the service anyway.
_pgs_db_scalar() { # <sql>
    [[ -f "$PGS_DB" ]] || return 1
    command -v runuser >/dev/null 2>&1 || return 1
    # cd / first: root's cwd is usually unreadable to grinplay.
    ( cd / && runuser -u "$PGS_USER" -- node -e '
try {
  const { DatabaseSync } = require("node:sqlite");
  const d = new DatabaseSync(process.argv[1], { readOnly: true });
  const row = d.prepare(process.argv[2]).get();
  process.stdout.write(String(row ? Object.values(row)[0] : ""));
} catch (e) { process.exit(1); }
' "$PGS_DB" "$1" ) 2>/dev/null
}

pgs_status() {
    _pgs_resolve_conf || true
    echo -e "\n${BOLD}Games — status (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────${RESET}"
    if ! pgs_installed; then
        echo -e "  Not installed. ${DIM}P → 1 installs it (the pool is not restarted).${RESET}"
        return 0
    fi
    local active enabled nr since
    active=$(systemctl is-active "$PGS_SERVICE" 2>/dev/null || true)
    enabled=$(systemctl is-enabled "$PGS_SERVICE" 2>/dev/null || true)
    nr=$(systemctl show "$PGS_SERVICE" -p NRestarts --value 2>/dev/null || echo "?")
    since=$(systemctl show "$PGS_SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null || echo "?")
    if [[ "$active" == "active" ]]; then
        echo -e "  Service   : ${GREEN}● running${RESET}  ${DIM}($PGS_SERVICE, $enabled, since ${since:-?}, NRestarts ${nr:-?})${RESET}"
    else
        echo -e "  Service   : ${RED}● ${active:-unknown}${RESET}  ${DIM}($PGS_SERVICE, $enabled, NRestarts ${nr:-?})${RESET}"
        local st; st=$(systemctl show "$PGS_SERVICE" -p ExecMainStatus --value 2>/dev/null || true)
        [[ "$st" == "78" ]] && echo -e "  ${RED}Last exit 78 = bad configuration${RESET} ${DIM}— the reason is the last line of $PGS_LOG${RESET}"
    fi
    local lst; lst=$(ss -tlnH "sport = :$PGS_PORT" 2>/dev/null | awk '{print $4}' | head -3 | tr '\n' ' ')
    if [[ -n "$lst" ]]; then
        if [[ "$lst" == *"127.0.0.1:$PGS_PORT"* && "$lst" != *"0.0.0.0"* && "$lst" != *"*:"* && "$lst" != *"[::]"* ]]; then
            echo -e "  Listener  : ${GREEN}$lst${RESET}"
        else
            echo -e "  Listener  : ${RED}$lst${RESET} ${RED}(expected 127.0.0.1:$PGS_PORT only)${RESET}"
        fi
    else
        echo -e "  Listener  : ${DIM}nothing on :$PGS_PORT${RESET}"
    fi
    local h; h=$(_pgs_health_json)
    if [[ "$h" == *'"ok":true'* ]]; then echo -e "  Health    : ${GREEN}ok${RESET} ${DIM}$h${RESET}"
    else echo -e "  Health    : ${RED}no answer${RESET}"; fi
    if [[ -f "$PGS_DB" ]]; then
        local sz sv
        sz=$(du -sh "$PGS_DB" 2>/dev/null | cut -f1 || echo "?")
        sv=$(_pgs_db_scalar "SELECT value FROM meta WHERE key = 'schema_version'" || true)
        echo -e "  Database  : $PGS_DB  ${DIM}($sz, schema v${sv:-?})${RESET}"
    else
        echo -e "  Database  : ${DIM}not created yet ($PGS_DB)${RESET}"
    fi
    if _pgs_link_ok; then
        local lm; lm=$(stat -c '%U:%G %a' "$PGS_LINK" 2>/dev/null || echo "?")
        if [[ "$lm" == "$PGS_USER:grinpool 440" ]]; then
            echo -e "  Link file : ${GREEN}present${RESET} ${DIM}($PGS_LINK, $lm)${RESET}"
        else
            echo -e "  Link file : ${YELLOW}present, $lm${RESET} ${DIM}(expected $PGS_USER:grinpool 440 — P → 1 repairs it)${RESET}"
        fi
    else
        echo -e "  Link file : ${RED}missing or short${RESET} ${DIM}($PGS_LINK — P → 1 creates it)${RESET}"
    fi
    local probe mode anon
    probe=$(_pgs_pool_config_probe)
    anon=$(sed -n 's/.*anon=\([0-9]*\).*/\1/p' <<<"$probe")
    mode=$(sed -n 's/.*mode=\([^ ]*\).*/\1/p' <<<"$probe")
    case "$mode" in
        off)     echo -e "  Pool mode : ${DIM}off${RESET} ${DIM}(pool setting; public /play/ routes 404)${RESET}" ;;
        preview) echo -e "  Pool mode : ${YELLOW}preview${RESET} ${DIM}(works by direct URL, nav link hidden)${RESET}" ;;
        on)      echo -e "  Pool mode : ${GREEN}on${RESET}" ;;
        *)       echo -e "  Pool mode : ${RED}unknown${RESET} ${DIM}(pool answered ${mode#ERR:} — is the pool running and deployed with the games link?)${RESET}" ;;
    esac
    # The games' own half of the switch (§19.17.2): the pages follow the LOWER of the two.
    case "$h" in
        *'"launch":"on"'*)      echo -e "  Launch    : ${GREEN}live${RESET} ${DIM}(admin → Games → Overview)${RESET}" ;;
        *'"launch":"preview"'*) echo -e "  Launch    : ${YELLOW}preview${RESET} ${DIM}(menu hidden until Go live — admin → Games → Overview)${RESET}" ;;
        *)                      echo -e "  Launch    : ${DIM}unknown (no health answer)${RESET}" ;;
    esac
    [[ "$probe" == *"chat="* ]] && echo -e "  Chat      : $(sed -n 's/.*chat=\([a-z]*\).*/\1/p' <<<"$probe")"
    if [[ "$anon" == "401" ]]; then
        echo -e "  Internal  : ${GREEN}401 without the secret${RESET}"
    else
        echo -e "  Internal  : ${RED}${anon:-?} without the secret (expected 401)${RESET}"
    fi
    local snip="${RED}missing${RESET}" inc="${RED}missing${RESET}"
    [[ -f "$PGS_NGINX_SNIPPET" ]] && snip="${GREEN}present${RESET}"
    grep -qF "script07-${POOL_SERVICE}-games-*.conf" "$POOL_NGINX_CONF" 2>/dev/null && inc="${GREEN}present${RESET}"
    echo -e "  nginx     : snippet $snip · vhost include $inc"
    # Impact budget 1 (§19.2): the pool's own restart counter, to compare before/after.
    local pnr pts
    pnr=$(systemctl show "$POOL_SERVICE" -p NRestarts --value 2>/dev/null || echo "?")
    pts=$(systemctl show "$POOL_SERVICE" -p ActiveEnterTimestamp --value 2>/dev/null || echo "?")
    echo -e "  ${DIM}Pool      : $POOL_SERVICE NRestarts ${pnr:-?}, active since ${pts:-?} — nothing under P changes these${RESET}"
    return 0
}

# ─── 6) Logs ──────────────────────────────────────────────────────────────────
pgs_view_logs() {
    [[ -f "$PGS_LOG" ]] || { warn "Log file not found: $PGS_LOG"; return 0; }
    tail -n 50 "$PGS_LOG" | less -FRX
}

# ─── 7) Rotate the link secret (§19.3) ────────────────────────────────────────
pgs_rotate_secret() {
    echo -e "\n${BOLD}Games — rotate the link secret (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "  ${DIM}Atomic replace. Both services re-read the file within about a second; NOTHING${RESET}"
    echo -e "  ${DIM}restarts. A call in flight during the swap may get one 401 and is retried.${RESET}"
    id "$PGS_USER" >/dev/null 2>&1 || { error "Games not installed — run P → 1 first."; return 1; }
    _pgs_resolve_conf || return 1
    echo -ne "  Rotate now? [y/N]: "
    local a; read -r a || a=""
    [[ "${a,,}" == "y" || "${a,,}" == "yes" ]] || { info "Unchanged."; return 0; }
    _pgs_write_link rotate || return 1
    sleep 2
    local probe; probe=$(_pgs_pool_config_probe)
    if [[ "$probe" == *"mode="[a-z]* && "$probe" != *"mode=ERR"* ]]; then
        success "The pool accepts the new secret."
    else
        warn "The pool did not answer with the new secret yet ($probe) — check P → 5 in a moment."
    fi
    return 0
}

# ─── 8) Uninstall ─────────────────────────────────────────────────────────────
# Removes service, unit, nginx snippet + zones, web dir, code dir, logrotate, vacuum cron and
# the link file. Keeps the DB unless confirmed a second time, keeps the grinplay user (the
# pool keeps grinpool the same way) and the pool.json keys (they equal the defaults).
_pgs_remove_nginx() {
    local had=0
    [[ -f "$PGS_NGINX_SNIPPET" || -f "$PGS_ZONE_CONF" ]] && had=1
    # Snippet first, zones second: the snippet references the zones.
    rm -f "$PGS_NGINX_SNIPPET" "$PGS_ZONE_CONF" 2>/dev/null \
        || { error "Could not remove the games nginx files."; return 1; }
    if (( had )) && command -v nginx >/dev/null 2>&1; then
        if declare -F nginx_test_reload >/dev/null 2>&1; then
            nginx_test_reload "after removing the games snippet" || return 1
        elif nginx -t >/dev/null 2>&1; then
            systemctl reload nginx 2>/dev/null || true
        else
            error "nginx -t fails after removing the games snippet — fix before any reboot."; return 1
        fi
    fi
    return 0
}

_pgs_remove_runtime() {
    systemctl stop "$PGS_SERVICE" 2>/dev/null || true
    systemctl disable "$PGS_SERVICE" 2>/dev/null || true
    rm -f "$PGS_UNIT" 2>/dev/null || { error "Could not remove $PGS_UNIT."; return 1; }
    systemctl daemon-reload 2>/dev/null || true
    _pgs_remove_nginx || warn "nginx cleanup reported a problem — see above."
    rm -f "$PGS_LOGROTATE" "$PGS_CRON_VACUUM" "$PGS_VACUUM_BIN" "$PGS_LINK" 2>/dev/null \
        || { error "Could not remove the games cron/logrotate/link files."; return 1; }
    rm -rf "${PGS_WEB_DIR:?}" "${PGS_APP_DIR:?}" 2>/dev/null \
        || { error "Could not remove $PGS_WEB_DIR / $PGS_APP_DIR."; return 1; }
    return 0
}

_pgs_remove_db() {
    rm -rf "${PGS_DATA_DIR:?}" 2>/dev/null || { error "Could not remove $PGS_DATA_DIR."; return 1; }
    return 0
}

pgs_uninstall() {
    echo -e "\n${RED}${BOLD}Games — uninstall (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "  Removes: $PGS_SERVICE + unit · nginx snippet + zones · $PGS_WEB_DIR · $PGS_APP_DIR"
    echo -e "           logrotate · weekly VACUUM cron · link secret ($PGS_LINK)"
    echo -e "  ${DIM}The pool keeps running. Set admin → Settings → Games → mode 'off' first, or the${RESET}"
    echo -e "  ${DIM}pool reports the games as offline until you do (the nav link hides either way).${RESET}"
    _pgs_resolve_conf || true
    echo -ne "  Uninstall the games? [y/N]: "
    local a; read -r a || a=""
    [[ "${a,,}" == "y" || "${a,,}" == "yes" ]] || { info "Cancelled — nothing changed."; return 0; }
    _pgs_remove_runtime || return 1
    success "Games service, files and nginx locations removed."
    if [[ -d "$PGS_DATA_DIR" ]]; then
        echo -e "  ${YELLOW}The database ($PGS_DB) holds every player's points, ratings and games.${RESET}"
        echo -ne "  Delete the games database too? [y/N]: "
        read -r a || a=""
        if [[ "${a,,}" == "y" || "${a,,}" == "yes" ]]; then
            _pgs_remove_db && success "Games database removed."
        else
            info "Database kept ($PGS_DATA_DIR) — a later P → 1 picks it up again."
        fi
    fi
    return 0
}

# ─── Weekly VACUUM (pool C) Cron → 3) ─────────────────────────────────────────
# Stops ONLY the games service, vacuums as grinplay (so the file and any sidecar stay the
# service's), starts it again from a trap. The pool is never touched.
_pgs_write_vacuum_script() {
    local node_bin; node_bin=$(command -v node 2>/dev/null || echo /usr/bin/node)
    cat > "$PGS_VACUUM_BIN" << EOF || { error "Could not write $PGS_VACUUM_BIN"; return 1; }
#!/bin/bash
# Offline VACUUM for $PGS_SERVICE — generated by Script 07 (07_lib_pool_games.sh).
# Stops the GAMES service only (never the pool), compacts grinium-games.db, starts it again.
set -uo pipefail
DB="$PGS_DB"
SVC="$PGS_SERVICE"
log() { echo "[\$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [vacuum] \$*"; }
[[ -f "\$DB" ]] || { log "no database at \$DB — nothing to do"; exit 0; }
was_active=no
if systemctl is-active --quiet "\$SVC"; then was_active=yes; fi
restore() {
  if [[ "\$was_active" == "yes" ]]; then
    systemctl start "\$SVC" && log "\$SVC restarted" || log "FAILED to restart \$SVC"
  fi
}
trap restore EXIT
if [[ "\$was_active" == "yes" ]]; then
  systemctl stop "\$SVC" || { log "could not stop \$SVC — refusing to vacuum a live database"; exit 1; }
  sleep 2
fi
before=\$(stat -c %s "\$DB" 2>/dev/null || echo 0)
# As $PGS_USER and from /, so the rewritten file and any sidecar stay the service's.
cd / || exit 1
if runuser -u $PGS_USER -- $node_bin -e '
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.argv[1]);
d.exec("VACUUM");
d.close();
' "\$DB"; then
  log "VACUUM ok — \$before → \$(stat -c %s "\$DB" 2>/dev/null || echo 0) bytes"
else
  log "VACUUM FAILED — database left as it was"
fi
chmod 600 "\$DB" 2>/dev/null || true
EOF
    chmod 700 "$PGS_VACUUM_BIN" || { error "Could not chmod $PGS_VACUUM_BIN"; return 1; }
    return 0
}

pgs_vacuum_toggle() {
    pgs_installed || { error "Games not installed — run P → 1 first."; return 1; }
    if [[ -f "$PGS_CRON_VACUUM" ]]; then
        rm -f "$PGS_CRON_VACUUM" "$PGS_VACUUM_BIN" || { error "Could not remove the games VACUUM cron."; return 1; }
        success "Weekly games VACUUM disabled."
        return 0
    fi
    _pgs_write_vacuum_script || return 1
    # 03:30, half an hour after the pool's own 03:00 vacuum, so the two never overlap.
    cat > "$PGS_CRON_VACUUM" << EOF || { error "Could not write $PGS_CRON_VACUUM"; return 1; }
30 3 * * 0 root $PGS_VACUUM_BIN >> $PGS_LOG 2>&1
EOF
    success "Weekly games VACUUM enabled (Sunday 03:30 UTC) — stops the games only, never the pool."
    return 0
}

# ─── Backup / restore hooks (D18; called from 07_lib_pool_backup.sh) ─────────
# Snapshot through the SQLite online-backup API (the same call gbe_snapshot_db makes for
# pool.db) but WITHOUT its cp fallback: a raw copy of a live WAL database is not a snapshot,
# and for a best-effort extra "no games data" beats "maybe-torn games data". It runs as
# root, so hand any -wal/-shm it created back to the service (the §J16-8 trap). rc 1 =
# no snapshot; callers treat that as a warning, never as a failed backup.
pgs_snapshot_db() { # <dest file>
    local dst="$1"
    [[ -f "$PGS_DB" ]] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    mkdir -p "$(dirname "$dst")" 2>/dev/null || return 1
    python3 -c 'import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' \
        "$PGS_DB" "$dst" 2>/dev/null || { rm -f "$dst"; return 1; }
    if id "$PGS_USER" >/dev/null 2>&1; then
        chown "$PGS_USER:$PGS_USER" "$PGS_DB-wal" "$PGS_DB-shm" 2>/dev/null || true
    fi
    [[ -s "$dst" ]]
}

# Restore the games DB from a DECRYPTED pool archive, if it holds one. Asks first, default
# Y (D18). Never fails the pool restore: every problem is a warning and rc 1 at most.
# The old DB is kept beside it as grinium-games.db.pre-restore (one generation).
pgs_restore_db_from_archive() { # <clear.tar.gz>
    local clear="$1" rel="${PGS_DB#/}"
    tar -tzf "$clear" "$rel" >/dev/null 2>&1 || return 0   # older archive / games never installed
    echo ""
    echo -e "  ${BOLD}This archive also holds the games database${RESET} ${DIM}(points, ratings, finished games).${RESET}"
    echo -ne "  Restore the games database too? [Y/n]: "
    local a; read -r a || a="n"   # EOF declines
    if [[ "${a,,}" == "n" || "${a,,}" == "no" ]]; then info "Games database left as it is."; return 0; fi

    local tmpd; tmpd=$(mktemp -d /tmp/grin_pubgames_restore_XXXXXX 2>/dev/null) \
        || { warn "mktemp failed — games database NOT restored."; return 1; }
    if ! tar -xzf "$clear" -C "$tmpd" "$rel" 2>/dev/null || [[ ! -s "$tmpd/$rel" ]]; then
        rm -rf "$tmpd"; warn "Could not extract the games database — NOT restored."; return 1
    fi
    local was_active=0
    if systemctl is-active --quiet "$PGS_SERVICE" 2>/dev/null; then
        was_active=1
        systemctl stop "$PGS_SERVICE" 2>/dev/null \
            || { rm -rf "$tmpd"; warn "Could not stop $PGS_SERVICE — games database NOT restored."; return 1; }
    fi
    if ! mkdir -p "$PGS_DATA_DIR" 2>/dev/null || ! chmod 700 "$PGS_DATA_DIR" 2>/dev/null; then
        rm -rf "$tmpd"; warn "Could not prepare $PGS_DATA_DIR — games database NOT restored."
        (( was_active )) && systemctl start "$PGS_SERVICE" 2>/dev/null
        return 1
    fi
    # Stale sidecars would be replayed onto the restored file: move them aside WITH the old
    # DB (a -wal belongs to its own database), so neither copy is corrupted.
    local f
    for f in "" "-wal" "-shm"; do
        if [[ -e "$PGS_DB$f" ]]; then
            mv -f "$PGS_DB$f" "$PGS_DB.pre-restore$f" 2>/dev/null \
                || { rm -rf "$tmpd"; warn "Could not move $PGS_DB$f aside — games database NOT restored."
                     (( was_active )) && systemctl start "$PGS_SERVICE" 2>/dev/null; return 1; }
        else
            rm -f "$PGS_DB.pre-restore$f" 2>/dev/null || true
        fi
    done
    if ! mv -f "$tmpd/$rel" "$PGS_DB" 2>/dev/null; then
        rm -rf "$tmpd"; warn "Could not move the restored games database into place (old one is at $PGS_DB.pre-restore)."
        return 1
    fi
    rm -rf "$tmpd"
    chmod 600 "$PGS_DB" 2>/dev/null || true
    if id "$PGS_USER" >/dev/null 2>&1; then
        chown -R "$PGS_USER:$PGS_USER" "$PGS_DATA_DIR" 2>/dev/null || warn "Could not chown $PGS_DATA_DIR to $PGS_USER."
    else
        info "Games are not installed on this box yet — P → 1 takes ownership of the restored database."
    fi
    success "Games database restored (previous copy: $PGS_DB.pre-restore)."
    if (( was_active )); then
        systemctl start "$PGS_SERVICE" 2>/dev/null && info "$PGS_SERVICE started again." \
            || warn "$PGS_SERVICE did not start — P → 4."
    fi
    return 0
}

# ─── Z) Cleanup hook (called from pool_cleanup) ──────────────────────────────
pgs_cleanup_marks() {
    echo -e "    Games service + files       $(_pool_cleanup_mark "$PGS_UNIT")"
    echo -e "    Games database              $(_pool_cleanup_mark "$PGS_DATA_DIR")"
}

pgs_cleanup_group() { # <step label> <database step label>
    local label="$1" dlabel="${2:-$1b}" a
    _pgs_resolve_conf >/dev/null 2>&1 || true
    if [[ -f "$PGS_UNIT" || -d "$PGS_APP_DIR" || -d "$PGS_WEB_DIR" || -f "$PGS_NGINX_SNIPPET" \
          || -f "$PGS_ZONE_CONF" || -f "$PGS_LOGROTATE" || -f "$PGS_LINK" || -f "$PGS_CRON_VACUUM" ]]; then
        echo -ne "${BOLD}${label})${RESET} Remove the games service, files, nginx snippet + zones, logrotate, cron, link secret? [Y/n]: "
        read -r a || a="n"
        if [[ "${a,,}" != "n" && "${a,,}" != "no" ]]; then
            if _pgs_remove_runtime; then
                success "Games service + files removed."
                log "Cleanup: removed $PGS_SERVICE, $PGS_APP_DIR, $PGS_WEB_DIR, $PGS_NGINX_SNIPPET, $PGS_ZONE_CONF, $PGS_LOGROTATE, $PGS_LINK"
            fi
            rm -f "$PGS_LOG" "$PGS_LOG".* 2>/dev/null || true
        fi
        echo ""
    fi
    if [[ -d "$PGS_DATA_DIR" ]]; then
        echo -e "   ${YELLOW}⚠ $PGS_DB holds every player's points, ratings and games.${RESET}"
        echo -ne "${BOLD}${dlabel})${RESET} Remove the games database ($PGS_DATA_DIR)? [y/N]: "
        read -r a || a=""
        if [[ "${a,,}" == "y" || "${a,,}" == "yes" ]]; then
            _pgs_remove_db && { success "Games database removed."; log "Cleanup: removed $PGS_DATA_DIR"; }
        else
            info "Games database kept."
        fi
        echo ""
    fi
    return 0
}

# ─── Menu P ───────────────────────────────────────────────────────────────────
_pgs_menu_state() {
    if ! pgs_installed; then echo -e "${DIM}not installed${RESET}"; return 0; fi
    if systemctl is-active --quiet "$PGS_SERVICE" 2>/dev/null; then echo -e "${GREEN}running${RESET}"
    else echo -e "${RED}stopped${RESET}"; fi
}

pool_games_menu() {
    local c
    while true; do
        clear
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${BOLD}${CYAN}  Play & chat (games) — ${POOL_NET_LABEL:-$POOL_NET}${RESET}"
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "  ${DIM}/play/ runs as its own service ($PGS_SERVICE). Nothing here restarts the pool.${RESET}"
        echo -e "  ${DIM}Public switches: admin → Settings → Games (off / preview / on) and Games → Overview (Go live).${RESET}"
        echo -e "  Service: $(_pgs_menu_state)"
        echo ""
        echo -e "  ${GREEN}1${RESET}) Install / repair       ${DIM}(user, dirs, link secret, code, unit, start)${RESET}"
        echo -e "  ${GREEN}2${RESET}) Deploy games code      ${DIM}(refresh from checkout, restart games only)${RESET}"
        echo -e "  ${GREEN}3${RESET}) Nginx                  ${DIM}(write /play/ locations + reload + route check)${RESET}"
        echo -e "  ${GREEN}4${RESET}) Service control        ${DIM}(start / stop / restart games)${RESET}"
        echo -e "  ${GREEN}5${RESET}) Status                 ${DIM}(unit, listener, DB, mode, internal auth)${RESET}"
        echo -e "  ${GREEN}6${RESET}) Logs                   ${DIM}(tail -50 | less)${RESET}"
        echo -e "  ${YELLOW}7${RESET}) Rotate link secret     ${DIM}(atomic replace, no restarts)${RESET}"
        echo -e "  ${RED}8${RESET}) Uninstall              ${DIM}(keeps the database unless you confirm twice)${RESET}"
        echo ""
        echo -e "  ${RED}0${RESET}) Back"
        echo ""
        echo -ne "${BOLD}Select [1-8/0]: ${RESET}"
        read -r c || c=0
        case "${c,,}" in
            "") continue ;;
            1) pgs_install       || true; _pool_pause ;;
            2) pgs_deploy_code   || true; _pool_pause ;;
            3) pgs_setup_nginx   || true; _pool_pause ;;
            4) pgs_service_menu  || true; _pool_pause ;;
            5) pgs_status        || true; _pool_pause ;;
            6) pgs_view_logs     || true ;;
            7) pgs_rotate_secret || true; _pool_pause ;;
            8) pgs_uninstall     || true; _pool_pause ;;
            0|q|exit) return 0 ;;
            *) warn "Invalid option."; sleep 1 ;;
        esac
    done
}
