# =============================================================================
# lib/052_lib_build.sh — build the Accio site from the vendored upstream tree
# =============================================================================
# Sourced by 052_grin_accio.sh. Inherits colours, info/warn/error/success/log
# and every ACC_* variable set by acc_set_network. No shebang.
#
#   ⚠ THIS FILE RUNS WITHOUT errexit, WHATEVER THE CALLER SET (R3)
#     The entry script does `set -euo pipefail`, and this lib used to claim it
#     inherited that. It does not. EVERY call site is
#         accio_build … || error …            (052_grin_accio.sh)
#         if accio_build …; then               (052_lib_nginx.sh)
#     and bash disables errexit for the whole dynamic extent of a function
#     called from an ||/&& list or an `if` condition. Re-issuing `set -e` inside
#     the function does not undo that — POSIX ignores it in those contexts. And
#     `error()` only prints; it never exits.
#
#     So NOTHING below is protected by the shell. Every command that creates,
#     copies, moves or deletes a file MUST carry its own
#     `|| { error …; return 1; }`. A bare `cp` here is a silent failure that
#     SHIPS, and both of its worst cases were real before R3:
#       • a patch that failed to overlay still got a valid SRI written for the
#         pristine upstream bytes — a wallet pointed at upstream's nodes, with a
#         green build log and a page that loads perfectly;
#       • `mv "$new" "$outdir"` does NOT fail when $outdir survived the rotate,
#         it moves $new INSIDE it (site/site.new/) — old site still served,
#         `success "Built N files"` still printed.
#     If you add a mutating command without a guard you are re-creating those.
#
#   PUBLIC ENTRY — called from outside this file
#     accio_build [net] [domain] [outdir]   full build, then swap the site in
#     accio_build_standalone [net]          the offline single-HTML artefact
#
#     Both are thin wrappers whose only job is to clean up after the run
#     (_acb_build_run / _acb_standalone_run do the work). A build can fail from
#     ~20 places, and every one of them used to leave <outdir>.stage behind — a
#     second complete copy of the upstream tree, backend PHP and all. On a box
#     that failed the build BECAUSE it ran out of disk, that is the worst
#     possible moment to keep it. One wrapper covers every return path; adding
#     the cleanup to each of them individually is how one gets missed.
#
#     `net` is a GUARD, not a switch: it must equal the already-selected
#     ACC_NETWORK or the build refuses. It used to call acc_set_network, which
#     silently re-pointed every ACC_* global — dirs, ports, conf path, service
#     name — for the rest of the hub session. Mainnet/testnet isolation must not
#     rest on nobody ever passing the documented argument. Select first, build
#     second.
#
#   INTERNAL. Nothing outside this file calls these today; they are listed
#   because a hub pre-flight screen is the obvious next caller.
#     acb_check_deps                        report missing build prerequisites
#     acb_env_report                        print the env contract a build uses
#
#   WHY THIS FILE EXISTS — the reason is one word: OFFLINE
#     Upstream ships a build script (vendored as a SPEC at
#     vendor/upstream-standalone-build/build.sh, pinned 043c2ddc, never run).
#     Its first act is to fetch an UNPINNED master.zip over the network, then
#     `chmod 777 -R` the result and `rm -rf` its own working files. Running it
#     would mean every build silently takes whatever upstream pushed that
#     morning — which is the precise failure S0 vendored the tree to prevent.
#
#     So: THIS SCRIPT MAKES NO NETWORK REQUEST OF ANY KIND. It reads
#     web/052_accio/vendor/ and web/052_accio/patches/ and nothing else. That
#     is not a style preference — it is the property that makes the pin mean
#     something. `_acb_assert_offline` re-checks it at runtime, so an edit that
#     adds a fetcher fails the build instead of quietly weakening the pin.
#
#   WHAT A BUILD IS
#     Upstream's site is PHP-templated. Its per-request inputs are all fixed
#     for a given deployment (server name, scheme, onion address), so PHP runs
#     ONCE here, at build time, and the VPS serves plain static files. No
#     php-fpm, no PHP request surface — the runtime stack is nginx + tor + the
#     Node gateway, matching the rest of the toolkit.
#
#       vendor/upstream-wallet/public_html   (immutable, pinned, never written)
#            │  copy
#            ▼
#       <outdir>.stage      ← patches/public_html/ overlaid by whole-file
#            │                replacement, then SRI checksums refreshed
#            │  php, once per templated file
#            ▼
#       <outdir>.new  →  swapped in last  →  <outdir>  (old kept as <outdir>.prev)
#
#     Everything is idempotent and the swap is last: unlike upstream's build.sh
#     this runs against a live box with other vhosts, live certs and a running
#     gateway, all of which must survive a failed build untouched.
#
#     ⚠ "Last" is the guarantee; ATOMIC is not, and this used to claim it. POSIX
#       cannot rename a directory over a non-empty one, so publishing is TWO
#       renames (rotate the old aside, move the new in) and there is a window
#       between them where the nginx root does not exist and a request 404s. It
#       is sub-millisecond and it is not nothing. A symlink flip would close it
#       and is deliberately not used — see the disable_symlinks note on the
#       standalone artefact for why symlinks are avoided in this product. What
#       IS guaranteed: nothing under <outdir> changes until the build has
#       succeeded and passed its post-conditions, and a failed publish rolls the
#       previous tree back.
#
#   FIVE FACTS ABOUT UPSTREAM, EACH LEARNED BY READING ITS SOURCE (S1)
#
#   1. THE THREE `NO_*` ENV VARS ARE TESTED FOR PRESENCE, NOT VALUE.
#      backend/resources.php:1760/1771/1782 all use array_key_exists(). So
#      NO_FILE_VERSIONS="" DISABLES file versions — an empty value is still a
#      key. build.sh sets all three to "" precisely to switch them off for the
#      standalone artefact. A hosted site wants them ON, which means the vars
#      must be ABSENT, so a hosted render runs under `env -u` for all three.
#      Exporting one in a shell profile would silently strip cache-busting and
#      Subresource Integrity from the whole site. (accio_build_standalone flips
#      exactly this one switch and changes nothing else about the render — see
#      _acb_render_one's 7th argument. It is a PARAMETER, not a global: as a
#      global with a manual reset, any `return` added inside the standalone
#      render loop would leak "standalone" into the next hosted build, and that
#      build would strip SRI and file-versions off the SERVED site with no error
#      anywhere.)
#
#   2. WE MUST RENDER 27 FILES; build.sh RENDERS 14.
#      build.sh only needs what folds into one self-contained index.html. A
#      hosted site also needs site.webmanifest, sitemap.xml, robots.txt,
#      browserconfig.xml, scripts/service_worker.js and the eight errors/*.html
#      pages — all of them PHP-templated too. Shipping build.sh's list would
#      publish those as raw PHP SOURCE: the manifest breaks PWA install and
#      service_worker.js breaks offline caching, both without an error anyone
#      would connect to the build. Hence: DISCOVER the templated files, never
#      list them. Every one starts with `<?php` at byte 0 (verified across all
#      266 files, with zero false positives among the binaries), so that leading
#      magic is the test — content-grep would false-positive on `<?=` bytes
#      inside the 7 MB of WASM.
#
#   3. 221 OF 252 RESOURCE ENTRIES CARRY A HARDCODED SRI CHECKSUM.
#      They are plain base64(sha512(bytes)) of the pristine file and they all
#      verify against the vendored tree. `scripts/node.js` — the file S5 must
#      patch to make our Grin nodes the default — is one of them. Patch it
#      without refreshing its checksum and the browser refuses to execute it on
#      SRI grounds: the wallet simply never boots. So the overlay step below
#      recomputes the checksum and bumps the cache version for every patched
#      file. S5 only has to drop a file in patches/; the build keeps SRI honest.
#      (Note upstream's own invariant: every PHP-RENDERED file has
#      Checksum => NULL. You cannot SRI bytes that vary per deployment. A patch
#      that makes a currently-static file templated therefore has to CLEAR the
#      checksum, not skip it — _acb_apply_patches passes "NULL" for that case.
#      Skipping left upstream's hash of the original static bytes in place, and
#      a hash the browser can never match is a page that will not load.)
#
#   4. PHP CLI PRINTS WARNINGS TO STDOUT BY DEFAULT.
#      Rendering redirects stdout into the built file, so one undefined-index
#      notice would be injected straight into index.html or the manifest. Every
#      render therefore forces display_errors=stderr, and a render whose stderr
#      is non-empty is reported instead of being swallowed.
#
#   5. THE PHP NEEDS mbstring AND intl.
#      mb_* is used throughout; backend/language.php calls
#      locale_accept_from_http() and NumberFormatter (intl). It also calls
#      setlocale(LC_ALL, "en_US.UTF-8") at line 604 — which FAILS SILENTLY on a
#      minimal Debian VPS where that locale was never generated, changing the
#      strcoll() ordering of the language menu. Non-fatal, but it makes two
#      boxes produce different bytes, so acb_check_deps warns and prints the
#      one-line fix.
#
#   KNOWN, ACCEPTED DEGRADATIONS OF PRERENDERING (record, don't "fix" blindly)
#     • site.webmanifest picked desktop-vs-mobile app icons from the User-Agent,
#       so prerendered everyone got the desktop set. RESOLVED in S5, which
#       replaced the whole raster icon set with one SVG and emits it directly —
#       the "Mobile Only" split no longer exists.
#     • errors/503.html and errors/error.html branch on Referer/REQUEST_URI to
#       hide the URL and to 404 a direct hit. Prerendered with REQUEST_URI="/"
#       they render as the plain maintenance/error page, which is the correct
#       fallback. Whether nginx wires error_page at them at all is S2's call.
#     • Language is negotiated per request upstream. It does NOT need one page
#       per language here: scripts/languages.js is itself PHP-rendered and
#       embeds every translation as JSON, and every string in the DOM carries
#       its English key in data-text, so language switching is CLIENT-side.
#       One en-US render is the whole site. (The design doc's "one static page
#       per language" predates reading languages.js.)
#
#   NEVER EDIT vendor/. Changes are whole-file replacements in patches/ — see
#   web/052_accio/patches/README.md. vendor/SHA256SUMS is the pin and
#   `git log <PINNED_SHA>..upstream/master` is how we review upstream security
#   fixes; editing in place retires both.
#
#   Since S6 that is ENFORCED rather than requested: accio_build sources
#   052_lib_vendor.sh and will not stage a single file until acv_verify_vendor
#   passes. An edited vendored byte, or a file added under vendor/ that the
#   manifest never listed, stops the build with the site untouched. That check
#   is offline too, and asserts itself so (`_acv_assert_offline_path`) — this
#   lib's no-network property now spans two files and is proved in both.
# =============================================================================

