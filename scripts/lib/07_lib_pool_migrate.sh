# =============================================================================
# 07_lib_pool_migrate.sh — guided HUB MOVE for the public pool (Migrate OUT / IN)
# =============================================================================
# Moves a live hub to a new box with every byte of state kept (balances,
# shares, hashrate history, audit, wallet seed, WG identity, TLS cert) and the
# least downtime. One half per box, both on B) Backup & Restore:
#   6) pmg_migrate_out   OLD hub: freeze → evidence → stop → manifest → final
#                        archive (+ cert) → transfer → runbook
#   7) pmg_migrate_in    NEW hub: checks (old hub DARK) → restore (frozen) →
#                        location → bring-up → continuity → start → DNS →
#                        gateway watch. CHECK = the read-only half, run BEFORE
#                        Migrate OUT. Its own order note sits above it below.
#
# The ORDER inside pmg_migrate_out IS the safety design — keep it:
#   · Two live pools on one wallet seed must never happen. Payouts are frozen
#     FIRST, while the service still runs (the scheduler re-reads payout_control
#     on every loop, so the live process obeys it at once and cannot start a
#     payout while we wait). Every restart path is then DISABLED, not just
#     stopped — pool service, the wallet listener's @reboot line and its */5
#     watchdog — so a reboot of this box cannot bring a second pool back.
#   · The final archive is taken AFTER everything stops, so pool.db and the
#     wallet it describes leave the box as one consistent pair.
#   · The hub's WireGuard goes DOWN and is disabled at boot. While it still
#     handshakes, a gateway's re-resolve timer sees a fresh handshake and never
#     looks up the new IP, so gateways would stay attached to this box.
#   · Every step is idempotent. Resuming after ANY failure is: fix the cause,
#     run B → 6 again. Nothing in this file ever unfreezes payouts.
#
# Manifest: $POOL_APP_DIR/migration_manifest.json, written before the archive
# so it rides inside it. Schema: see _PMG_JS_DB (mode "manifest"). Migrate IN
# compares its ledger figures AND per-row digests with the restored pool.db
# (mode "continuity" — they must be EQUAL), and probes source.public_ip on the
# stratum port and the pool API to prove the old hub is dark. On a successful
# start the live copy is renamed migration_manifest.applied-<UTC>.json, so a
# later backup of the new hub never carries it as if it were fresh.
#
# Sourced at the END of 07_lib_pool_backup.sh (reuses pbk_freeze_payouts,
# _pbk_build_archive, _pbk_restore_extract/_perms, PBK_*). pw_*, gnc_*, gwi_*,
# WG_*, pool_read_conf / pool_write_conf_key / pool_deroot / pool_deploy_web /
# pool_setup_nginx belong to the parent script and are referenced at CALL time.
# ⚠ Runs WITHOUT errexit — the menu calls it `|| true`, which disables set -e
#   for the whole body (memory project_lib_errexit_suppression). Every step
#   checks its own result. Convention: sourced lib → NO shebang / NO `set -e`.
# =============================================================================

[[ -n "${_GRIN_POOL_MIGRATE_SH_LOADED:-}" ]] && return 0
_GRIN_POOL_MIGRATE_SH_LOADED=1

PMG_MANIFEST_NAME="migration_manifest.json"
PMG_FREEZE_REASON="hub migration in progress"
PMG_FREEZE_BY="migrate-out"
# Where Migrate IN looks first. Same path as this box's archive dir on purpose.
PMG_REMOTE_DIR_DEFAULT="/opt/grin/backups"

if ! declare -F info    >/dev/null 2>&1; then info()    { echo "[INFO]  $*"; }; fi
if ! declare -F warn    >/dev/null 2>&1; then warn()    { echo "[WARN]  $*"; }; fi
if ! declare -F error   >/dev/null 2>&1; then error()   { echo "[ERROR] $*" >&2; }; fi
if ! declare -F success >/dev/null 2>&1; then success() { echo "[OK]    $*"; }; fi

# ─── pool.db reader (node:sqlite — node is a hard dependency of this product) ─
# argv: <db> <mode> <app_dir> <local_region> [<manifest_out | manifest_in>]
#   mode "inflight"   → one TSV line per in-flight withdrawal (id amount status method addr)
#   mode "facts"      → the JSON block below, on stdout
#   mode "manifest"   → facts + row digests + PMG_M_* / PMG_W_* env → <manifest_out>
#                       (0600, atomic)
#   mode "continuity" → Migrate IN: this DB vs <manifest_in>, one TSV line per figure
#                       (label, expected, actual, ok|BAD|skip); rc 4 when any is BAD
# "In flight" is the scheduler's own PENDING_SQL, read out of the DEPLOYED
# lib/withdrawal-scheduler.js so this list can never drift from what the
# scheduler treats as pending; FALLBACK is used only if that file is unreadable.
# In "continuity" mode it is the MANIFEST's sql instead: the new box may run newer
# code, and a different status list would make identical ledgers compare unequal.
# Opened read-write on purpose: the last connection to close checkpoints and
# removes the WAL, so no root-owned -wal/-shm is left behind (and the chown in
# _pmg_rechown_db covers the rest).
#
# Digests (manifest + continuity only — they read every row): a sum or a count
# can match while two balances are swapped, so each money table is also hashed
# row by row, in id order, over the columns that ARE the money: sha256 of one
# JSON array per row. Explicit column lists, never SELECT * — blocks carries a
# u64 nonce, and node:sqlite throws on an INTEGER past 2^53 (memory
# reference_nodesqlite_u64_throws). shares is counted, never hashed: millions
# of rows, and no balance lives in it.
read -r -d '' _PMG_JS_DB <<'JS' || true
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const [dbPath, mode, appDir, localRegion, outPath] = process.argv.slice(1);
const FALLBACK = "status IN ('tor_checking','tor_sending','retry_scheduled','slatepack_pending','finalizing')";
const SAFE_PENDING = /^status IN \(('[a-z_]+'\s*,?\s*)+\)$/;
let pending = FALLBACK, pendingSrc = 'fallback';
let man = null;
if (mode === 'continuity') {
  try { man = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (e) { console.error('manifest unreadable: ' + e.message); process.exit(2); }
  const ms = man && man.in_flight_statuses && man.in_flight_statuses.sql;
  if (typeof ms === 'string' && SAFE_PENDING.test(ms)) { pending = ms; pendingSrc = 'manifest'; }
} else {
  try {
    const src = fs.readFileSync(appDir + '/lib/withdrawal-scheduler.js', 'utf8');
    const m = src.match(/const PENDING_SQL\s*=\s*"(status IN \([^"]+\))"/);
    if (m && SAFE_PENDING.test(m[1])) { pending = m[1]; pendingSrc = 'scheduler'; }
  } catch (e) { /* fallback */ }
}
const d = new DatabaseSync(dbPath);
d.exec('PRAGMA busy_timeout = 15000');
const get = (sql, ...a) => { try { return d.prepare(sql).get(...a) || null; } catch (e) { return null; } };
const num = (v) => (v === null || v === undefined) ? null : Number(v);

if (mode === 'inflight') {
  let rows;
  try {
    rows = d.prepare('SELECT id, amount, status, method, grin_address FROM withdrawals WHERE ' + pending + ' ORDER BY id').all();
  } catch (e) { d.close(); console.error('withdrawals unreadable: ' + e.message); process.exit(2); }
  for (const r of rows) {
    console.log([r.id, r.amount, r.status, r.method, String(r.grin_address || '').slice(0, 14)].join('\t'));
  }
  d.close();
  process.exit(0);
}

const acc = get('SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS b, COALESCE(SUM(balance_locked),0) AS l FROM miner_accounts');
const sh  = get('SELECT COUNT(*) AS c, MAX(id) AS m, MAX(created_at) AS t FROM shares');
const bl  = get('SELECT COUNT(*) AS c, MAX(id) AS m FROM blocks');
const wd  = get('SELECT COUNT(*) AS c, MAX(id) AS m FROM withdrawals');
const wf  = get('SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS a FROM withdrawals WHERE ' + pending);
const lg  = get('SELECT COUNT(*) AS c, MAX(id) AS m FROM balance_log');
const pc  = get('SELECT frozen, reason, frozen_by, frozen_at FROM payout_control WHERE id = 1');
const lr  = get("SELECT value FROM pool_config WHERE section = '_state' AND key = 'local_region'");
const wi  = get('SELECT slatepack_address FROM wallet_identity WHERE id = 1');
const loc = get('SELECT stratum_url, is_active FROM pool_locations WHERE region = ?', String(localRegion || ''));
const digest = (sql) => {
  try {
    const h = crypto.createHash('sha256');
    for (const r of d.prepare(sql).iterate()) { h.update(JSON.stringify(Object.values(r))); h.update('\n'); }
    return h.digest('hex');
  } catch (e) { return null; }
};
const dg = (mode === 'manifest' || mode === 'continuity') ? {
  accounts:    digest('SELECT id, grin_address, balance, balance_locked FROM miner_accounts ORDER BY id'),
  blocks:      digest('SELECT id, height, hash, reward, status FROM blocks ORDER BY id'),
  withdrawals: digest('SELECT id, grin_address, amount, fee, fee_charged, status, method FROM withdrawals ORDER BY id'),
  balance_log: digest('SELECT id, grin_address, amount, balance_after, locked_after FROM balance_log ORDER BY id'),
} : {};
d.close();

const facts = {
  ok: !!(acc && sh && bl && wd),
  ledger: {
    accounts:    acc ? { count: num(acc.c), balance_sum: num(acc.b), balance_locked_sum: num(acc.l), digest: dg.accounts } : null,
    shares:      sh  ? { count: num(sh.c), max_id: num(sh.m), latest_at: num(sh.t) } : null,
    blocks:      bl  ? { count: num(bl.c), max_id: num(bl.m), digest: dg.blocks } : null,
    withdrawals: wd  ? { count: num(wd.c), max_id: num(wd.m),
                         in_flight_count: wf ? num(wf.c) : null, in_flight_amount: wf ? num(wf.a) : null,
                         digest: dg.withdrawals } : null,
    balance_log: lg  ? { count: num(lg.c), max_id: num(lg.m), digest: dg.balance_log } : null,
  },
  in_flight_statuses: { sql: pending, source: pendingSrc },
  payout_control: pc ? { frozen: num(pc.frozen), reason: pc.reason, frozen_by: pc.frozen_by, frozen_at: num(pc.frozen_at) } : null,
  local_region_stamp: lr ? lr.value : null,
  local_region_row: loc ? { stratum_url: loc.stratum_url, is_active: num(loc.is_active) } : null,
  wallet_identity: wi ? wi.slatepack_address : null,
};
if (mode === 'facts') { console.log(JSON.stringify(facts)); process.exit(0); }
if (mode === 'continuity') {
  // EQUAL or it is BAD: nothing runs between Migrate OUT's manifest and its archive, so
  // any difference at all means the wrong archive, a damaged one, or a ledger that moved.
  // A figure the manifest does not carry (an older manifest) is "skip", never "ok".
  const ml = man.ledger || {};
  const pick = (o, p) => p.split('.').reduce((x, k) => (x === null || x === undefined) ? undefined : x[k], o);
  const show = (v) => (v === null || v === undefined) ? '-' : (typeof v === 'string' && v.length === 64 ? v.slice(0, 12) + '…' : String(v));
  let bad = 0;
  const row = (label, exp, act) => {
    let verdict;
    if (exp === null || exp === undefined) verdict = 'skip';
    else verdict = (exp === act) ? 'ok' : 'BAD';
    if (verdict === 'BAD') bad++;
    console.log([label, show(exp), show(act), verdict].join('\t'));
  };
  for (const p of ['accounts.count', 'accounts.balance_sum', 'accounts.balance_locked_sum', 'accounts.digest',
                   'shares.count', 'shares.max_id', 'shares.latest_at',
                   'blocks.count', 'blocks.max_id', 'blocks.digest',
                   'withdrawals.count', 'withdrawals.max_id', 'withdrawals.in_flight_count',
                   'withdrawals.in_flight_amount', 'withdrawals.digest',
                   'balance_log.count', 'balance_log.max_id', 'balance_log.digest']) {
    row(p, pick(ml, p), pick(facts.ledger, p));
  }
  row('wallet_identity', man.wallet_identity, facts.wallet_identity);
  process.exit(bad ? 4 : 0);
}
if (mode !== 'manifest' || !outPath) { console.error('bad mode'); process.exit(2); }

const E = process.env;
const s = (k) => (E[k] === undefined || E[k] === '') ? null : E[k];
const i = (k) => { const v = s(k); return v !== null && /^[0-9]+$/.test(v) ? Number(v) : null; };
// Amounts stay STRINGS exactly as grin-wallet printed them: a float round-trip is how
// 0.1 + 0.2 ends up in a comparison that is supposed to prove nothing moved.
const amt = (k) => { const v = s(k); return v !== null && /^[0-9]+(\.[0-9]+)?$/.test(v) ? v : null; };
let before = null;
try { before = s('PMG_M_PAYOUT_BEFORE') ? JSON.parse(E.PMG_M_PAYOUT_BEFORE) : null; } catch (e) { before = null; }
const now = new Date();
const manifest = {
  schema: 1,
  kind: 'grin-pubpool-migration',
  created_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  created_at_unix: Math.floor(now.getTime() / 1000),
  net: s('PMG_M_NET'),
  product: s('PMG_M_PRODUCT'),
  archive_name: s('PMG_M_ARCHIVE_NAME'),
  source: { hostname: s('PMG_M_HOSTNAME'), public_ip: s('PMG_M_PUBLIC_IP'), mode: s('PMG_M_MODE') },
  pool: {
    domain: s('PMG_M_DOMAIN'),
    stratum_port: i('PMG_M_STRATUM_PORT'),
    local_region: s('PMG_M_REGION'),
    local_region_stamp: facts.local_region_stamp,
    local_region_row: facts.local_region_row,
    cloudflare_proxy: s('PMG_M_CF_PROXY'),
  },
  wireguard: { iface: s('PMG_M_WG_IFACE'), listen_port: i('PMG_M_WG_PORT'), endpoint_host: s('PMG_M_WG_ENDPOINT_HOST') },
  node: { height: i('PMG_M_NODE_HEIGHT') },
  wallet: {
    ok: s('PMG_W_OK') === '1',
    error: s('PMG_W_ERROR'),
    height: i('PMG_W_HEIGHT'),
    refreshed_from_node: s('PMG_W_REFRESHED') === '1',
    total: amt('PMG_W_TOTAL'),
    awaiting_confirmation: amt('PMG_W_AWAIT_CONF'),
    awaiting_finalization: amt('PMG_W_AWAIT_FIN'),
    immature: amt('PMG_W_IMMATURE'),
    locked: amt('PMG_W_LOCKED'),
    spendable: amt('PMG_W_SPENDABLE'),
  },
  wallet_identity: facts.wallet_identity,
  ledger: facts.ledger,
  in_flight_statuses: facts.in_flight_statuses,
  payout_control: { before: before, after: facts.payout_control },
  certs_included: s('PMG_M_CERTS'),
};
const tmp = outPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, outPath);
console.log(facts.ok ? 'OK' : 'INCOMPLETE');
process.exit(facts.ok ? 0 : 3);
JS

