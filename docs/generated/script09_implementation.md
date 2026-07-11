# Script 09 — Implementation notes

**Scope:** what is actually built, per member. Design/rationale lives in
`script09_design.md`; this file records the implemented shape and the decisions
locked at implementation time.

---

## 091 — Floonet relay deployer (implemented 2026-07-10)

Deploys upstream `floonet-rs` (github.com/2ro, docs.floonet.dev) — we deploy,
we don't fork. Not yet exercised on a live VPS (upstream repo checked
2026-07-10; `bash -n` clean; TOML editor unit-tested locally).

### Files

| File | Role |
|---|---|
| `scripts/091_grin_floonet_relay.sh` | Entry point: guided setup wizard + monitor/admin menu |
| `scripts/lib/091_lib_floonet.sh` | `flr_*` helpers: setup steps, config.toml editor, dashboard, config menus, update/mixexit/uninstall, backup (product `floonet`) |
| `scripts/lib/nostr_relay_deploy.sh` | `nrd_*` shared primitive (design PART C.1): wss vhost via HTTP-first→certbot→SSL, firewall, WebSocket-handshake + NIP-11 probes. 091 is the first consumer; GoblinPay's bundled relay reuses it. |

No `web/091_*` — Floonet ships its own relay; we add no app code.

### Layout (upstream install.sh conventions, reused not reinvented)

```
/usr/local/bin/floonet-rs          binary
/etc/floonet-rs/config.toml        config (0600; 0640 root:floonet under fallback unit; 0644 if the installed unit is DynamicUser — token lives in env, not here)
/etc/floonet-rs/env                optional env overrides (FLOONET_GOBLINPAY_TOKEN), 0600
/var/lib/floonet-rs                state (SQLite)
/opt/grin/floonet/src              cloned source / build dir
/opt/grin/conf/grin_floonet.conf   deployer settings (FLR_DOMAIN/FLR_EMAIL/backup)
/etc/nginx/sites-available/floonet-relay          wss vhost
/etc/nginx/conf.d/script09-floonet[-conn].conf    zones floonet_ws (60r/m) + floonet_conn
```

### Guided setup (option 1) — newbie path

Intro screen (what you get / what you need / the 8 steps) → all questions
up-front (domain with DNS A-record pre-check against the server's public IP,
certbot email, relay name, description) → summary confirm → hands-off:

1. deps (git, compiler, `protoc`, ssl headers, sqlite3) — apt/yum
2. Rust via rustup minimal profile, only if cargo absent
3. clone/refresh `floonet-rs` source
4. build: **prebuilt-release probe first** (GitHub API; none exist as of
   2026-07-10), else `cargo build --release`; **temp 2 GB swap offer** on
   <3.5 GB RAM boxes (removed after build)
5. install: run upstream `deploy/install.sh` when present; verify/complete
   (binary → /usr/local/bin, unit, config seed from repo example) either way
6. `info.relay_url = wss://<domain>/` + name/description;
   `database.data_directory` always re-pointed at /var/lib/floonet-rs and
   `network.address` always forced to 127.0.0.1 (nginx is the only public
   entrance — an upstream example shipping 0.0.0.0 must not win)
7. nginx zones + `nrd_deploy_wss_vhost` + ufw/firewalld 80/443
8. enable + start + local WebSocket handshake verify

Every step idempotent; failures print a "fix and re-run option 1" hint. Final
screen shows the wss:// URL (end-to-end verified when possible) and next steps.
Option 2 re-runs only domain/SSL (post-DNS-fix path).

### Monitor / admin menu

- **3 Status dashboard**: service state/since, binary version, relay_url,
  loopback listener, cert days-remaining, state-dir size + `event` count
  (sqlite3 readonly), journal error count (1h), live local + public
  WebSocket-handshake probes.
- **4 Live logs** (`journalctl -f`, INT-trapped so Ctrl-C returns to menu),
  **5 service control**, **6 test relay** (local ws, public wss, NIP-11 doc).