# ─── Tunables (override before calling if a box needs it) ────────────────────
ACB_PHP_BIN="${ACB_PHP_BIN:-php}"

# Build-time Accept-Language. Only decides which language the DOM is rendered
# in; the visitor switches client-side (see the note above).
ACB_BUILD_LANG="${ACB_BUILD_LANG:-en-US,en;q=0.9}"

# Never served — build-time-only PHP libraries and php-fpm runtime config.
# public_html/.user.ini even hardcodes upstream's own session.save_path.
ACB_EXCLUDE_DIRS="backend languages"
ACB_EXCLUDE_FILES=".user.ini errors/template.php"

# =============================================================================
# Guards
# =============================================================================

# The offline property is load-bearing (see the header), so it is asserted at
# runtime rather than trusted. Only command position matters — an edit that
# introduces a fetcher trips this before it can weaken the pin.
_acb_assert_offline() {
    local self="${BASH_SOURCE[0]}" hit pat
    # The fetcher names are split across string concatenations on purpose.
    # S1's stated acceptance check is a plain grep for the two common
    # downloaders over this lib returning NOTHING, so a detector that spelled
    # its own targets out would fail the very check it exists to serve.
    pat="(^|[;&|(]|[[:space:]])(wg""et|cu""rl|nc|scp|sftp|rsync|ftp)[[:space:]]"
    hit=$(grep -nE "$pat" "$self" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
    if [[ -n "$hit" ]]; then
        error "052_lib_build.sh must never fetch anything. Found:"
        echo "$hit" >&2
        return 1
    fi
    return 0
}

# Reports what is missing; returns 1 so callers can stop before touching disk.
acb_check_deps() {
    local missing="" ext cmd
    if ! command -v "$ACB_PHP_BIN" >/dev/null 2>&1; then
        missing="php-cli"
    else
        for ext in mbstring intl json; do
            if ! "$ACB_PHP_BIN" -m 2>/dev/null | grep -qix "$ext"; then
                missing="$missing php-$ext"
            fi
        done
    fi
    # Only the commands that can genuinely be absent are listed. The rest of
    # what the build shells out to (sed, grep, tr, head, cut, wc, sort, date,
    # du, mktemp, basename, dirname, chmod) is coreutils and ships with the
    # base system; xargs is findutils and diff is diffutils, and BOTH are
    # separately omittable on a minimal container image. They matter because
    # neither fails loudly here: no xargs means no build manifest (guarded, so
    # the build stops), and no diff makes the reproducibility check report
    # "Differs from the previous build" on two identical trees — a false
    # negative on the one line S2 uses as acceptance evidence.
    for cmd in openssl sha256sum awk find xargs diff; do
        if ! command -v "$cmd" >/dev/null 2>&1; then missing="$missing $cmd"; fi
    done

    if [[ -n "$missing" ]]; then
        error "Build prerequisites missing:$missing"
        echo ""
        echo -e "  ${DIM}PHP is a BUILD-time dependency only — no php-fpm is installed,${RESET}"
        echo -e "  ${DIM}enabled or reachable, and the VPS serves plain static files.${RESET}"
        echo -e "  ${BOLD}apt-get install -y php-cli php-mbstring php-intl${RESET}"
        echo -e "  ${DIM}findutils / diffutils cover xargs and diff if those are listed.${RESET}"
        return 1
    fi

    # Fact 5: a missing en_US.UTF-8 makes setlocale() a silent no-op, which
    # reorders the language menu. Warn, never fail — the wallet works either way.
    if command -v locale >/dev/null 2>&1; then
        if ! locale -a 2>/dev/null | tr 'A-Z' 'a-z' | grep -qE '^en_us\.utf-?8$'; then
            warn "Locale en_US.UTF-8 is not generated — backend/language.php:604"
            warn "  setlocale() will no-op and the language menu order will differ"
            warn "  from a box that has it. Harmless, but not byte-reproducible."
            warn "  Fix: apt-get install -y locales && locale-gen en_US.UTF-8"
        fi
    fi
    return 0
}

acb_env_report() {
    local domain="$1" https="$2" onion="$3"
    local v_https v_httpsaddr v_tor
    local absent='(absent → browser uses location.hostname)'
    if [[ "$https" == "on" ]]; then
        v_https="on"; v_httpsaddr="https://$domain"
    else
        v_https="(absent)"; v_httpsaddr="$absent"
    fi
    # Spelled out rather than nested expansions: `${onion:+http://$onion}` and
    # `${onion:-...}` BOTH expand when onion is set, which printed the address
    # twice — exactly the line an operator reads to confirm the onion is right.
    if [[ -n "$onion" ]]; then v_tor="http://$onion"; else v_tor="$absent"; fi
    echo -e "  ${DIM}SERVER_NAME           = ${domain}${RESET}"
    echo -e "  ${DIM}HTTPS                 = ${v_https}${RESET}"
    echo -e "  ${DIM}HTTPS_SERVER_ADDRESS  = ${v_httpsaddr}${RESET}"
    echo -e "  ${DIM}TOR_SERVER_ADDRESS    = ${v_tor}${RESET}"
    echo -e "  ${DIM}NO_FILE_VERSIONS      = (unset — versions ON)${RESET}"
    echo -e "  ${DIM}NO_FILE_CHECKSUMS     = (unset — SRI ON)${RESET}"
    echo -e "  ${DIM}NO_MINIFIED_FILES     = (unset — no .min.* exists at this pin anyway)${RESET}"
}

# =============================================================================
# Rendering
# =============================================================================

# Fact 2: a templated file always begins with `<?php`. Cheap, exact, and immune
# to the `<?=` byte sequences that occur naturally inside 7 MB of WASM.
_acb_is_templated() {
    # `tr -d '\0'` is not cosmetic: a command substitution over the first bytes
    # of a WASM blob, PNG or woff2 makes bash print "ignored null byte in
    # input" — 24 warnings per build on this tree, all of them noise. Stripping
    # NULs cannot create a false positive, because any NUL inside the first five
    # bytes leaves fewer than five, which can never equal the magic.
    local magic
    magic="$(head -c 5 -- "$1" 2>/dev/null | tr -d '\0')" || return 1
    [[ "$magic" == "<?php" ]]
}

_acb_excluded() {
    local rel="$1" d f
    for d in $ACB_EXCLUDE_DIRS; do
        if [[ "$rel" == "$d/"* ]]; then return 0; fi
    done
    for f in $ACB_EXCLUDE_FILES; do
        if [[ "$rel" == "$f" ]]; then return 0; fi
    done
    return 1
}

# Renders one templated file. stdout is the built file, so PHP diagnostics are
# forced to stderr (fact 4) and surfaced rather than injected into the output.
_acb_render_one() {
    local src="$1" dst="$2" domain="$3" https="$4" onion="$5"
    # The path to name in diagnostics. Passed in, not derived: `src` lives under
    # <outdir>.stage, so stripping "*/public_html/" left the full absolute path.
    local rel="${6:-$src}"
    # 1 = the standalone artefact's env contract. A parameter, never a global.
    local standalone="${7:-0}"
    local errfile rc

    local -a envv=(
        SERVER_NAME="$domain"
        SERVER_PROTOCOL="HTTP/1.1"
        REQUEST_URI="/"
        HTTP_ACCEPT_LANGUAGE="$ACB_BUILD_LANG"
    )
    # HTTPS is tested with array_key_exists too — absent means plain HTTP.
    if [[ "$https" == "on" ]]; then
        envv+=( HTTPS=on HTTPS_SERVER_ADDRESS="https://$domain" )
    fi
    # Absent, the page falls back to location.hostname — right for the clearnet
    # copy, wrong once an onion exists, because the "Onion Service" address type
    # would then hand out a clearnet host. Set it as soon as S7 mints the onion.
    if [[ -n "$onion" ]]; then
        envv+=( TOR_SERVER_ADDRESS="http://$onion" )
    fi
    # HTTP_USER_AGENT is deliberately absent: it only drives a Googlebot test
    # and the webmanifest's mobile-icon split, both of which want the default.

    # ── ABSENCE IS A VALUE, SO IT IS ENFORCED, NOT ASSUMED ───────────────────
    # `env` hands php the caller's ENTIRE environment, and PHP CLI copies every
    # environment variable into $_SERVER. Upstream tests these with
    # array_key_exists (fact 1), so a variable that merely happens to be
    # exported in the operator's shell silently supplies a per-request input.
    # The three NO_* vars were already unset for exactly this reason. These five
    # are the rest of the set upstream reads (verified: SERVER_NAME 17×,
    # HTTPS 14×, HTTP_REFERER 11×, SERVER_PROTOCOL 7×, REQUEST_URI 7×,
    # HTTP_USER_AGENT 6×, HTTP_ACCEPT_LANGUAGE 4×, TOR_SERVER_ADDRESS 1×,
    # HTTPS_SERVER_ADDRESS 1×) — the four this function sets unconditionally are
    # safe; the rest were left to chance:
    #   TOR_SERVER_ADDRESS   a stale export bakes the WRONG onion into the
    #                        "Onion Service" address type while acb_env_report
    #                        prints "(absent)" — the one line an operator reads
    #                        to confirm the onion would be lying to them
    #   HTTPS / HTTPS_SERVER_ADDRESS
    #                        canonical, hreflang, the web manifest and
    #                        msapplication-starturl all flip to https on a
    #                        deployment that is serving plain HTTP
    #   HTTP_USER_AGENT      drives a Googlebot branch and the icon split; the
    #                        comment above calls it "deliberately absent", so
    #                        make that true rather than hope for it
    #   HTTP_REFERER         errors/503.html and errors/error.html branch on it
    # `env -u FOO FOO=on` is not a contradiction: env applies its options before
    # its assignments, so the conditional envv entries above still win.
    local -a novars=(
        -u HTTPS -u HTTPS_SERVER_ADDRESS -u TOR_SERVER_ADDRESS
        -u HTTP_USER_AGENT -u HTTP_REFERER
    )

    # ── hosted vs standalone: the ONLY difference in how php is invoked ──────
    # Fact 1: the three NO_* vars are tested with array_key_exists, so PRESENT
    # (even empty) means "off". A hosted build wants versions and SRI ON, i.e.
    # the vars ABSENT — hence `env -u`. The standalone artefact wants them OFF:
    # there is no second file to version-bust and no separate file to hash once
    # everything is a data: URI inside one page, and leaving SRI on would have
    # the browser check a hash against bytes that are no longer fetched.
    #
    # The unsets stay FIRST in the array: env stops parsing options at the first
    # NAME=VALUE, so putting the standalone assignments ahead of them would make
    # every `-u` below a literal argument to php.
    if [[ "$standalone" == "1" ]]; then
        novars+=( NO_FILE_VERSIONS= NO_FILE_CHECKSUMS= NO_MINIFIED_FILES= )
    else
        novars+=( -u NO_FILE_VERSIONS -u NO_FILE_CHECKSUMS -u NO_MINIFIED_FILES )
    fi

    errfile="$(mktemp)" || { error "mktemp failed while rendering $rel"; return 1; }
    # `cmd || rc=$?` captures the status without touching the caller's shell
    # options. A bare set +e/set -e pair here would silently ENABLE errexit for
    # a caller that had it off.
    rc=0
    env "${novars[@]}" \
        "${envv[@]}" \
        "$ACB_PHP_BIN" \
            -d display_errors=stderr \
            -d log_errors=0 \
            -d error_reporting=E_ALL \
            -d variables_order=EGPCS \
            -f "$src" > "$dst" 2>"$errfile" || rc=$?

    if [[ $rc -ne 0 ]]; then
        error "php failed (rc=$rc) on $rel"
        sed -n '1,20p' "$errfile" >&2 || true
        rm -f "$errfile"
        return 1
    fi
    if [[ ! -s "$dst" ]]; then
        error "php produced an empty file for $rel"
        rm -f "$errfile"
        return 1
    fi
    if [[ -s "$errfile" ]]; then
        warn "php diagnostics for $rel:"
        sed -n '1,10p' "$errfile" >&2 || true
    fi
    rm -f "$errfile"
    return 0
}

# =============================================================================
# Overlay + Subresource Integrity
# =============================================================================

_acb_sri() { openssl dgst -sha512 -binary -- "$1" | openssl base64 -A; }

# Rewrites one entry of the $files table in a staged backend/resources.php:
# new SRI checksum, and Version+1 so returning browsers do not serve the old
# bytes from cache against a new checksum.
#
# Pass newsum="NULL" to CLEAR the checksum instead of setting one. That is the
# right call for a file our overlay has made PHP-templated: the bytes the
# browser fetches are produced by php further down and differ per deployment,
# so no fixed hash can ever match them. A real SRI is 88 base64 characters, so
# "NULL" can never collide with one.
#   exit 0  rewritten
#   exit 3  no such entry — the caller escalates only if the path IS listed
#   exit 4  entry found but its Version/Checksum lines did not match, i.e. the
#           table format drifted. Always fatal: the alternative is a stale SRI.
#   exit 5  SUCCESS, but no checksum was written: a real hash was offered and
#           the entry says NULL, which upstream means as "never SRI this file".
#           The file is still written out. Distinguished from 0 only so the
#           build log cannot claim a refresh that did not happen — the log is
#           the acceptance evidence for a build nobody watches run.
_acb_set_resource_entry() {
    local res="$1" dotpath="$2" newsum="$3" tmp rc=0
    tmp="$(mktemp)" || { error "mktemp failed rewriting $dotpath"; return 1; }
    awk -v key="$dotpath" -v newsum="$newsum" '
        BEGIN { open_line = "\t\t\"" key "\" => ["
                inblk = 0; found = 0; drift = 0; keptnull = 0 }
        {
            if (inblk == 0 && $0 == open_line) {
                inblk = 1; sawver = 0; sawsum = 0; print; next
            }
            if (inblk == 1) {
                # The LAST entry of a table closes "\t\t]" with NO comma —
                # valid PHP, and true of both tables in this file ($files ends
                # at "./images/usb license.txt", ATTRIBUTIONS at "X25519 WASM
                # Wrapper"). Matching only "\t\t]," walked straight past that
                # boundary into the next table, where an unrelated closing
                # brace then set `found`. Harmless at this pin only because
                # ATTRIBUTIONS carries no Version/Checksum lines to clobber.
                if ($0 ~ /^\t\t\]/) {
                    inblk = 0; found = 1
                    # The real drift guard. Finding the block proves nothing —
                    # if the Version/Checksum LINES stopped matching we would
                    # copy them through untouched and report success, shipping
                    # a stale SRI. That is the silent failure worth exiting on;
                    # the brace shape never was.
                    if (sawver == 0 || sawsum == 0) drift = 1
                    print; next
                }
                if ($0 ~ /^\t\t\t"Version" => [0-9]+,$/) {
                    sawver = 1
                    v = $0
                    sub(/^\t\t\t"Version" => /, "", v)
                    sub(/,$/, "", v)
                    # Version 0 means "emit no ?query"; keep that meaning.
                    printf "\t\t\t\"Version\" => %d,\n", (v + 0 == 0 ? 0 : v + 1)
                    next
                }
                if ($0 ~ /^\t\t\t"Checksum" => /) {
                    sawsum = 1
                    # NULL means upstream deliberately does not SRI this file
                    # (every PHP-rendered file). Leave it NULL.
                    if ($0 == "\t\t\t\"Checksum\" => NULL") {
                        if (newsum != "NULL") keptnull = 1
                        print; next
                    }
                    # Our overlay newly made this file templated, so the
                    # upstream hash of the ORIGINAL static bytes is now a
                    # checksum the browser can never match — i.e. a page that
                    # refuses to load, blaming integrity. Clear it.
                    # (No apostrophes in here: this awk program lives inside a
                    # single-quoted bash string.)
                    if (newsum == "NULL") { print "\t\t\t\"Checksum\" => NULL"; next }
                    printf "\t\t\t\"Checksum\" => \"%s\"\n", newsum
                    next
                }
            }
            print
        }
        END { if (found == 0) exit 3
              if (drift != 0) exit 4
              if (keptnull != 0) exit 5 }
    ' "$res" > "$tmp" || rc=$?
    # 5 is a success code — the rewritten table still has to be installed.
    if [[ $rc -ne 0 && $rc -ne 5 ]]; then rm -f "$tmp"; return "$rc"; fi
    # Guarded: an unguarded mv here leaves $res UNCHANGED and still returns 0,
    # so the caller logs "checksum refreshed" over a stale SRI — the exact
    # silent failure the exit-4 drift guard above exists to prevent.
    mv -f "$tmp" "$res" || {
        error "Could not install the rewritten resources table over $res"
        rm -f "$tmp"
        return 1
    }
    return "$rc"
}