_pmg_conf() {
    if declare -F pool_read_conf >/dev/null 2>&1; then pool_read_conf "$1" "${2:-}"; else echo "${2:-}"; fi
}
_pmg_db() { echo "$POOL_APP_DIR/pool.db"; }
_pmg_log() {
    mkdir -p "$(dirname "$PBK_LOG")" 2>/dev/null || true
    echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ${_PMG_LOG_TAG:-migrate-out}: $*" >> "$PBK_LOG" 2>/dev/null || true
}
# Root opened the DB — hand any sidecar it created back to the de-rooted service
# (§J16-8's trap: a root-owned -wal/-shm stops a grinpool-run pool writing).
_pmg_rechown_db() {
    local db; db=$(_pmg_db)
    if id grinpool >/dev/null 2>&1; then
        chown grinpool:grinpool "$db" "$db-wal" "$db-shm" 2>/dev/null || true
    fi
}
_pmg_js() {  # <mode> [manifest_out] — runs _PMG_JS_DB against this net's pool.db
    node -e "$_PMG_JS_DB" "$(_pmg_db)" "$1" "$POOL_APP_DIR" "$(_pmg_conf region main)" "${2:-}" 2>/dev/null
}
# The cert paths that WILL go into this archive (flag raised by pmg_migrate_out).
_pmg_cert_paths() { if [[ "$PBK_INCLUDE_CERTS" == "1" ]]; then _pbk_cert_paths; fi; }
_pmg_port_listening() {
    if declare -F gnc_get_pid_on_port >/dev/null 2>&1; then
        gnc_get_pid_on_port "$1" >/dev/null 2>&1
    else
        ss -tln 2>/dev/null | grep -q ":$1 "
    fi
}
_pmg_frozen_by() {  # echoes payout_control.frozen_by when frozen, else nothing
    _pmg_js facts | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const p=JSON.parse(s).payout_control;if(p&&p.frozen===1)process.stdout.write(String(p.frozen_by||"?"));}catch(e){}})' 2>/dev/null
}

# ─── State / rollback screens (every failure path and the final screen) ───────
_pmg_print_state() {
    local fb pay svc_a svc_e lst wd ar wg_up wg_en cron
    fb=$(_pmg_frozen_by)
    if [[ -n "$fb" ]]; then pay="${GREEN}FROZEN${RESET} ${DIM}(by $fb)${RESET}"; else pay="${RED}NOT frozen${RESET}"; fi
    svc_a=$(systemctl is-active "$POOL_SERVICE" 2>/dev/null); svc_e=$(systemctl is-enabled "$POOL_SERVICE" 2>/dev/null)
    if _pmg_port_listening "${PW_OWNER_PORT:-3420}"; then lst="${YELLOW}listening on :${PW_OWNER_PORT:-3420}${RESET}"; else lst="stopped"; fi
    wd="absent"; [[ -f "${PW_WATCHDOG_CRON:-/nonexistent}" ]] && wd="${YELLOW}present${RESET}"
    ar="absent"; crontab -l 2>/dev/null | grep -qF "${PW_AUTOSTART_TAG:-#none}" && ar="${YELLOW}present${RESET}"
    wg_up="down"; ip link show "${WG_IFACE:-none}" >/dev/null 2>&1 && wg_up="${YELLOW}UP${RESET}"
    wg_en=$(systemctl is-enabled "wg-quick@${WG_IFACE:-none}" 2>/dev/null)
    cron="off"; [[ -f "$PBK_CRON" ]] && cron="on"
    echo -e "  ${BOLD}State of this box now:${RESET}"
    echo -e "    payouts          : $pay"
    echo -e "    pool service     : ${svc_a:-unknown} · ${svc_e:-unknown}  ${DIM}($POOL_SERVICE)${RESET}"
    echo -e "    wallet listener  : $lst  ${DIM}· watchdog $wd · @reboot $ar${RESET}"
    echo -e "    hub WireGuard    : $wg_up · boot ${wg_en:-n/a}  ${DIM}(${WG_IFACE:-none})${RESET}"
    echo -e "    daily backup     : $cron   ${DIM}· grin node: left running${RESET}"
}

_pmg_print_rollback() {
    echo -e "  ${BOLD}Rollback (bring THIS box back) — valid ONLY while the new hub has accepted${RESET}"
    echo -e "  ${BOLD}no shares and paid nothing:${RESET}"
    echo -e "    ${DIM}# the new hub, if started, must be stopped + disabled FIRST${RESET}"
    if [[ -f "${WG_CONF:-/nonexistent}" ]]; then
        echo -e "    systemctl enable --now wg-quick@${WG_IFACE}"
    fi
    echo -e "    env SHELL=/bin/bash $(pw_boot_script 2>/dev/null || echo '<wallet dir>/pool-wallet-boot.sh')   ${DIM}# listener + unlock${RESET}"
    echo -e "    systemctl enable --now $POOL_SERVICE"
    echo -e "    ${DIM}then: pool menu 5) → 6) e (boot autostart) + 7) i (watchdog); B → 3) daily backup;${RESET}"
    echo -e "    ${DIM}reconcile, THEN resume payouts in admin → Payouts (never before).${RESET}"
}

_pmg_fail() {  # <step label> <message>
    echo ""
    error "Migrate OUT stopped at step $1: $2"
    warn "Payouts stay FROZEN. Nothing here unfreezes them."
    echo ""
    _pmg_print_state
    echo ""
    echo -e "  ${BOLD}To resume:${RESET} fix the cause above, then run B → 6) Migrate OUT again —"
    echo -e "  ${DIM}every step is idempotent (a finished step is a no-op the second time).${RESET}"
    echo -e "  ${BOLD}To abandon the move:${RESET} use the rollback below."
    echo ""
    _pmg_print_rollback
    _pmg_log "FAILED at step $1: $2"
    return 1
}

# ─── Step 3 helper: one-shot wallet info as evidence ─────────────────────────
# Run AS THE SERVICE USER (a root run would leave root-owned lmdb files the
# de-rooted listener then cannot open) with the passphrase on STDIN from the
# saved file — never -p, which puts it in ps/proc for the whole run
# (CLAUDE.md "Passphrase input"; grin-wallet's rpassword reads a piped stdin).
# Sets PMG_W_*; rc 1 = no usable evidence (the caller carries on regardless).
PMG_W_OK=0; PMG_W_ERROR=""; PMG_W_HEIGHT=""; PMG_W_REFRESHED=0
PMG_W_TOTAL=""; PMG_W_AWAIT_CONF=""; PMG_W_AWAIT_FIN=""; PMG_W_IMMATURE=""; PMG_W_LOCKED=""; PMG_W_SPENDABLE=""
_pmg_wallet_info() {
    PMG_W_OK=0; PMG_W_ERROR=""; PMG_W_HEIGHT=""; PMG_W_REFRESHED=0
    PMG_W_TOTAL=""; PMG_W_AWAIT_CONF=""; PMG_W_AWAIT_FIN=""; PMG_W_IMMATURE=""; PMG_W_LOCKED=""; PMG_W_SPENDABLE=""
    local dir bin pf out rc to=()
    dir=$(pw_wallet_dir 2>/dev/null); bin=$(pw_bin 2>/dev/null); pf=$(pw_pass_file 2>/dev/null)
    if [[ ! -x "$bin" || ! -f "$pf" ]]; then
        PMG_W_ERROR="wallet binary or saved passphrase missing"; return 1
    fi
    command -v timeout >/dev/null 2>&1 && to=(timeout 300)
    if [[ $(id -u) -eq 0 ]] && id grinpool >/dev/null 2>&1; then
        out=$({ cat -- "$pf"; printf '\n'; } | "${to[@]}" su -s /bin/bash grinpool -c \
              "cd '$dir' && HOME='$dir' exec '$bin' ${PW_NET_FLAG:-} --top_level_dir '$dir' info" 2>&1)
        rc=$?
    else
        out=$({ cat -- "$pf"; printf '\n'; } | (cd "$dir" && HOME="$dir" "${to[@]}" "$bin" ${PW_NET_FLAG:-} --top_level_dir "$dir" info) 2>&1)
        rc=$?
    fi
    local line k v
    while IFS= read -r line; do
        [[ "$line" == *"|"* ]] || continue
        k="${line%%|*}"; v="${line#*|}"
        k="${k#"${k%%[![:space:]]*}"}"; k="${k%"${k##*[![:space:]]}"}"
        v="${v//[[:space:]]/}"
        [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] || continue
        case "$k" in
            "Confirmed Total"*)        PMG_W_TOTAL="$v" ;;
            "Awaiting Confirmation"*)  PMG_W_AWAIT_CONF="$v" ;;
            "Awaiting Finalization"*)  PMG_W_AWAIT_FIN="$v" ;;
            "Immature Coinbase"*)      PMG_W_IMMATURE="$v" ;;
            "Locked"*)                 PMG_W_LOCKED="$v" ;;
            "Currently Spendable"*)    PMG_W_SPENDABLE="$v" ;;
        esac
    done <<< "$out"
    if [[ "$out" =~ as\ of\ height\ ([0-9]+) ]]; then PMG_W_HEIGHT="${BASH_REMATCH[1]}"; fi
    # grin-wallet prints this when it could not reach the node and fell back to its cache.
    if ! grep -qi 'failed to verify data against a live node' <<< "$out"; then PMG_W_REFRESHED=1; fi
    if [[ "$rc" -eq 0 && -n "$PMG_W_TOTAL" && -n "$PMG_W_SPENDABLE" ]]; then
        PMG_W_OK=1; return 0
    fi
    PMG_W_ERROR=$(tail -n 1 <<< "$out" | tr -cd '[:print:]' | cut -c1-200)
    [[ -n "$PMG_W_ERROR" ]] || PMG_W_ERROR="grin-wallet info exited $rc"
    return 1
}

# Node tip height from the Owner API get_status (never /v1/ — CLAUDE.md). The
# secret goes to curl as a config on STDIN (-K -), never argv. Empty on failure.
_pmg_node_height() { local s; s=$(_pmg_node_status); echo "${s%% *}"; }

# "<height> <sync_status>" from get_status (sync_status "no_sync" = synced), or empty.
# Needs a PARSED {"Ok":…} result — an HTTP 200 alone proves no node (CLAUDE.md).
_pmg_node_status() {
    local url sec cfg=""
    url=$(_pmg_conf node_api_url "")
    if [[ -z "$url" ]]; then
        if [[ "$POOL_NET" == "testnet" ]]; then url="http://127.0.0.1:13413"; else url="http://127.0.0.1:3413"; fi
    fi
    url="${url%/}"
    sec=$(grin_node_secret_path "$POOL_NET" owner 2>/dev/null || true)
    [[ -n "$sec" && -f "$sec" ]] && cfg="user = \"grin:$(tr -d '[:space:]' < "$sec")\""
    printf '%s' "$cfg" | curl -s --max-time 10 -K - -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' "$url/v2/owner" 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);const r=j.result&&(j.result.Ok||j.result);const h=r&&r.tip&&r.tip.height;if(Number.isInteger(h))process.stdout.write(String(h)+" "+String(r.sync_status||"unknown").replace(/\s/g,"_"));}catch(e){}})' 2>/dev/null
}

_pmg_public_ip() {
    local ip; ip=$(curl -s --max-time 6 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || ( "$ip" == *:* && "$ip" =~ ^[0-9A-Fa-f:]+$ ) ]]; then
        echo "$ip"
    fi
}