- **7–11 config menus** — all edit `/etc/floonet-rs/config.toml` via the
  section-aware text-preserving python editor (`_flr_py_toml`; uncomments
  commented defaults, appends missing sections) then offer a restart:
  settings ([info]/[limits] incl. event-kind allowlist), access control
  ([authorization] NIP-42 toggles + pubkey whitelists), NIP-05 name authority
  (one-key enable with domain defaults), GoblinPay (pay_mode/url/prices; token
  goes to the env file + a systemd drop-in `EnvironmentFile=-`, never
  config.toml), raw editor.
- **B backup** — shared engine, product `floonet`: staged
  config+env+deployer-conf+SQLite-snapshot archive,
  `grin_floonet_backup_DDMMYYYY.tar.gz.enc`, restore (typed key), daily
  cron via self-contained wrapper `/usr/local/bin/grin-floonet-backup`
  (regenerated on schedule enable and retention change), offsite push hook.
- **U update** (git fetch → rebuild → reinstall → restart; no-op only when
  origin HEAD == the rev recorded at install time in `FLR_INSTALLED_REV`, so
  a fetch followed by a failed build can't fake "up to date"), **M mixnet
  exit** (optional add-on: builds
  `floonet-mixexit` from the relay tree or its own repo when reachable, then
  lets upstream install.sh co-install; honest "not available upstream" path),
  **D uninstall** (typed REMOVE; data/config/cert/source removals each opt-in;
  backups never touched).

### Decisions locked (design doc A.4 opens)

- **ONE relay per operator** — network-agnostic transport, no per-net
  instances (matches upstream's single service).
- **Unit**: upstream's hardened unit as-is when his install.sh runs. Toolkit
  **fallback unit uses a stable `User=floonet`**, not DynamicUser — a 0600
  root-owned config is unreadable under DynamicUser; stable user avoids the
  trap and suits backups.
- **Rust policy**: reuse existing cargo, else rustup (root, minimal profile).
- Prebuilt-first probe future-proofs the "publish release archives" upstream
  PR candidate without blocking on it.

### Review + hardening pass (2026-07-11, pre-VPS-test)

Deep logic/security review of all three files; every finding fixed same day:

- **TOML editor** (`_flr_py_toml`) rewritten set-mode: prefers the ACTIVE
  `key =` line and only uncomments a `# key =` docs line when no active line
  exists (the old first-match-wins produced duplicate keys → Rust toml parse
  failure → relay refused to start); drops pre-existing active duplicates;
  handles files without a trailing newline; get-mode strips inline `#`
  comments off bare values (was breaking `flr_port` silently). 9-case
  behavioral test suite passed against the shipped heredoc.
- **`network.address` forced to 127.0.0.1** in `flr_ensure_config` (was only
  pinning data_directory — an upstream 0.0.0.0 example would have exposed the
  bare relay port past the nginx limits).
- **DynamicUser config readability**: ensure_config + restore now chmod 644
  when the installed unit is `DynamicUser=yes` (0600/0640 root files are
  unreadable there; safe — secrets live in the env file only).
- **Update correctness**: `FLR_INSTALLED_REV` recorded in grin_floonet.conf
  at install; U compares against it, not the fetch delta.
- Leftover 2 GB build-swap file from an interrupted run is swapoff'd/removed
  at the next build-memory check; mixexit build no longer hides cargo stderr.
- Input validation: whitelist entries must be 64-hex pubkeys
  (`_flr_set_pubkey_array`), GRIN prices `^[0-9]+(\.[0-9]+)?$`; declining a
  bool toggle no longer offers a pointless restart; uninstall `rm -rf` paths
  carry `${VAR:?}` guards; `nrd_ws_handshake_test` max-time 10→4 s (curl
  always waits out the timeout after a 101, dashboards were stalling 20 s).

Still open until a live VPS run (unchanged watch list): upstream install.sh
behavior (may prompt/build), the `--config` flag name in the fallback unit,
the real `[network]` schema key names, protobuf-compiler availability on
Rocky/Alma, whether upstream's unit actually uses DynamicUser, and the
unverified prebuilt-release probe (no upstream releases exist yet — no
checksum on that path by design, HTTPS+GitHub trust only).

### Not built / future

- GoblinPay-side composition (05 member consuming this relay) — PART C.2.
- 092 Transporter remains deferred (design PART B unchanged).