# Overlays patches/public_html by whole-file replacement, then keeps SRI honest
# for anything it replaced (fact 3).
#
# TWO passes, deliberately. The SRI pass reads the $files table out of the
# STAGED backend/resources.php, and that file is itself patchable — so a single
# interleaved pass would only apply a patched table to the paths that happen to
# sort after "backend/resources.php" in LC_ALL=C order. Anything sorting before
# it (every path starting with an uppercase letter, e.g. "MWC Wallet
# license.txt") would be checksummed against the OLD table and silently skipped
# as "not listed". Copy everything first, then read the table once it is final.
_acb_apply_patches() {
    local stage="$1" patchroot="$2"
    local res="$stage/backend/resources.php"
    local n=0 rel dot sum rc
    local -a patched=()

    if [[ ! -d "$patchroot" ]]; then
        info "No patches/public_html — building pristine upstream."
        return 0
    fi

    # Pass 1 — overlay every file.
    #
    # ⚠ BOTH commands are guarded, and that is not defensive habit. Unguarded
    #   (errexit does not reach this file — see the header), a failed cp still
    #   pushed $rel into patched[] and printed "patched". Pass 2 then hashed
    #   whatever sat at $stage/$rel — the PRISTINE upstream file — and wrote a
    #   perfectly valid SRI for it. The build succeeded, the browser loaded it
    #   cleanly, and nothing said the patch had not landed. With S5's
    #   scripts/node.js patch that is a self-custodial wallet talking to
    #   upstream's nodes instead of ours.
    while IFS= read -r -d '' pf; do
        rel="${pf#"$patchroot"/}"
        mkdir -p "$stage/$(dirname -- "$rel")" || {
            error "Could not create the staged directory for patch: $rel"; return 1; }
        cp -f -- "$pf" "$stage/$rel" || {
            error "Could not overlay patch: $rel"
            error "Refusing to continue — an un-overlaid patch is SRI'd as valid."
            return 1
        }
        n=$((n + 1))
        patched+=("$rel")
        info "  patched  $rel"
    done < <(find "$patchroot" -type f -print0 | LC_ALL=C sort -z)

    if [[ $n -eq 0 ]]; then
        info "patches/public_html is empty — building pristine upstream."
        return 0
    fi

    # Pass 2 — refresh SRI against the now-final table.
    for rel in "${patched[@]}"; do

        # backend/ and languages/ are never served, so they carry no checksum.
        if _acb_excluded "$rel"; then continue; fi
        [[ -f "$res" ]] || continue

        # A templated file is SRI'd as Checksum => NULL upstream, because its
        # served bytes are produced by php further down and differ per
        # deployment. Hashing it HERE would hash the template — a checksum the
        # browser can never match, i.e. the exact "wallet won't boot" failure
        # this step exists to prevent.
        dot="./$rel"
        if _acb_is_templated "$stage/$rel"; then
            # Do NOT just skip. If upstream shipped this path as a static file
            # with a real checksum and our patch turned it into a template,
            # skipping leaves that stale hash in place and the browser refuses
            # to execute the rendered bytes — an "integrity" console error that
            # points at the file, not at the overlay. Clearing it is a no-op
            # for the files upstream already templates (their entry is already
            # NULL), and the fix for the ones it does not.
            sum="NULL"
        else
            # An empty $sum would be written out as `Checksum => ""`, which no
            # browser can ever match — the same dead page as a stale hash.
            sum="$(_acb_sri "$stage/$rel")" || sum=""
            if [[ -z "$sum" ]]; then
                error "Could not compute an SRI checksum for $rel (openssl failed)."
                return 1
            fi
        fi
        rc=0
        _acb_set_resource_entry "$res" "$dot" "$sum" || rc=$?
        # No message claims a version bump: an entry at Version 0 means "emit no
        # ?query" and deliberately STAYS at 0, so most of these lines would be
        # asserting a cache-bust that did not happen.
        if [[ $rc -eq 0 ]]; then
            if [[ "$sum" == "NULL" ]]; then
                info "  sri  $rel — templated, checksum cleared"
            else
                info "  sri  $rel — checksum refreshed"
            fi
        elif [[ $rc -eq 5 ]]; then
            info "  sri  $rel — upstream sets no checksum here, none written"
        elif [[ $rc -eq 4 ]]; then
            error "resources.php lists $dot but its Version/Checksum lines did"
            error "not match — the \$files table format changed upstream."
            error "Update _acb_set_resource_entry; do NOT ship a stale checksum."
            return 1
        elif grep -qF "\"$dot\" => [" "$res"; then
            # Listed, but not in the shape the rewriter understands: the table
            # format changed under us. Failing loudly beats shipping a page the
            # browser will refuse to execute with no clue why.
            error "resources.php lists $dot but its entry could not be rewritten."
            error "The \$files table format changed — update _acb_set_resource_entry."
            return 1
        else
            info "  sri  $rel — not in the resources table, nothing to refresh"
        fi
    done

    success "Applied $n patch file(s)."
    return 0
}