# ─── Step 6 helper: prove the archive we are about to carry is usable ────────
# Decrypts with the loaded key and checks that every critical path that EXISTS on
# this box is IN the archive — pool.db, the manifest, pool.json, .wallet_pass, the
# wallet seed, the WG conf — and that each cert live/ link travelled as a SYMLINK
# (tar never got -h). A missing pool.db must fail here, not on the new box.
_pmg_verify_archive() {
    local archive="$1" d tmp list vlist rel p wdir miss=0
    d=$(gbe_parse_date "$archive") || { error "Archive name does not carry a date: $archive"; return 1; }
    tmp=$(mktemp "/tmp/grin_pubpool_mverify_XXXXXX.tar.gz") || { error "mktemp failed."; return 1; }
    if ! gbe_decrypt "$archive" "$tmp" "${GBE_PERSONAL_KEY}${d}"; then
        rm -f "$tmp"; error "The new archive does not decrypt with the loaded personal key."; return 1
    fi
    list=$(tar -tzf "$tmp" 2>/dev/null) || { rm -f "$tmp"; error "The decrypted archive is not a readable tar.gz."; return 1; }
    vlist=$(tar -tvzf "$tmp" 2>/dev/null)
    rm -f "$tmp"
    wdir=$(pw_wallet_dir 2>/dev/null || echo "${POOL_WALLET_DIR:-}")
    for p in "$POOL_APP_DIR/pool.db" "$POOL_APP_DIR/$PMG_MANIFEST_NAME" "$POOL_CONF" \
             "$(pw_pass_file 2>/dev/null)" "$wdir/wallet_data/wallet.seed" "${WG_CONF:-}"; do
        [[ -n "$p" && -e "$p" ]] || continue
        rel="${p#/}"
        if ! grep -qxF "$rel" <<< "$list"; then error "  missing from archive: $p"; miss=1; fi
    done
    if [[ "$PBK_INCLUDE_CERTS" == "1" ]]; then
        while IFS= read -r p; do
            [[ "$p" == */live/* && -d "$p" ]] || continue
            local f
            for f in "$p"/*.pem; do
                [[ -L "$f" ]] || continue
                if ! grep -qF " ${f#/} -> " <<< "$vlist"; then
                    error "  cert link not stored as a symlink: $f"; miss=1
                fi
            done
        done < <(_pbk_cert_paths)
    fi
    [[ "$miss" -eq 0 ]] || { error "The archive is incomplete — do not carry it."; return 1; }
    return 0
}

# ─── Step 7: transfer ────────────────────────────────────────────────────────
# Reuses the offsite push's KEY (if one exists) and ssh options, but never reads or
# writes its saved target (grin_backup_remote.conf) — the new box is a one-off.
# Not BatchMode: a new box usually only has a root password yet, and one
# ControlMaster connection means it is asked for once, not three times.
_pmg_transfer() {
    local archive="$1" sidecar="$2" sha="$3" base; base=$(basename "$archive")
    echo ""
    echo -e "  ${BOLD}Step 7 — get the archive to the new box${RESET}"
    echo -e "    ${GREEN}1${RESET}) Push it now over scp"
    echo -e "    ${GREEN}2${RESET}) Show me the command — I will copy it myself"
    echo -ne "  Select [1/2]: "
    local c; read -r c || c=2
    if [[ "$c" == "1" ]]; then
        local tgt rdir user host port=22
        echo -ne "  New box (user@host or user@host:port): "
        read -r tgt || tgt=""
        if [[ "$tgt" =~ ^([A-Za-z0-9._-]+)@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:([0-9]{1,5}))?$ ]]; then
            user="${BASH_REMATCH[1]}"; host="${BASH_REMATCH[2]}"; port="${BASH_REMATCH[4]:-22}"
            host="${host#[}"; host="${host%]}"
            echo -ne "  Remote directory [$PMG_REMOTE_DIR_DEFAULT]: "
            read -r rdir || rdir=""
            rdir="${rdir:-$PMG_REMOTE_DIR_DEFAULT}"
            if [[ ! "$rdir" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
                warn "Remote directory must be an absolute path of letters, digits, . _ - / only."
            else
                local cmdir; cmdir=$(mktemp -d /tmp/grin_pmg_ssh_XXXXXX 2>/dev/null) || cmdir=""
                local -a common=( -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 )
                [[ -n "$cmdir" ]] && common+=( -o ControlMaster=auto -o "ControlPath=$cmdir/cm" -o ControlPersist=120 )
                [[ -f "${GBP_KEY:-/nonexistent}" ]] && common+=( -i "$GBP_KEY" )
                local rsha=""
                info "Connecting to $user@$host:$port ..."
                if ssh "${common[@]}" -p "$port" "$user@$host" "mkdir -p '$rdir' && chmod 700 '$rdir'" \
                   && scp -q "${common[@]}" -P "$port" "$archive" "$sidecar" "$user@$host:$rdir/"; then
                    rsha=$(ssh "${common[@]}" -p "$port" "$user@$host" "sha256sum '$rdir/$base'" 2>/dev/null | awk '{print $1}')
                fi
                [[ -n "$cmdir" ]] && { ssh -o "ControlPath=$cmdir/cm" -O exit "$user@$host" >/dev/null 2>&1 || true; rm -rf "$cmdir"; }
                if [[ -n "$rsha" && "$rsha" == "$sha" ]]; then
                    success "Pushed → $user@$host:$rdir/$base  (remote sha256 matches)"
                    _pmg_log "pushed $base to $user@$host:$rdir (sha256 verified)"
                    return 0
                fi
                if [[ -n "$rsha" ]]; then
                    error "Remote sha256 does NOT match ($rsha) — the copy is damaged. Copy it again."
                else
                    warn "Push did not complete (ssh/scp failed, or the remote has no sha256sum)."
                fi
            fi
        else
            warn "Not a user@host[:port] target."
        fi
        echo -e "  ${DIM}The archive is safe here — copy it by hand:${RESET}"
    fi
    echo ""
    echo -e "  ${BOLD}Copy command (run on THIS box):${RESET}"
    echo "    scp -P 22 $archive $sidecar root@NEW_BOX:$PMG_REMOTE_DIR_DEFAULT/"
    echo -e "  ${DIM}Then on the new box: cd $PMG_REMOTE_DIR_DEFAULT && sha256sum -c $(basename "$sidecar")${RESET}"
    return 0
}

# ─── The steps ───────────────────────────────────────────────────────────────
_pmg_out_intro() {
    local dom region; dom=$(_pmg_conf subdomain "?"); region=$(_pmg_conf region main)
    clear 2>/dev/null || true
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Migrate OUT — this hub → a new box (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  ${DIM}Pool $dom · local region $region · service $POOL_SERVICE${RESET}"
    echo ""
    echo -e "  In this order:"
    echo -e "    1. Preflight (read-only): services, backup key, payouts in flight."
    echo -e "    2. Payouts FROZEN — before anything stops."
    echo -e "    3. Wallet listener stopped (watchdog + boot autostart removed first), then a"
    echo -e "       one-shot wallet info records the balance as evidence."
    echo -e "    4. Pool service stopped + disabled; hub WireGuard down + disabled; daily"
    echo -e "       backup cron off. The grin node keeps running."
    echo -e "    5. Manifest written (the figures Migrate IN checks against)."
    echo -e "    6. Final encrypted archive — with the TLS cert, this archive only — verified."
    echo -e "    7. Copy to the new box (scp), or the command to do it yourself."
    echo ""
    echo -e "  ${YELLOW}Miners disconnect NOW and stay off until DNS points at the new hub.${RESET}"
    echo -e "  ${YELLOW}This box will NOT restart the pool afterwards — not even after a reboot.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}MIGRATE${RESET} to begin (anything else cancels): "
    local go; read -r go || go=""
    [[ "$go" == "MIGRATE" ]] || { info "Cancelled — nothing changed."; return 1; }
}

_pmg_out_preflight() {
    echo ""; echo -e "${BOLD}Step 1 — preflight${RESET}"
    local t
    for t in node tar gzip openssl sha256sum systemctl; do
        command -v "$t" >/dev/null 2>&1 || { error "Required tool missing: $t — nothing changed."; return 1; }
    done
    [[ -f "$POOL_CONF" ]] || { error "No pool config at $POOL_CONF — is this the hub? Nothing changed."; return 1; }
    [[ -f "$(_pmg_db)" ]] || { error "No pool.db at $(_pmg_db) — nothing to migrate. Nothing changed."; return 1; }
    echo -e "  Network      : ${BOLD}${POOL_NET_LABEL:-$POOL_NET}${RESET}"
    echo -e "  Pool service : $(systemctl is-active "$POOL_SERVICE" 2>/dev/null || true) · $(systemctl is-enabled "$POOL_SERVICE" 2>/dev/null || true)"
    if declare -F pw_listener_status >/dev/null 2>&1; then echo -e "  Wallet       : $(pw_listener_status 2>/dev/null)"; fi

    pbk_load_conf
    gbe_require_key || { error "The final archive needs the backup personal key — nothing changed."; return 1; }

    local prev; prev=$(_pmg_frozen_by)
    if [[ "$prev" == "$PMG_FREEZE_BY" ]]; then
        info "Payouts are already frozen by an earlier Migrate OUT — resuming it."
    elif [[ -n "$prev" ]]; then
        warn "Payouts are already frozen (by '$prev'). The reason will be overwritten here;"
        warn "  the original row is kept in the manifest under payout_control.before."
    fi

    local rows rc
    rows=$(_pmg_js inflight); rc=$?
    if [[ "$rc" -ne 0 ]]; then error "Could not read the withdrawals table — nothing changed."; return 1; fi
    if [[ -z "$rows" ]]; then
        success "No withdrawals in flight."
        return 0
    fi
    warn "Withdrawals IN FLIGHT (the scheduler's pending statuses):"
    printf '    %-6s %-14s %-18s %-10s %s\n' "id" "amount" "status" "method" "address"
    local id amount st method addr
    while IFS=$'\t' read -r id amount st method addr; do
        printf '    %-6s %-14s %-18s %-10s %s…\n' "$id" "$amount" "$st" "$method" "$addr"
    done <<< "$rows"
    echo -e "  ${DIM}Not a hard stop: the final archive is taken AFTER the stop, so the DB and the${RESET}"
    echo -e "  ${DIM}wallet move together and the new hub resolves these like a restart would. But${RESET}"
    echo -e "  ${DIM}a Tor send mid-flight (tor_sending) is best left to finish: wait a few minutes${RESET}"
    echo -e "  ${DIM}and re-run if you can.${RESET}"
    echo -ne "  Type ${BOLD}PROCEED${RESET} to migrate with these in flight: "
    local go; read -r go || go=""
    [[ "$go" == "PROCEED" ]] || { info "Cancelled — nothing changed."; return 1; }
}

_pmg_out_freeze() {
    echo ""; echo -e "${BOLD}Step 2 — freeze payouts${RESET}"
    PMG_PAYOUT_BEFORE=$(_pmg_js facts | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.stringify(JSON.parse(s).payout_control));}catch(e){process.stdout.write("null");}})' 2>/dev/null)
    [[ -n "$PMG_PAYOUT_BEFORE" ]] || PMG_PAYOUT_BEFORE="null"
    if ! pbk_freeze_payouts "$(_pmg_db)" "$PMG_FREEZE_REASON" "$PMG_FREEZE_BY"; then
        _pmg_rechown_db
        error "Could not freeze payouts — nothing was stopped; the pool is still serving."
        return 1
    fi
    _pmg_rechown_db
    success "Payouts FROZEN (reason: $PMG_FREEZE_REASON)."
}

_pmg_out_wallet() {
    echo ""; echo -e "${BOLD}Step 3 — wallet listener off, then evidence${RESET}"
    local f
    for f in pw_watchdog_remove pw_autostart_disable pw_listener_stop pw_wallet_dir pw_bin pw_pass_file; do
        declare -F "$f" >/dev/null 2>&1 || { _pmg_fail 3 "wallet helper $f is not loaded"; return 1; }
    done
    # Restart paths FIRST: the */5 watchdog relaunches a stopped listener, and the
    # info below can run for minutes — long enough for it to fire mid-evidence.
    pw_watchdog_remove >/dev/null 2>&1 || true
    pw_autostart_disable >/dev/null 2>&1 || true
    if [[ -f "${PW_WATCHDOG_CRON:-/nonexistent}" ]]; then
        _pmg_fail 3 "could not remove the wallet watchdog ($PW_WATCHDOG_CRON)"; return 1
    fi
    if crontab -l 2>/dev/null | grep -qF "$PW_AUTOSTART_TAG"; then
        _pmg_fail 3 "could not remove the wallet @reboot line from root's crontab"; return 1
    fi
    success "Wallet watchdog + boot autostart removed."
    pw_listener_stop >/dev/null 2>&1 || true
    local n=0
    while _pmg_port_listening "$PW_OWNER_PORT" && (( n < 10 )); do sleep 1; n=$((n + 1)); done
    if _pmg_port_listening "$PW_OWNER_PORT"; then
        _pmg_fail 3 "the wallet listener still holds :$PW_OWNER_PORT after the stop"; return 1
    fi
    success "Wallet listener stopped (:$PW_OWNER_PORT free)."

    info "Recording wallet evidence (grin-wallet info; passphrase on stdin, as the service user)..."
    if _pmg_wallet_info; then
        success "Wallet: total $PMG_W_TOTAL · spendable $PMG_W_SPENDABLE · immature ${PMG_W_IMMATURE:-?} · locked ${PMG_W_LOCKED:-?} · height ${PMG_W_HEIGHT:-?}"
        [[ "$PMG_W_REFRESHED" == "1" ]] || warn "  (from the wallet's cache — it could not refresh against the node)"
    else
        warn "Wallet evidence unavailable: $PMG_W_ERROR — recorded as such; carrying on."
    fi
}

_pmg_out_stop() {
    echo ""; echo -e "${BOLD}Step 4 — stop and disable${RESET}"
    systemctl stop "$POOL_SERVICE" 2>/dev/null || true
    systemctl disable "$POOL_SERVICE" >/dev/null 2>&1 || true
    if systemctl is-active --quiet "$POOL_SERVICE" 2>/dev/null; then
        _pmg_fail 4 "$POOL_SERVICE is still running after systemctl stop"; return 1
    fi
    if [[ "$(systemctl is-enabled "$POOL_SERVICE" 2>/dev/null)" == "enabled" ]]; then
        _pmg_fail 4 "$POOL_SERVICE is still enabled at boot"; return 1
    fi
    success "$POOL_SERVICE stopped + disabled."

    # This net's hub tunnel only: a testnet pool on the same box has its own iface and
    # is not part of this move. Stop the UNIT when it owns the tunnel — a bare wg-quick
    # down leaves wg-quick@ "active (exited)", and then the rollback's enable --now is a
    # silent no-op that never brings the tunnel back.
    if [[ -n "${WG_IFACE:-}" ]] && { [[ -f "${WG_CONF:-/nonexistent}" ]] || ip link show "$WG_IFACE" >/dev/null 2>&1; }; then
        systemctl stop "wg-quick@${WG_IFACE}" 2>/dev/null || true
        if ip link show "$WG_IFACE" >/dev/null 2>&1; then wg-quick down "$WG_IFACE" >/dev/null 2>&1 || true; fi
        systemctl disable "wg-quick@${WG_IFACE}" >/dev/null 2>&1 || true
        if ip link show "$WG_IFACE" >/dev/null 2>&1; then
            _pmg_fail 4 "hub tunnel $WG_IFACE is still up — gateways would keep handshaking with this box"; return 1
        fi
        if [[ "$(systemctl is-enabled "wg-quick@${WG_IFACE}" 2>/dev/null)" == "enabled" ]]; then
            _pmg_fail 4 "wg-quick@${WG_IFACE} is still enabled at boot"; return 1
        fi
        success "Hub WireGuard $WG_IFACE down + disabled (gateways can now follow DNS)."
    else
        info "No hub WireGuard on this box (single-box pool) — nothing to take down."
    fi

    # The daily cron writes the SAME archive name (one per product per day) and would
    # replace the cert-carrying migration archive with a cert-free one, changing the
    # sha256 printed below. A dark box needs no daily backups anyway.
    if [[ -f "$PBK_CRON" ]]; then
        rm -f "$PBK_CRON" || { _pmg_fail 4 "could not remove the daily backup cron ($PBK_CRON)"; return 1; }
        success "Daily backup cron off (it would overwrite today's migration archive)."
    fi
}

_pmg_out_manifest() {
    echo ""; echo -e "${BOLD}Step 5 — manifest${RESET}"
    local out="$POOL_APP_DIR/$PMG_MANIFEST_NAME" ip height res rc
    ip=$(_pmg_public_ip)
    [[ -n "$ip" ]] || warn "Could not resolve this box's public IP (ipify) — Migrate IN will ask for it."
    height=$(_pmg_node_height)
    [[ -n "$height" ]] || height="$PMG_W_HEIGHT"
    [[ -n "$height" ]] || warn "Node height unknown (get_status failed and no wallet height)."
    local certs="no"; [[ -n "$(_pmg_cert_paths)" ]] && certs="yes"
    # The name the step-6 archive is EXPECTED to get; _pmg_out_archive checks it came true.
    PMG_MANIFEST_ARCHIVE="${PBK_PREFIX}$(gbe_date).tar.gz.enc"
    res=$(PMG_M_NET="$POOL_NET" PMG_M_PRODUCT="$PBK_PRODUCT" PMG_M_MODE="${POOL_MODE:-}" \
          PMG_M_ARCHIVE_NAME="$PMG_MANIFEST_ARCHIVE" \
          PMG_M_HOSTNAME="$(hostname 2>/dev/null)" PMG_M_PUBLIC_IP="$ip" \
          PMG_M_DOMAIN="$(_pmg_conf subdomain "")" PMG_M_STRATUM_PORT="$(_pmg_conf stratum_port "")" \
          PMG_M_REGION="$(_pmg_conf region main)" PMG_M_CF_PROXY="$(_pmg_conf cloudflare_proxy "")" \
          PMG_M_WG_IFACE="${WG_IFACE:-}" PMG_M_WG_PORT="${WG_LISTEN_PORT:-}" \
          PMG_M_WG_ENDPOINT_HOST="$(_pmg_conf wg_endpoint_host "")" PMG_M_NODE_HEIGHT="$height" \
          PMG_M_PAYOUT_BEFORE="${PMG_PAYOUT_BEFORE:-null}" PMG_M_CERTS="$certs" \
          PMG_W_OK="$PMG_W_OK" PMG_W_ERROR="$PMG_W_ERROR" PMG_W_HEIGHT="$PMG_W_HEIGHT" \
          PMG_W_REFRESHED="$PMG_W_REFRESHED" PMG_W_TOTAL="$PMG_W_TOTAL" PMG_W_AWAIT_CONF="$PMG_W_AWAIT_CONF" \
          PMG_W_AWAIT_FIN="$PMG_W_AWAIT_FIN" PMG_W_IMMATURE="$PMG_W_IMMATURE" PMG_W_LOCKED="$PMG_W_LOCKED" \
          PMG_W_SPENDABLE="$PMG_W_SPENDABLE" \
          _pmg_js manifest "$out"); rc=$?
    _pmg_rechown_db
    if [[ "$rc" -ne 0 || ! -s "$out" ]]; then
        _pmg_fail 5 "manifest not written (${res:-node exited $rc}) — pool.db may be missing a core table"; return 1
    fi
    if id grinpool >/dev/null 2>&1; then chown grinpool:grinpool "$out" 2>/dev/null || true; fi
    chmod 600 "$out" 2>/dev/null || true
    success "Manifest → $out"
}

_pmg_out_archive() {
    echo ""; echo -e "${BOLD}Step 6 — final archive${RESET}"
    if [[ -z "$(_pmg_cert_paths)" ]]; then
        warn "No Let's Encrypt cert found for the pool vhost — the archive carries none;"
        warn "  the new box issues one after DNS moves (4) Setup nginx there)."
    fi
    echo -e "  ${DIM}Named for today, so it REPLACES today's scheduled archive — intended: it is newer,${RESET}"
    echo -e "  ${DIM}taken after the stop. It carries the TLS cert; daily archives never do.${RESET}"
    if gbp_configured 2>/dev/null; then
        echo -e "  ${DIM}Offsite push is on: this archive (cert included) is also pushed there.${RESET}"
    fi
    if ! _pbk_build_archive 1; then
        _pmg_fail 6 "the final archive could not be built"; return 1
    fi
    PMG_ARCHIVE="$GBE_ARCHIVE"
    # The archive is named (and keyed) by the LOCAL date at step 6, the manifest's
    # archive_name by the date at step 5. A run straddling local midnight made them differ,
    # and Migrate IN rightly refuses a manifest naming another archive — so the move's own
    # archive was unusable (audit Part 9 C1). Everything is stopped, so the ledger cannot
    # have moved: rewrite the manifest under the new date and rebuild once. The rebuild
    # gets the SAME file name and replaces the mismatched archive; no orphan is left.
    if [[ "$(basename "$PMG_ARCHIVE")" != "$PMG_MANIFEST_ARCHIVE" ]]; then
        warn "The local date changed between the manifest and the archive (midnight) — rewriting"
        warn "  the manifest under the new date and building the archive once more."
        _pmg_out_manifest || return 1
        if ! _pbk_build_archive 1; then
            _pmg_fail 6 "the final archive could not be rebuilt"; return 1
        fi
        PMG_ARCHIVE="$GBE_ARCHIVE"
        if [[ "$(basename "$PMG_ARCHIVE")" != "$PMG_MANIFEST_ARCHIVE" ]]; then
            _pmg_fail 6 "the archive ($(basename "$PMG_ARCHIVE")) still does not match its manifest ($PMG_MANIFEST_ARCHIVE)"; return 1
        fi
    fi
    info "Verifying the archive (decrypt + contents)..."
    if ! _pmg_verify_archive "$PMG_ARCHIVE"; then
        _pmg_fail 6 "the final archive failed verification ($PMG_ARCHIVE)"; return 1
    fi
    PMG_SHA=$(sha256sum "$PMG_ARCHIVE" 2>/dev/null | awk '{print $1}')
    [[ "$PMG_SHA" =~ ^[0-9a-f]{64}$ ]] || { _pmg_fail 6 "could not hash $PMG_ARCHIVE"; return 1; }
    PMG_SIDECAR="${PMG_ARCHIVE}.sha256"
    printf '%s  %s\n' "$PMG_SHA" "$(basename "$PMG_ARCHIVE")" > "$PMG_SIDECAR" \
        || { _pmg_fail 6 "could not write $PMG_SIDECAR"; return 1; }
    chmod 600 "$PMG_SIDECAR" 2>/dev/null || true
    success "Archive verified: $PMG_ARCHIVE"
    echo -e "  ${BOLD}sha256${RESET} $PMG_SHA"
    _pmg_log "archive $(basename "$PMG_ARCHIVE") sha256 $PMG_SHA"
    pbk_prune "$PBK_KEEP"
}

_pmg_out_final() {
    local dom sturl sthost wgh
    dom=$(_pmg_conf subdomain "")
    wgh=$(_pmg_conf wg_endpoint_host "")
    sturl=$(_pmg_js facts | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const r=JSON.parse(s).local_region_row;if(r&&r.stratum_url)process.stdout.write(String(r.stratum_url));}catch(e){}})' 2>/dev/null)
    _pmg_rechown_db
    sthost="${sturl#*://}"; sthost="${sthost%%/*}"; sthost="${sthost%:*}"
    echo ""
    echo -e "${BOLD}${GREEN}Migrate OUT complete.${RESET} This box is dark: pool stopped, payouts frozen, tunnel down."
    echo ""
    echo -e "  ${BOLD}Next, in this order:${RESET}"
    echo -e "    1. On the NEW box: B) Backup & Restore → ${BOLD}7) Migrate IN${RESET}."
    echo -e "    2. Only when Migrate IN says ${BOLD}ready for DNS${RESET}, point these A records at the new IP:"
    local -a recs=(); local r seen=" "
    [[ -n "$dom" ]] && recs+=("$dom" "www.$dom")
    [[ -n "$sthost" ]] && recs+=("$sthost")
    [[ -n "$wgh" ]] && recs+=("$wgh")
    for r in "${recs[@]}"; do
        [[ "$seen" == *" $r "* ]] && continue
        seen+="$r "
        echo -e "         ${BOLD}$r${RESET}"
    done
    [[ -n "$wgh" ]] || echo -e "       ${DIM}(no wg_endpoint_host: gateways paired to a raw IP need 2) Configure on each gateway)${RESET}"
    echo -e "    3. Do ${BOLD}NOT${RESET} restart anything on this box."
    echo -e "    4. Wipe this box after ~7 days — it still holds the wallet seed and the hub WG key."
    echo ""
    _pmg_print_state
    echo ""
    _pmg_print_rollback
    _pmg_log "complete — $(basename "${PMG_ARCHIVE:-?}") sha256 ${PMG_SHA:-?}; box dark, payouts frozen"
}

