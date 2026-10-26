# Script numbering — full per-script notes

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

## Script Numbering Convention
```
grin-node-toolkit.sh     Main menu entry point
scripts/
  01_  Build new Grin node (chain sync, binary install)
  02_  Nginx file server manager
  03_  Share chain data
  04_  Node foreign API + stats collector
  05_  Wallet services hub (launches 051–059; also hosts the 05C CMD-wallet quick setup)
  051_ Fidelius — personal web wallet (051x_ = XP-themed variant; has its OWN hub key
       since 2026-08-04, and is still reachable from inside 051)
  052_ Accio — public web wallet. IN BUILD since 2026-08-09 (packet S0), so it is
       no longer "reserved" — the number is ASSIGNED and the script file exists.
       **EVERY packet through S8 is written and EVERY menu key is live** (the last
       stub went 2026-08-10), and hub 05 key `2` now dispatches to the real script.
       S9's optional deletion passes started 2026-08-11 (pass 1 = MQS).
       ⚠ **Nothing has ever run on a VPS** — not one build, deploy, send or receive.
       S2 is no longer a build packet at all: it is the ACCEPTANCE session and owes
       every packet's runs at once, testnet before mainnet. A menu with no stubs is
       not a tested one. Self-custodial (keys in the browser
       tab) — the exact opposite of 051, which holds keys server-side. Vendored, not
       written: web/052_accio/vendor/ pins two MIT upstreams; the gateway
       (web/052_accio/gateway/, 9 modules, ZERO npm deps) is ours and carries both
       rails — /tor/ out, /listen + /wallet/<suffix> in. Four libs: build (site +
       the offline standalone HTML), gateway, nginx (vhost/certbot/onion), vendor.
       ⚠ nginx security headers live in TWO snippets (shared, and TLS-only for the
       headers the onion front must NOT emit) that every block adding any header of
       its own must include — `add_header` in a child block DISCARDS the parent's
       set, which is how a CSP goes missing from exactly the routes that matter, and
       a header repeated as a literal in three blocks is how the next one goes
       missing. And minting the onion is not enough: TOR_SERVER_ADDRESS is baked in
       at BUILD time, so an un-rebuilt site hands out a clearnet host to whoever
       picked "Onion Service". ⚠ The onion path is THREE listeners and so needs
       THREE ports — tor → ACC_TOR_FRONT_PORT (nginx block) → ACC_TOR_PORT
       (gateway), beside ACC_PORT (gateway ← :443). Collapsing two roles onto one
       port is a bind collision, not a saving, and NOTHING on this box reports one:
       `nginx -t` ignores a port someone else holds (EADDRINUSE is not an error
       in test mode — it does try the bind), `systemctl reload` returns 0 before the
       master binds, and a status line that greps `ss` for a port two roles share
       goes green whichever won. Verify the listener after the reload. ⚠ Its
       /opt/grin/accio-<net>/gateway-state/ is DURABLE STATE, not a cache: losing it
       changes the receiving address of every wallet that ever connected.
       De-branding lives in web/052_accio/patches/ (S5, 16 files; S9 pass 1 added a
       17th; S10's theme added a 18th + 19th) — NEVER edit vendor/, and never rename
       MWC_WALLET_TYPE (it is a chain discriminator, not branding; S9+ deletes those
       paths). ⚠ The theme ("Orbital Dawn", S10) is ONE added stylesheet loaded LAST
       — styles/accio.css — plus three hooks; upstream's 21 stylesheets are NOT
       overlaid, so `git log PINNED_SHA..upstream/master` stays readable. It must
       stay last, retuning is a :root token edit, and it carries no url() because
       the standalone inliner only rewrites the double-quoted form. It is a
       light→dark FLIP (upstream's content panels are near-white with near-black
       text), so a missed rule is black text on a navy panel — check coverage
       mechanically, never by eye. ⚠ But a coverage sweep only sees selectors upstream
       SETS a colour on, and the flip's worst bug is the opposite: a quiet button
       (menu rail, language picker) that overrides only `background` and inherits our
       DARK base ink — the main nav shipped at 1.2:1. Resolve colour/background/
       box-shadow PER PROPERTY, PER BUTTON. Two more from the same review: a ground
       gradient needs its arithmetic done (colour reaches only `last-stop × ry` back
       from the centre — ours landed at y=110%, so the whole "dawn" rendered as
       nothing and looked deliberate), and a hairline on a sized box is an `inset`
       box-shadow, never a `border` (upstream is `content-box`, so a border pushed the
       seed-phrase dialog 2px past its parent).
       There is deliberately NO operator theme switch. ⚠ An S9 pass is a
       REDUCTION, not an `rm`, whenever the subsystem is referenced from a file we
       don't patch: pass 1 kept Mqs's 5-symbol external surface because
       `Slate.compactProofAddress` switches on `Mqs.ADDRESS_LENGTH` on the slatepack
       ENCODE path, un-gated — deleting the file would ReferenceError on every send
       with a payment proof. A removal must never change how a slate is READ.
       Every patch is marked `ACCIO PATCH`;
       grep for that rather than diffing — ⚠ which makes an UNMARKED patch invisible
       to the only review method there is. R8 found one (check_for_updates.js, six
       rewritten URLs, no marker, unread through S5/S6/S8 and four review packets;
       it was beaconing to api.github.com from the "offline" standalone). The rule
       and a table of all 19 files — including the five whose format cannot hold an
       inline marker — now live in patches/README.md, which is where a patch author
       actually looks. ⚠ Branding is a phrase map duplicated in backend/language.php
       and scripts/language.js: the maps being IDENTICAL is necessary and proves
       nothing, because a phrase map keyed on English word order misses every
       translator who reordered it — Dutch/Greek/Chinese shipped 27 unbranded
       strings, the page title and the CURRENCY LABEL among them. Check a new
       language against the map programmatically before shipping it.
       ⚠ Since S6 the build is GATED on
       052_lib_vendor.sh verifying vendor/ against vendor/SHA256SUMS (no bypass) —
       an edited or added byte there stops the build; the fix is a re-vendor in this
       repo, NEVER regenerating the manifest on the VPS.
       Design → docs/reference/script052_design.md;
       the build handoff is script052_implementation.md's Open items + Build notes, never the chat.
  053_ WooCommerce payment gateway
  054–058 FREE — assign a number when a build STARTS, not to an idea. Pick one that
       keeps the 05 hub menu ascending (menu groups run wallets → payments →
       giveaways, so a wallet product needs a low number); a 2nd giveaway takes 058
       and that band grows downward. Pre-assigning numbers to unbuilt ideas is what
       made that menu read 1,5,C,3,4,6,2. An unbuilt product has NO number, so its
       design doc lives under its HUB's number, never a reserved one. Planned:
       Payment Pro, GoblinPay (script09_design.md PART C). Note the script number is
       still unassigned even though the 05 hub now gives these a menu KEY — the two
       are independent (see the fixed-slot rule below).
  059_ Grin Drop (giveaway + donation portal) — moved from 052 on 2026-08-04 so the
       single-member Giveaways category parks at the end of the band and leaves a
       contiguous run for the two categories that grow (wallets, payments). At 054
       it would have cost a second migration (WooCommerce → 055). Full reasoning is
       in the 05_grin_wallet_service.sh header + docs/reference/script05_implementation.md.
  06_  Global health + price collector (06b = GrinScan explorer)
  07_  Mining services hub → 07_grin_mining_solo.sh (solo private, has a `lan` arg) and
       07_grin_mining_public_pool.sh (GRINIUM public pool; libs 07_lib_hub.sh central hub /
       07_lib_gateway.sh thin regional stratum forwarder / 07_lib_gwctl.sh the single
       WireGuard-mutation binary / 07_lib_pool_wallet.sh / 07_lib_pool_backup.sh / 07_lib_pool_install.sh install+deploy / 07_lib_pool_nginx.sh vhost / 07_lib_pool_ops.sh admin+service+cron / 07_lib_pool_regions.sh WireGuard peers / 07_lib_pool_cleanup.sh Z cleanup; app code in
       web/07_mining_pool_public/). The pool's /play/ games service is menu P (07_lib_pool_games.sh,
       web/07_mining_pool_public/play/): its own unit/user/DB, and nothing under P restarts the pool.
       ⚠ The old SATELLITE role is GONE — deleted 2026-06-22
       (f2ebade) together with 07_lib_satellite.sh, back-end-pool/satellite.js and
       lib/share-relay.js. A region is a THIN stratum gateway under Model C: no node, no
       wallet, no DB, no Node app. It carries **no HTTP ingestion API**, so there is no
       share/block POST surface, no `requireSatellite` allowlist and no shared secret. Only
       the pool script's `Z) Cleanup` still knows the name, to remove a legacy install.)
  08_  Node admin centre (monitoring, nginx, firewall, backup, disk cleanup)
  08del_ Full cleanup (destructive)
  09_  Grin Connectivity Hub → 091_ Floonet relay deployer (deploys 2ro's floonet-rs via
       nginx/certbot — we deploy, don't fork), 092_ RESERVED for the mwixnet CoinSwap mixer
       (NOT BUILT — run one hop of a Grin CoinSwap route; ledger-level unlinkability, the one
       thing Tor cannot give. Design → script09_design.md PART D), and 093_ Grin Transporter
       (store-and-forward slate queue, was "Script 056"; Node+SQLite+Tor; Phase 1 built
       2026-07-11 STANDALONE — wiring into 059/07 stays deferred on wallet relay-receive
       support, design B.9 #6). 094+ free. Numbers swapped 2026-07-10 (Floonet first — serves
       existing users); Transporter moved 092→093 on 2026-08-04 to free 092 for the mixer.
       ⚠ That renumber is the band's ONE sanctioned exception to "assign a number when a build
       STARTS": 092 is held for an unbuilt product. It was affordable only because 093 has never
       been VPS-deployed AND its runtime identifiers are name-keyed, not number-keyed
       (grin-transporter-*, /opt/grin/transporter-*, grin_transporter.conf, ports 7456/7466) —
       so there was no Drop-style matched-key migration. Do not renumber a deployed product.
       Design → docs/reference/script09_design.md, memory project_comms_hub_09. Menu grouping is
       display-only; the number stays the label.
  lib/ Sourced libraries — always prefixed with parent script number
       e.g. 059_lib_wallet.sh, 059_lib_nginx.sh
```