# =============================================================================
# Post-conditions
# =============================================================================

# Cheap, total, and catches the failure modes that are otherwise invisible:
# a `php` that is a shim, a newly templated file upstream added, or an
# exclusion that stopped matching.
_acb_assert_output() {
    local out="$1" expect="${2:-}" bad=0 rel got

    if [[ ! -s "$out/index.html" ]]; then
        error "Built tree has no index.html — refusing to publish it."
        return 1
    fi

    # The file COUNT, not just the shape. Every copy in the render loop is
    # guarded now, but this is the post-condition that would have caught a lost
    # one anyway: the counters increment per iteration, so they describe what
    # the loop INTENDED, and the manifest is generated from the tree afterwards
    # — it records damage rather than catching it. Only a count comparison
    # notices that an asset never arrived.
    if [[ -n "$expect" ]]; then
        got=$(find "$out" -type f | wc -l)
        if [[ "$got" -ne "$expect" ]]; then
            error "Built tree holds $got file(s), expected $expect."
            error "A copy or render was lost — refusing to publish it."
            return 1
        fi
    fi

    while IFS= read -r -d '' f; do
        rel="${f#"$out"/}"
        if _acb_is_templated "$f"; then
            error "Unrendered PHP left in the built tree: $rel"
            bad=$((bad + 1))
        fi
        case "$rel" in
            *.php|backend/*|languages/*|.user.ini)
                error "Build-time-only file reached the built tree: $rel"
                bad=$((bad + 1)) ;;
        esac
    done < <(find "$out" -type f -print0)

    if [[ $bad -gt 0 ]]; then
        error "$bad problem(s) in the built tree — not publishing."
        return 1
    fi
    return 0
}

# =============================================================================
# Public entry
# =============================================================================

# Set by _acb_build_run the moment it knows them; read only by accio_build's
# cleanup. Not a mode flag — written once per run and cleared on both sides of
# it, so no state survives to be inherited (contrast _ACB_STANDALONE, which was
# a mode global and is now a parameter for exactly that reason).
_ACB_STAGE=""
_ACB_NEW=""

# accio_build [net] [domain] [outdir]
#
# Every parameter defaults from ACC_* / $ACC_CONF, so a rebuild never
# re-prompts. Nothing under $outdir changes until the build has succeeded and
# passed its post-conditions.
#
# This wrapper exists only so that failure cleanup lives in ONE place. The build
# proper can return non-zero from roughly twenty points, and each of them used to
# leave <outdir>.stage on disk — a second complete copy of the upstream tree,
# backend PHP and .user.ini included. Cleaning up at each return is how one of
# them gets missed on the next edit.
accio_build() {
    _ACB_STAGE=""; _ACB_NEW=""
    local rc=0
    _acb_build_run "$@" || rc=$?
    if [[ $rc -ne 0 ]]; then
        if [[ -n "$_ACB_STAGE" && -d "$_ACB_STAGE" ]]; then
            rm -rf -- "$_ACB_STAGE" 2>/dev/null \
                || warn "Could not remove the staging dir $_ACB_STAGE"
        fi
        # .new is KEPT deliberately: it is the evidence for whatever failed (a
        # half-rendered tree, an unrendered PHP file), it is a sibling of the
        # nginx root rather than inside it, and the next run clears it before
        # staging anything. Only the bulk copy goes.
        if [[ -n "$_ACB_NEW" && -d "$_ACB_NEW" ]]; then
            info "Partial build kept at $_ACB_NEW (cleared on the next run)."
        fi
    fi
    _ACB_STAGE=""; _ACB_NEW=""
    return "$rc"
}

_acb_build_run() {
    local net="${1:-$ACC_NETWORK}"
    local domain="${2:-}"
    local outdir="${3:-}"

    _acb_assert_offline || return 1

    if [[ -z "$net" ]]; then error "accio_build: no network selected."; return 1; fi
    # A GUARD, not a switch. This used to call acc_set_network, which re-pointed
    # every ACC_* global — dirs, ports, conf path, service name, nginx vhost —
    # for the whole remaining hub session, with no restore. Mainnet/testnet
    # isolation must not depend on nobody passing the documented argument.
    if [[ "$net" != "$ACC_NETWORK" ]]; then
        error "accio_build: asked for '$net' while '$ACC_NETWORK' is selected."
        error "Call acc_set_network '$net' first — the build never switches it."
        return 1
    fi

    if [[ -z "$domain" ]]; then domain="$(_acc_conf_get ACCIO_DOMAIN "")"; fi
    if [[ -z "$outdir" ]]; then outdir="$ACC_SITE_DIR"; fi
    # Everything below derives .stage/.new/.prev from $outdir and rm -rf's them.
    # The expansions carry a :? too, but a bare :? in a sourced lib EXITS the
    # whole toolkit instead of returning to the menu, so the readable check goes
    # first and the expansion is the net underneath it.
    if [[ -z "$outdir" ]]; then
        error "accio_build: no output directory (was acc_set_network ever run?)."
        return 1
    fi

    local https onion
    https="$(_acc_conf_get ACCIO_HTTPS "off")"
    onion="$(_acc_conf_get ACCIO_ONION "")"

    if [[ -z "$domain" ]]; then
        error "No domain configured. Set ACCIO_DOMAIN= in $ACC_CONF"
        error "(Install / deploy writes it; the build never prompts.)"
        return 1
    fi
    if [[ ! -d "$ACC_VENDOR_SRC/public_html" ]]; then
        error "Vendored tree missing: $ACC_VENDOR_SRC/public_html"
        return 1
    fi

    # ── S6: the pin is checked, not assumed ──────────────────────────────────
    # Step 1 below copies the whole vendored tree into the build, so anything
    # sitting in vendor/ ships to a self-custodial wallet. One changed byte
    # fails here instead. 052_lib_vendor.sh is REQUIRED, not best-effort: a
    # build that silently skips the integrity check is worse than no check,
    # because the manifest then reads as evidence it never provided.
    if ! declare -F acv_verify_vendor >/dev/null 2>&1; then
        local _acb_vlib
        _acb_vlib="$(dirname "${BASH_SOURCE[0]}")/052_lib_vendor.sh"
        if [[ ! -f "$_acb_vlib" ]]; then
            error "Missing library: $_acb_vlib"
            error "It verifies vendor/ against vendor/SHA256SUMS before a build."
            return 1
        fi
        # shellcheck disable=SC1090
        source "$_acb_vlib"
    fi
    if ! acv_verify_vendor --quiet; then
        error "Refusing to build from an unverified vendored tree."
        error "Nothing was staged, rendered or swapped — $outdir is untouched."
        return 1
    fi

    acb_check_deps || return 1

    local stage="${outdir:?}.stage" new="${outdir:?}.new" prev="${outdir:?}.prev"
    # Published to the wrapper before anything is created, so every return below
    # is covered — including the two failures in the next four lines.
    _ACB_STAGE="$stage"; _ACB_NEW="$new"
    rm -rf -- "$stage" "$new" || {
        error "Could not clear the staging directories."; return 1; }
    mkdir -p -- "$stage" "$new" || {
        error "Could not create the staging directories."; return 1; }

    info "Accio build — $ACC_NET_LABEL"
    acb_env_report "$domain" "$https" "$onion"
    echo ""

    # ── 1. stage a writable copy; vendor/ is never touched ───────────────────
    cp -a -- "$ACC_VENDOR_SRC/public_html/." "$stage/" || {
        error "Failed to stage the vendored tree."; return 1; }

    # ── 2. overlay patches/ and keep SRI honest ──────────────────────────────
    _acb_apply_patches "$stage" "$ACC_PATCHES_SRC/public_html" || return 1

    # ── 3. render or copy, file by file ──────────────────────────────────────
    local rendered=0 copied=0 skipped=0 rel
    while IFS= read -r -d '' f; do
        rel="${f#"$stage"/}"
        if _acb_excluded "$rel"; then skipped=$((skipped + 1)); continue; fi
        mkdir -p -- "$new/$(dirname -- "$rel")" || {
            error "Could not create the output directory for $rel"; return 1; }
        if _acb_is_templated "$f"; then
            _acb_render_one "$f" "$new/$rel" "$domain" "$https" "$onion" "$rel" 0 || return 1
            rendered=$((rendered + 1))
        else
            # Guarded: the counter increments either way, so an unguarded copy
            # publishes a site missing an asset and still logs it as copied.
            cp -p -- "$f" "$new/$rel" || {
                error "Could not copy $rel into the build."; return 1; }
            copied=$((copied + 1))
        fi
    done < <(find "$stage" -type f -print0 | LC_ALL=C sort -z)

    info "Rendered $rendered, copied $copied, excluded $skipped."

    # Modes reach here from two places, neither of them chosen: `cp -a` carries
    # them over from the git checkout, and rendered files take whatever the
    # caller's umask happens to be. A checkout made under a restrictive umask,
    # or a toolkit run under `umask 077`, produces a tree nginx's worker user
    # cannot read — and the symptom is a 403 on every asset with a completely
    # clean build log, which reads as an nginx misconfiguration and is not one.
    # Normalising is one line and removes the whole class.
    # (Note what this is NOT: upstream's build.sh does `chmod 777 -R`. Nothing
    # in a served tree should be writable by anyone but root.)
    find "$new" -type d -exec chmod 755 {} + \
        || warn "Could not normalise directory modes under $new"
    find "$new" -type f -exec chmod 644 {} + \
        || warn "Could not normalise file modes under $new"

    # ── 4. post-conditions ───────────────────────────────────────────────────
    _acb_assert_output "$new" "$((rendered + copied))" || return 1

    # ── 5. manifest, written OUTSIDE the served root ─────────────────────────
    # Deterministic ordering so two runs diff cleanly. The previous manifest is
    # kept so S2 step 1 ("run it twice, diff the SHA256SUMS") is one command:
    #   diff <outdir>.SHA256SUMS.prev <outdir>.SHA256SUMS
    local manifest="${outdir}.SHA256SUMS"
    ( cd "$new" && find . -type f -print0 | LC_ALL=C sort -z \
        | xargs -0 sha256sum ) > "${manifest}.tmp" || {
        error "Failed to write the build manifest."; return 1; }
    if [[ -f "$manifest" ]]; then
        mv -f "$manifest" "${manifest}.prev" || {
            error "Could not rotate the previous manifest aside."; return 1; }
    fi
    mv -f "${manifest}.tmp" "$manifest" || {
        error "Could not install the build manifest."; return 1; }

    local pinned="unknown" _pin
    if [[ -f "$ACC_PINNED_SHA" ]]; then
        # NOT `grep … | cut … || echo unknown`. The `||` binds to the whole
        # PIPELINE, whose status is cut's — and cut succeeds on empty input. So
        # that form only produced "unknown" when pipefail happened to be set;
        # without it, a PINNED_SHA missing the line wrote a BLANK upstream_sha
        # into BUILD_INFO, which is the field an auditor reads to answer "which
        # upstream is this site built from". Capture, then decide.
        _pin=$(grep -E '^UPSTREAM_SHA=' "$ACC_PINNED_SHA" | cut -d'"' -f2) || _pin=""
        if [[ -n "$_pin" ]]; then pinned="$_pin"; fi
    fi
    {
        echo "# Accio build info — NOT byte-stable (it carries a timestamp)."
        echo "# Compare ${manifest##*/} between runs, not this file."
        echo "built_utc=$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
        echo "network=$ACC_NETWORK"
        echo "domain=$domain"
        echo "https=$https"
        echo "onion=${onion:-}"
        echo "upstream_sha=$pinned"
        echo "php=$("$ACB_PHP_BIN" -r 'echo PHP_VERSION;' 2>/dev/null || echo unknown)"
        echo "files_rendered=$rendered"
        echo "files_copied=$copied"
        echo "files_excluded=$skipped"
    } > "${outdir}.BUILD_INFO"

    # ── 6. swap last ─────────────────────────────────────────────────────────
    # ⚠ GUARDED END TO END, because the failure here is invisible otherwise.
    #   `mv "$new" "$outdir"` does NOT fail when $outdir is still present — it
    #   moves $new INSIDE it, producing site/site.new/ while the OLD tree keeps
    #   being served and every line below reports success. The manifest and
    #   BUILD_INFO then describe a tree nobody serves, so after a security
    #   rebuild the operator holds written evidence that the fix shipped.
    #   Therefore: prove the rotate before publishing, and put the old tree back
    #   if the publish fails.
    rm -rf -- "${prev:?}" || {
        error "Could not clear $prev — not swapping. The old site is untouched."
        return 1
    }
    if [[ -d "$outdir" ]]; then
        mv -- "$outdir" "$prev" || {
            error "Could not rotate $outdir aside — not swapping."
            error "The previous site is untouched and still served."
            return 1
        }
    fi
    if ! mv -- "$new" "$outdir"; then
        error "Failed to publish the new tree into $outdir."
        if [[ -d "$prev" && ! -e "$outdir" ]]; then
            if mv -- "$prev" "$outdir"; then
                error "Rolled back — the previous site is serving again."
            else
                error "ROLLBACK FAILED. The previous tree is at: $prev"
            fi
        fi
        return 1
    fi
    rm -rf -- "${stage:?}" || warn "Could not remove the staging dir $stage"

    success "Built $((rendered + copied)) files → $outdir"
    info "Manifest: $manifest"
    if [[ -f "${manifest}.prev" ]]; then
        if diff -q "${manifest}.prev" "$manifest" >/dev/null 2>&1; then
            success "Byte-identical to the previous build (reproducible)."
        else
            info "Differs from the previous build:"
            info "  diff ${manifest}.prev $manifest"
        fi
    fi
    if [[ -d "$prev" ]]; then info "Previous tree kept at: $prev"; fi
    log "accio_build: net=$ACC_NETWORK domain=$domain rendered=$rendered copied=$copied"
    return 0
}