pmg_migrate_out() {
    PMG_ARCHIVE=""; PMG_SHA=""; PMG_SIDECAR=""; PMG_PAYOUT_BEFORE="null"; PMG_MANIFEST_ARCHIVE=""
    # Certs go into THIS call's archive only. `local` scopes dynamically, so
    # _pbk_sources (called below us) sees 1, and it is 0 again once we return.
    local PBK_INCLUDE_CERTS=1

    _pmg_out_intro     || return 1
    _pmg_out_preflight || return 1   # read-only: a refusal here changed nothing
    _pmg_out_freeze    || return 1   # nothing stopped yet if this fails
    _pmg_log "started — payouts frozen"
    # From here on every failure leaves payouts FROZEN and prints the state (_pmg_fail).
    _pmg_out_wallet    || return 1
    _pmg_out_stop      || return 1
    _pmg_out_manifest  || return 1
    _pmg_out_archive   || return 1
    _pmg_transfer "$PMG_ARCHIVE" "$PMG_SIDECAR" "$PMG_SHA"
    _pmg_out_final
    return 0
}

# ═════════════════════════════════════════════════════════════════════════════
# 7) Migrate IN — run on the NEW hub
# ═════════════════════════════════════════════════════════════════════════════
# The order is the safety design, as in OUT — keep it:
#   0  MIGRATE, or CHECK = only the read-only box checks. CHECK is meant to run
#      BEFORE Migrate OUT on the old hub: whatever it finds (no 1) Install, node
#      not synced, node stratum not wired) is then fixed while the old hub still
#      serves, instead of inside the downtime window.
#   1  box checks (read-only): tools, 1) Install ran, node up + synced, node
#      stratum wired for the pool.
#   2  archive: pick → sha256 → decrypt → read ONLY the manifest out of it.
#      This comes before the manifest checks because they need its figures;
#      nothing is written to this box's own paths until step 3.
#   1b manifest checks: right net + product + THIS archive; node height ≥ the
#      old hub's; the live-ledger clobber guard; firewall (warn); and the OLD HUB
#      IS DARK (F4): two live pools on one wallet seed must never happen.
#   3  restore through _pbk_restore_extract — the same core and the same freeze
#      as 2) Restore. Payouts come up FROZEN.
#   4  location (singlebox): a new region tag, so Part 1's move rule in
#      ensureLocalRegion publishes the new row on the first start.
#   5  bring-up: node secrets, wallet binary, ownership, web files, WG, nginx.
#   6  continuity: every ledger figure AND per-row digest EQUAL to the manifest;
#      the wallet opens and refreshes against THIS box's node. Any ✗ stops here,
#      before anything that serves has started.
#   7  start: the old hub is probed AGAIN, then wallet listener, then pool; each
#      verified. 8 ready-for-DNS · 9 watch gateways · 10 final screen.
# Nothing here unfreezes payouts. Before step 7 every failure leaves this box's
# pool stopped AND disabled at boot (step 3 disables the unit 1) Install enabled —
# else a reboot starts the restored pool unattended); resuming is: fix the cause, run B → 7 again (the restore repeats
# from the same archive, and the clobber guard lets an unchanged ledger through).

PMG_IN_FREEZE_REASON="hub migrated — verify, reconcile, then resume"
PMG_IN_FREEZE_BY="migrate-in"
PMG_SYSTEMD_DIR="${PMG_SYSTEMD_DIR:-/etc/systemd/system}"
PMG_NGINX_SITES_ENABLED="${PMG_NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"
# A gateway counts as reconnected once its WireGuard handshake is younger than this.
PMG_IN_HANDSHAKE_OK_S=150

# Manifest → PMG_MF_<KEY> (whitelisted keys only; values arrive as data, never eval'd).
_PMG_MF_KEYS="KIND SCHEMA NET PRODUCT ARCHIVE CREATED CREATED_UNIX IP HOST DOMAIN STRATUM_PORT REGION STAMP WG_IFACE WG_PORT WG_HOST HEIGHT SH_LATEST SH_MAX W_OK W_TOTAL W_SPEND W_IMM W_LOCKED W_AWAIT INFLIGHT WALLET_ID CERTS"
read -r -d '' _PMG_JS_MF <<'JS' || true
const fs = require('fs');
let m;
try { m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch (e) { process.exit(1); }
const g = (p) => p.split('.').reduce((o, k) => (o === null || o === undefined) ? undefined : o[k], m);
const K = { KIND: 'kind', SCHEMA: 'schema', NET: 'net', PRODUCT: 'product', ARCHIVE: 'archive_name',
  CREATED: 'created_at', CREATED_UNIX: 'created_at_unix', IP: 'source.public_ip', HOST: 'source.hostname',
  DOMAIN: 'pool.domain', STRATUM_PORT: 'pool.stratum_port', REGION: 'pool.local_region',
  STAMP: 'pool.local_region_stamp', WG_IFACE: 'wireguard.iface', WG_PORT: 'wireguard.listen_port',
  WG_HOST: 'wireguard.endpoint_host', HEIGHT: 'node.height', SH_LATEST: 'ledger.shares.latest_at',
  SH_MAX: 'ledger.shares.max_id', W_OK: 'wallet.ok', W_TOTAL: 'wallet.total', W_SPEND: 'wallet.spendable',
  W_IMM: 'wallet.immature', W_LOCKED: 'wallet.locked', W_AWAIT: 'wallet.awaiting_confirmation',
  INFLIGHT: 'ledger.withdrawals.in_flight_count', WALLET_ID: 'wallet_identity', CERTS: 'certs_included' };
for (const [k, p] of Object.entries(K)) {
  let v = g(p);
  if (v === null || v === undefined) v = '';
  if (typeof v === 'boolean') v = v ? '1' : '0';
  console.log(k + '\t' + String(v).replace(/[\t\r\n]/g, ' '));
}
JS

_pmg_manifest_load() {  # <manifest.json> → PMG_MF_*; rc 1 when unreadable
    local k v
    for k in $_PMG_MF_KEYS; do printf -v "PMG_MF_$k" '%s' ""; done
    [[ -f "$1" ]] || return 1
    while IFS=$'\t' read -r k v; do
        [[ " $_PMG_MF_KEYS " == *" $k "* ]] || continue
        printf -v "PMG_MF_$k" '%s' "$v"
    done < <(node -e "$_PMG_JS_MF" "$1" 2>/dev/null)
    [[ -n "$PMG_MF_KIND" ]]
}

_pmg_in_reset() {
    PMG_IN_CHECK_ONLY=0; PMG_IN_STAGE="none"; PMG_IN_ARCHIVE=""; PMG_IN_CLEAR=""; PMG_IN_MDIR=""
    PMG_IN_MANIFEST=""; PMG_IN_SAMEBOX=0; PMG_IN_PUBLIC_IP=""; PMG_IN_OLD_IP=""; PMG_IN_NODE_HEIGHT=""
    PMG_IN_DARK=""; PMG_IN_DARK_WHY=""; PMG_IN_DARK_CONFIRMED=0; PMG_IN_CERT_OK=0
    _pmg_manifest_load /nonexistent || true
}

# The decrypted archive holds the wallet seed and the hub WG key: it never outlives the run.
_pmg_in_cleanup() {
    if [[ -n "$PMG_IN_CLEAR" ]]; then rm -f "$PMG_IN_CLEAR" 2>/dev/null || true; fi
    if [[ -n "$PMG_IN_MDIR" ]]; then rm -rf "$PMG_IN_MDIR" 2>/dev/null || true; fi
    PMG_IN_CLEAR=""; PMG_IN_MDIR=""
}

# ─── Probes of the OLD hub (F4) ──────────────────────────────────────────────
# A "no" only counts when the OLD BOX ITSELF said it. A firewall answers for a box too — a
# DROP times out, and a REJECT answers with ICMP (firewalld's default: icmp-host-prohibited,
# "No route to host") or a RST — so a box filtered FROM HERE used to read as dark while its
# pool still served (audit Part 9 C6). Hence: only a RST counts as a stratum "no", and only
# an HTTP answer that is not the pool counts as an API "no"; everything else proves nothing.
# rc 0 = connected · 1 = REFUSED (a TCP RST) · 2 = timed out, or any other error: proves nothing
_pmg_tcp_probe() {  # <host> <port>
    local rc err
    err=$(LC_ALL=C timeout 6 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$1" "$2" 2>&1); rc=$?
    case "$rc" in 0) return 0 ;; 124) return 2 ;; esac
    [[ "$err" == *"Connection refused"* ]] && return 1
    return 2
}

# The pool's own /api/health on the OLD IP, SNI + Host = the pool domain (--resolve), so
# it reaches that box even though DNS may already point here, and bypasses a CDN. Only a
# PARSED {"status":"ok"} counts as the pool answering — nginx alone answers 502 there
# once the service is stopped (CLAUDE.md: a 200 proves nothing, a parsed result does).
# That 502 is also the only "no" that counts: Migrate OUT leaves nginx running on purpose,
# so a dark old hub still answers HTTP. No HTTP answer at all (refused, TLS failure, empty
# reply) means the box's :443 is unreachable from here — which proves nothing about its pool.
# rc 0 = the old POOL answered · 1 = the old box answered HTTP, not as the pool · 2 = proves nothing
_pmg_https_probe() {  # <domain> <ip>
    local dom="$1" ip="$2" rip="$2" out rc code body
    [[ "$ip" == *:* ]] && rip="[$ip]"
    out=$(curl -sk --max-time 8 --resolve "$dom:443:$rip" -w '\n%{http_code}' "https://$dom/api/health" 2>/dev/null)
    rc=$?
    [[ "$rc" -eq 0 ]] || return 2
    code="${out##*$'\n'}"; body="${out%$'\n'*}"
    [[ "$code" =~ ^[1-5][0-9][0-9]$ ]] || return 2
    if [[ "$code" == "200" ]] && node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.exit(JSON.parse(s).status==="ok"?0:1);}catch(e){process.exit(1);}})' <<< "$body" 2>/dev/null; then
        return 0
    fi
    [[ "$code" == "429" ]] && return 2   # rate-limited: something answered, but not provably the pool
    return 1
}

# Sets PMG_IN_DARK = alive | dark | unknown, and PMG_IN_DARK_WHY.
# Dark needs BOTH a stratum RST and an HTTP answer from the old IP that is not the pool.
# Anything else — a timeout, a filter, a box whose nginx is also gone — is "unknown", and
# the operator confirms on the old box by typing it.
_pmg_in_dark_probe() {
    local ip="$PMG_IN_OLD_IP" port="${PMG_MF_STRATUM_PORT:-}" dom="${PMG_MF_DOMAIN:-}" t=1 h=2
    local -a why=()
    if [[ -z "$port" && -z "$dom" ]]; then
        PMG_IN_DARK="unknown"; PMG_IN_DARK_WHY="the manifest names no stratum port and no domain to probe"; return 0
    fi
    if [[ -n "$port" ]]; then _pmg_tcp_probe "$ip" "$port"; t=$?; fi
    if [[ -n "$dom" ]]; then _pmg_https_probe "$dom" "$ip"; h=$?; fi
    if [[ "$t" -eq 0 ]]; then PMG_IN_DARK="alive"; PMG_IN_DARK_WHY="stratum $ip:$port accepts connections"; return 0; fi
    if [[ "$h" -eq 0 ]]; then PMG_IN_DARK="alive"; PMG_IN_DARK_WHY="the pool API on $ip answers /api/health"; return 0; fi
    if [[ "$t" -eq 1 && "$h" -eq 1 ]]; then
        PMG_IN_DARK="dark"; PMG_IN_DARK_WHY="stratum ${port:+:$port }refused, and its web server answers but the pool API does not"; return 0
    fi
    [[ "$t" -eq 2 ]] && why+=("stratum $ip:$port timed out or was filtered (no RST from the box)")
    if [[ "$h" -eq 2 ]]; then
        if [[ -n "$dom" ]]; then why+=("nothing on $ip:443 answered HTTP (timeout, refused, TLS, or rate-limited)")
        else why+=("the manifest names no domain, so the pool API cannot be checked"); fi
    fi
    PMG_IN_DARK="unknown"; PMG_IN_DARK_WHY="${why[*]}"
}

