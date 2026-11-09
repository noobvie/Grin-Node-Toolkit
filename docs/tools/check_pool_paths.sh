#!/bin/bash
# Tests _pw_safe_path and the root-owned pin (scripts/lib/07_lib_pool_wallet.sh). pool.json is owned
# by grinpool and root acts on these values, so this pins what must never get through.
# Run from the repo root: bash docs/tools/check_pool_paths.sh
# Exit 0 = all passed, 1 = a check failed.

LIB="scripts/lib/07_lib_pool_wallet.sh"
[[ -f "$LIB" ]] || { echo "Run from the repo root."; exit 2; }
for fn in _pw_pin_file _pw_safe_path _pw_pin_set _pw_pinned; do
    eval "$(sed -n "/^$fn() {/,/^}/p" "$LIB")"
done
eval "$(grep '^_pw_pin_file()' "$LIB")"
error() { echo "ERROR $*"; }

DEF=/opt/grin/pubpoolwallet/mainnet
pass=0 failed=0
expect() {  # <label> <input> <expected>
    local got; got=$(_pw_safe_path "$2" "$DEF" 2>/dev/null)
    if [[ "$got" == "$3" ]]; then pass=$((pass + 1)); echo "  PASS  $1"
    else failed=$((failed + 1)); echo "  FAIL  $1 — got: $got"; fi
}

expect "the default"             "$DEF"                       "$DEF"
expect "the pass file"           /opt/grin/pubpool/mainnet/.wallet_pass /opt/grin/pubpool/mainnet/.wallet_pass
expect "an operator's own dir"   /data/wallet                 /data/wallet
expect "command substitution"    '/x$(touch /tmp/p)'          "$DEF"
expect "backticks"               '/x`id`'                     "$DEF"
expect "a newline into the unit" $'/x\nExecStartPre=+/bin/sh' "$DEF"
expect "a space"                 '/x y'                       "$DEF"
expect "a quote"                 "/x'y"                       "$DEF"
expect "a relative path"         x/y                          "$DEF"
expect "dot-dot"                 /opt/grin/pubpool/../lib     "$DEF"
expect "the root dir"            /                            "$DEF"
expect "/etc"                    /etc                         "$DEF"
expect "under /etc"              /etc/cron.d                  "$DEF"
expect "/root"                   /root/x                      "$DEF"
expect "/usr"                    /usr/local/bin               "$DEF"
expect "/opt/grin itself"        /opt/grin                    "$DEF"
expect "the libs root sources"   /opt/grin/lib                "$DEF"
expect "the root-run scripts"    /opt/grin/lib/pubpool-mainnet "$DEF"
expect "the key vault"           /opt/grin/keys               "$DEF"
expect "the config dir"          /opt/grin/conf               "$DEF"
expect "the node dirs"           /opt/grin/node/mainnet-prune "$DEF"
expect "a trailing slash"        /etc/                        "$DEF"
expect "a doubled slash"         //etc/cron.d                 "$DEF"
expect "a dot segment"           /./etc/cron.d                "$DEF"
expect "a doubled inner slash"   /opt//grin/keys              "$DEF"
expect "root's ssh dir"          //root/.ssh                  "$DEF"
expect "cron spool"              /var/spool/cron              "$DEF"
expect "a wallet under /var"     /var/lib/poolwallet          /var/lib/poolwallet

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export PW_PIN_DIR="$T"
_PW_NET=mainnet
CONF_VALUE=/opt/grin/pubpoolwallet/mainnet
pool_read_conf() { printf '%s' "$CONF_VALUE"; }
id() { echo 0; }
is() {
    if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); echo "  PASS  $1"
    else failed=$((failed + 1)); echo "  FAIL  $1 — got: $2"; fi
}
is "the first safe read is used"       "$(_pw_pinned grin_wallet_dir "$DEF")" "$CONF_VALUE"
is "and pinned"                        "$(sed -n 's/^grin_wallet_dir=//p' "$T/pool_wallet_paths_mainnet.conf")" "$CONF_VALUE"
CONF_VALUE=/tmp/attacker
is "a later pool.json edit is ignored" "$(_pw_pinned grin_wallet_dir "$DEF")" /opt/grin/pubpoolwallet/mainnet
rm -f "$T/pool_wallet_paths_mainnet.conf"
CONF_VALUE=/etc
is "an unsafe value falls back"        "$(_pw_pinned grin_wallet_dir "$DEF" 2>/dev/null)" "$DEF"
is "and is never pinned"               "$(ls "$T" | wc -l | tr -d ' ')" 0

echo ""
echo "$pass passed, $failed failed"
(( failed == 0 ))
