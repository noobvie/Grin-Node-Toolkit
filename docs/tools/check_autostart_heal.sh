#!/bin/bash
# Tests gnc_autostart_heal_owner_chown (scripts/lib/grin_node_control.sh) against a stubbed
# crontab. It rewrites root's crontab on production boxes, so its edge cases are pinned here:
# both old line shapes, the lines it must not touch, the backup, and a no-op re-run.
# Run from the repo root: bash docs/tools/check_autostart_heal.sh
# Exit 0 = all passed, 1 = a check failed. Touches only a temp dir.

LIB="scripts/lib/grin_node_control.sh"
[[ -f "$LIB" ]] || { echo "Run from the repo root."; exit 2; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GNC_CRON_BACKUP_DIR="$T"
CF="$T/cron"

error() { echo "ERROR $*"; }
info() { :; }
crontab() {
    if [[ "${1:-}" == "-l" ]]; then
        [[ -f "$CF" ]] && cat "$CF"
    else
        [[ -n "${CRON_WRITE_FAILS:-}" ]] && { cat >/dev/null; return 1; }
        cat > "$CF"
    fi
}
eval "$(sed -n '/^gnc_autostart_heal_owner_chown() {/,/^}/p' "$LIB")"

pass=0 failed=0
check() {
    if eval "$2"; then pass=$((pass + 1)); echo "  PASS  $1"
    else failed=$((failed + 1)); echo "  FAIL  $1"; fi
}
backups() { find "$T" -name 'crontab.before-owner-chown.*' | wc -l; }

cat > "$CF" <<'EOF'
MAILTO=""
@reboot sleep 5 && chown -R grin:grin '/opt/grin/node/mainnet-prune' 2>/dev/null; su -s /bin/bash grin -c "cd '/opt/grin/node/mainnet-prune' && echo \$(date -u +\%s)" # main
@reboot sleep 1000 && chown -R grin:grin '/opt/grin/node/testnet-prune' 2>/dev/null; chgrp grinsecret '/opt/grin/node/testnet-prune/.api_secret' '/opt/grin/node/testnet-prune/.foreign_api_secret' 2>/dev/null && chmod 640 '/opt/grin/node/testnet-prune/.api_secret' '/opt/grin/node/testnet-prune/.foreign_api_secret' 2>/dev/null; su -s /bin/bash grin -c "cd x" # test
@reboot sleep 45 && env SHELL=/bin/bash /opt/grin/pubpool/boot.sh >> /tmp/l 2>&1 # wallet
# chown -R grin:grin '/opt/grin/node/mainnet-prune' 2>/dev/null; su -c old
0 3 * * * chown -R grin:grin '/opt/grin/wallet' 2>/dev/null; su -c job
EOF
cp "$CF" "$T/orig"

gnc_autostart_heal_owner_chown; rc=$?
check "rc 0" "[[ $rc == 0 ]]"
check "both @reboot node lines lose the group" "[[ \$(grep -c \"^@reboot.*chown -R grin '/opt\" '$CF') == 2 ]]"
check "the chgrp step is gone" "! grep -q 'chgrp grinsecret' '$CF'"
check "the launch part of the line survives" "grep -q \"2>/dev/null; su -s /bin/bash grin -c \\\"cd x\\\" # test\" '$CF'"
check "an escaped percent is untouched" "grep -q 'date -u +.%s' '$CF'"
check "the wallet line is untouched" "grep -q 'boot.sh >> /tmp/l 2>&1 # wallet' '$CF'"
check "a comment line is untouched" "grep -q \"^# chown -R grin:grin\" '$CF'"
check "a non-@reboot job is untouched" "grep -q \"^0 3 .*chown -R grin:grin '/opt/grin/wallet'\" '$CF'"
check "the backup equals the original" "cmp -s '$T/orig' \$(find '$T' -name 'crontab.before-owner-chown.*' | head -1)"
check "the healed lines parse" "grep '^@reboot' '$CF' | sed 's/^@reboot //' | bash -n"

cp "$CF" "$T/healed"
n=$(backups)
gnc_autostart_heal_owner_chown
check "a re-run changes nothing" "cmp -s '$T/healed' '$CF'"
check "a re-run makes no backup" "[[ \$(backups) == $n ]]"

cp "$T/orig" "$CF"
CRON_WRITE_FAILS=1 gnc_autostart_heal_owner_chown >/dev/null; rc=$?
check "a failed write returns 1 and changes nothing" "[[ $rc == 1 ]] && cmp -s '$T/orig' '$CF'"

printf '%s\n' "@reboot sleep 5 && chown -R grin:grin /opt/grin/node/mainnet-prune; su -c x # hand-edited" > "$CF"
cp "$CF" "$T/variant"
gnc_autostart_heal_owner_chown >/dev/null; rc=$?
check "a line it cannot rewrite returns 1 and stays" "[[ $rc == 1 ]] && cmp -s '$T/variant' '$CF'"

rm -f "$CF"
gnc_autostart_heal_owner_chown; rc=$?
check "no crontab: rc 0, none created" "[[ $rc == 0 && ! -f '$CF' ]]"

echo ""
echo "$pass passed, $failed failed"
(( failed == 0 ))