# ─── Firewall (warn only — the plan's rule: a closed port is fixable, not unsafe) ─
# rc 0 allowed · 1 not allowed · 2 no managed firewall active. Anchored ufw status
# (a disabled ufw prints "Status: inactive", which a bare 'active' matches).
_pmg_fw_allows() {  # <port> <tcp|udp>
    local p="$1" pr="$2" st
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
        st=$(ufw status 2>/dev/null)
        grep -qE "^${p}(/${pr})?([[:space:]]+on[[:space:]]+[^[:space:]]+)?[[:space:]]+ALLOW" <<< "$st" && return 0
        grep -qE "^([0-9:]+,)*${p}(,[0-9:]+)*/${pr}[[:space:]].*ALLOW" <<< "$st" && return 0
        if [[ "$pr" == "tcp" && "$p" == "80" ]] && grep -qE "^(Nginx Full|Nginx HTTP|WWW|WWW Full)[[:space:]].*ALLOW" <<< "$st"; then return 0; fi
        if [[ "$pr" == "tcp" && "$p" == "443" ]] && grep -qE "^(Nginx Full|Nginx HTTPS|WWW Secure|WWW Full)[[:space:]].*ALLOW" <<< "$st"; then return 0; fi
        return 1
    fi
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd --query-port="${p}/${pr}" >/dev/null 2>&1 && return 0
        if [[ "$p" == "80" ]] && firewall-cmd --query-service=http >/dev/null 2>&1; then return 0; fi
        if [[ "$p" == "443" ]] && firewall-cmd --query-service=https >/dev/null 2>&1; then return 0; fi
        return 1
    fi
    return 2
}

_pmg_in_fw_check() {  # [wg_optional] — 1 = the WG port is listed as "if you run gateways"
    local role sp wgp spec p pr rc any=0 note
    role=$(_pmg_conf role singlebox)
    sp="${PMG_MF_STRATUM_PORT:-}"; [[ -n "$sp" ]] || sp=$(_pmg_conf stratum_port "")
    wgp="${PMG_MF_WG_PORT:-}";     [[ -n "$wgp" ]] || wgp="${WG_LISTEN_PORT:-}"
    local -a want=("80/tcp" "443/tcp")
    [[ "$role" == "singlebox" && -n "$sp" ]] && want+=("$sp/tcp")
    if [[ -n "$wgp" ]] && { [[ "${1:-0}" == "1" ]] || [[ -n "${PMG_MF_WG_IFACE:-}" ]]; }; then want+=("$wgp/udp"); fi
    for spec in "${want[@]}"; do
        p="${spec%/*}"; pr="${spec#*/}"
        note=""; [[ "$pr" == "udp" && "${1:-0}" == "1" ]] && note=" (WireGuard — only if the old hub runs gateways)"
        _pmg_fw_allows "$p" "$pr"; rc=$?
        if [[ "$rc" -eq 2 ]]; then
            info "No ufw/firewalld active — the provider's firewall must allow: ${want[*]}."
            return 0
        fi
        if [[ "$rc" -eq 0 ]]; then
            echo -e "  ${GREEN}✓${RESET} firewall allows $spec$note"
        else
            any=1
            warn "Firewall does NOT allow $spec$note."
            echo -e "      ${DIM}fix: ufw allow $spec   (firewalld: firewall-cmd --permanent --add-port=$spec; firewall-cmd --reload)${RESET}"
        fi
    done
    [[ "$any" -eq 0 ]] || warn "Not a refusal — but miners/gateways/HTTPS cannot reach this box until it is fixed."
    return 0
}

# ─── Step 1: this box (read-only; the CHECK mode runs exactly this) ──────────
# Node stratum wiring: the pool mines NOTHING when the node's own stratum is off or its
# coinbase URL points at the wrong port. grin-secret-sync fixes the toml, but only a node
# RESTART makes the running node use it — a long wait that belongs before the move.
_pmg_in_stratum_wiring() {
    local dir toml sp miss=""
    sp=$(_pmg_conf node_stratum_port "")
    if [[ -z "$sp" ]]; then if [[ "$POOL_NET" == "testnet" ]]; then sp=13416; else sp=3416; fi; fi
    dir=$(grin_live_node_dir "$POOL_NET" 2>/dev/null || true)
    toml="$dir/grin-server.toml"
    if [[ -z "$dir" || ! -f "$toml" ]]; then
        warn "Could not find this node's grin-server.toml — check its stratum wiring by hand."
        return 0
    fi
    grep -qE '^[[:space:]]*enable_stratum_server[[:space:]]*=[[:space:]]*true' "$toml" || miss+=" enable_stratum_server"
    grep -qE "^[[:space:]]*stratum_server_addr[[:space:]]*=[[:space:]]*\"127\.0\.0\.1:${sp}\"" "$toml" || miss+=" stratum_server_addr"
    grep -qE "^[[:space:]]*wallet_listener_url[[:space:]]*=[[:space:]]*\"http://127\.0\.0\.1:${PW_OWNER_PORT}\"" "$toml" || miss+=" wallet_listener_url"
    if [[ -n "$miss" ]]; then
        error "The node is not wired for the pool yet (${miss# }) — the pool would mine NOTHING."
        error "  fix: grin-secret-sync, then restart the node (Script 01) and let it sync."
        return 1
    fi
    if ! _pmg_port_listening "$sp"; then
        error "grin-server.toml is wired, but nothing listens on :$sp — the node started before the change."
        error "  fix: restart the node (Script 01) and let it sync."
        return 1
    fi
    success "Node stratum wired + listening on :$sp (coinbase → wallet :$PW_OWNER_PORT)."
}

_pmg_in_box_checks() {
    echo ""; echo -e "${BOLD}Step 1 — this box (read-only)${RESET}"
    local t bad=0 miss="" ns h s
    for t in node tar gzip openssl sha256sum systemctl curl timeout; do
        command -v "$t" >/dev/null 2>&1 || { error "Required tool missing: $t"; bad=1; }
    done
    [[ -f "$PMG_SYSTEMD_DIR/$POOL_SERVICE.service" ]] || miss+=" unit"
    [[ -f "$POOL_APP_DIR/index.js" ]]                 || miss+=" app"
    [[ -d "$POOL_APP_DIR/node_modules" ]]             || miss+=" node_modules"
    if [[ -n "$miss" ]]; then
        error "1) Install has not run here (missing:$miss)."
        error "  fix: pool menu 1) Install — only that; 5) Set up wallet would mint a seed the restore replaces."
        bad=1
    else
        success "1) Install has run (unit, app, node_modules)."
    fi
    if [[ -f "$(pw_toml 2>/dev/null)" ]]; then
        warn "A pool wallet already exists here ($(pw_wallet_dir)) — the restore REPLACES it with the"
        warn "  old hub's wallet. If this one ever received anything, back it up first."
    fi
    ns=$(_pmg_node_status); h="${ns%% *}"; s="${ns#* }"
    if [[ -z "$ns" ]]; then
        error "The $POOL_NET node does not answer get_status on this box."
        error "  fix: Script 01 — build/start the node, then wait for it to sync."
        bad=1
    elif [[ "$s" != "no_sync" ]]; then
        error "The node is still syncing ($s, height $h) — fix: wait until Script 01 shows it synced."
        bad=1
    else
        PMG_IN_NODE_HEIGHT="$h"
        success "Node synced at height $h."
    fi
    _pmg_in_stratum_wiring || bad=1
    return "$bad"
}

_pmg_in_check_only() {
    local bad=0 f any=""
    _pmg_in_box_checks || bad=1
    echo ""; echo -e "${BOLD}Firewall${RESET}"
    _pmg_in_fw_check 1
    while IFS= read -r f; do
        if [[ -f "$f.sha256" ]]; then any="$f"; break; fi
    done < <(ls -t "$PBK_BACKUP_DIR/${PBK_PREFIX}"*.tar.gz.enc 2>/dev/null || true)
    echo ""
    if [[ -n "$any" ]]; then info "Migrate OUT archive already here: $(basename "$any")"
    else info "No Migrate OUT archive in $PBK_BACKUP_DIR yet — Migrate OUT step 7 copies it here."; fi
    if [[ "$bad" -eq 0 ]]; then
        success "READY. Next: Migrate OUT on the old hub (B → 6), then here B → 7 → MIGRATE."
    else
        error "NOT ready — fix the ✗ items above while the old hub still serves, then CHECK again."
    fi
    echo -e "  ${DIM}The checks that need the archive — manifest, old hub dark, live-ledger guard, continuity —${RESET}"
    echo -e "  ${DIM}run during MIGRATE. Nothing was changed.${RESET}"
    return 0
}

# ─── Step 2: the archive ─────────────────────────────────────────────────────
_pmg_in_locate() {
    echo ""; echo -e "${BOLD}Step 2 — the archive${RESET}"
    local -a baks=(); local f="" i=1 def=0 sel side base other
    while IFS= read -r f; do [[ -n "$f" ]] && baks+=("$f"); done \
        < <(ls -t "$PBK_BACKUP_DIR/${PBK_PREFIX}"*.tar.gz.enc 2>/dev/null || true)
    if [[ "${#baks[@]}" -gt 0 ]]; then
        echo -e "  Archives in $PBK_BACKUP_DIR (newest first; ${BOLD}[migration]${RESET} = has Migrate OUT's .sha256):"
        for f in "${baks[@]}"; do
            side=""
            if [[ -f "$f.sha256" ]]; then side=" ${BOLD}[migration]${RESET}"; [[ "$def" -eq 0 ]] && def=$i; fi
            echo -e "    ${GREEN}$i${RESET}) $(basename "$f")$side"
            i=$((i + 1))
        done
        [[ "$def" -gt 0 ]] || def=1
        echo -e "    ${GREEN}P${RESET}) another path    ${DIM}0) cancel${RESET}"
        echo -ne "  Select [$def]: "
        read -r sel || sel=0
        sel="${sel:-$def}"
    else
        info "No ${PBK_PREFIX}* archive in $PBK_BACKUP_DIR."
        sel="P"
    fi
    f=""
    case "$sel" in
        0) info "Cancelled — nothing changed."; return 1 ;;
        P|p) echo -ne "  Path to the Migrate OUT archive: "; read -r f || f="" ;;
        *) if [[ "$sel" =~ ^[0-9]+$ && "$sel" -ge 1 && "$sel" -le "${#baks[@]}" ]]; then
               f="${baks[$((sel - 1))]}"
           else
               warn "Invalid choice — nothing changed."; return 1
           fi ;;
    esac
    [[ -n "$f" && -f "$f" ]] || { error "No such file: ${f:-<empty>} — nothing changed."; return 1; }
    base=$(basename "$f")
    if [[ "$base" != "$PBK_PREFIX"* ]]; then
        if [[ "$PBK_PRODUCT" == "pubpool" ]]; then other="grin_pubpooltestnet_backup_"; else other="grin_pubpool_backup_"; fi
        if [[ "$base" == "$other"* ]]; then
            error "That archive is from the OTHER network — run Migrate IN from that network's pool menu. Nothing changed."
        else
            error "Not a ${PBK_PREFIX}DDMMYYYY.tar.gz.enc archive: $base"
            error "  The date in the name is part of the decryption key — never rename it. Nothing changed."
        fi
        return 1
    fi
    gbe_parse_date "$f" >/dev/null || { error "No date in the archive name: $base — nothing changed."; return 1; }
    PMG_IN_ARCHIVE="$f"

    local sha want="" src
    sha=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { error "Could not hash $f — nothing changed."; return 1; }
    if [[ -f "$f.sha256" ]]; then
        want=$(awk 'NR==1{print $1}' "$f.sha256" 2>/dev/null); src="Migrate OUT's .sha256 file"
    else
        echo -ne "  Paste the sha256 Migrate OUT printed (Enter to skip): "
        read -r want || want=""
        want="${want//[[:space:]]/}"; want="${want,,}"; src="the pasted sha256"
        if [[ -n "$want" && ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
            error "That is not a sha256 (64 hex characters) — nothing changed. Run B → 7 again and paste it whole."
            return 1
        fi
    fi
    if [[ -n "$want" ]]; then
        if [[ "$want" != "$sha" ]]; then
            error "sha256 does NOT match $src — a damaged copy, or not the archive Migrate OUT made."
            echo "      expected $want"
            echo "      actual   $sha"
            error "  Copy it again. Nothing changed."
            return 1
        fi
        success "sha256 matches $src."
    else
        warn "sha256 NOT verified (no .sha256 file beside it, none pasted)."
    fi
}

_pmg_in_decrypt() {
    local d key tries=0 ok=0 rel
    d=$(gbe_parse_date "$PMG_IN_ARCHIVE")
    PMG_IN_CLEAR=$(mktemp /tmp/grin_pubpool_migin_XXXXXX.tar.gz) || { PMG_IN_CLEAR=""; error "mktemp failed — nothing changed."; return 1; }
    pbk_load_conf
    if [[ -n "${GBE_PERSONAL_KEY:-}" ]] && gbe_decrypt "$PMG_IN_ARCHIVE" "$PMG_IN_CLEAR" "${GBE_PERSONAL_KEY}${d}"; then
        ok=1; success "Decrypted with this box's saved personal key."
    fi
    while [[ "$ok" -eq 0 && "$tries" -lt 3 ]]; do
        read -rs -p "  Personal backup key (the one the OLD hub used): " key || key=""; echo ""
        [[ -n "$key" ]] || { unset key; warn "No key entered — nothing changed."; return 1; }
        if gbe_decrypt "$PMG_IN_ARCHIVE" "$PMG_IN_CLEAR" "${key}${d}"; then ok=1; else error "Wrong key (or a damaged archive)."; fi
        tries=$((tries + 1))
    done
    unset key
    [[ "$ok" -eq 1 ]] || { error "Could not decrypt — nothing changed."; return 1; }
    tar -tzf "$PMG_IN_CLEAR" >/dev/null 2>&1 || { error "The decrypted archive is not a readable tar.gz — nothing changed."; return 1; }
    [[ "$tries" -eq 0 ]] || success "Decrypted."

    PMG_IN_MDIR=$(mktemp -d /tmp/grin_pubpool_migman_XXXXXX) || { PMG_IN_MDIR=""; error "mktemp failed — nothing changed."; return 1; }
    rel="${POOL_APP_DIR#/}/$PMG_MANIFEST_NAME"
    if ! tar -xzf "$PMG_IN_CLEAR" -C "$PMG_IN_MDIR" "$rel" 2>/dev/null || [[ ! -s "$PMG_IN_MDIR/$rel" ]]; then
        error "This archive carries no migration manifest — it is a daily / Backup-now archive, not a"
        error "  Migrate OUT one. Disaster recovery from a daily archive is 2) Restore. Nothing changed."
        return 1
    fi
    PMG_IN_MANIFEST="$PMG_IN_MDIR/$rel"
    _pmg_manifest_load "$PMG_IN_MANIFEST" || { error "The manifest is unreadable — nothing changed."; return 1; }
}

# ─── Step 1b: the manifest's checks ──────────────────────────────────────────
_pmg_in_clobber_guard() {
    local db f max lat wid go newer=0
    db=$(_pmg_db)
    if [[ ! -f "$db" ]]; then success "No pool.db on this box yet — nothing to overwrite."; return 0; fi
    f=$(_pmg_js facts); _pmg_rechown_db
    IFS='|' read -r max lat wid < <(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let o={};try{o=JSON.parse(s);}catch(e){}const sh=(o.ledger||{}).shares||{};const v=x=>(x===null||x===undefined)?"":String(x);process.stdout.write([v(sh.max_id),v(sh.latest_at),v(o.wallet_identity)].join("|")+"\n");})' <<< "$f" 2>/dev/null)
    if [[ "${max:-}" =~ ^[0-9]+$ && "$PMG_MF_SH_MAX" =~ ^[0-9]+$ ]] && (( max > PMG_MF_SH_MAX )); then newer=1; fi
    if [[ "${lat:-}" =~ ^[0-9]+$ && "$PMG_MF_SH_LATEST" =~ ^[0-9]+$ ]] && (( lat > PMG_MF_SH_LATEST )); then newer=1; fi
    if [[ "$newer" -eq 0 ]]; then
        success "This box's pool.db is not newer than the archive (shares to id ${max:-none}) — safe to replace."
        return 0
    fi
    error "LIVE LEDGER: this box's pool.db has shares NEWER than the archive"
    error "  (id ${max:-?} vs ${PMG_MF_SH_MAX:-?}; latest ${lat:-?} vs ${PMG_MF_SH_LATEST:-?})."
    if [[ -n "${wid:-}" && "$wid" == "$PMG_MF_WALLET_ID" ]]; then
        error "  It is THIS pool's ledger (same wallet): the moved pool has already RUN here and"
        error "  accepted shares. Restoring would roll back every balance earned since. Stop here."
    else
        error "  It belongs to a different pool (wallet ${wid:-none}); the restore erases it."
    fi
    echo -ne "  Type ${BOLD}OVERWRITE LEDGER${RESET} to replace it anyway (anything else stops; nothing changed): "
    read -r go || go=""
    [[ "$go" == "OVERWRITE LEDGER" ]] || { info "Stopped — nothing changed."; return 1; }
    warn "Replacing a NEWER ledger at the operator's request."
    _pmg_log "OVERWRITE LEDGER confirmed (local shares id ${max:-?} > archive ${PMG_MF_SH_MAX:-?})"
}

