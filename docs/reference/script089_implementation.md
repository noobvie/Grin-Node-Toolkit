# Script 089 — Backup & Restore: implementation

> **Covers code as of:** 2026-11-16 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-11-16 (uncommitted) — `scripts/089_backup_restore.sh` (menu key `V`, weekly-check refresh on menu open), `scripts/lib/grin_backup_verify.sh`, `scripts/lib/grin_backup_verify_check.py`
> **Scope:** the backup verifier (menu `V`) as built. Backup, schedule, restore and offsite push are described only in the header comments of `scripts/089_backup_restore.sh`, `scripts/lib/grin_backup_engine.sh` and `scripts/lib/grin_backup_push.sh`; no design doc exists (see README "Known gaps").

## What shipped

### Verify backups (menu `V`)

**Status:** built, not VPS-tested. A WSL harness (fixtures for every profile, any-file mode,
traps and signals, freshness, offsite via a fake `ssh`, the weekly wrapper) passes.
**Menu:** hub 08 ▸ `9` Backup & Restore ▸ `V`.
**Files:** `scripts/lib/grin_backup_verify.sh` (`gbv_*`: profiles, sandbox, decrypt, report,
menu, weekly wrapper) · `scripts/lib/grin_backup_verify_check.py` (data checks, run as
`python3 -I <file> <mode>` from `/`).

Proves an archive is restorable without touching a live path: decrypt → extract every member
into a sandbox → read the restored data → ✓/✗/⚠ per check with a data summary → wipe the
sandbox. rc 0 = no ✗ (⚠ allowed), 1 = at least one ✗.

| Key | Action |
|---|---|
| `1` | Newest archive of each product in `/opt/grin/backups` (engine archives, pool DB snapshots, Script 04 onion tarballs), plus freshness and offsite size. A product whose backup cron exists but which has no archive at all is a ✗. |
| `2` | One file: pick from the 20 newest in `/opt/grin/backups` (+ legacy `/opt/grin/temp`), or type any path. |
| `3` | Weekly check on/off: `/etc/cron.d/grin-backup-verify`, Sundays 06:xx, `/usr/local/bin/grin-backup-verify`. Unattended: never prompts. |

Each verification from the menu runs in a subshell while the menu holds a no-op INT trap, so
Ctrl-C ends that verification (its sandbox is wiped) and the menu comes back.

### Profiles

Data at the top of `grin_backup_verify.sh`, one per product, read from that product's own
source list. `*` matches across `/`; `a|b` = either; `<dir>=><member>` = required only when
`<dir>` is in the archive (a network's dir present → that network's seed/config required).

| Profile (name) | Password | Required members | Freshness limit |
|---|---|---|---|
| toolkit (`grin_toolkit_backup_*`) | key + DDMMYYYY | `MANIFEST.txt`, `crontabs`, and every `conf:`, `wallet:`, `fidelius-wallet:`, `database:` path that `MANIFEST.txt` lists | 089 root-crontab line: every day → 26 h, else 8 days |
| pubpool / pubpooltestnet (`grin_pubpool[testnet]_backup_*`) | key + DDMMYYYY | `opt/grin/pubpool/<net>/pool.db`, `opt/grin/conf/grin_pubpool[_testnet].json`, `*/wallet_data/wallet.seed`, `*/grin-wallet.toml` | 26 h if the pool backup cron exists |
| pubpool[testnet]-dbsnap (`grin_*_dbsnap_<DDMMYYYY>_<HHMM>`, UTC) | key + the UTC DDMMYYYY | `opt/grin/pubpool/<net>/pool.db` | 2 × `PDS_INTERVAL` from the pool backup conf (else 2 h); stale = ⚠, the snapshot run skips when nothing changed |
| solo | key + DDMMYYYY | a wallet seed; per `solowallet/<net>` dir present: its seed + `grin-wallet.toml` | 26 h if `grin-solo-backup` cron |
| drop | key + DDMMYYYY | a wallet seed; per `drop-<main\|test>` dir present: its seed + `grin-wallet.toml` | 26 h if `grin-drop-backup` cron |
| floonet | key + DDMMYYYY | `etc-floonet-rs/config.toml` | 26 h if `grin-floonet-backup` cron |
| transporter | key + DDMMYYYY | `main/` or `test/config.json`; per `<main\|test>` dir its `config.json`; per `agent-<net>` dir its `agent.json` | 26 h if `grin-transporter-backup` cron |
| tor-onion (`grin_tor_onion_<net>.tar.gz`) | none (plain) | `hs_ed25519_secret_key` | none (made on demand) |
| legacy (`temp_dir_*.tar.gz.enc`) | DDMMYYYY from the name's YYYYMMDD | — | none |
| legacy-plain (`grin_backup_*.tar.gz`) | none (plain) | — | none |
| engine (any other `grin_<p>_backup_<date>`) | key + DDMMYYYY | — | none |