# =============================================================================
# THE STANDALONE ARTEFACT
# =============================================================================
#   accio_build_standalone [net]
#
#   One self-contained index.html: every image, font, shader, model, WASM blob,
#   stylesheet, web worker and script folded into the page as a data: URI or an
#   inline tag. Open it from a USB stick with no server and no network and the
#   wallet works.
#
#   ⚠ IT CAN SEND BUT IT CANNOT RECEIVE. Receiving needs a listening socket, a
#     browser tab has none, and the thing that lends it one is the gateway —
#     which is a server. A standalone user can still receive by running their
#     own gateway and pointing the wallet at it; with nothing, they can build,
#     sign and broadcast payments, and that is all.
#
#   ─── WHY THIS IS A LOOP AND UPSTREAM'S IS 253 sed COMMANDS ─────────────────
#   The spec is `vendor/upstream-standalone-build/build.sh` lines 39-311 — 273
#   lines, 253 of them machine-generated `sed -i` calls, one per asset, each
#   naming a file path and an HTML attribute verbatim. Transcribing that would
#   have produced a build that silently stops inlining an asset the moment
#   upstream renames one — and our own overlay renames several (S5 replaced the
#   whole raster icon set with a single SVG, so a third of build.sh's image list
#   does not exist in our tree at all). So every phase below DISCOVERS its
#   asset list from the rendered files, and upstream's list is used only as
#   proof that the eight phases are the right eight.
#
#   The order of those phases is not free:
#     A  strip the head links that only make sense on a served site
#     B  images        -> data: URIs inside index.html
#     C  shaders/models/WASM -> data: URIs inside the .js that loads them
#     D  fonts         -> data: URIs inside the rendered .css
#     E  workers' importScripts() -> the imported file's text
#     F  workers       -> <script type="javascript/worker"> + a Blob URL rewrite
#     G  stylesheets   -> <style> in index.html
#     H  scripts       -> <script> in index.html
#   C/D/E must precede F/G/H: once a .js or .css has been folded into the page
#   it is no longer a file anyone can substitute into. F must precede H because
#   it rewrites the very script (slate.js, output.js, camera.js) that H inlines.
#
#   Reproducibility: this shares accio_build's staging, patch overlay and PHP
#   rendering, so the same vendored bytes and the same overlay produce the same
#   artefact. The one difference is the env — see _acb_render_one, fact 1.

# What data: URI type each extension gets. Anything not listed is not inlined,
# which is deliberate: an unknown type is far more likely to be a file that
# should stay a file than one we should guess a MIME type for.
_acb_sa_mime() {
    case "${1,,}" in
        *.svg)          echo "image/svg+xml" ;;
        *.png)          echo "image/png" ;;
        *.ico)          echo "image/x-icon" ;;
        *.jpg|*.jpeg)   echo "image/jpeg" ;;
        *.webp)         echo "image/webp" ;;
        *.gif)          echo "image/gif" ;;
        *.woff)         echo "font/woff" ;;
        *.woff2)        echo "font/woff2" ;;
        *.ttf)          echo "font/ttf" ;;
        *.otf)          echo "font/otf" ;;
        *.wasm)         echo "application/wasm" ;;
        *.json)         echo "application/json" ;;
        *.vert|*.frag|*.glsl|*.txt) echo "text/plain" ;;
        *)              return 1 ;;
    esac
}

# Extensions that are NOT in the table on purpose, so that a genuinely unknown
# one can be told apart from them.
#
#   .js  is load-bearing. `"." + getResource("./scripts/slate_worker.js")` is the
#        body of Slate.WORKER_FILE_LOCATION, and phase F rewrites the CONSTANT at
#        its call sites into a Blob URL. Inline the getter's path here and phase F
#        has nothing left to point at.
#   .css/.js as page assets belong to phases G/H, not to a data: URI.
#   .html/.php/.webmanifest/.xml are pages or manifests, not embeddable assets.
#
# Anything else reaching _acb_sa_note_skip is an asset type upstream added since
# this pin. It gets a warning — dropping it in silence is exactly the drift that
# "discover the list, never write it down" exists to prevent, and it would show
# up only as a broken feature in someone's offline wallet.
ACB_SA_NOINLINE=".js .css .html .php .webmanifest .xml .map"

_acb_sa_note_skip() {
    local ref="$1" ext k
    ext=".${ref##*.}"; ext="${ext,,}"
    for k in $ACB_SA_NOINLINE; do
        if [[ "$ext" == "$k" ]]; then return 0; fi
    done
    # Once per extension per build, not once per reference.
    case " ${_ACB_SA_WARNED:-} " in *" $ext "*) return 0 ;; esac
    _ACB_SA_WARNED="${_ACB_SA_WARNED:-} $ext"
    warn "  no MIME mapping for '$ext' — $ref left as a runtime fetch"
    warn "  (upstream added an asset type; add it to _acb_sa_mime)"
    return 0
}

# base64, one line, no wrapping. `openssl base64 -A` is upstream's own choice
# and is present on every box that can run this build (acb_check_deps already
# requires openssl for the SRI pass).
_acb_sa_b64() { openssl base64 -A -in "$1"; }

# base64, refusing to hand back an empty string. An empty $b64 still expands into
# a syntactically fine `data:…;base64,` URI that resolves to ZERO BYTES — a WASM
# module or font that fails in the browser with nothing in the build log.
_acb_sa_b64_checked() {
    local out
    out="$(_acb_sa_b64 "$1")" || out=""
    if [[ -z "$out" ]]; then
        error "base64 produced nothing for $1"
        return 1
    fi
    printf '%s' "$out"
}

# Escape a literal string for use as a sed BRE pattern. Only the BRE
# metacharacters need it — `+`, `(`, `)`, `?` and `|` are literal in a BRE, so
# `"." + getResource(...)` needs no handling beyond its dots.
#
# `#` is in the set even though it is not a BRE metacharacter: every caller of
# this helper builds an `s#…#…#g`, so `#` is a DELIMITER there and an unescaped
# one ends the pattern early and turns the remainder into sed syntax. `/` is in
# the set for the same reason (phase E addresses are `/…/`). An escaped ordinary
# character is itself in GNU sed, so escaping both is safe in either position.
_acb_sa_re() { printf '%s' "$1" | sed 's/[][\.*^$/#]/\\&/g'; }

# Apply a generated sed script, but only if it has content. Writing the script
# to a FILE rather than passing it on the command line is not tidiness: the
# secp256k1 WASM is ~2 MB, its base64 ~2.7 MB, and a single sed expression that
# size is at or over ARG_MAX on a normal Linux box. Upstream hit exactly this
# and had to convert two of its own substitutions to a here-doc for the reason.
_acb_sa_apply() {
    local script="$1" target="$2"
    [[ -s "$script" ]] || return 0
    sed -i -f "$script" "$target" || { error "sed pass failed on $target"; return 1; }
    return 0
}