_pmg_in_dark_gate() {
    local go
    PMG_IN_PUBLIC_IP=$(_pmg_public_ip)
    PMG_IN_OLD_IP="${PMG_MF_IP:-}"
    if [[ -z "$PMG_IN_OLD_IP" ]]; then
        warn "Migrate OUT could not record the old hub's public IP."
        echo -ne "  The OLD hub's public IP: "
        read -r PMG_IN_OLD_IP || PMG_IN_OLD_IP=""
        if [[ ! "$PMG_IN_OLD_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ && ! ( "$PMG_IN_OLD_IP" == *:* && "$PMG_IN_OLD_IP" =~ ^[0-9A-Fa-f:]+$ ) ]]; then
            error "Not an IP address — nothing changed."; return 1
        fi
    fi
    if [[ -n "$PMG_IN_PUBLIC_IP" && "$PMG_IN_PUBLIC_IP" == "$PMG_IN_OLD_IP" ]]; then
        PMG_IN_SAMEBOX=1
        info "The archive came from THIS box's IP (a rebuild in place) — there is no other hub to probe."
        return 0
    fi
    _pmg_in_dark_probe
    case "$PMG_IN_DARK" in
        dark)  success "Old hub $PMG_IN_OLD_IP is dark ($PMG_IN_DARK_WHY)." ;;
        alive) error "The old hub is still serving: $PMG_IN_DARK_WHY."
               error "  Run Migrate OUT there first (B → 6). Two live pools on one wallet seed must never happen."
               error "  Nothing changed."
               return 1 ;;
        *)     warn "Cannot PROVE the old hub ($PMG_IN_OLD_IP) is dark: $PMG_IN_DARK_WHY."
               warn "  A firewall that DROPS or REJECTS for the old box looks exactly like a dead box."
               echo -e "  On the OLD box, confirm: ${BOLD}systemctl is-active $POOL_SERVICE${RESET} → inactive, and B → 6 finished."
               echo -ne "  Type ${BOLD}OLD HUB IS DARK${RESET} once you have checked (anything else stops; nothing changed): "
               read -r go || go=""
               [[ "$go" == "OLD HUB IS DARK" ]] || { info "Stopped — nothing changed."; return 1; }
               PMG_IN_DARK_CONFIRMED=1
               _pmg_log "old hub not provably dark ($PMG_IN_DARK_WHY) — operator confirmed" ;;
    esac
    return 0
}

_pmg_in_manifest_checks() {
    echo ""; echo -e "${BOLD}Step 1b — the manifest${RESET}"
    local base now age go
    base=$(basename "$PMG_IN_ARCHIVE")
    if [[ "$PMG_MF_KIND" != "grin-pubpool-migration" || "$PMG_MF_SCHEMA" != "1" ]]; then
        error "Unknown manifest (kind '$PMG_MF_KIND', schema '$PMG_MF_SCHEMA') — from another toolkit version? Nothing changed."
        return 1
    fi
    if [[ "$PMG_MF_NET" != "$POOL_NET" || "$PMG_MF_PRODUCT" != "$PBK_PRODUCT" ]]; then
        error "The manifest is for ${PMG_MF_NET:-?} ($PMG_MF_PRODUCT); this menu is $POOL_NET ($PBK_PRODUCT). Nothing changed."
        return 1
    fi
    if [[ "$PMG_MF_ARCHIVE" != "$base" ]]; then
        error "The manifest belongs to '$PMG_MF_ARCHIVE', not to '$base'."
        error "  A later backup of a box that was once migrated still carries that old manifest; this is"
        error "  not the archive Migrate OUT just made. Use the one it printed. Nothing changed."
        return 1
    fi
    echo -e "  Taken    : $PMG_MF_CREATED on ${PMG_MF_HOST:-?} (${PMG_MF_IP:-IP not recorded})"
    echo -e "  Pool     : ${PMG_MF_DOMAIN:-?} · region ${PMG_MF_REGION:-?} · stratum :${PMG_MF_STRATUM_PORT:-?}"
    echo -e "  Ledger   : shares to id ${PMG_MF_SH_MAX:-?} · in-flight withdrawals ${PMG_MF_INFLIGHT:-?} · node height ${PMG_MF_HEIGHT:-?}"
    echo -e "  Wallet   : total ${PMG_MF_W_TOTAL:-not recorded} · spendable ${PMG_MF_W_SPEND:-?} · immature ${PMG_MF_W_IMM:-?}"
    echo -e "  TLS cert : ${PMG_MF_CERTS:-no}"
    now=$(date -u +%s)
    if [[ "$PMG_MF_CREATED_UNIX" =~ ^[0-9]+$ ]]; then
        age=$(( (now - PMG_MF_CREATED_UNIX) / 3600 ))
        if (( age >= 24 )); then
            warn "This archive is ${age} h old. If the old hub served again after it (a rollback), this ledger"
            warn "  is STALE: it would bring back balances that were paid out since."
            echo -ne "  Type ${BOLD}PROCEED${RESET} if the old hub has been dark since then: "
            read -r go || go=""
            [[ "$go" == "PROCEED" ]] || { info "Stopped — nothing changed."; return 1; }
        fi
    fi
    if [[ "$PMG_MF_HEIGHT" =~ ^[0-9]+$ && "$PMG_IN_NODE_HEIGHT" =~ ^[0-9]+$ ]] && (( PMG_IN_NODE_HEIGHT < PMG_MF_HEIGHT )); then
        error "This node is at height $PMG_IN_NODE_HEIGHT — BEHIND the old hub's $PMG_MF_HEIGHT."
        error "  fix: wait until it passes $PMG_MF_HEIGHT (a wallet checked against a shorter chain proves nothing). Nothing changed."
        return 1
    fi
    success "Manifest matches this archive and this network; node height ${PMG_IN_NODE_HEIGHT:-?} ≥ ${PMG_MF_HEIGHT:-?}."
    _pmg_in_clobber_guard || return 1
    _pmg_in_dark_gate     || return 1
    _pmg_in_fw_check 0
}

# ─── State / rollback / failure (after the restore) ──────────────────────────
_pmg_in_print_state() {
    local fb pay svc_a svc_e lst wg_up https
    fb=$(_pmg_frozen_by); _pmg_rechown_db
    if [[ -n "$fb" ]]; then pay="${GREEN}FROZEN${RESET} ${DIM}(by $fb)${RESET}"; else pay="${RED}NOT frozen${RESET}"; fi
    svc_a=$(systemctl is-active "$POOL_SERVICE" 2>/dev/null); svc_e=$(systemctl is-enabled "$POOL_SERVICE" 2>/dev/null)
    if _pmg_port_listening "${PW_OWNER_PORT:-3420}"; then lst="listening on :${PW_OWNER_PORT:-3420}"; else lst="stopped"; fi
    wg_up="down"; ip link show "${WG_IFACE:-none}" >/dev/null 2>&1 && wg_up="up"
    https="no"; _pmg_port_listening 443 && https="yes"
    echo -e "  ${BOLD}State of this box now:${RESET}"
    echo -e "    payouts          : $pay"
    echo -e "    pool service     : ${svc_a:-unknown} · ${svc_e:-unknown}  ${DIM}($POOL_SERVICE)${RESET}"
    echo -e "    wallet listener  : $lst"
    echo -e "    hub WireGuard    : $wg_up  ${DIM}(${WG_IFACE:-none})${RESET}"
    echo -e "    HTTPS :443       : $https"
}

_pmg_in_print_rollback() {
    echo -e "  ${BOLD}Rollback (back to the OLD box) — valid ONLY while this hub has accepted no${RESET}"
    echo -e "  ${BOLD}shares and paid nothing:${RESET}"
    echo -e "    here FIRST:   systemctl disable --now $POOL_SERVICE"
    echo -e "                  pool menu 5) → 3) Stop listener, 6) d (boot autostart), 7) r (watchdog)"
    if [[ -f "${WG_CONF:-/nonexistent}" ]]; then
        echo -e "                  systemctl disable --now wg-quick@${WG_IFACE}"
    fi
    echo -e "    then on the OLD box: the rollback commands Migrate OUT printed; DNS back to the old IP."
}

_pmg_in_fail() {  # <step> <message>
    echo ""
    error "Migrate IN stopped at step $1: $2"
    if [[ "$PMG_IN_STAGE" == "none" ]]; then
        echo -e "  Nothing on this box was changed."
    else
        warn "Payouts stay FROZEN. Nothing here unfreezes them."
        echo ""
        _pmg_in_print_state
    fi
    echo ""
    echo -e "  ${BOLD}To resume:${RESET} fix the cause above, then B → 7) Migrate IN again with the same archive."
    if [[ "$PMG_IN_STAGE" == "started" ]]; then
        echo ""
        _pmg_in_print_rollback
    fi
    _pmg_log "FAILED at step $1: $2"
    return 1
}

# ─── Step 3: restore ─────────────────────────────────────────────────────────
_pmg_in_restore() {
    echo ""; echo -e "${BOLD}Step 3 — restore${RESET}"
    local go rc
    echo -e "  ${RED}${BOLD}This OVERWRITES at their original paths:${RESET}"
    tar -tzf "$PMG_IN_CLEAR" 2>/dev/null | awk -F/ 'NF>=3{print "/"$1"/"$2"/"$3}' | sort -u | sed 's|^|    |'
    echo -ne "  Type ${BOLD}RESTORE${RESET} to confirm (anything else stops; nothing changed): "
    read -r go || go=""
    [[ "$go" == "RESTORE" ]] || { info "Stopped — nothing changed."; return 1; }

    # 1) Install ENABLED the pool unit. From the restore until step 7 this box holds the old
    # hub's seed and ledger, and a reboot must not start that pool unattended — so the unit is
    # disabled first, and only step 7 enables it again (audit Part 9 C2).
    systemctl disable "$POOL_SERVICE" >/dev/null 2>&1 || true
    if [[ "$(systemctl is-enabled "$POOL_SERVICE" 2>/dev/null)" == "enabled" ]]; then
        error "Could not disable $POOL_SERVICE at boot — nothing restored. systemctl disable $POOL_SERVICE, then B → 7 again."
        return 1
    fi

    _pbk_restore_extract "$PMG_IN_CLEAR" "$PMG_IN_FREEZE_REASON" "$PMG_IN_FREEZE_BY"
    rc=$?
    case "$rc" in
        0) PMG_IN_STAGE="restored"
           warn "Payouts FROZEN on the restored ledger (reason: $PMG_IN_FREEZE_REASON)." ;;
        1) PMG_IN_STAGE="restored"
           # The core froze whatever pool.db a partial extraction left in place.
           [[ "$PBK_EXTRACT_FROZEN" == "1" ]] || error "Payouts could NOT be frozen on the pool.db now in place."
           _pbk_restore_perms
           _pmg_in_fail 3 "extraction failed — this box may hold a PARTIAL restore (disk full? df -h)"
           return 1 ;;
        2) PMG_IN_STAGE="restored"; _pbk_restore_perms
           _pmg_in_fail 3 "payouts could NOT be frozen on the restored pool.db — do not start anything"
           return 1 ;;
        *) PMG_IN_STAGE="restored"; _pbk_restore_perms
           _pmg_in_fail 3 "the archive held no pool.db"
           return 1 ;;
    esac
    _pbk_restore_perms
    success "Restored: pool.db, pool.json, wallet, WG identity${PMG_MF_CERTS:+, TLS cert ($PMG_MF_CERTS)}."
    _pmg_log "restored $(basename "$PMG_IN_ARCHIVE") — payouts frozen"
}

