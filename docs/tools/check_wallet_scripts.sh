#!/bin/bash
# Tests pw_refresh_scripts (scripts/lib/07_lib_pool_wallet.sh) on a temp box in the older layout,
# with the wallet scripts in the wallet dir: they must end up generated and valid in the script
# dir, root's crontab must follow, and the old copies must go. A failed write must change nothing.
# Run from the repo root: bash docs/tools/check_wallet_scripts.sh
# Exit 0 = all passed, 1 = a check failed. Touches only a temp dir.

LIB="scripts/lib/07_lib_pool_wallet.sh"
[[ -f "$LIB" ]] || { echo "Run from the repo root."; exit 2; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
W="$T/wallet" D="$T/scripts" CF="$T/cron"
mkdir -p "$W"

error() { echo "ERROR $*"; }
warn() { :; }
info() { :; }
success() { :; }

# The real lib, so the test cannot drift from it. Everything it would touch is stubbed below.
POOL_NET=mainnet
# shellcheck source=/dev/null
source "$LIB"

crontab() {
    if [[ "${1:-}" == "-l" ]]; then
        [[ -f "$CF" ]] && cat "$CF" || { echo "no crontab for root" >&2; return 1; }
    else
        cat > "$CF"
    fi
}
chown() { :; }

PW_OWNER_PORT=3420 PW_TMUX_WALLET=wallet_test PW_NET_FLAG=""
PW_WATCHDOG_BIN="$T/watchdog" PW_WATCHDOG_LOG="$T/wd.log" PW_WATCHDOG_STATE="$T/wd"
PW_AUTOSTART_TAG="# tag"
pw_wallet_dir() { echo "$W"; }
pw_script_dir() { echo "$D"; }
pw_bin() { echo "$W/grin-wallet"; }
pw_toml() { echo "$W/grin-wallet.toml"; }
pw_pass_file() { echo "$T/.wallet_pass"; }
pw_owner_secret_path() { echo "$W/.owner_api_secret"; }
pw_foreign_secret_path() { echo "$W/.foreign_api_secret"; }
pw_launcher() { echo "$D/listen-wallet.sh"; }
pw_unlock_helper() { echo "$D/pool-wallet-unlock.js"; }
pw_boot_script() { echo "$D/pool-wallet-boot.sh"; }

pass=0 failed=0
check() {
    if eval "$2"; then pass=$((pass + 1)); echo "  PASS  $1"
    else failed=$((failed + 1)); echo "  FAIL  $1"; fi
}

touch "$W/grin-wallet.toml" "$W/listen-wallet.sh" "$W/pool-wallet-unlock.js" "$W/pool-wallet-boot.sh"
echo '#!/bin/bash' > "$PW_WATCHDOG_BIN"
chmod 750 "$PW_WATCHDOG_BIN"
printf '%s\n' "@reboot sleep 45 && env SHELL=/bin/bash $W/pool-wallet-boot.sh >> /tmp/l 2>&1 # tag" "0 3 * * * other job" > "$CF"

pw_refresh_scripts; rc=$?
check "rc 0" "[[ $rc == 0 ]]"
check "all three scripts are in the script dir" "[[ -x '$D/listen-wallet.sh' && -e '$D/pool-wallet-unlock.js' && -x '$D/pool-wallet-boot.sh' ]]"
check "the launcher parses" "bash -n '$D/listen-wallet.sh'"
check "the boot script parses" "bash -n '$D/pool-wallet-boot.sh'"
check "the watchdog parses" "bash -n '$PW_WATCHDOG_BIN'"
check "the watchdog points at the new boot script" "grep -q 'BOOT=\"$D/pool-wallet-boot.sh\"' '$PW_WATCHDOG_BIN'"
check "the boot script points at the new launcher" "grep -q 'LAUNCHER=\"$D/listen-wallet.sh\"' '$D/pool-wallet-boot.sh'"
check "the @reboot line follows" "grep -q '$D/pool-wallet-boot.sh' '$CF' && ! grep -q '$W/pool-wallet-boot.sh' '$CF'"
check "other cron lines stay" "grep -q 'other job' '$CF'"
check "the old copies are gone" "[[ ! -e '$W/pool-wallet-boot.sh' && ! -e '$W/listen-wallet.sh' && ! -e '$W/pool-wallet-unlock.js' ]]"
check "no temp file is left" "! ls '$D'/*.new '$PW_WATCHDOG_BIN.new' 2>/dev/null | grep -q ."

cp "$CF" "$T/cron.after"
pw_refresh_scripts; rc=$?
check "a re-run is clean" "[[ $rc == 0 ]] && cmp -s '$T/cron.after' '$CF'"

printf '%s\n' "@reboot sleep 45 && env SHELL=/bin/bash /elsewhere//pool-wallet-boot.sh >> /tmp/l 2>&1 # tag" > "$CF"
touch "$W/pool-wallet-boot.sh"
pw_refresh_scripts; rc=$?
check "a line spelled differently still follows, by its tag" "[[ $rc == 0 ]] && grep -q '$D/pool-wallet-boot.sh' '$CF'"

printf '%s\n' "@reboot sleep 1 $W/pool-wallet-boot.sh # hand-made, no tag" > "$CF"
touch "$W/pool-wallet-boot.sh"
pw_refresh_scripts >/dev/null; rc=$?
check "an untagged line keeps the old script and returns 1" "[[ $rc == 1 && -e '$W/pool-wallet-boot.sh' ]]"

rm -f "$CF"
pw_refresh_scripts; rc=$?
check "no crontab at all is fine" "[[ $rc == 0 && ! -f '$CF' ]]"

rm -f "$W/grin-wallet.toml"
rm -rf "$D"
pw_refresh_scripts; rc=$?
check "no wallet yet: rc 0, nothing written" "[[ $rc == 0 && ! -e '$D' ]]"

touch "$W/grin-wallet.toml"
printf '%s\n' "@reboot x $W/pool-wallet-boot.sh # tag" > "$CF"
touch "$W/pool-wallet-boot.sh"
mkdir -p "$T/blocker"; : > "$T/notadir"
pw_script_dir() { echo "$T/notadir/sub"; }
pw_launcher() { echo "$T/notadir/sub/listen-wallet.sh"; }
pw_unlock_helper() { echo "$T/notadir/sub/pool-wallet-unlock.js"; }
pw_boot_script() { echo "$T/notadir/sub/pool-wallet-boot.sh"; }
pw_refresh_scripts >/dev/null 2>&1; rc=$?
check "a failed write returns 1" "[[ $rc == 1 ]]"
check "and leaves the crontab and old script alone" "grep -q '$W/pool-wallet-boot.sh' '$CF' && [[ -e '$W/pool-wallet-boot.sh' ]]"

echo ""
echo "$pass passed, $failed failed"
(( failed == 0 ))