# ── Phase A ─────────────────────────────────────────────────────────────────
# Head elements that describe a SERVED site. Left in place they point a file://
# page at URLs that do not exist for it: a manifest it cannot fetch, a canonical
# URL on our domain, preload hints for files that are now inlined (each one a
# console error and a wasted fetch attempt), and the two msapplication tags that
# name a browserconfig.xml which is not shipped. Line-addressed deletions,
# exactly as upstream does it — each of these tags occupies its own line, and
# removing a whole `--> ... <!--` line leaves the surrounding comment balanced.
_acb_sa_strip_head() {
    local index="$1"
    sed -i \
        -e '/<link rel="preload".*>/d' \
        -e '/--><link rel="prefetch".*><!--/d' \
        -e '/<link .* rel="manifest".*>/d' \
        -e '/<meta name="msapplication-config".*>/d' \
        -e '/<meta name="msapplication-starturl".*>/d' \
        -e '/<link rel="alternate".*>/d' \
        -e '/<link rel="canonical".*>/d' \
        "$index" || { error "phase A (head strip) failed on $index"; return 1; }
    return 0
}

# ── Phase B ─────────────────────────────────────────────────────────────────
# Every src="./..." / href="./..." in index.html whose target exists in the
# built tree and has an inlinable type. Discovered, not listed.
_acb_sa_inline_images() {
    local root="$1" index="$2" script n=0 ref file mime b64
    script="$(mktemp)" || { error "mktemp failed in phase B"; return 1; }
    while IFS= read -r ref; do
        file="$root/${ref#./}"
        [[ -f "$file" ]] || continue
        if ! mime="$(_acb_sa_mime "$ref")"; then _acb_sa_note_skip "$ref"; continue; fi
        b64="$(_acb_sa_b64_checked "$file")" || { rm -f "$script"; return 1; }
        printf 's#"%s"#"data:%s;base64,%s"#g\n' "$(_acb_sa_re "$ref")" "$mime" "$b64" >> "$script"
        n=$((n + 1))
    done < <(grep -oE '(src|href)="\./[^"]+"' "$index" \
             | sed -E 's/^(src|href)="//; s/"$//' | LC_ALL=C sort -u)
    _acb_sa_apply "$script" "$index" || { rm -f "$script"; return 1; }
    rm -f "$script"
    info "  inlined $n image reference(s) into index.html"
    return 0
}

# ── Phase C ─────────────────────────────────────────────────────────────────
# The wallet loads its shaders, its 3-D model and its five WASM modules through
# one expression: `"." + getResource(X)`. X is either a string literal or a
# class constant (Logo.VERTEX_SHADER_FILE_LOCATION), and the constant is a
# `static get` returning the path. Both forms are resolved here.
#
# ⚠ THE CLASS IS HALF THE KEY. This used to match `X.CONST`, throw the `X` away,
#   grep `static get CONST()` across every script and take head -n1 in GLOB
#   order. That is not a theoretical hazard in this tree: WORKER_FILE_LOCATION
#   is declared THREE times — camera.js, output.js, slate.js — each returning a
#   different path. It resolved correctly only because the four constants that
#   currently appear in the `X.CONST` form happen to be unique names. The first
#   time upstream writes one of the triplicated names in that form, the build
#   inlines camera's asset under slate's expression — silently, because the
#   warning below only fires when NOTHING resolves.
#
# So: find the file that declares the class, and read the getter out of it. If
# the class cannot be located, fall back to the tree-wide search but REFUSE an
# ambiguous answer rather than picking one. Returning empty is safe — the caller
# warns and leaves the asset as a runtime fetch, which degrades one feature
# instead of silently shipping the wrong bytes.
# Reads a `static get <CONST>()` body from stdin and prints the path it returns.
#
# TWO forms, because upstream writes both:
#     return "./shaders/logo.vert";
#     return "." + getResource("./scripts/slate_worker.js");
# The obvious `return "\(\.[^"]*\)"` captures a bare "." from the second form — a
# path that is not a path. It then failed the -f test and was skipped in silence,
# and, worse, it made all three WORKER_FILE_LOCATION getters resolve to the same
# "." — so the ambiguity guard below saw unanimity where there is none. Requiring
# `./` in the first form and matching the concatenation explicitly in the second
# means each getter yields its real, distinct path.
_acb_sa_getter_path() {
    sed -n -e 's/.*return "\(\.\/[^"]*\)".*/\1/p' \
           -e 's/.*return "\." + getResource("\(\.[^"]*\)").*/\1/p'
}

_acb_sa_resolve_const() {
    local root="$1" cls="$2" const="$3" f owner="" hit
    local -a hits=()

    for f in "$root"/scripts/*.js; do
        [[ -f "$f" ]] || continue
        if grep -qE "^[[:space:]]*class[[:space:]]+${cls}[[:space:]]*(\{|extends[[:space:]])" "$f"; then
            owner="$f"; break
        fi
    done

    # `|| true` throughout: not finding the getter is an expected outcome, and
    # head -n1 can SIGPIPE the grep. Both make the pipeline non-zero under
    # pipefail, which would abort the build instead of warning — today it does
    # not only because errexit happens to be off (see the header).
    if [[ -n "$owner" ]]; then
        hit=$(grep -A4 -h "static get ${const}()" "$owner" 2>/dev/null \
              | _acb_sa_getter_path | head -n1 || true)
        if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi
    fi

    while IFS= read -r hit; do
        [[ -n "$hit" ]] && hits+=("$hit")
    done < <(grep -A4 -h "static get ${const}()" "$root"/scripts/*.js 2>/dev/null \
             | _acb_sa_getter_path | LC_ALL=C sort -u || true)

    if [[ ${#hits[@]} -eq 1 ]]; then printf '%s' "${hits[0]}"; return 0; fi
    if [[ ${#hits[@]} -gt 1 ]]; then
        # >&2 is required, not tidiness: this function's stdout IS the resolved
        # path, so an un-redirected warn would be captured as the path.
        warn "  ${cls}.${const} resolves to ${#hits[@]} different paths across scripts/" >&2
        warn "  — refusing to guess; add the class declaration or resolve by hand" >&2
    fi
    return 0
}

_acb_sa_inline_js_resources() {
    local root="$1" js script expr ref file mime b64 cls const n=0
    for js in "$root"/scripts/*.js; do
        [[ -f "$js" ]] || continue
        script="$(mktemp)" || { error "mktemp failed in phase C"; return 1; }

        # Literal form: "." + getResource("./scripts/X.wasm")
        while IFS= read -r expr; do
            ref=$(printf '%s' "$expr" | sed -n 's/.*getResource("\(\.[^"]*\)").*/\1/p')
            [[ -n "$ref" ]] || continue
            file="$root/${ref#./}"
            [[ -f "$file" ]] || continue
            if ! mime="$(_acb_sa_mime "$ref")"; then _acb_sa_note_skip "$ref"; continue; fi
            b64="$(_acb_sa_b64_checked "$file")" || { rm -f "$script"; return 1; }
            printf 's#%s#"data:%s;base64,%s"#g\n' "$(_acb_sa_re "$expr")" "$mime" "$b64" >> "$script"
            n=$((n + 1))
        done < <(grep -oE '"\." \+ getResource\("\./[^"]+"\)' "$js" | LC_ALL=C sort -u)

        # Constant form: "." + getResource(Logo.MODEL_FILE_LOCATION)
        # Both halves are captured — see _acb_sa_resolve_const for why the class
        # name is not optional.
        while IFS= read -r expr; do
            cls=$(printf '%s' "$expr" | sed -n 's/.*getResource(\([A-Za-z_][A-Za-z0-9_]*\)\.[A-Z0-9_]*).*/\1/p')
            const=$(printf '%s' "$expr" | sed -n 's/.*getResource([A-Za-z_][A-Za-z0-9_]*\.\([A-Z0-9_]*\)).*/\1/p')
            [[ -n "$cls" && -n "$const" ]] || continue
            ref="$(_acb_sa_resolve_const "$root" "$cls" "$const")"
            if [[ -z "$ref" ]]; then
                warn "  could not resolve ${cls}.${const} — ${js##*/} will fetch it at runtime"
                continue
            fi
            file="$root/${ref#./}"
            [[ -f "$file" ]] || continue
            if ! mime="$(_acb_sa_mime "$ref")"; then _acb_sa_note_skip "$ref"; continue; fi
            b64="$(_acb_sa_b64_checked "$file")" || { rm -f "$script"; return 1; }
            printf 's#%s#"data:%s;base64,%s"#g\n' "$(_acb_sa_re "$expr")" "$mime" "$b64" >> "$script"
            n=$((n + 1))
        done < <(grep -oE '"\." \+ getResource\([A-Za-z_][A-Za-z0-9_]*\.[A-Z0-9_]+\)' "$js" | LC_ALL=C sort -u)

        _acb_sa_apply "$script" "$js" || { rm -f "$script"; return 1; }
        rm -f "$script"
    done
    info "  inlined $n script resource(s) (shaders, models, WASM)"
    return 0
}

# ── Phase D ─────────────────────────────────────────────────────────────────
# url("...") inside every rendered stylesheet, resolved RELATIVE TO THAT
# STYLESHEET — upstream's font CSS reaches back up with ../../, and resolving
# those against the tree root instead would find nothing and silently inline
# nothing at all.
_acb_sa_inline_css() {
    local root="$1" css dir script ref file mime b64 abs parent n=0
    while IFS= read -r -d '' css; do
        dir="$(dirname "$css")"
        script="$(mktemp)" || { error "mktemp failed in phase D"; return 1; }
        while IFS= read -r ref; do
            case "$ref" in data:*|http:*|https:*|//*) continue ;; esac
            abs="$dir/$ref"
            # Collapse ../ segments without realpath, which a minimal box may
            # not have. The paths here are always inside the staged tree.
            #
            # TWO statements on purpose. As one line —
            #   abs="$(cd "$(dirname "$abs")" && pwd)/$(basename "$abs")" || continue
            # — the assignment takes its status from the LAST substitution
            # (basename, which always succeeds), so that `|| continue` could
            # never fire and a failed cd silently produced abs="/name.svg".
            parent="$(cd "$(dirname -- "$abs")" 2>/dev/null && pwd)" || continue
            [[ -n "$parent" ]] || continue
            abs="$parent/$(basename -- "$abs")"
            [[ -f "$abs" ]] || continue
            if ! mime="$(_acb_sa_mime "$ref")"; then _acb_sa_note_skip "$ref"; continue; fi
            b64="$(_acb_sa_b64_checked "$abs")" || { rm -f "$script"; return 1; }
            printf 's#url("%s")#url("data:%s;base64,%s")#g\n' "$(_acb_sa_re "$ref")" "$mime" "$b64" >> "$script"
            n=$((n + 1))
        done < <(grep -oE 'url\("[^"]+"\)' "$css" | sed -E 's/^url\("//; s/"\)$//' | LC_ALL=C sort -u)
        _acb_sa_apply "$script" "$css" || { rm -f "$script"; return 1; }
        rm -f "$script"
    done < <(find "$root" -type f -name '*.css' -print0)
    info "  inlined $n font/image reference(s) into stylesheets"
    return 0
}