# ─── Step 4: location ────────────────────────────────────────────────────────
# The seeded row for a new tag (e.g. cqf) already exists INACTIVE on the old hub's DB.
# Part 1's rule in ensureLocalRegion activates it on the first start because the tag
# differs from the `_state/local_region` stamp. A manifest WITHOUT a stamp (the old hub
# never ran that code) would make the move look like a first boot → stamp only, no
# activation; so the old tag is written as the stamp here first (F3).
read -r -d '' _PMG_JS_LOC <<'JS' || true
const { DatabaseSync } = require('node:sqlite');
const [db, oldR, tag, label, country, cc, lat, lng] = process.argv.slice(1);
const d = new DatabaseSync(db);
d.exec('PRAGMA busy_timeout = 15000');
let stamped = 0;
const st = d.prepare("SELECT value FROM pool_config WHERE section = '_state' AND key = 'local_region'").get();
if (!st && oldR) {
  d.prepare("INSERT INTO pool_config (section, key, value, value_type) VALUES ('_state', 'local_region', ?, 'string')").run(oldR);
  stamped = 1;
}
const row = d.prepare('SELECT label, country_code, is_active FROM pool_locations WHERE region = ?').get(tag);
if (lat !== '' && lng !== '') {
  if (row) d.prepare('UPDATE pool_locations SET lat = ?, lng = ?, updated_at = unixepoch() WHERE region = ?').run(Number(lat), Number(lng), tag);
  else d.prepare('INSERT INTO pool_locations (region, label, country, country_code, is_active, lat, lng) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(tag, label || null, country || null, cc || null, Number(lat), Number(lng));
}
d.close();
const v = (x) => (x === null || x === undefined) ? '' : String(x);
console.log([stamped, row ? 1 : 0, row ? v(row.label) : '', row ? v(row.country_code) : '', row ? v(row.is_active) : ''].join('|'));
JS

_pmg_in_location() {
    echo ""; echo -e "${BOLD}Step 4 — location${RESET}"
    local role cur ans tag label country cc lat lng res stamped had rlabel rcc ract
    role=$(_pmg_conf role singlebox)
    if [[ "$role" != "singlebox" ]]; then
        info "Role '$role' publishes no local region — nothing to relocate."; return 0
    fi
    cur=$(_pmg_conf region main)
    echo -e "  The old hub's region: ${BOLD}$cur${RESET} ${DIM}($(_pmg_conf region_label '') $(_pmg_conf region_country_code ''))${RESET}"
    echo -ne "  Is this hub in a NEW location (a different region tag, e.g. nyc → cqf)? [y/N]: "
    read -r ans || ans=""
    if [[ "${ans,,}" != "y" ]]; then info "Region stays '$cur'."; return 0; fi
    declare -F pool_write_conf_key >/dev/null 2>&1 || { _pmg_in_fail 4 "pool_write_conf_key is not loaded"; return 1; }

    while true; do
        echo -ne "  New region tag (2–12 of a-z 0-9 -, e.g. cqf; 0 = keep '$cur'): "
        read -r tag || tag="0"
        tag="${tag,,}"
        if [[ "$tag" == "0" || -z "$tag" ]]; then info "Region stays '$cur'."; return 0; fi
        if [[ ! "$tag" =~ ^[a-z0-9-]{2,12}$ ]]; then warn "Use 2–12 of a-z 0-9 -."; continue; fi
        if [[ "$tag" == "$cur" ]]; then warn "That is the current tag."; continue; fi
        if node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Object.prototype.hasOwnProperty.call(d.region_ports||{},process.argv[2])?0:1);}catch(e){process.exit(1);}' "$POOL_CONF" "$tag" 2>/dev/null; then
            warn "'$tag' is a GATEWAY's region (it has a tunnel port) — the hub cannot take it. Pick another."; continue
        fi
        break
    done
    echo -ne "  Display name (e.g. Gravelines; Enter = none): "; read -r label || label=""
    echo -ne "  Country (e.g. France; Enter = none): ";           read -r country || country=""
    echo -ne "  2-letter country code (e.g. FR; Enter = none): "; read -r cc || cc=""
    cc=$(printf '%s' "$cc" | tr '[:lower:]' '[:upper:]')
    if [[ -n "$cc" && ! "$cc" =~ ^[A-Z]{2}$ ]]; then warn "Ignoring '$cc' — not a 2-letter code."; cc=""; fi
    echo -ne "  Map position lat,lng (e.g. 50.98,2.13; Enter = set later in admin → Regions): "
    local ll; read -r ll || ll=""
    lat=""; lng=""
    if [[ -n "$ll" ]]; then
        ll="${ll//[[:space:]]/}"
        if [[ "$ll" =~ ^(-?[0-9]{1,2}(\.[0-9]+)?),(-?[0-9]{1,3}(\.[0-9]+)?)$ ]] \
           && node -e 'const a=+process.argv[1],b=+process.argv[2];process.exit(a>=-90&&a<=90&&b>=-180&&b<=180?0:1)' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" 2>/dev/null; then
            lat="${BASH_REMATCH[1]}"; lng="${BASH_REMATCH[3]}"
        else
            warn "Ignoring '$ll' — expected lat,lng in range. Set it in admin → Regions."
        fi
    fi

    # Empty values are written too: pool.json still holds the OLD hub's label/country, and
    # a new row created from them would publish "New York" for a box in France.
    pool_write_conf_key region "$tag"                   || { _pmg_in_fail 4 "could not write region to $POOL_CONF"; return 1; }
    pool_write_conf_key region_label "$label"           || { _pmg_in_fail 4 "could not write region_label"; return 1; }
    pool_write_conf_key region_country "$country"       || { _pmg_in_fail 4 "could not write region_country"; return 1; }
    pool_write_conf_key region_country_code "$cc"       || { _pmg_in_fail 4 "could not write region_country_code"; return 1; }
    res=$(node -e "$_PMG_JS_LOC" "$(_pmg_db)" "$cur" "$tag" "$label" "$country" "$cc" "$lat" "$lng" 2>/dev/null)
    local rc=$?
    _pmg_rechown_db
    [[ "$rc" -eq 0 && -n "$res" ]] || { _pmg_in_fail 4 "could not update pool.db for the new region"; return 1; }
    IFS='|' read -r stamped had rlabel rcc ract <<< "$res"
    [[ "$stamped" == "1" ]] && info "The old hub never stamped its region — wrote '$cur' as the last local region, so the first start sees a move (F3)."
    if [[ "$had" == "1" ]]; then
        info "Row '$tag' already exists (${rlabel:-no label} ${rcc}, $( [[ "$ract" == "1" ]] && echo active || echo inactive )) — the first start activates it."
        echo -e "  ${DIM}Its label, country and connect host are NOT overwritten from here: edit them in admin → Regions.${RESET}"
    else
        info "Row '$tag' is created on the first start."
    fi
    success "Region → '$tag'."
    echo -e "  ${DIM}'$cur' is left as it is — deactivate or re-point it in admin → Regions (that box may become a gateway).${RESET}"
    _pmg_log "region $cur → $tag"
}

# ─── Step 5: bring-up (nothing that serves miners yet) ───────────────────────
_pmg_in_nginx() {
    local dom se n=0
    dom=$(_pmg_conf subdomain "")
    if ! command -v nginx >/dev/null 2>&1; then
        warn "nginx is not installed — install it, then 4) Setup nginx after DNS moves."; return 0
    fi
    if [[ -n "$dom" && -f "$PBK_LE_DIR/live/$dom/fullchain.pem" && -f "$PBK_LE_DIR/live/$dom/privkey.pem" ]]; then
        # The archive carries the vhost but NOT its header snippets, rate-limit zones or the
        # sites-enabled link, so a bare nginx -t + reload of the restored file cannot work
        # here. 4) Setup nginx regenerates all of it from pool.json, and with the cert already
        # in place it goes straight to the SSL vhost — no certbot, no DNS needed.
        declare -F pool_setup_nginx >/dev/null 2>&1 || { _pmg_in_fail 5 "pool_setup_nginx is not loaded"; return 1; }
        info "TLS cert for $dom came in the archive — writing the vhost (4) Setup nginx, no certbot)..."
        pool_setup_nginx || { _pmg_in_fail 5 "4) Setup nginx failed (above)"; return 1; }
        # A reload returns 0 BEFORE the master binds (CLAUDE.md) — look for the listener.
        while ! _pmg_port_listening 443 && (( n < 10 )); do sleep 1; n=$((n + 1)); done
        _pmg_port_listening 443 || { _pmg_in_fail 5 "nginx reloaded, but nothing listens on :443"; return 1; }
        PMG_IN_CERT_OK=1
        success "HTTPS up: :443 listening for $dom (the old hub's cert)."
        return 0
    fi
    warn "No TLS cert for ${dom:-the pool domain} came in the archive — HTTPS starts after DNS moves:"
    warn "  then run 4) Setup nginx (it issues the certificate)."
    # A restored SSL vhost pointing at a cert this box lacks must not stay ENABLED: the next
    # nginx start — a reboot, a certbot renewal — would fail for every site here (§J16-5).
    se="$PMG_NGINX_SITES_ENABLED/$(basename "$POOL_NGINX_CONF")"
    if [[ -L "$se" || -f "$se" ]] && ! nginx -t >/dev/null 2>&1; then
        rm -f "$se" && warn "Disabled the restored pool vhost ($se): nginx -t fails without its cert."
    fi
    return 0
}

_pmg_in_bringup() {
    echo ""; echo -e "${BOLD}Step 5 — bring-up${RESET}"
    local out wdir tag
    # a. node secrets — the restored wallet toml points at the OLD box's node dir.
    if declare -F grin_secrets_sync_all >/dev/null 2>&1; then out=$(grin_secrets_sync_all 2>&1)
    elif command -v grin-secret-sync >/dev/null 2>&1; then out=$(grin-secret-sync 2>&1)
    else _pmg_in_fail 5 "grin-secret-sync is not available"; return 1
    fi
    [[ -n "$out" ]] && sed 's/^/    /' <<< "$out"
    if grep -q 'RESTART the' <<< "$out"; then
        _pmg_in_fail 5 "the node's pool wiring was just changed — the RUNNING node does not have it. Restart the node (Script 01), let it sync, then B → 7 again"
        return 1
    fi
    if declare -F grin_install_secret_sync >/dev/null 2>&1; then
        grin_install_secret_sync >/dev/null 2>&1 || warn "Could not install the grin-secret-sync timer (self-heal)."
    fi
    success "Node secrets re-pointed at this box's node."

    # b. wallet binary — archives never carry it.
    wdir=$(pw_wallet_dir)
    if [[ ! -x "$(pw_bin)" ]]; then
        tag=$(gwi_current_tag "$wdir" 2>/dev/null || true)
        info "Installing grin-wallet${tag:+ $tag} into $wdir (binaries never travel in an archive)..."
        if [[ -n "$tag" ]]; then
            GWI_PIN_TAG="$tag" gwi_install_grin_wallet "$wdir" 0 || { _pmg_in_fail 5 "grin-wallet $tag install failed"; return 1; }
        else
            gwi_install_grin_wallet "$wdir" 0 || { _pmg_in_fail 5 "grin-wallet install failed"; return 1; }
        fi
    fi
    [[ -x "$(pw_bin)" ]] || { _pmg_in_fail 5 "no grin-wallet binary at $(pw_bin)"; return 1; }
    success "grin-wallet binary present."

    # c. ownership (after the binary landed as root)
    if declare -F pool_deroot >/dev/null 2>&1; then pool_deroot >/dev/null 2>&1 || { _pmg_in_fail 5 "pool_deroot failed"; return 1; }; fi
    if declare -F pool_ensure_served_dirs >/dev/null 2>&1; then pool_ensure_served_dirs || true; fi
    success "Ownership swept to the grinpool service user."

    # d. web files — the web root is not in the archive; pool-config.js comes from pool.json.
    if declare -F pool_deploy_web >/dev/null 2>&1; then
        pool_deploy_web || { _pmg_in_fail 5 "the web files could not be deployed"; return 1; }
    fi

    # e. hub WireGuard (restored conf + keys = same hub key, same tunnel IPs: no re-pairing)
    if [[ -f "${WG_CONF:-/nonexistent}" ]]; then
        systemctl enable --now "wg-quick@${WG_IFACE}" >/dev/null 2>&1 || true
        if ! ip link show "$WG_IFACE" >/dev/null 2>&1; then wg-quick up "$WG_IFACE" >/dev/null 2>&1 || true; fi
        ip link show "$WG_IFACE" >/dev/null 2>&1 || { _pmg_in_fail 5 "hub tunnel $WG_IFACE did not come up (wg-quick up $WG_IFACE shows why)"; return 1; }
        if [[ "$(systemctl is-enabled "wg-quick@${WG_IFACE}" 2>/dev/null)" != "enabled" ]]; then
            warn "wg-quick@${WG_IFACE} is up but not enabled at boot — systemctl enable wg-quick@${WG_IFACE}"
        fi
        success "Hub WireGuard $WG_IFACE up + enabled (gateways keep their pairing)."
    else
        info "No hub WireGuard in the archive (single-box pool)."
    fi

    # f. nginx
    _pmg_in_nginx || return 1
}

# ─── Step 6: continuity ──────────────────────────────────────────────────────
_pmg_in_is_zero() { [[ -z "$1" || "$1" =~ ^0*(\.0*)?$ ]]; }

_pmg_in_continuity() {
    echo ""; echo -e "${BOLD}Step 6 — continuity (nothing that serves has started)${RESET}"
    local rows rc label exp act v mark bad=0 warnw=0 go
    rows=$(_pmg_js continuity "$PMG_IN_MANIFEST"); rc=$?
    _pmg_rechown_db
    if [[ "$rc" -ne 0 && "$rc" -ne 4 ]] || [[ -z "$rows" ]]; then
        _pmg_in_fail 6 "could not compare the restored pool.db with the manifest (node exited $rc)"; return 1
    fi
    printf '    %-30s %-22s %s\n' "pool.db" "manifest (old hub)" "restored here"
    while IFS=$'\t' read -r label exp act v; do
        case "$v" in
            ok)   mark="${GREEN}✓${RESET}" ;;
            skip) mark="${DIM}–${RESET}" ;;
            *)    mark="${RED}✗${RESET}"; bad=1 ;;
        esac
        printf '  %b %-30s %-22s %s\n' "$mark" "$label" "$exp" "$act"
    done <<< "$rows"

    info "Wallet on THIS box (grin-wallet info as the service user, passphrase on stdin)..."
    printf '    %-30s %-22s %s\n' "wallet" "manifest (old hub)" "this box"
    if ! _pmg_wallet_info; then
        printf '  %b %-30s %-22s %s\n' "${RED}✗${RESET}" "opens here" "yes" "NO: ${PMG_W_ERROR:-?}"
        bad=1
    else
        if [[ "$PMG_W_REFRESHED" == "1" ]]; then
            printf '  %b %-30s %-22s %s\n' "${GREEN}✓${RESET}" "refreshed from this node" "yes" "yes"
        else
            printf '  %b %-30s %-22s %s\n' "${RED}✗${RESET}" "refreshed from this node" "yes" "cache only"
            bad=1
        fi
        if [[ "$PMG_MF_W_OK" != "1" || -z "$PMG_MF_W_TOTAL" ]]; then
            printf '  %b %-30s %-22s %s\n' "${DIM}–${RESET}" "total" "not recorded" "$PMG_W_TOTAL"
        elif [[ "$PMG_W_TOTAL" == "$PMG_MF_W_TOTAL" ]]; then
            printf '  %b %-30s %-22s %s\n' "${GREEN}✓${RESET}" "total" "$PMG_MF_W_TOTAL" "$PMG_W_TOTAL"
        elif ! _pmg_in_is_zero "$PMG_MF_INFLIGHT" || ! _pmg_in_is_zero "$PMG_MF_W_AWAIT"; then
            # No coinbase can arrive while both pools are stopped; only a transaction the old
            # hub had already started can move the total. That case is explained, not fatal.
            printf '  %b %-30s %-22s %s\n' "${YELLOW}⚠${RESET}" "total" "$PMG_MF_W_TOTAL" "$PMG_W_TOTAL"
            warnw=1
        else
            printf '  %b %-30s %-22s %s\n' "${RED}✗${RESET}" "total" "$PMG_MF_W_TOTAL" "$PMG_W_TOTAL"
            bad=1
        fi
        printf '    %-30s %-22s %s\n' "spendable" "${PMG_MF_W_SPEND:--}" "${PMG_W_SPENDABLE:--}"
        printf '    %-30s %-22s %s\n' "immature" "${PMG_MF_W_IMM:--}" "${PMG_W_IMMATURE:--}"
        printf '    %-30s %-22s %s\n' "locked" "${PMG_MF_W_LOCKED:--}" "${PMG_W_LOCKED:--}"
        echo -e "    ${DIM}(immature → spendable as blocks pass is expected; the total may not move)${RESET}"
    fi
    if [[ "$bad" -ne 0 ]]; then
        _pmg_in_fail 6 "the restored state does NOT match the manifest (✗ above) — wrong or damaged archive, or a ledger that moved"
        return 1
    fi
    if [[ "$warnw" -eq 1 ]]; then
        warn "The wallet total changed, and the old hub had withdrawals in flight or funds awaiting"
        warn "  confirmation. A payout that confirmed since Migrate OUT explains it — reconcile it before"
        warn "  resuming payouts."
        echo -ne "  Type ${BOLD}ACCEPT${RESET} to continue with this wallet total (anything else stops): "
        read -r go || go=""
        [[ "$go" == "ACCEPT" ]] || { _pmg_in_fail 6 "the wallet total differs — stopped by the operator"; return 1; }
        _pmg_log "wallet total $PMG_MF_W_TOTAL → $PMG_W_TOTAL accepted (in flight at OUT)"
    fi
    success "Continuity: every ledger figure matches the manifest; the wallet opens against this node."
    _pmg_log "continuity OK"
}