A required member must be a real directory or a regular, non-empty, non-symlink file; a
required `.db` must open as SQLite and pass `integrity_check` — otherwise ✗. No schedule for a
scheduled-type product → ⚠ with the archive's age. Stale against a schedule → ✗.

### Checks, in order

`.sha256` sidecar (Migrate OUT) · stale-sandbox sweep · free space · decrypt · `gzip -t` · tar
listing (device/FIFO members refuse the extract) · full extract (`--no-same-owner`, umask 077) ·
required/optional members · data · freshness (menu `1` only) · offsite.

- **Key:** read without the engine's legacy-key migration (`gbe_load_key` would write
  `grin_backup.conf`): the shared conf first, then the solo/drop legacy confs, read-only.
  Interactive: up to 3 typed older keys; unattended: ✗. A decrypt counts only when the result
  looks right — gzip magic for a profiled archive — because a wrong key passes openssl's padding
  check about once in 256.
- **Free space:** sizes come from the tar listing (never `gzip -l`, which stores the size mod
  2^32; a bare `.gz` is stream-counted). Every step must leave max(2 GiB, 10 % of the
  filesystem) free, since the sandbox shares the disk with live databases.
- **Sandbox + traps:** `mktemp -d /var/tmp/grin-verify.XXXXXX`, mode 700. EXIT/INT/TERM/HUP
  traps are set per verification and the caller's traps restored after it; a signal wipes the
  sandbox and re-raises on `$BASHPID`. In a subshell the caller's traps are NOT restored —
  `trap -p` there prints the parent's handlers, and re-arming the parent's EXIT handler would
  run it when the subshell ends. Sandboxes older than 6 h (a run killed with -9) are removed at
  the start of each run, under a `flock` on `/var/tmp/.grin-verify.lock`, prefix-gated, never
  through a symlink, and skipped if the lock file is a symlink or not ours.

### Data checks (`grin_backup_verify_check.py`)

- Every `*.db`/`*.sqlite`: `integrity_check`, table and row counts, newest `created_at`-style
  timestamp. `pool.db`: miner accounts and balances (excluding the `pool_fee`/`prize_pool`
  buckets, listed apart), newest share, block count — columns from `back-end-pool/lib/db.js`.
- JSON parse; TOML via `tomllib` (3.11+), else `tomli`/`toml` if importable, else a basic
  line-level syntax check, reported as such. A config named in the profile that does not
  parse is ✗, any other ⚠.
- Tor keys: 96/64-byte `ed25519v1` headers, v3 hostname. WireGuard: 32-byte base64 keys,
  `[Interface]` + `PrivateKey`. `wallet.seed`: present, non-empty, encrypted-seed JSON shape —
  content never printed. `grin_backup.conf` / `grin_backup_remote.conf` inside any archive → ⚠.
- Member names are printed and logged with control characters replaced by `?`.

### Any-file mode (no profile)