# ── Phase E ─────────────────────────────────────────────────────────────────
# A web worker pulls its dependencies with importScripts(). There is no network
# in a standalone artefact, so each call is replaced by the file's text. Looped
# until the file stops changing, because an imported script may import more.
_acb_sa_inline_worker_imports() {
    local root="$1" worker wdir script ref file pass n=0 left
    for worker in "$root"/scripts/*_worker.js; do
        [[ -f "$worker" ]] || continue
        # A SERVICE worker is not a Worker. It is registered by URL, never
        # constructed from a Blob, and upstream's installer already declines to
        # register on file:// (service_worker_installer.js:24) — so it is not
        # folded into the artefact and its file is discarded with the work dir.
        # The `*_worker.js` glob catches it anyway; excluded by name in both
        # phases so it stops producing work and warnings that mean nothing.
        case "${worker##*/}" in service_worker.js) continue ;; esac
        wdir="$(dirname -- "$worker")"
        for pass in 1 2 3 4 5; do
            script="$(mktemp)" || { error "mktemp failed in phase E"; return 1; }
            while IFS= read -r ref; do
                # importScripts() resolves against the WORKER's own URL, so the
                # path is kept rather than flattened to its basename — a
                # basename lookup silently picks scripts/x.js for an
                # importScripts("./sub/x.js") that meant a different file.
                case "$ref" in
                    /*) file="$root${ref}" ;;
                    *)  file="$wdir/${ref#./}" ;;
                esac
                if [[ ! -f "$file" ]]; then
                    # Never silent: offline, this worker throws on first use.
                    warn "  ${worker##*/} imports '$ref' which is not in the tree"
                    warn "  — it will call importScripts() with no network to serve it"
                    continue
                fi
                # `r` queues the file's text after the matched line and `d`
                # removes the line itself; GNU sed runs them in the order given.
                printf '/importScripts("%s");/r %s\n' "$(_acb_sa_re "$ref")" "$file" >> "$script"
                printf '/importScripts("%s");/d\n'    "$(_acb_sa_re "$ref")"          >> "$script"
                n=$((n + 1))
            done < <(grep -oE 'importScripts\("[^"]+"\);' "$worker" \
                     | sed -E 's/^importScripts\("//; s/"\);$//' | LC_ALL=C sort -u)
            if [[ ! -s "$script" ]]; then rm -f "$script"; break; fi
            _acb_sa_apply "$script" "$worker" || { rm -f "$script"; return 1; }
            rm -f "$script"
        done
        # The 5-pass cap is a cycle guard, not a budget. Hitting it with imports
        # still in the file used to end the loop in silence.
        left=$(grep -c 'importScripts("' "$worker" 2>/dev/null || true)
        if [[ "${left:-0}" -gt 0 ]]; then
            warn "  ${worker##*/} still has $left importScripts() call(s) after 5 passes"
            warn "  — an import cycle, or a dependency that is not in the tree"
        fi
    done
    info "  inlined $n importScripts() dependency/ies into the workers"
    return 0
}

# ── Phase F ─────────────────────────────────────────────────────────────────
# A Worker needs a URL, and a standalone page has none to give. Upstream's
# answer, carried over exactly: park the worker's source in the page as a
# <script type="javascript/worker"> (a type no browser executes), and rewrite
# the constant that named its file into a Blob object URL built from that
# element's text at runtime.
#
# The triples are DISCOVERED — scripts/<name>_worker.js implies scripts/<name>.js
# and the class <Name> — and each is verified by finding the constant before
# anything is rewritten. A worker whose owner cannot be identified is reported
# and skipped rather than half-processed.
_acb_sa_inline_workers() {
    local root="$1" index="$2" worker base owner cls id n=0 blob
    for worker in "$root"/scripts/*_worker.js; do
        [[ -f "$worker" ]] || continue
        # Not a Worker — see the note in _acb_sa_inline_worker_imports. Without
        # this, every single standalone build warned "service_worker has no
        # scripts/service.js", which is true, expected, and trains an operator
        # to skim past the warnings that do matter.
        case "${worker##*/}" in service_worker.js) continue ;; esac
        base="$(basename "$worker" .js)"           # slate_worker
        owner="${base%_worker}"                    # slate
        cls="$(tr '[:lower:]' '[:upper:]' <<< "${owner:0:1}")${owner:1}"   # Slate
        id="$base"

        if [[ ! -f "$root/scripts/$owner.js" ]]; then
            warn "  $base has no scripts/$owner.js — left as a separate file"
            continue
        fi
        if ! grep -q "${cls}\.WORKER_FILE_LOCATION" "$root/scripts/$owner.js"; then
            warn "  $owner.js does not name ${cls}.WORKER_FILE_LOCATION — skipped"
            continue
        fi

        # 1. open the worker block immediately before the owner's <script> tag
        #
        # ⚠ `.*` HERE, NEVER `[^>]*`. The rendered tag line is one line:
        #     --><script src="./scripts/slate.js" integrity="…" … defer="true"></script><!--
        #   so the text between the src attribute and the trailing `><!--` CONTAINS the
        #   `>` that closes the opening tag. A `[^>]*` cannot cross it, so the address
        #   matches nothing — and sed exits 0 on an address that never fires. Tightening
        #   upstream's `.*` to `[^>]*` therefore turns this whole phase into a silent
        #   no-op while step 3 below still rewrites the constant, leaving a standalone
        #   artefact whose getElementById() returns null the first time a slate is built.
        #   Verified against the rendered markup, not assumed.
        sed -i "/--><script .*\"\.\/scripts\/${owner}\.js\".*><!--/i --><script id=\"${id}\" type=\"javascript\/worker\">" "$index" \
            || { error "phase F: could not open the worker block for $base"; return 1; }

        # …and proof that it fired, before anything irreversible happens. Step 3
        # is the half that cannot be undone: it points live code at an element id,
        # so it must never run for a block that was not inserted.
        if ! grep -qF "id=\"${id}\"" "$index"; then
            warn "  no <script> tag for ${owner}.js in the page — $base left as a file"
            warn "  (upstream markup changed; ${cls}.WORKER_FILE_LOCATION untouched)"
            continue
        fi

        # 2. fill it, and close it. `[^>]*` IS right here — this line is one we
        #    just wrote ourselves and has no `>` inside an attribute value.
        sed -i -e "/--><script [^>]*\"${id}\"[^>]*>/r $worker" \
               -e "/--><script [^>]*\"${id}\"[^>]*>/a </script><!--" "$index" \
            || { error "phase F: could not fill the worker block for $base"; return 1; }
        # 3. point the owner at the block instead of at a file
        blob="window[\"URL\"].createObjectURL(new Blob([document.getElementById(\"${id}\")[\"textContent\"]], {\"type\": \"application/javascript\"}))"
        # Fatal, not skippable: step 2 already put the block in the page. Leaving
        # the constant naming a file that no longer ships is a worker that 404s
        # on a page with no server to 404 it.
        sed -i "s#${cls}\.WORKER_FILE_LOCATION#${blob}#g" "$root/scripts/$owner.js" \
            || { error "phase F: could not repoint ${cls}.WORKER_FILE_LOCATION"; return 1; }
        n=$((n + 1))
    done
    info "  inlined $n web worker(s) as Blob sources"
    return 0
}

# ── Phases G + H ────────────────────────────────────────────────────────────
# <link href="./x.css"> -> <style>...</style> and <script src="./x.js"> ->
# <script>... ONE awk pass over index.html rather than two sed invocations per
# file: awk can read the replacement file on demand, so a 60-asset page is one
# traversal instead of 120, and the `--> ... <!--` comment wrapper upstream's
# markup uses to swallow inter-tag whitespace is preserved per line instead of
# per hand-written pattern.
_acb_sa_inline_page() {
    local root="$1" index="$2" map tmp ref n=0
    map="$(mktemp)" || { error "mktemp failed in phases G/H"; return 1; }
    tmp="$(mktemp)" || { error "mktemp failed in phases G/H"; rm -f "$map"; return 1; }

    while IFS= read -r ref; do
        [[ -f "$root/${ref#./}" ]] || continue
        printf '%s\t%s\tstyle\n' "$ref" "$root/${ref#./}" >> "$map"
        n=$((n + 1))
    done < <(grep -oE '<link[^>]*href="\./[^"]+\.css"' "$index" \
             | grep -oE '\./[^"]+\.css' | LC_ALL=C sort -u)

    while IFS= read -r ref; do
        [[ -f "$root/${ref#./}" ]] || continue
        printf '%s\t%s\tscript\n' "$ref" "$root/${ref#./}" >> "$map"
        n=$((n + 1))
    done < <(grep -oE '<script[^>]*src="\./[^"]+\.js"' "$index" \
             | grep -oE '\./[^"]+\.js' | LC_ALL=C sort -u)

    awk -v mapfile="$map" '
        BEGIN {
            while ((getline l < mapfile) > 0) {
                split(l, a, "\t")
                if (a[1] == "") continue
                nrefs++
                refs[nrefs] = a[1]; path[a[1]] = a[2]; kind[a[1]] = a[3]
            }
            close(mapfile)
        }
        {
            line = $0
            for (i = 1; i <= nrefs; i++) {
                r = refs[i]
                if (index(line, "\"" r "\"") == 0) continue
                # A tag, not a mention: the worker sources inlined by phase F
                # are ordinary JavaScript and may contain a matching literal.
                if (kind[r] == "style"  && (index(line, "<link")   == 0 || index(line, "href=") == 0)) continue
                if (kind[r] == "script" && (index(line, "<script") == 0 || index(line, "src=")  == 0)) continue

                wrapped = (line ~ /^[[:space:]]*-->/)
                tag = (kind[r] == "style") ? "style" : "script"
                printf "%s<%s>\n", (wrapped ? "-->" : ""), tag
                while ((getline c < path[r]) > 0) print c
                close(path[r])
                printf "</%s>%s\n", tag, (wrapped ? "<!--" : "")
                next
            }
            print line
        }
    ' "$index" > "$tmp" || { rm -f "$map" "$tmp"; error "page inlining failed"; return 1; }

    mv -f "$tmp" "$index" || {
        error "Could not install the folded page over $index"
        rm -f "$map" "$tmp"
        return 1
    }
    rm -f "$map"
    info "  folded $n stylesheet(s)/script(s) into the page"
    return 0
}

# =============================================================================
# Public entry — the standalone artefact
# =============================================================================
# Set by _acb_standalone_run once it knows it; read only by the wrapper.
_ACB_WORK=""