# ─── Step 7: start ───────────────────────────────────────────────────────────
_pmg_in_start() {
    echo ""; echo -e "${BOLD}Step 7 — start${RESET}"
    local go port n=0 ok=0 body role sp prc
    # Minutes have passed since step 1b: the old hub is probed once more, right before the
    # only step that could put a second pool on this seed.
    if [[ "$PMG_IN_SAMEBOX" -ne 1 ]]; then
        _pmg_in_dark_probe
        case "$PMG_IN_DARK" in
            dark)  success "Old hub still dark." ;;
            alive) _pmg_in_fail 7 "the OLD hub answers again ($PMG_IN_DARK_WHY) — stop it there before anything starts here"
                   return 1 ;;
            *)     if [[ "$PMG_IN_DARK_CONFIRMED" -ne 1 ]]; then
                       warn "The old hub no longer PROVABLY dark: $PMG_IN_DARK_WHY."
                       echo -ne "  Type ${BOLD}OLD HUB IS DARK${RESET} once checked on the old box (anything else stops): "
                       read -r go || go=""
                       [[ "$go" == "OLD HUB IS DARK" ]] || { _pmg_in_fail 7 "the old hub could not be confirmed dark"; return 1; }
                       PMG_IN_DARK_CONFIRMED=1
                   else
                       info "Old hub still not provable ($PMG_IN_DARK_WHY) — on your earlier confirmation."
                   fi ;;
        esac
    fi

    declare -F pw_listener_start >/dev/null 2>&1 || { _pmg_in_fail 7 "wallet helpers are not loaded"; return 1; }
    pw_listener_start || { _pmg_in_fail 7 "the wallet listener did not start or unlock (above)"; return 1; }

    systemctl enable "$POOL_SERVICE" >/dev/null 2>&1 || true
    systemctl start "$POOL_SERVICE" 2>/dev/null || { PMG_IN_STAGE="started"; _pmg_in_fail 7 "systemctl start $POOL_SERVICE failed — journalctl -u $POOL_SERVICE -n 50"; return 1; }
    PMG_IN_STAGE="started"

    port=$(_pmg_conf service_port "${POOL_PORT:-8080}")
    while (( n < 30 )); do
        body=$(curl -s --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null)
        if node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.status==="ok"&&j.network===process.argv[1]?0:1);}catch(e){process.exit(1);}})' "$POOL_NET" <<< "$body" 2>/dev/null; then
            ok=1; break
        fi
        sleep 1; n=$((n + 1))
    done
    [[ "$ok" -eq 1 ]] || { _pmg_in_fail 7 "the pool service runs but /api/health does not answer ($POOL_NET) on :$port — journalctl -u $POOL_SERVICE -n 50"; return 1; }
    success "Pool API answers on :$port ($POOL_NET)."

    role=$(_pmg_conf role singlebox)
    if [[ "$role" == "singlebox" ]]; then
        sp=$(_pmg_conf stratum_port "")
        n=0
        while [[ -n "$sp" ]] && ! _pmg_port_listening "$sp" && (( n < 10 )); do sleep 1; n=$((n + 1)); done
        if [[ -n "$sp" ]] && ! _pmg_port_listening "$sp"; then
            _pmg_in_fail 7 "nothing listens on the public stratum :$sp"; return 1
        fi
        success "Stratum listening on :$sp."
    fi

    prc=0; pw_coinbase_probe || prc=$?
    case "$prc" in
        0) success "Wallet open — coinbase (build_coinbase) answers." ;;
        1) _pmg_in_fail 7 "the wallet listener is up but LOCKED — coinbase would fail (pool menu 5) → 2)"; return 1 ;;
        *) warn "Could not confirm the wallet is open (build_coinbase probe inconclusive) — check pool menu 5)." ;;
    esac

    # This box is now THE hub: give it the restart paths Migrate OUT took off the old one.
    pw_autostart_enable >/dev/null 2>&1 || warn "Wallet boot autostart NOT enabled — pool menu 5) → 6) e."
    pw_watchdog_install >/dev/null 2>&1 || warn "Wallet watchdog NOT installed — pool menu 5) → 7) i."
    success "Wallet boot autostart + */5 watchdog on."

    # Retire the manifest: a later backup of THIS box must not carry it as if it were fresh.
    local live="$POOL_APP_DIR/$PMG_MANIFEST_NAME"
    if [[ -f "$live" ]]; then
        mv -f "$live" "$POOL_APP_DIR/migration_manifest.applied-$(date -u +%Y%m%dT%H%M%SZ).json" 2>/dev/null \
            || warn "Could not rename $live — delete it by hand once the move is settled."
    fi
    _pmg_log "started on $(hostname 2>/dev/null) — payouts still frozen"
}

# ─── Step 8: ready for DNS ───────────────────────────────────────────────────
_pmg_in_dns() {
    local ip dom wgh cf sturl sthost r kind seen=" " rec
    ip="${PMG_IN_PUBLIC_IP:-}"; [[ -n "$ip" ]] || ip=$(_pmg_public_ip)
    [[ -n "$ip" ]] || ip="<this box's public IP>"
    rec="A"; [[ "$ip" == *:* ]] && rec="AAAA"
    dom=$(_pmg_conf subdomain ""); wgh=$(_pmg_conf wg_endpoint_host ""); cf=$(_pmg_conf cloudflare_proxy "")
    sturl=$(_pmg_js facts | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const r=JSON.parse(s).local_region_row;if(r&&r.stratum_url)process.stdout.write(String(r.stratum_url));}catch(e){}})' 2>/dev/null)
    _pmg_rechown_db
    sthost="${sturl#*://}"; sthost="${sthost%%/*}"; sthost="${sthost%:*}"
    echo ""
    echo -e "${BOLD}${GREEN}Step 8 — ready for DNS.${RESET}"
    echo -e "  Point these $rec records at ${BOLD}$ip${RESET}:"
    local -a recs=()
    [[ -n "$dom" ]]    && recs+=("$dom|web" "www.$dom|web")
    [[ -n "$sthost" ]] && recs+=("$sthost|stratum")
    [[ -n "$wgh" ]]    && recs+=("$wgh|wg")
    for r in "${recs[@]}"; do
        kind="${r#*|}"; r="${r%|*}"
        [[ "$seen" == *" $r "* ]] && continue
        seen+="$r "
        case "$kind" in
            web)     if [[ "$cf" == "true" ]]; then echo -e "    ${BOLD}$r${RESET}  ${DIM}(Cloudflare: proxied, as before)${RESET}"; else echo -e "    ${BOLD}$r${RESET}"; fi ;;
            stratum) echo -e "    ${BOLD}$r${RESET}  ${DIM}(stratum — DNS only: a proxy cannot carry raw TCP :$(_pmg_conf stratum_port 3333))${RESET}" ;;
            wg)      echo -e "    ${BOLD}$r${RESET}  ${DIM}(WireGuard endpoint — DNS only; gateways re-resolve it)${RESET}" ;;
        esac
    done
    if [[ -z "$wgh" && -f "${WG_CONF:-/nonexistent}" ]]; then
        echo -e "    ${DIM}(no wg_endpoint_host: each gateway is paired to the old raw IP → on each gateway${RESET}"
        echo -e "    ${DIM} 2) Configure the new endpoint $ip:${WG_LISTEN_PORT:-51820}, then 3) Bring up tunnel)${RESET}"
    fi
    echo -e "  ${DIM}TTL: lowered to 60 s ≥ 48 h ago → miners follow within minutes. Otherwise resolvers keep${RESET}"
    echo -e "  ${DIM}the old IP up to the old TTL; nothing is lost meanwhile — miners on the dark hub retry.${RESET}"
}

# ─── Step 9: watch the gateways come back ────────────────────────────────────
read -r -d '' _PMG_JS_WATCH <<'JS' || true
const fs = require('fs');
const [stJson, confPath, dbPath, localRegion, okAge] = process.argv.slice(1);
let st = {}, conf = {};
try { st = JSON.parse(stJson); } catch (e) {}
try { conf = JSON.parse(fs.readFileSync(confPath, 'utf8')); } catch (e) {}
const hs = {};
for (const g of (st.gateways || [])) hs[g.region] = g.handshake_age;
const regions = [...new Set([...Object.keys(conf.region_ports || {}), ...Object.keys(hs)])].sort();
const now = Math.floor(Date.now() / 1000);
const act = {};
try {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(dbPath, { readOnly: true });
  for (const r of d.prepare('SELECT region, MAX(created_at) AS t, COUNT(DISTINCT grin_address) AS m FROM shares WHERE created_at > ? GROUP BY region').all(now - 600)) {
    act[r.region] = { t: r.t, m: r.m };
  }
  d.close();
} catch (e) {}
const age = (s) => s === null || s === undefined ? 'never' : (s < 120 ? s + ' s' : Math.round(s / 60) + ' min');
const pad = (s, n) => String(s).padEnd(n);
console.log('    ' + pad('region', 12) + pad('WG handshake', 16) + pad('last share', 14) + 'miners (10 min)');
let ok = 0;
for (const r of regions) {
  const a = hs[r];
  const good = a !== null && a !== undefined && a < Number(okAge);
  if (good) ok++;
  const x = act[r];
  console.log('  ' + (good ? 'OK' : '..') + pad(r, 12) + pad(age(a), 16) + pad(x ? age(now - x.t) : '> 10 min', 14) + (x ? x.m : 0));
}
if (localRegion) {
  const x = act[localRegion];
  console.log('  --' + pad(localRegion, 12) + pad('(direct)', 16) + pad(x ? age(now - x.t) : '> 10 min', 14) + (x ? x.m : 0));
}
console.log('SUMMARY ' + ok + ' ' + regions.length);
JS

_pmg_in_watch() {
    local k out gw_bin="${GWCTL_BIN:-/usr/local/bin/grin-gateway-ctl}" st lr
    if [[ ! -f "${WG_CONF:-/nonexistent}" ]]; then info "No regional gateways — nothing to watch."; return 0; fi
    echo -ne "  Watch the gateways reconnect now? [Y/n]: "
    read -r k || k="n"
    [[ "${k,,}" == "n" ]] && return 0
    lr=""; [[ "$(_pmg_conf role singlebox)" == "singlebox" ]] && lr=$(_pmg_conf region main)
    while true; do
        clear 2>/dev/null || true
        echo -e "${BOLD}${CYAN}  Gateways → this hub ($(date -u '+%H:%M:%S') UTC)${RESET}"
        st=$("$gw_bin" status --net "$POOL_NET" 2>/dev/null || echo '{}')
        out=$(node -e "$_PMG_JS_WATCH" "$st" "$POOL_CONF" "$(_pmg_db)" "$lr" "$PMG_IN_HANDSHAKE_OK_S" 2>/dev/null)
        while IFS= read -r k; do
            case "$k" in
                SUMMARY*) set -- $k; echo ""; echo -e "  ${BOLD}$2 of $3${RESET} gateways reconnected (handshake < ${PMG_IN_HANDSHAKE_OK_S} s)." ;;
                "  OK"*)  echo -e "  ${GREEN}✓${RESET} ${k:4}" ;;
                "  .."*)  echo -e "  ${YELLOW}·${RESET} ${k:4}" ;;
                "  --"*)  echo -e "  ${DIM}·${RESET} ${k:4}" ;;
                *)        echo -e "$k" ;;
            esac
        done <<< "$out"
        echo -e "  ${DIM}A gateway paired to a DNS name follows ~2–3 min after DNS propagates (its re-resolve${RESET}"
        echo -e "  ${DIM}timer); one paired to a raw IP needs 2) Configure on that gateway, then 3).${RESET}"
        echo -ne "  Enter = refresh · q = done: "
        read -r k || k="q"
        [[ "${k,,}" == "q" ]] && break
    done
    return 0
}

# ─── Step 10: final screen ───────────────────────────────────────────────────
_pmg_in_final() {
    echo ""
    echo -e "${BOLD}${GREEN}Migrate IN complete.${RESET} This box is the hub. Payouts are still ${BOLD}FROZEN${RESET}."
    echo ""
    echo -e "  ${BOLD}Next, in this order:${RESET}"
    echo -e "    1. Change the DNS records above, if not done yet. Re-check gateways any time: W → list."
    if [[ "$PMG_IN_CERT_OK" -ne 1 ]]; then
        echo -e "    2. Once DNS points here: ${BOLD}4) Setup nginx${RESET} issues the TLS certificate."
    else
        echo -e "    2. HTTPS is up with the old hub's cert; certbot renews it here from now on."
    fi
    echo -e "    3. Reconcile: admin → Health → Reconciliation must report clean."
    echo -e "    4. THEN resume payouts in admin → Payouts. Nothing here unfreezes them."
    echo -e "    5. B → 3 turns the daily backup back on (B → 4 → 1 first if this box has no key yet)."
    echo -e "       ${DIM}Its first run REPLACES today's migration archive (same name) — keep a copy elsewhere.${RESET}"
    echo -e "    6. Wipe the OLD box after ~7 days — it still holds the wallet seed and the hub WG key."
    echo ""
    _pmg_in_print_rollback
    _pmg_log "complete — $(basename "$PMG_IN_ARCHIVE"); payouts frozen"
}

# ─── Intro + orchestration ───────────────────────────────────────────────────
_pmg_in_intro() {
    local go dom
    dom=$(_pmg_conf subdomain "")
    clear 2>/dev/null || true
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  Migrate IN — a Migrate OUT archive → this box (${POOL_NET_LABEL:-$POOL_NET})${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    [[ -n "$dom" ]] && dom=" · pool.json here: $dom"
    echo -e "  ${DIM}Service $POOL_SERVICE$dom${RESET}"
    echo ""
    echo -e "  In this order:"
    echo -e "    1. Checks (read-only): 1) Install ran, node synced, the archive and its manifest, and"
    echo -e "       the OLD hub is dark — it must not answer on its stratum or its pool API."
    echo -e "    2. Restore — the same extraction as 2) Restore. Payouts come up FROZEN."
    echo -e "    3. Location: a new region tag if this hub moved (e.g. nyc → cqf)."
    echo -e "    4. Bring-up: node secrets, wallet binary, ownership, web files, WireGuard, nginx."
    echo -e "    5. Continuity: every balance, count and max id must EQUAL the manifest, and the wallet"
    echo -e "       must open against this node. Any ✗ stops here — nothing has started."
    echo -e "    6. Wallet listener + pool start; then the DNS records to change."
    echo ""
    echo -e "  ${YELLOW}Run CHECK first, BEFORE Migrate OUT on the old hub — what it finds is then fixed while${RESET}"
    echo -e "  ${YELLOW}the old hub still serves, not inside the downtime window.${RESET}"
    echo ""
    echo -ne "  Type ${BOLD}MIGRATE${RESET} to begin, ${BOLD}CHECK${RESET} to check only (anything else cancels): "
    read -r go || go=""
    case "$go" in
        MIGRATE) return 0 ;;
        CHECK)   PMG_IN_CHECK_ONLY=1; return 0 ;;
        *)       info "Cancelled — nothing changed."; return 1 ;;
    esac
}

_pmg_in_run() {
    _pmg_in_intro || return 1
    if [[ "$PMG_IN_CHECK_ONLY" -eq 1 ]]; then _pmg_in_check_only; return 0; fi
    _pmg_in_box_checks || { error "Fix the ✗ items above, then B → 7 again. Nothing changed."; return 1; }
    _pmg_in_locate          || return 1
    _pmg_in_decrypt         || return 1
    _pmg_in_manifest_checks || return 1   # the last read-only step
    _pmg_log "started — $(basename "$PMG_IN_ARCHIVE") from ${PMG_MF_HOST:-?} (${PMG_MF_IP:-?})"
    _pmg_in_restore         || return 1   # from here on payouts are FROZEN
    _pmg_in_location        || return 1
    _pmg_in_bringup         || return 1
    _pmg_in_continuity      || return 1   # the last step before anything serves
    _pmg_in_start           || return 1
    _pmg_in_dns
    _pmg_in_watch
    _pmg_in_final
    return 0
}

pmg_migrate_in() {
    local _PMG_LOG_TAG="migrate-in" rc
    _pmg_in_reset
    _pmg_in_run; rc=$?
    _pmg_in_cleanup
    return "$rc"
}