Every such report ends "READABLE, not COMPLETE".

- `.tar.gz/.tgz/.tar/.gz`: as above. `.zip`: `unzip -t` when installed (a second structure
  opinion only); extraction is python `zipfile`, refusing symlink entries, absolute or `..`
  paths, anything resolving outside the sandbox, and more bytes than the free-space budget.
- `.enc`: saved key + a date found in the name, then a legacy date password, then (interactive)
  a typed one. The result must be recognisable (gzip, zip, SQLite, tar, or mostly printable
  text) or it counts as a wrong key. The decrypted file keeps its inner name (`x.sql.enc` →
  `x.sql`) and is checked as that type.
- `.db/.sqlite`: copied with the backup API first — the live file is never opened read-write.
- `.sql`: SQLite dump → loaded into `:memory:` only, behind an authorizer that refuses
  ATTACH/DETACH, every PRAGMA outside the ones a dump emits, and file-touching functions;
  a dump whose text contains ATTACH, VACUUM or `load_extension` is refused unloaded (✗).
  MySQL/MariaDB → text check only (header, `-- Dump completed` footer, CREATE/INSERT per
  table); the report says a real restore test belongs on a spare box — an untrusted dump is
  never run against this box's database server. PostgreSQL → `pg_restore --list` for custom
  format, else a header/footer text check.

### Offsite

When the push in `grin_backup_push.sh` is configured: one read-only `ssh … wc -c` per archive,
`BatchMode`, `StrictHostKeyChecking=yes` (never adds a known_hosts entry), 60 s timeout. Same
size ✓ · different ✗ · missing ⚠ · unreachable ⚠. A missing same-day aside archive
(`<HHMMSS>_<DDMMYYYY>`) is explained instead: the remote holds the later archive under the
plain name.

### Freshness

Age = now − the older of the file's mtime and the time its NAME implies (dbsnap: its UTC
minute; aside: its HHMMSS; plain date: the end of that local day), so neither a copy nor a
`touch` makes an old archive look fresh.

### Weekly check

- Cron cannot source the repo, so the wrapper sources copies installed in `/opt/grin/lib`:
  `grin_backup_verify.sh`, `grin_backup_engine.sh`, `grin_backup_push.sh`,
  `grin_backup_verify_check.py`, and `grin_alert_send.sh` under the name
  `grin_backup_verify_alert.sh` (the node event recorder installs and removes its own
  `grin_alert_send.sh` there; neither may delete the other's).
- The dir and every copy must be root-owned, not a symlink, and not group/world-writable —
  checked before installing and by the wrapper itself before it sources anything (✗ logged,
  exit 1).
- `grin_backup_verify.version` beside the copies holds each copy's sha256 and the newest
  source mtime. Copies are refreshed when 089's menu (or menu `V`) opens and the content
  differs; a checkout older than the installed copies never replaces them (logged). Toolkit
  self-update (hub 08 key 8) has no post-install hook, so the refresh waits for the next
  menu open. Switching the check off and on forces a clean copy.
- The wrapper runs at `nice 19` / `ionice -c2 -n7`, defines its own logging fallbacks, and
  never prompts. On any ✗ it sends one alert through the node event recorder's channels
  (`/opt/grin/conf/node-events/recorder.conf`, read with an allow-list, never sourced);
  with no channel configured the result is logged only.
- Log: `/opt/grin/logs/backup-verify.log`, mode 600, one `=== RESULT: OK|FAIL ===` line per
  run (shown in the menu).
- Removal: `08del_clean_all_grin_things.sh` already covers the cron file, the wrapper and the
  `/opt/grin/lib` copies through its `grin*` sweeps of `/etc/cron.d` and `/usr/local/bin`
  and its removal of `/opt/grin`.

## Open items

- Not built: opening the restored wallet (needs its password) — a later opt-in.
- No logrotate entry for `backup-verify.log` (one block per archive per week).