# Same wrapper, same reason as accio_build: one cleanup covering every return
# path instead of a cleanup per return that the next edit forgets.
accio_build_standalone() {
    _ACB_WORK=""
    local rc=0
    _acb_standalone_run "$@" || rc=$?
    if [[ $rc -ne 0 && -n "$_ACB_WORK" && -d "$_ACB_WORK" ]]; then
        # Only the staged upstream copy goes — the same split the hosted build
        # makes. $work/render is what the folding phases were operating on when
        # it failed, and inspecting it is the only way to tell a missing asset
        # from a markup change upstream.
        if [[ -d "$_ACB_WORK/stage" ]]; then
            rm -rf -- "$_ACB_WORK/stage" 2>/dev/null \
                || warn "Could not remove $_ACB_WORK/stage"
        fi
        if [[ -d "$_ACB_WORK/render" ]]; then
            info "Partial render kept at $_ACB_WORK/render (cleared on the next run)."
        fi
    fi
    _ACB_WORK=""
    return "$rc"
}

_acb_standalone_run() {
    local net="${1:-$ACC_NETWORK}"

    _acb_assert_offline || return 1

    if [[ -z "$net" ]]; then error "accio_build_standalone: no network selected."; return 1; fi
    # Same guard as accio_build, same reason: never re-point the hub's globals.
    if [[ "$net" != "$ACC_NETWORK" ]]; then
        error "accio_build_standalone: asked for '$net' while '$ACC_NETWORK' is selected."
        error "Call acc_set_network '$net' first — the build never switches it."
        return 1
    fi
    if [[ -z "$ACC_DIR" ]]; then
        error "accio_build_standalone: ACC_DIR unset (was acc_set_network run?)."
        return 1
    fi

    local domain https onion
    domain="$(_acc_conf_get ACCIO_DOMAIN "")"
    https="$(_acc_conf_get ACCIO_HTTPS "off")"
    onion="$(_acc_conf_get ACCIO_ONION "")"
    if [[ -z "$domain" ]]; then
        error "No domain configured. Set ACCIO_DOMAIN= in $ACC_CONF"
        error "(It is baked into the artefact's own About page and links.)"
        return 1
    fi
    if [[ ! -d "$ACC_VENDOR_SRC/public_html" ]]; then
        error "Vendored tree missing: $ACC_VENDOR_SRC/public_html"
        return 1
    fi

    # Same gate as the hosted build, for the same reason and with more at stake:
    # this artefact is handed to someone to run OFFLINE, where nothing will ever
    # re-check it and no security update can reach it.
    if ! declare -F acv_verify_vendor >/dev/null 2>&1; then
        local _vlib; _vlib="$(dirname "${BASH_SOURCE[0]}")/052_lib_vendor.sh"
        if [[ ! -f "$_vlib" ]]; then
            error "Missing library: $_vlib (it verifies vendor/ before a build)."
            return 1
        fi
        # shellcheck disable=SC1090
        source "$_vlib"
    fi
    if ! acv_verify_vendor --quiet; then
        error "Refusing to build a standalone artefact from an unverified tree."
        return 1
    fi

    acb_check_deps || return 1

    local work stage rend outdir
    work="${ACC_DIR:?}/standalone.work"
    stage="$work/stage"; rend="$work/render"
    outdir="${ACC_DIR:?}/standalone"
    _ACB_WORK="$work"   # before it exists, so the clear below is covered too
    rm -rf -- "$work"    || { error "Could not clear $work"; return 1; }
    mkdir -p -- "$stage" "$rend" "$outdir" || {
        error "Could not create the standalone work directories."; return 1; }

    # Per-build, so the "unknown asset type" warnings are not suppressed by an
    # earlier build in the same session.
    _ACB_SA_WARNED=""

    info "Accio standalone artefact — $ACC_NET_LABEL"
    acb_env_report "$domain" "$https" "$onion"
    echo -e "  ${DIM}NO_FILE_VERSIONS / NO_FILE_CHECKSUMS / NO_MINIFIED_FILES = (set — OFF)${RESET}"
    echo -e "  ${DIM}  versions and SRI mean nothing once nothing is fetched${RESET}"
    echo ""

    # ── 1. stage + overlay, exactly as the hosted build does ─────────────────
    cp -a -- "$ACC_VENDOR_SRC/public_html/." "$stage/" || {
        error "Failed to stage the vendored tree."; return 1; }
    _acb_apply_patches "$stage" "$ACC_PATCHES_SRC/public_html" || return 1

    local version
    # `|| true` — head -n1 can SIGPIPE the sed, which is a non-zero pipeline
    # under pipefail for a case the next line already handles.
    version=$(sed -n 's/.*VERSION_NUMBER[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
              "$stage/backend/common.php" 2>/dev/null | head -n1 || true)
    version="${version:-unknown}"
    # It lands in a filename. Refuse anything that could climb out of $outdir.
    case "$version" in
        *[!A-Za-z0-9._-]*|*..*) version="unknown" ;;
    esac

    # ── 2. render, with the standalone env contract ──────────────────────────
    # The trailing 1 is the standalone env contract (fact 1). A parameter, so
    # there is no mode left set on a global for the next hosted build to inherit.
    local rendered=0 copied=0 rel f
    while IFS= read -r -d '' f; do
        rel="${f#"$stage"/}"
        if _acb_excluded "$rel"; then continue; fi
        mkdir -p -- "$rend/$(dirname -- "$rel")" || {
            error "Could not create the render directory for $rel"; return 1; }
        if _acb_is_templated "$f"; then
            _acb_render_one "$f" "$rend/$rel" "$domain" "$https" "$onion" "$rel" 1 || return 1
            rendered=$((rendered + 1))
        else
            cp -p -- "$f" "$rend/$rel" || {
                error "Could not copy $rel into the render tree."; return 1; }
            copied=$((copied + 1))
        fi
    done < <(find "$stage" -type f -print0 | LC_ALL=C sort -z)
    info "Rendered $rendered, copied $copied."

    local index="$rend/index.html"
    if [[ ! -s "$index" ]]; then
        error "No index.html was rendered — nothing to fold into."
        return 1
    fi

    # PRE-conditions for the folding, and the same count check the hosted build
    # runs. An asset lost here does not fail loudly the way a hosted one does —
    # it just never gets inlined, and the artefact silently reaches for a file
    # that is not there on a page with no server to ask.
    _acb_assert_output "$rend" "$((rendered + copied))" || return 1

    # ── 3. the eight phases, in the one order that works ─────────────────────
    info "Folding the site into a single page..."
    _acb_sa_strip_head            "$index"          || return 1
    _acb_sa_inline_images  "$rend" "$index"         || return 1
    _acb_sa_inline_js_resources "$rend"             || return 1
    _acb_sa_inline_css     "$rend"                  || return 1
    _acb_sa_inline_worker_imports "$rend"           || return 1
    _acb_sa_inline_workers "$rend" "$index"         || return 1
    _acb_sa_inline_page    "$rend" "$index"         || return 1

    # ── 4. post-conditions ───────────────────────────────────────────────────
    if _acb_is_templated "$index"; then
        error "The artefact still starts with raw PHP — refusing to publish it."
        return 1
    fi
    if grep -q '<?php' "$index"; then
        error "Unrendered PHP inside the artefact — refusing to publish it."
        return 1
    fi
    # A warning, never a failure: upstream's own artefact leaves a handful of
    # runtime-constructed paths behind, and they belong to features that simply
    # do not work offline. The count is printed so a jump in it gets noticed.
    local leftovers
    # `|| true`: ZERO leftovers is the GOOD outcome, and it is the one that makes
    # grep exit 1 — i.e. the success case is the failing pipeline under pipefail.
    leftovers=$(grep -oE '(src|href)="\./[^"]+"' "$index" 2>/dev/null | wc -l || true)
    if [[ "$leftovers" -gt 0 ]]; then
        warn "$leftovers relative reference(s) remain — those features need a server."
    fi

    # ── 5. publish ───────────────────────────────────────────────────────────
    # A name we chose, in our own vocabulary (naming policy layer 1): nothing
    # about a file an operator hands out should say MWC.
    local final="$outdir/accio-wallet-${ACC_NET_SHORT}-v${version}.html"
    # Guarded: unguarded, a failed mv left the PREVIOUS build's $final of the
    # same version in place, and every line below then republished, hashed and
    # announced that stale artefact — after `rm -rf "$work"` had destroyed the
    # fresh one. Someone downloads a wallet built before the fix.
    mv -f "$index" "$final" || {
        error "Could not publish the artefact to $final"
        error "Nothing was replaced; $outdir is unchanged."
        return 1
    }
    chmod 644 "$final" || warn "Could not chmod 644 $final"

    # current.html is what nginx serves at /standalone.html. A copy, not a
    # symlink: nginx can be configured with disable_symlinks on, and a download
    # that 403s on some boxes and not others is worse than 10 MB of disk.
    #
    # Written aside then renamed. cp'ing ~10 MB straight over the live file
    # hands a concurrent download a truncated wallet; the rename is atomic.
    cp -f "$final" "$outdir/current.html.new" || {
        error "Could not stage current.html"; return 1; }
    chmod 644 "$outdir/current.html.new" || warn "Could not chmod 644 current.html.new"
    mv -f "$outdir/current.html.new" "$outdir/current.html" || {
        error "Could not publish current.html — /standalone.html still serves the old one."
        rm -f "$outdir/current.html.new"
        return 1
    }
    chmod 755 "$outdir" || warn "Could not chmod 755 $outdir"

    # Hashed by BASENAME from inside $outdir: `sha256sum "$final"` records the
    # absolute path, so `sha256sum -c` on the operator's machine only verifies
    # if run from / with the same directory layout.
    ( cd "$outdir" && sha256sum "${final##*/}" > "${final##*/}.sha256" ) \
        || warn "Could not write ${final##*/}.sha256"
    rm -rf -- "$work" || warn "Could not remove the work dir $work"

    echo ""
    success "Standalone artefact: $final"
    info "Size: $(du -h "$final" 2>/dev/null | cut -f1)   upstream version: $version"
    info "Served as: https://${domain}/standalone.html  (as a download)"
    echo ""
    echo -e "  ${YELLOW}⚠ It can SEND but it cannot RECEIVE.${RESET}"
    echo -e "  ${DIM}Receiving needs a listening socket; a browser tab has none, and the${RESET}"
    echo -e "  ${DIM}thing that lends it one is this box's gateway. Offline it can still${RESET}"
    echo -e "  ${DIM}build, sign and broadcast payments — that is the whole of it.${RESET}"
    log "accio_build_standalone: net=$ACC_NETWORK version=$version file=$final"
    return 0
}
