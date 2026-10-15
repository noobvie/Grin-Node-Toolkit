# Script 07 — Games platform `/play/` (Implementation)

> **Covers code as of:** 2026-09-27, the uncommitted games-platform Part 2, Part 3, Part 4, Part 5 and Part 6 working trees; *Part 7*, *Part 8*, *Part 9*, *Part 10*, *Part 11* and *Part 12* 2026-09-28, the uncommitted Part 7–12 working trees; *Part C1*, *Part C2*, *Part C3* and *Part C4* 2026-10-04, written with the uncommitted code they describe; *R1 review* 2026-10-04, written by the R1 session with its two name-rule fixes — *Part C3*'s rows on `name-rule.js` still read true but no longer list everything in it; *Part C5* 2026-10-04, written with the uncommitted code it describes; *Part C6* 2026-10-04, likewise; *Part C7* 2026-10-04, likewise (as §10.13 in `script07_implementation.md`)
> **Last verified:** **§10.13 *Chat backend* + *The chat UI* only, by the session that built them**: their file tables, the moderator set-up steps and the test counts read against `play/server/lib/{chat,moderation,auth,settings,db,app}.js`, `play/shell/js/play-chat.js`, `admin-panel/games{,-chat,-players}.html` + `games-admin.js` as written; games `npm test` 815/815, pool 2322/2322, the headless-Edge probe 58/58 · earlier §10.13 entries are chained into a mixed pool + games entry in the header of [`script07_implementation.md`](script07_implementation.md)
> **Product code last changed:** 2026-10-15 (`pgs_deploy_code` restarts games only when its runtime code changed — menu table row 2; `scripts/lib/07_lib_pool_games.sh`; uncommitted, not VPS-tested) · 2026-10-12 (games DB in the hub move — a mixed pool + games entry, in the header of [`script07_implementation.md`](script07_implementation.md)) · 2026-10-04 (games v2 R2 review, the guest login limiter — `play/server/lib/guests.js`, `lib/ratelimit.js`; §10.13 *R2 review*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C7, the floating chat bubble + the CMS body sandbox (D22-4) — the files in §10.13 *The floating chat bubble*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C6, the guest UI on /play/ — the files in §10.13 *The guest UI*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C5, guest accounts backend + games schema v5 — the files in §10.13 *Guest accounts backend*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 R1 review — the shared name rule's pool-name fold + two EXCEPTIONS, both copies + the fixture; §10.13 *R1 review*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C4, donor names auto-checked — the files in §10.13 *Donor names auto-checked*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C3, names v2 + games schema v4 — the files in §10.13 *Names v2*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C2, launch state + Community group — the files in §10.13 *The Community group*; uncommitted, not VPS-tested) · 2026-10-04 (games v2 Part C1, Option B — `public_html/js/{branding,ads}.js`, `lib/ads.js`, `lib/pool-settings.js`, the `index.js` step-up list, `admin-panel/{ads,settings-analytics}.html`, NEW `scripts/test-operator-code-sinks.js`; §10.13 *Operator code removed*; uncommitted, not VPS-tested) · 2026-09-28 (games platform Part 12, approved nicknames: NEW `play/server/lib/names.js`, schema v3, `play/shell/js/play-names.js`, pool `admin-panel/games-names.html` — §10.13 *Approved nicknames*; no pool backend code) · 2026-09-28 (games platform Part 11 review fixes: global caps in `back-end-pool/lib/games-link.js`, free matches out of `results_daily` in `play/server/lib/matches.js`, the sign-in hint, the pool menu's B row — §10.13 *Independent review of the first ten parts*) · 2026-09-28 (games platform Part 10: PvP in `play/server/lib/matches.js`, NEW `lib/ratings.js` + `scripts/test-pvp.js`, four PvP settings; NEW `play/shell/js/play-lobby.js` + the G-08 panel, the board buttons and polls in `play-shell.js`, PvP boards; pool admin `games-players.html` void + `games.html` PvP group; no pool backend code — §10.13 *PvP correspondence chess*)
> Prose last edited 2026-10-12 (new file: §10.13 of `script07_implementation.md` + the design's §19.14–19.15 records, re-sectioned to the implementation template; each part's design deltas sit under the part; dated headings → **Status:** lines; review records distilled into *Build notes — obstacles & lessons* (raw text in git at `e8932ab`), their open and accepted points moved to *Open items*. A re-section, not a verification)

**Product:** the `/play/` games service (`web/07_mining_pool_public/play/`, operator menu `P` in
`scripts/lib/07_lib_pool_games.sh`) and its one link into the pool backend (`lib/games-link.js`).
Design → [`script07_design_games.md`](script07_design_games.md) (§19); the pool itself →
[`script07_implementation.md`](script07_implementation.md).

Section numbers are permanent IDs: this file is §10.13 of the pool implementation doc, moved out
whole, plus the design's §19.14 status table and §19.15 build deltas. Each part below carries its
§19.15 deltas under *As built vs the design*.

| Part | Contents |
|---|---|
| [What shipped](#what-shipped) | one section per built feature, in build order |
| [Runbook](#runbook) | the operator side — menu `P`, unit, nginx, backup / restore, cron, cleanup |
| [Build notes](#build-notes--obstacles--lessons) | obstacles & lessons |
| [Open items](#open-items) | what is owed |

---

# What shipped

## 10.13 Games platform (design §19)

**Status:** built 2026-09-27 → 2026-10-04, not VPS-tested

The contract is design §19; the per-part deltas are in §19.15. This section records what each part
built in the pool and what a reader of the pool code needs to know.

## Games service skeleton

**Status:** built 2026-09-27, not VPS-tested. No §10.13 write-up; the build record is below.

### As built vs the design (§19.15)

**Part 1 — games service skeleton (2026-09-27, not VPS-tested).** Code in
`web/07_mining_pool_public/play/server/` (+ `play/README.md`). No §19.4 schema change: the
suite runs §19.4's SQL block on its own and requires the migration to produce exactly the same
35 tables and indexes. **So §19.4's SQL block is now test-bound.** A schema change is a new
migration *and* an edit to that block, in the same change.

1. **Layout (§19 Layout / plan).** Two files beyond the plan's list: `lib/app.js` (routes, the
   server, `listen`, `shutdown`), so tests use the real pieces without booting, and `lib/log.js`
   (one-line records; newlines in a message are flattened so no message can forge a second log
   record). `index.js` only wires them to the process.
2. **Exit code 78 (EX_CONFIG) on a bad config**, 1 on any other boot failure. Part 3's unit
   should set `RestartPreventExitStatus=78`: a restart cannot fix a config, and without it
   systemd loops on one.
3. **Config is stricter than §19.12 implied** (`lib/config.js`):
   - `GAMES_NET` has **no default**.
   - An unknown `GAMES_*` variable refuses the start, so a typo cannot quietly leave a
     default in force. A later part that adds a variable adds it to `KNOWN_GAMES_KEYS`, and
     Part 3's unit must set only known keys.
   - `POOL_INTERNAL_URL` must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with an
     explicit port and nothing after it. `localhost` is refused because it is a name, and the
     link secret will be sent to this URL (Part 4).
   - `GAMES_DB` must end in `.db` and must not resolve inside the code dir or the games dir.
     That turns D3's rsync trap into a start refusal.
   - `GAMES_PORT` must differ from the pool's port.
   - The listen host is not configurable at all.
4. **DB file modes (D3).** The file is created 0600 *before* SQLite opens it (SQLite gives
   `-wal`/`-shm` the main file's mode), and then chmod'ed as the pool does. That closes the
   create-then-chmod window. The mode check is skipped on Windows, where chmod does nothing,
   and is owed on the VPS.
5. **Migrations (§19.4 rules).** Idempotence comes from the version gate plus one transaction
   per migration. The SQL is plain `CREATE`, not `IF NOT EXISTS`, so a leftover table with the
   wrong shape fails loudly instead of being adopted. A DB whose `schema_version` is newer than
   the build is refused (no silent downgrade). `meta.net` is checked **before** migrating, so
   a future migration never runs against the other network's file.
6. **`transaction()`** starts the outermost level with `BEGIN IMMEDIATE` (§19.8 needs this for
   every write), nests as `SAVEPOINT`, and **refuses an async callback**. With one
   `DatabaseSync` connection, an `await` inside a transaction would pull other requests'
   statements into it.
7. **HTTP rules for every route (`lib/http.js`).**
   - **Paths:** matched on the raw path, with no percent-decoding and no dot-segment
     resolution. A `:param` segment is `[A-Za-z0-9_.~-]` and never starts with a dot.
   - **Bodies:** **every non-GET request needs `Content-Type: application/json`**, including
     `logout`, whose client must send `{}` (the CSRF layer of §19.5). The body is capped at
     16 KB unless the route sets its own cap. `Content-Length` over the cap gets 413 before a
     byte is read. A streamed overflow gets 413 + `Connection: close`, and the rest of that
     body is drained, not left unread: closing a socket with unread input can reset the
     connection before the client sees the 413. nginx's body cap bounds the drain.
   - **Headers:** JSON responses also carry `Content-Security-Policy: default-src 'none';
     frame-ancestors 'none'`, beside nosniff + no-store.
   - **HEAD** is answered on GET routes, for Part 3's `curl -sI` checks.
   - **Request ids:** a well-formed incoming `X-Request-Id` (the admin proxy's) is kept;
     anything else is replaced.
8. **Client IP.** `X-Real-IP` is trusted only from exactly `127.0.0.1`, `::1` or
   `::ffff:127.0.0.1`, not from all of 127/8. A malformed header from loopback falls back to
   the peer address.
9. **Cookies (for Part 4).** A cookie name sent twice parses as `null`, which means no
   session. The reason is cookie tossing: a sibling subdomain can plant a second `grin_play`,
   and "first one wins" would let it choose the session. The `__Host-` prefix cannot be used,
   because it requires `Path=/` and §19.5 uses `Path=/play/`.
10. **Health (§19.3).** It reads `schema_version` live, so a DB that stopped answering returns
    503 `db_unavailable` instead of a cached "fine".
11. **Maintenance (§19.12).** Both tiers (5 min and hourly) already exist, not just the hourly
    scaffold. Every job runs through one serial queue, so two tiers never interleave at an
    `await`, and a tier that comes due while already queued is coalesced. Timers are unref'd.
    No jobs are registered yet.
12. **Node 24 prints `ExperimentalWarning: SQLite …` once at boot.** It is harmless. The test
    runner suppresses it with `--disable-warning=ExperimentalWarning`; Part 3 decides whether
    the unit does too.

## Pool link (the only pool-side change)

**Status:** built 2026-09-27, not VPS-tested

**All logic lives in NEW `lib/games-link.js`** (`createGamesLink()`). `index.js` gained the
require, `const gamesLink = createGamesLink()` + `app.use(gamesLink.internal)` **above
`express.json()`**, `gamesLink.attach({...})` + `gamesLink.mountAdmin(app, {...})` right after the
branding route, `cfg.games = gamesLink.publicFlag()` in the branding builder, `'games'` in
`STEP_UP_SETTINGS_SECTIONS`, and one clause in the branding row of `API_DOC_META`. Nothing touches
the stratum, share, block, reward or payout paths.

- **Why two phases.** The internal routes must see the request before `express.json()` (the secret
  is checked before any body is read, and the verify cap is 2 KB, not express.json's 100 KB), but
  the DB and settings only exist inside `initializePool`. So the middleware is mounted at the top of
  the file and gets its dependencies from `attach()`, which runs before `app.listen`.
- **`/internal/*` guards, in order:** (1) a forwarding header (`X-Forwarded-For` / `X-Real-IP`) or a
  non-loopback socket → 404; (2) link file missing/short → 503 `link_not_configured`; (3) wrong or
  missing `X-Games-Link` → 401 `unauthorised` (one `timingSafeEqual`); (4) exact route match, else
  404. So a request that came through nginx cannot even learn whether the secret is configured.
- **Link secret:** path from pool.json `games_link_secret_file` (default
  `/opt/grin/conf/grin_pubgames_link_<net>`, `lib/config.js`). It is re-stat'ed at most once a
  second and re-read when its mtime or size changes, with surrounding whitespace trimmed. The games
  side must trim the same way (Part 4).
- **verify-proof** requires `client_ip` and refuses a loopback/unspecified one (a broken X-Real-IP
  chain would put every player in one throttle bucket). It calls the real `verifyOwnerProof` with
  that IP, audits `owner_proof:games_login:ok|deny`, and answers **200** with either
  `{ok:true, method, slot, age_seconds}` or `{ok:false, reason}`. Errors carry `error`, never
  `reason`.
- **activity** is one statement with `INDEXED BY idx_hashrate_time`. The planner already picks that
  index without the pin (`SEARCH … (recorded_at>? AND recorded_at<?)` + a temp b-tree for the
  GROUP BY). The pin makes a dropped index a loud error instead of a scan on the stratum process.
- **config** answers 503 `settings_unavailable` rather than a guessed `off`, so the games service can
  keep its last known mode (§19.2).
- **Admin proxy** `ALL /api/admin/games/*` → games `/internal/admin/*`. Step-up is decided by
  `requiresStepUp()`: GET never; the six §19.11 fast writes (fixed POST paths, see §19.11) never;
  **every other write always, so a games admin route added later is step-up until it is listed**.
  Paths are charset-checked raw (no `%`, no dot-segments), bodies are re-serialised JSON ≤ 64 KB,
  2 s budget. Games down → 503 `games_offline`, non-JSON → 502. Each step-up call writes one
  `games_admin` audit row. `GET /api/admin/games-link` (not proxied) feeds the Settings → Games
  health line.
- **Probe:** `GET 127.0.0.1:<games_port>/play/api/health` at attach, then every 60 s (unref'd, 1 s
  hard timeout, `agent:false`). Healthy = 200 + `ok:true` + the pool's own network. A flip calls
  `invalidateBranding`, so the nav reacts on the next branding fetch rather than after the 60 s memo.
- **Settings:** new `games` section `{ mode:'off', chat_enabled:false }` with strict validators
  (exact enum; booleans or the exact strings `'true'`/`'false'`, stored as `value_type 'boolean'`).
  The reader treats anything unexpected as off. `games_port` / `games_link_secret_file` are
  **pool.json keys, not settings** (§19.15 *Part 2*). A bad value in pool.json disables the link and
  logs one line; it never blocks the pool's boot.
- **Nav:** `public-shell.js` NAV gained `{ href:'/play/', label:'Play', icon:'🎮', games:true }`,
  rendered with `data-games="1" style="display:none"` in the header and the footer Pool column.
  `branding.js applyGamesNav` shows it only on `cfg.games.mode === 'on'`.
- **Admin page:** NEW `admin-panel/settings-games.html` (a `<select id="mode">`, because the
  harvester does not handle radios, plus `#chat_enabled` and the health line), linked under
  Settings in `admin-shell.js`. `settings-common.js` gained `loadGamesLinkStatus()` (textContent
  only).

**Tests.** NEW `scripts/test-games-link.js` (169), wired into `test:unit`. It runs the real lib on
a throwaway DB behind an express app mounted in index.js's order, with a fake games server on
`127.0.0.1:0`. `test-public-leakage.js` gained `[games]` (5). Pool `npm test`: **2108 → 2282
passed, 0 failed** (22 → 23 files).

**Deploy note.** This is the one planned pool restart of the whole games build (§19.2 impact budget
#1). With mode `off` (the default) and no games service installed, the only runtime change is one
refused localhost connection a minute from the probe.

**Not done / open.** Nothing ran against a live pool or on a VPS. The nginx
`location ^~ /internal/ { return 404; }`, the link file itself and `id grinpool` are Part 3's.

### As built vs the design (§19.15)

**Part 2 — pool link (2026-09-27, not VPS-tested).** Code in NEW `back-end-pool/lib/games-link.js`
plus mount lines in `index.js`; as-built notes in impl §10.13. What changed against §19.3, §19.11
and the plan:

1. **`games_port` and `games_link_secret_file` are pool.json keys, not pool settings** (§19.3
   table edited). The admin proxy sends the link secret and admin headers to `games_port`. As a
   panel setting, a stolen admin session could have pointed that at any localhost service (the
   wallet owner API on 3420, say), and an admin-editable file path would make the pool read any
   file it can. `lib/config.js` supplies the per-network defaults. Part 3 writes them with
   `pool_write_conf_key` only if absent. **A bad value disables the link and logs one line; it never
   fails the pool's boot**, because nothing about the games may endanger mining.
2. **Mounted before `express.json()`, not just before the rate limiters.** Otherwise express.json
   would parse up to 100 KB for an unauthenticated caller before the secret check, against §19.3's
   "secret first". The lib reads its own body with the 2 KB cap. The setup therefore has two phases:
   `createGamesLink()` + `app.use()` at the top of `index.js`, `attach()` in `setupRoutes`.
3. **A third guard on `/internal/*`:** any `X-Forwarded-For` / `X-Real-IP`, or a non-loopback
   socket, gets 404 before the secret is looked at. nginx always adds XFF, so a request that
   reached `/internal/` through any proxy location cannot even learn whether the link is configured.
   **Part 4's `pool-link.js` must send neither header to the pool.**
4. **verify-proof refuses a loopback or unspecified `client_ip`** (400 `client_ip`). If games ever
   forwards `127.0.0.1`, its X-Real-IP chain is broken and every player would share one throttle
   bucket (D7); refusing makes that loud. It also refuses **unknown body keys** (400 naming the
   key). Proof results are **HTTP 200** either way: `{ok:true, method, slot, age_seconds}` or
   `{ok:false, reason}`. Transport and shape errors carry `error` (plus `field`), never `reason`,
   so Part 4 can tell "the proof failed" from "the call failed". 413 `payload_too_large` and 415
   `unsupported_media_type` join §19.3's error codes.
5. **Success envelopes carry `ok:true`** on config and activity too (§19.3 listed bare fields).
   Activity 400s name `field`: `from` / `to` / `window` or the unknown key. Repeated params,
   signs, decimals, `1e3` and `0x…` are refused.
6. **Activity SQL is pinned with `INDEXED BY idx_hashrate_time`.** The planner already chooses that
   index without stats (checked 2026-09-27: `SEARCH … (recorded_at>? AND recorded_at<?)` + a temp
   b-tree for the GROUP BY). The pin turns a future dropped or renamed index into an error instead
   of a silent scan on the stratum process.
7. **Link secret file format:** surrounding whitespace is trimmed (a trailing newline is not part
   of it), files over 4 KB are ignored, and the file is re-stat'ed at most once a second. So a
   rotation is picked up within about 1 s, not strictly "on the next call". **Part 4 must trim the
   same way.**
8. **`config` answers 503 `settings_unavailable`** when the settings cannot be read, never a
   guessed `off`, so the games service's "keep the last known mode ≤ 10 min" (§19.2) can work.
9. **The step-up list is written as the FAST list, fail-closed** (§19.11 now lists the six exact
   paths). Games-side route names in Parts 7–9 are bound by it. The pool-owned Settings → Games save
   is step-up (`'games'` added to `STEP_UP_SETTINGS_SECTIONS`, per §19.11's "every games-settings
   write"). Admin proxy methods are GET/POST/PUT/PATCH/DELETE (others 405). The proxied path is
   checked raw: games' `:param` charset per segment, no `%`, no dot-leading segment, ≤ 256 chars.
   Upstream responses are capped at 2 MB.
10. **Probe health also requires `net` to equal the pool's network**, so a testnet games service
    answering on the mainnet port is unhealthy. A health flip calls `invalidateBranding`, so the nav
    follows within one branding fetch instead of the 60 s memo. The pool reads mode `off` until the
    first probe answers (it runs at attach, before `listen`).
11. **Branding `games.chat`** is `false` whenever the published mode is `off`, whatever
    `chat_enabled` says.
12. **Admin UI:** mode is a `<select>`, not radios, because the settings harvester sends every
    input's `id` and has no radio handling (memory `project_pool_admin_settings_form`). The health
    line reads a new pool-only route, `GET /api/admin/games-link` (secureAdmin, not proxied). It
    returns the switch state, `public_mode`, the port, the link file path, `link_configured` and the
    probe, never the secret.
13. **Implementation doc section is §10.13**, not the plan's §10.10 (§10.10–§10.12 were taken by
    then).

## Login, sessions, activity sync, plays ledger (games service only)

**Status:** built 2026-09-27, not VPS-tested

**VPS checkpoint A was skipped by the operator** (2026-09-27: installs later), so Part 4 was built
on top of Parts 1–3 with none of them run on a box. **No pool code changed in this part.** Everything
is in `web/07_mining_pool_public/play/server/`:

| File | What |
|---|---|
| `lib/pool-link.js` (NEW) | client for the three `/internal/games/*` routes: secret file trimmed, 32 B–4 KB, re-stat'ed ≤ 1/s; **no** `X-Forwarded-For` / `X-Real-IP`; 2 s whole-exchange timeout; typed `PoolLinkError` codes `link_not_configured` / `link_down` / `link_unauthorised` / `link_rejected` (+`field`) / `pool_error` / `bad_response`; every response shape-checked (activity rows with a bad address, the other network's prefix, a duplicate or a non-integer count are dropped and counted) |
| `lib/ratelimit.js` (NEW) | LRU-bounded token buckets; a failure backoff whose record survives expiry (so escalation is reachable) and whose overflow never evicts a live lockout |
| `lib/ledger.js` (NEW) | `post()` — the only writer of `players.plays` / `points`, balance + ledger row in one transaction, no overdraft (`LedgerError no_plays`), exactly-once by `uq_ledger_ref`; `verify()` reports drift, never fixes it |
| `lib/plays.js` (NEW) | the activity sync (§19.6): hour-aligned contiguous windows from the watermark to now − 120 s, one transaction per window, `UNIQUE(window_from)`, ≤ 24 pool calls per tick, > 7 d behind = one skipped row, seconds clamped to the window |
| `lib/sessions.js` (NEW) | sessions (§19.5): sha256-hex token hash, 14 d hard, `last_seen` ≤ 1 per 5 min, 20 live per address, `chat_ok_after` with the 1 h floor, `ip_coarse` /24 · /48, `ua_hint` "Browser on OS" (raw UA never stored), purge after 30 d |
| `lib/auth.js` (NEW) | routes `POST /play/api/login` · `logout` · `logout-all`, `GET /play/api/me` · `sessions`; the login limiter chain; chat status |
| `lib/mode.js` (NEW) | the pool's `games.mode` cache: off until the first answer, last known ≤ 10 min, single-flight, 60 s unref'd timer, transitions logged once |
| `lib/settings.js` (NEW) | games-owned settings (`settings` table) with a typed spec; Part 4 keys: `minutes_per_play`, `plays_daily_cap`, `plays_balance_cap`, `chat_min_proof_age`, `chat_requires_password` |
| `lib/mask.js` (NEW) | the pool's `maskAddr`, copied |
| `lib/app.js` | builds the services; `publicRoute()` = mode gate (off → 404) + CSRF layer 3 for every public route except health; `registerJobs()`; `start()`/`stop()` for the mode timer |
| `lib/http.js` | `sameOriginOk()`; `HttpError` carries response headers (`Retry-After`); five new message codes |
| `index.js` | registers the jobs, starts the mode cache after `listen` |

**Login, in order** (each step before anything dearer): body shape (`GRIN_ADDR_RE` + this network's
prefix, proof 1–256 chars, no other keys) → a loopback client IP is refused (400 `client_ip`, pool not
called) → per-IP and per-(address, IP) failure lockouts → per-IP bucket (10, refilling 1/min) →
per-address failure budget (20, refilling 1 per 3 min; a /24 · /48 with a session for that address in
the last 30 d passes when it is spent) → ban → **one** pool verify with the real IP. Only `no_match`
counts as a failure. Failure answers: 401 `login_failed` + `reason` + `hint` (the account page's own
sentence), 429 for `too_many_attempts` and every local limit (with `Retry-After`), 503
`pool_unavailable` for `lookup_failed` and any link error, 403 `banned`.

**Chat status** in `/me` (`auth.chatStatus`): `chat_off` · `muted` · `anchor_proof` ·
`password_required` · `proof_too_new` (+ `available_at`). Part 8 adds the recent-mining gate there.

**Maintenance jobs:** 5 m `activity_sync` (budget 15 s); 1 h `session_purge`, `limiter_sweep`,
`ledger_verify` (logs at most 20 drift lines).

**Tests.** NEW `scripts/test-auth.js` (163): the real pool-link against a stub pool on `127.0.0.1:0`
(headers sent, secret trim / rotation / short / missing / oversized, every error code, the 2 s
bound), the limiters (escalation after expiry, overflow), the ledger (1000 seeded random ops keep the
invariant; a tampered balance is reported and left alone), the sync (window shape, idempotence, two
concurrent syncs, UTC midnight, clamp, both caps, catch-up bound, the 7-day skip, link failures),
login / sessions / `/me` over a loopback server with a stubbed pool (mode gate, cookie attributes,
hashed token, every limiter, ban, CSRF, D9 variants, the 30-day known-IP window), the mode cache,
and log hygiene. Four mutations (no clamp, no Origin check, backoff record deleted at expiry,
`trivial_password` counted) each turned the suite red. Games `npm test`: **155 → 318 passed, 0
failed** (1 → 2 suites). The `test-skeleton.js` calls to `buildApp` now pass a full config
(`appConfig()`), since the app builds the pool link at construction.

**Owed on the VPS** (with checkpoint A, whenever the operator installs): a real login through nginx
(X-Real-IP reaching the service, the Origin check against the real Host), the pool's `games_login`
audit rows, the first sync's pool cost (≤ 24 activity calls, then one per 5 min), and the mode
following the admin switch within ~60 s.

### As built vs the design (§19.15)

**Part 4 — login, sessions, activity sync, plays ledger (2026-09-27, not VPS-tested).** Games service
only (`play/server/lib/`); no pool code changed. Built with checkpoint A **skipped by the operator**.
As built in impl §10.13 *Login, sessions*. What changed against §19.2, §19.5, §19.6 and the plan:

1. **Mode `off` answers 404 to login too.** The plan's Part 4 said "every public route except
   health/login"; D12 says every public route except health, and §19 wins. A login that works while
   the operator believes the games are off would be a proof oracle nobody is watching.
2. **Modules beyond the plan's list:** `settings.js` (the games-owned `settings` table behind a typed
   spec; a stored value that no longer validates reads as the default with one warning; Part 9 writes
   through it), `mode.js` (the mode cache), `auth.js` (the routes), `mask.js` (the pool's `maskAddr`,
   copied). `app.js publicRoute()` applies the mode gate and CSRF layer 3 to every public route.
   **Admin routes (Parts 7–9) must not use it:** they are secret-gated and must work while the games
   are off, so the operator can prepare them.
3. **The per-address limit counts FAILURES only, and a known IP passes it.** A limit on every attempt
   at an address is a switch any stranger can flip to lock the owner out (the pool's §J3-3 lesson).
   So: a per-IP bucket (10 attempts, refilling 1/min); per-IP (10) and per-(address, IP) (5) failure
   lockouts, 5 min doubling to 6 h, set below the pool's 20 / 8 so ours trip first; a per-address
   **failure** budget (20, refilling 1 per 3 min) that an IP whose /24 (/48) had a session for that
   address in the last 30 days skips. Only `no_match` counts, exactly as in the pool: every other
   reason is decided before any scrypt. All of it is in memory and forgotten on restart; the pool's
   own throttles, keyed on the real IP, are the real stop.
4. **Dead sessions are kept 30 days**, not purged sooner, because the known-IP check reads them.
5. **Login answers.** 401 `login_failed` with `reason` and `hint` (the account page's sentence for
   it); `too_many_attempts` and every local limit → 429 with `Retry-After`; `lookup_failed` and any
   link error → 503 `pool_unavailable`; an unknown reason is shown as `no_match`. A loopback client
   IP (no `X-Real-IP`) → 400 `client_ip` without calling the pool, the same refusal the pool makes.
6. **CSRF layer 3, exactly:** the expected origin is `https://` + the `Host` nginx forwards
   (`X-Forwarded-Proto` believed from a loopback peer only). `Origin: null` is refused, and so is any
   `Sec-Fetch-Site` other than `same-origin` / `none`, which also refuses a sibling subdomain. An
   absent `Origin` passes: curl and the admin proxy send none, and a browser always sends one on a
   cross-origin POST.
7. **Chat status.** `chat_ok_after` is fixed at login, but the password-only switch is **re-read on
   every `/me`**, so turning it on mid-incident closes chat to IP-proof sessions already open. A later
   raise of `chat_min_proof_age` is not retroactive. Reason codes: `chat_off`, `muted`,
   `anchor_proof`, `password_required`, `proof_too_new` (+ `available_at`). Part 8 adds the
   recent-mining gate in `auth.chatStatus`.
8. **Session metadata.** `ua_hint` is a coarse "Browser on OS" parsed from the User-Agent; the raw UA
   is never stored (attacker-chosen text, and a fingerprint).
9. **Activity sync.** The first sync starts at the current UTC midnight, so today's minutes count at
   launch (≤ 24 windows, one tick). An outage past 7 days is **one** skipped row, not one per hour. A
   pool 400 on `from` (clock skew at the lookback edge) skips that window instead of retrying it
   forever. Per-address seconds are clamped to the window length. The sync runs in every mode,
   `off` included (one indexed pool query per 5 min, and plays exist when the games switch on); with
   no link secret it is a no-op.
10. **"A change never recomputes the past", made precise.** `due` uses the whole current UTC day's
    seconds (§19.6's formula), so a lower `minutes_per_play` set at noon also re-rates the morning's
    minutes from the next window on. Nothing is ever clawed back, credited windows are never
    rewritten, and earlier days are untouched.
11. **Ledger.** `post()` is the only writer of `players.plays` / `points`. `reason` must be one of
    §19.4's list; `ref` matches `[A-Za-z0-9:_.-]{1,64}`; `|delta| ≤ 10^9`. `verify()` also reports
    ledger sums for an address with no `players` row.
12. **Jobs registered:** 5 m `activity_sync`; 1 h `session_purge`, `limiter_sweep`, `ledger_verify`.
13. **Growth (§19.13 #19): the ledger has no retention yet.** About 24 rows per active address per day
    from mining, plus match rows from Part 5, and `verify()` sums the whole table hourly. That is fine at
    this community's size; Part 11 must decide on a rollup before it matters.
14. **Ban revocation at the moment a ban is applied is Part 8/9's.** Until then, a session lookup
    already refuses a banned player, so a ban takes effect on the next request.

## Match platform, chess, bot (games service only)

**Status:** built 2026-09-27, not VPS-tested

Built on Parts 1–4 with nothing run on a box (checkpoint A skipped). **No pool code changed.**
Contract: design §19.7–§19.8; deltas: §19.15 *Part 5*.

| File | What |
|---|---|
| `play/games/chess/manifest.json` (NEW) | `kind: match`, modes bot + pvp, bot levels 1–3, UCI `move_pattern`, move times 1 / 3 / 7 days (default 3), `max_plies` 600, points bot 1/2/3, PvP 10/5 |
| `play/games/chess/rules.js` (NEW) | our own rules on a 0x88 board, UMD (global `GrinChessRules` in the frame): FEN in/out, UCI moves, `initial` · `toMove` · `legal` · `apply` · `status` (checkmate, stalemate, automatic threefold with FIDE en passant identity, automatic fifty-move, dead material, 600 plies) · `bot`. The bot is seeded splitmix32 over FNV-1a of (seed, ply, FEN, level): level 1 random, level 2 greedy material with mate-in-1, level 3 2-ply alpha-beta over material + Michniewski piece-square tables, `BOT_NODE_BUDGET` 20 000 |
| `server/lib/registry.js` (NEW) | `loadGames()`: real-path containment, size caps (manifest 16 KB, rules 512 KB), a strict manifest validator (unknown keys refused; `skill` / `chance` refused as reserved), rules.js evaluated in a sandboxed `vm` context, a smoke test on the start position; a bad game is skipped with one `[games] skipped …` line |
| `server/lib/matches.js` (NEW) | routes `GET /play/api/games`, `POST /play/api/matches`, `GET …/matches/mine`, `GET …/matches/:id`, `POST …/:id/move`, `POST …/:id/resign`; the replay + integrity check, `advance()` (settle, or bot replies until a human is to move), `settle` / `abort` (`UPDATE … WHERE state='active'` must change exactly one row), the points cap, timeouts, the purge |
| `server/lib/app.js` | builds the registry (injectable for tests) and matches; the match routes go through `publicRoute()`; jobs `match_timeouts` (5 m), `bot_moves_purge` (1 h) |
| `server/lib/settings.js` | `bot_play_cost` (1, 0–10), `points_daily_cap` (100, 0–100 000) |
| `server/lib/http.js` | ten message codes (`unknown_game` … `game_error`) |

**A move, in order** (one `BEGIN IMMEDIATE`): the match exists (404) → the caller holds a seat (403
`not_your_match`) → it is active (409 `not_active`) → a passed deadline is finalised and committed
(409 `timeout`) → the game is loaded (503 `unknown_game`) → it is the caller's turn (403) → `ply`
equals the stored ply (409 `stale`) → `move_pattern` → replay of the move list (must reach the stored
position) → `rules.apply` (400 `illegal_move`) → status → settle, or the bot's reply → status → … A
throw or a malformed return from any rules call answers 500 `game_error` and rolls the whole
transaction back.

**Tests.** NEW `scripts/test-matches.js` (133):
- **Perft:** start d1–4, Kiwipete d1–3, and three more reference positions (en passant pins, promotion
  and castling).
- **Rules cases:** castling through and out of check, a rook captured at home, en passant and its
  rank-pin, under-promotion, a pinned piece, every automatic game end, and repetition identity with an
  unusable en passant square.
- **Bot:** determinism across calls and separate sandbox loads, legality over 18 self-play games, mate
  in 1 found at levels 2–3, level 3 never allowing a mate in 1, and the budget cut-off.
- **Registry:** 15 planted folders, each good or bad for one reason, including a junction pointing
  outside the games dir.
- **Match API** over a loopback server with a stubbed pool: create validation, CSRF, `no_plays` with
  nothing left behind, two racing moves (exactly one wins), stale / illegal / forged / another
  address's match, the rate limit, public masking with no seed, resign exactly once, both timeout
  paths (sweep and lazy), win / draw / `max_plies` points with the daily cap and its UTC reset, free
  games, a throwing rules.js, a tampered position, `/mine` paging, mode off, the retention watermark,
  the ledger invariant and `EXPLAIN` on the hot reads.

Games `npm test`: **318 → 451 passed, 0 failed** (2 → 3 suites).

**Owed on the VPS** (with checkpoint A, whenever the operator installs): the registry's boot line on
the box (`[games] loaded chess 1.0.0 …` from `/opt/grin/pubgames/<net>/games/`); a bot game at each
level through nginx once Part 6's shell exists; the `[matches] slow bot move` warning never
appearing on the real CPU.

### As built vs the design (§19.15)

**Part 5 — match platform, chess, bot (2026-09-27, not VPS-tested).** Games service only: NEW
`play/server/lib/{registry,matches}.js`, NEW `play/games/chess/{manifest.json,rules.js}`, wiring in
`lib/app.js`; no pool code. As built in impl §10.13 *Match platform*. What changed against §19.4, §19.6–§19.8
and the plan:

1. **rules.js is evaluated, not `require()`d.** The registry runs it in its own `vm` context: no
   `require`, `process`, `console` or timers, no `Date`, a `Math.random` that throws, string eval and
   WASM codegen refused, and a 1 s limit on the load. That turns §19.7's "pure, no I/O, no `Date`, no
   `Math.random`" from a convention into a check. It is **not** a security boundary: rules.js is our own
   reviewed code. The registry also smoke-tests each game on its start position (`initial`, `toMove`,
   `legal` against `move_pattern`, `status`, one `apply`), so a broken game is skipped at boot, not
   found by the first player. The folder rule is §19.7's `^[a-z0-9-]{2,32}$`, stricter than Part 3's
   deploy regex (which also takes `_` and one-character names). A folder the deploy copies but the
   registry refuses is skipped with a log line.
2. **A free bot game pays no points** (the plan's self-review question b). With `bot_play_cost` 0 a
   level-1 bot would be a points tap that needs no mining at all, which bypasses D10. The cost is
   recorded in the match (`params_json.cost`, a key §19.4's comment did not list), so a later settings
   change never alters what an existing match refunds or pays.
3. **Point values are manifest values, not settings.** §19.6's `bot_points[level]`, `pvp_win_points`
   and `pvp_draw_points` are the game's `points.bot`, `points.pvp_win` and `points.pvp_draw`. A game
   defines what its own levels are worth, so changing them is a deploy. The games-owned settings added
   are `bot_play_cost` (1, range 0–10) and `points_daily_cap` (100, range 0–100 000). Part 9 may add
   per-game overrides if the operator wants them in the panel.
4. **Unknown body keys are REFUSED** (400, `field: 'body'`), not ignored as the plan's test list said.
   That matches login and the pool's verify-proof, and a forged `position`, `result`, `score` or
   `points` can never be half-accepted.
5. **The move rate is per ADDRESS** (burst 3, 1/s), not per session. With 20 sessions per address, a
   per-session limit would allow 20 bot searches a second.
6. **The deadline check comes before the turn and ply checks** (§19.8 listed it third). A timed-out
   match is finalised whoever asks, and the finalisation is committed before the 409 `timeout`.
   Timeouts apply to bot matches too: the human is always the side to move, and `ply < 2` aborts and
   refunds. Creating a bot game over an expired active one finalises the old one first, so an
   abandoned game never blocks the slot.
7. **The platform enforces `max_plies` for every game** (a draw with reason `max_plies`), on top of
   chess's own check in `rules.status`. A game whose rules forget it still ends.
8. **Every move replays the match.** The repetition history is rebuilt from `match_moves` through
   `rules.apply` on each move. The replay doubles as an integrity check: it must land exactly on the
   stored position, or the request answers 500 `game_error` and the match is left alone. Chess's
   `apply` makes only the one matching pseudo-legal move for this reason, not the whole legal list.
   **Worst-case CPU of one move request** (self-review c): a 409-ply replay plus a level-3 reply took
   about 13 ms on the Windows dev box.
9. **The bot's node budget is a backstop.** 2-ply alpha-beta never came near 20 000 nodes in testing:
   1 051 at most, a 32-queen position included. The cut-off is proved with a tests-only budget
   argument (`botStats`'s fifth argument; `bot()` always uses the constant). Level 3 scores a leaf
   that is in check with no legal move as mate, so it never walks into a mate in 1. **The match seed is
   never sent to a client**: with it, a player could replay the bot's tie-breaks offline.
10. **`game_version` is recorded, not enforced.** A deploy that bumps a game's version continues active
    matches under the new rules; a version check would strand every one of them. If a game's folder
    disappears, move and resign answer 503 `unknown_game`, and its timeouts abort and refund, because
    only the rules know whose turn it was.
11. **Retention (§19.8).** The hourly bot-move purge walks match ids upward from a watermark in `meta`
    (`bot_moves_purged_through`). The watermark stops at the first bot match that is not yet eligible,
    so none is ever skipped: a long-running bot game only delays the purge of later ones. A purged match
    still reads, with `moves: []`.
12. **Routes and shapes for Part 6.**
    - A new route, `GET /play/api/games`: the registry's public summary.
    - `GET /matches/:id` needs no session. A spectator gets `you: null` and no `legal` list.
    - `colour` is `'seat1'` | `'seat2'` | `'random'`; for chess, seat1 is white.
    - Error codes: `unknown_game` 404 · `mode_unavailable` 400 (PvP, until Part 10) · `active_match`
      409 (+ `match_id`) · `not_your_match` 403 · `not_your_turn` 403 · `not_active` 409 · `stale`
      409 · `timeout` 409 · `illegal_move` 400 · `game_error` 500 · `no_plays` 409.
    - The match view: `{ id, game_id, game_version, mode, state, labels{1,2}, you, to_move, your_turn,
      ply, position, last_move, legal, status{over,result,reason}, bot_level, move_seconds,
      turn_deadline, created_at, started_at, finished_at, last_move_at, since_ply, moves }`.
13. **Jobs registered:** 5 m `match_timeouts` (at most 200 per tick, oldest deadline first); 1 h
    `bot_moves_purge` (at most 500 match rows per run).

## The `/play/` shell + the chess frame (one pool static file, one bash hunk)

**Status:** built 2026-09-27, not VPS-tested

Built on Parts 1–5 with nothing run on a box. Contract: design §19.7 + D4 + D13; deltas: §19.15
*Part 6*. **No pool backend code changed** — the one pool file is a static script served by nginx,
live with the pool's web deploy and no restart.

| File | What |
|---|---|
| `play/shell/index.html` (NEW) | the page: pool header/footer (`public-shell.js` → `public-theme.js` → `branding.js`), states loading · offline/closed · sign-in · signed in, the Plays/Points/Signed-in-as placard, devices fold + log out / log out everywhere, the board panel (G-02), new game vs the bot (G-03), My games (G-04), "How plays are earned" (G-05). `<html data-untrusted-html="exempt">`; no inline script; own assets stamped `?v=__GRIN_PLAY_VERSION__` |
| `play/shell/js/play-api.js` (NEW) | `PlayApi.get/post` under `/play/api/`: same-origin, `no-store`, `redirect:'error'`, JSON content type on writes, 20 s abort. Offline = network error, non-JSON content type, a body without `ok`, 503 `shutting_down`/`db_unavailable` |
| `play/shell/js/frame-host.js` (NEW) | `FrameHost.create`: `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">` at `/play/games/<id>/frame/?v=<version.js>`; inbound only from `contentWindow`, exact-key schemas, move checked against the manifest `move_pattern`; `sendState` rebuilds §19.7's fields so nothing else can ride along; state/theme held until `ready` |
| `play/shell/js/play-shell.js` (NEW) | the controller: `/me` → signed in (401 → sign-in, 404 → "Games are closed", offline → retry), `/games`, `/matches/mine` (paged), opens the active bot game or `#m=<id>`, create / move / resign, two-click confirms, `/me` every 5 min while visible. No `innerHTML` |
| `play/shell/css/play.css` (NEW) | layout only, pool tokens only; `[hidden]` wins on this page; board 8:9 capped at 560 px; one column under 900 px |
| `play/games/chess/frame/{index.html,game.js,game.css}` (NEW) | 64 button squares (roving tabindex, arrows, Enter/Space), click-click + pointer drag, promotion picker, legal-target dots/rings, last-move tint, check marker (`rules.inCheck`), orientation from `you`, a provisional board from `rules.apply` while a move is in flight, input locked until the next `state`. Classic scripts; own dark/light palette |
| `public_html/js/public-shell.js` (pool) | every rendered href is site-absolute via `abs()`, active item compared by path; no ad slots / `ads.js` on a `data-untrusted-html="exempt"` page |
| `scripts/lib/07_lib_pool_games.sh` | `_pgs_stage_trees` replaces `__GRIN_PLAY_VERSION__` in every staged `*.html` after the hash; the "no shell" notice is a warning now |

**The blog permalink bug this fixed.** `post.html` is served at `/blog/<slug>` with no `<base>`, so
every header and footer link on a blog post resolved under `/blog/` (`/blog/index.html` …) and 404'd.
The same links would have broken on `/play/`. Absolute hrefs fix both.

**Tests.**
- NEW games `scripts/test-shell.js` (68): static rules on both HTML pages and all shell/frame JS (no
  inline script, no `on*`, no module script, no HTML sink, no eval, never `allow-same-origin`, every own
  asset stamped, the untrusted-HTML opt-out, load order, no `name=` on the login inputs); `FrameHost`
  in a `vm` with a fake DOM (ready gating, source check, exact schemas, a foreign-realm object dropped,
  extra state fields dropped, destroy); `PlayApi` with a fake fetch (every offline rule, incl. a body
  that parses but is not served as JSON); the nginx snippet's frame CSP. Mutation-checked: removing
  the move schema, the source check, the content-type rule, the sandbox value or a `textContent`
  each turns it red.
- Pool `test-games-link.js` 169 → 173: hrefs through `abs()`, no relative literal, `abs()` itself, the
  ad gating.
- A one-shot headless-Edge probe over CDP (127.0.0.1 server with the real nginx headers and the
  STAGED tree, stubbed `/play/api`, killed after): 48/48 — 1280 and 390 px in dark and light (0
  console errors or CSP violations, no horizontal overflow, square board, frame theme follows), a move
  through the frame (POST body exactly `{ply, move}`, bot reply drawn), junk and foreign messages
  dropped, the frame cannot read `document.cookie`, the parent, storage or `/play/api/` (origin
  `null`), login refusals, links absolute + Play active, no ads, 502 HTML → offline, 404 → closed, a
  direct frame visit sandboxed.

Games `npm test`: **451 → 519 passed, 0 failed** (3 → 4 suites).

**Owed on the VPS** (with checkpoint A): `P → 2` deploy shows the stamped URLs in
`/var/www/grin-play/index.html`; a bot game at each level through nginx and Cloudflare in preview;
the real CSP headers on `/play/` and `/play/games/` (`curl -sI`); a blog permalink's header links.

### As built vs the design (§19.15)

**Part 6 — the `/play/` shell + the chess frame (2026-09-27, not VPS-tested).** NEW `play/shell/**` and
`play/games/chess/frame/**`; one pool static file (`public_html/js/public-shell.js`) and one hunk of
`07_lib_pool_games.sh`; no games-service or pool-backend code. As built in impl §10.13 *The `/play/` shell*. What
changed against §19.7, D4, D13, §19.15 *Part 3* #6 and the plan:

1. **Cache-bust = a deploy-time stamp, not a JS loader.** Every own `<script>`/`<link>` in the shell
   and in a frame is written `?v=__GRIN_PLAY_VERSION__`; `_pgs_stage_trees` replaces it in every staged
   `*.html` with the version.js stamp, after the hash. A static tag stays parser-inserted — ordered, and
   render-blocking for CSS — which a loader reading `version.js` at runtime could not give. The shell
   still loads `/play/version.js` (Part 3 #6): `frame-host.js` reads `GRIN_PLAY_VERSION` for the frame
   `src`. The pool's own `/css` + `/js` stay unversioned, as on every pool page.
2. **The pool chrome runs on `/play/` unchanged in behaviour:** `public-shell.js` → `public-theme.js` →
   `branding.js`, all under the shell CSP. `branding.js` is clean there because the page sets
   `<html data-untrusted-html="exempt">` — a rig password is typed in the login card, so the §J1-1
   rule applies: no analytics, no operator raw HTML. Its `<style>` injections are covered by the CSP's
   `style-src 'unsafe-inline'`, its JSON-LD block is data, not script.
3. **Pool change 1: no ads on an exempt page.** A `code` ad is operator HTML/JS that `ads.js` re-creates
   as executing scripts — the same sink. `public-shell.js` now renders no ad slot and never loads
   `ads.js` when the page opts out. *Noticed, not changed:* `account-settings.html` takes the same rig
   password and does NOT opt out, so it still runs analytics, custom HTML and code ads. Pool
   `CREDENTIAL_PAGES` is `['login']`. For Part 11 / the security audit to decide.
4. **Pool change 2: every chrome href is site-absolute** (`abs()`), and the active item is compared by
   path. A relative `index.html` resolved to `/play/index.html` here — and to `/blog/index.html` on every
   blog permalink (`post.html` is served at `/blog/<slug>` with no `<base>`), where the header and
   footer links have been 404s since the permalinks shipped. A `<base href="/">` was rejected: it turns
   the skip link's `#main` into a navigation to the home page.
5. **In-flight moves are the frame's job, not a protocol message.** After posting a `move` the frame
   draws it provisionally (its copy of `rules.apply`) and takes no input until the next `state`, which
   is the server's board either way. The shell drops a move that arrives while a request is in flight;
   no "busy" state is ever posted (a state for the old position would snap the piece back).
6. **No reset on the iframe's `load` event.** The frame's `ready` is posted while its scripts run and
   can be handled before the parent sees `load`; a reset there would strand the frame. A reloaded frame
   just sends `ready` again, which re-sends the held theme + state.
7. **What counts as "offline"** (`play-api.js`): a network error or 20 s timeout, any response whose
   Content-Type is not JSON (a 200 included), a body with no boolean `ok`, and 503
   `shutting_down`/`db_unavailable`. A 404 `not_found` on `/me` is mode `off` → "Games are closed"; 401 →
   sign in; 403 `banned` → signed out with the server's sentence. A background `/me` refresh ignores an
   offline blip rather than blanking the page.
8. **Frame messages are exact-key.** Inbound to the shell: `ready {protocol:1}` and `move {move}` with no
   other keys, a same-realm plain object, from the frame's `contentWindow` only. `sendState` rebuilds
   §19.7's fields from the match view, so a token, full address or seed cannot ride along by accident;
   `legal` is omitted, not `null`, when it is not the viewer's turn. The frame validates `state` the same
   way (FEN shape, move pattern, ≤ 512 legal moves, labels ≤ 64 chars).
9. **Sign-in copy and form.** IP *or* rig password; common passwords and anything under 8 characters are
   never proof, so those miners sign in by IP; the pool checks and the games never store the proof; a
   link to `/#rx-miner-guide`. The inputs carry no `name` (a fallback submit sends nothing), the proof box
   is `type=password` with a Show toggle, and the address shape is checked before any call. Refusals show
   the server's own `hint`.
10. **The "How plays are earned" fold states DEFAULTS** ("by default 10 minutes = 1 play, 24 a day, 100
    held"). No public route reports the live settings; if the operator changes them the page is wrong
    until Part 9 surfaces them (a `GET /play/api/rules`, or fields on `/me`).
11. **Confirmations are two-click in-page** (Resign, Log out everywhere: the button arms for 5 s). No
    native dialog anywhere on the page.
12. **`#m=<id>`** reopens a match after a reload. Signed-in only in v1: the API already serves a
    spectator view (`you: null`) and the frame draws one, but a public spectator page is Part 10's call.
    No `turns` polling yet — a bot game answers in the same request; `/me` refreshes every 5 min while
    the page is visible and on returning to the tab.
13. **The frame keeps its own two palettes** (it is a separate, opaque-origin document; the pool tokens
    cannot reach it), chosen by the `theme` message the shell sends from `GriniumTheme.isLight()` and on
    every body-class change. Its dark squares were lightened after the probe screenshots showed black
    pieces barely reading on them. A `data:` favicon keeps a direct visit from requesting
    `/favicon.ico`.
14. **Self-review (the plan's three questions).** (a) API data never reaches `innerHTML`: the shell and
    frame JS contain no HTML sink at all (`test-shell.js` enforces it), and the pool chrome's own
    `innerHTML` renders only its static NAV through `esc()`; the probe planted
    `<img src=x onerror=…>` in a label and it rendered as text. (b) No inline script or handler in
    either page (enforced; 0 CSP violations under the real header). (c) A 502 HTML page → the offline
    panel (probe + test).

## Leaderboards, events, the admin Events page

**Status:** built 2026-09-28, not VPS-tested

Built on Parts 1–6 with nothing run on a box. Contract: design §19.9 + §19.11 + D15 + D17; deltas:
§19.15 *Part 7*. **No pool backend code changed** — two admin-panel static files (a new page and a
nav entry), live with the pool's web deploy and no restart. The pool-side step-up rule the page
relies on (`FAST_WRITES` in `lib/games-link.js`) was written in Part 2 and already names these routes.

| File | What |
|---|---|
| `play/server/lib/leaderboard.js` (NEW) | `GET /play/api/leaderboard?board=&game=&mode=&period=`: points held (`players`), rating (`ratings`, ≥ 5 rated games), wins / match points per game + mode over the current UTC day, ISO week, month or all time (`results_daily`). Masked names, `own` flag + `you` rank for the caller, 60 s cache over a closed key space |
| `play/server/lib/events.js` (NEW) | the platform: validation, lifecycle (`tick()`), `finalise()`, public routes `GET /play/api/events` + `/:id`, admin routes under `/internal/admin/` (`event-kinds`, `events` list / create, `events/:id` get / update, `…/cancel`, `…/finalise`) |
| `play/server/lib/events/{game_results,mining_minutes,active_days}.js` (NEW) | one module per kind: `validate` · `compute` · `describe` · `gameId` (+ `fields` for the admin form). Reads `results_daily` / `activity_daily` only |
| `play/server/lib/events/index.js`, `_rules.js` (NEW) | the explicit kind list (a new kind = a module + one line here); the rules helpers (`RulesError`, strict keys, typed ints / enums) |
| `play/server/lib/admin.js` (NEW) | the `/internal/admin/*` guard, run before the body is read: forwarding headers or a non-loopback peer → 404; link secret → 401 / 503; `X-Admin-User` → 400; `X-Admin-Stepup: 1` on every non-FAST write → 403 `step_up_required`. `audit()` writes the `mod_actions` row |
| `play/server/lib/badges.js` (NEW) | the eight badge ids + labels; parsing of `players.badges_json` |
| `play/server/lib/app.js` | builds admin / leaderboard / events; public routes through `publicRoute()`, admin routes straight on the router; jobs `event_transitions` (5 m, after `activity_sync`) and `mod_actions_purge` (1 h, 365 days) |
| `play/server/lib/http.js` | a route `guard` option (runs before the body is read); five message codes |
| `play/server/lib/pool-link.js` | `checkSecret(given)` → `ok` / `wrong` / `not_configured`: the admin guard gets a verdict, never the secret |
| `play/server/lib/auth.js` | `/me` gains `badges` `[{ id, label, event_id }]` |
| `play/shell/js/play-boards.js` (NEW) | the G-06 panel: Leaderboards / Events tabs (ARIA tablist, arrow keys), board + period pickers, ranked tables, the event list, detail with rewards and standings. Follows the page state from `play-shell.js`'s `play:view` event; shown signed in or out; no polling; no `innerHTML` |
| `play/shell/index.html`, `js/play-shell.js`, `css/play.css` | the G-06 section, a badges line on the account strip, a sentence on events in G-05; `setView()` sets `body[data-play-view]` and fires `play:view`; tab / table / chip styles from the pool tokens |
| `back-end-pool/admin-panel/games-events.html` (NEW) | event form (kind → rule fields from `event-kinds`, title, first / last UTC day as date inputs, reward tiers, participation), the list (AdminTable, state chips, Edit / Results / Finalise now / Cancel), the results table with full addresses, an in-page confirm dialog; every call through `adminFetch('/api/admin/games/…')` |
| `back-end-pool/admin-panel/admin-shell.js` | NAV: a **Games** group (🎮) holding Events, between Dashboard and Settings |

**Finalising an event, in order** (one `BEGIN IMMEDIATE`): the event is `finalising` (else nothing is
written) → the kind computes over the window's UTC days → addresses with a zero value, or banned at
that moment, drop out → sort by value DESC, address ASC; rank = position → the state flips to `done`
(an `UPDATE … WHERE state = 'finalising'` that must change one row) → per ranked address: an
`event_results` row, the reward (the first tier holding the rank, else participation if the value
reaches it) as a `('points', +n, 'event', 'e:<id>')` ledger row, the badge appended to
`badges_json`. A throw anywhere rolls all of it back and leaves the event `finalising` for the next tick.

**A link-secret 401 is not a logout.** `API.get` / `Auth.fetch` send the admin to `/login.html` on
ANY 401, and the proxy passes the games service's own 401 (pool and games disagree on the link
secret) through unchanged. So `games-events.html` does not use `API.*`: it reads the body, and a 401
whose body has `ok: false` is shown as "rotate the link secret (P → 7)"; only the pool's own 401
(which never carries `ok`) goes to the login page. Parts 9's games pages need the same.

**Tests.**
- NEW games `scripts/test-events.js` (101): UTC periods (ISO week across a year end, leap February);
  ranking and its tie-breaks; kind rules; every board over a loopback server (periods, modes, the
  provisional rating rule, masking, `own` / `you`, parameter refusals, the 60 s cache, mode off);
  the admin guard (forwarding headers, missing / wrong / absent secret, the guard before the body,
  admin user, step-up, `FAST_WRITES` compared as text with the pool's); event validation; the whole
  lifecycle through `tick()`; `mining_minutes` equal to the `activity_daily` sums over exactly the
  window over randomised data; `active_days`; `game_results` with `min_games`, a banned address and
  another mode; exactly-once (a second tick, a direct finalise, a forced replay that must fail whole,
  a duplicate ledger ref); cancel from running and from finalising paying nothing; finalise-now;
  public visibility of cancelled events; every public response scanned for a full address; `EXPLAIN`
  on every board and kind query, and a source check that none reads `matches` or `ledger`; the
  ledger invariant; the `mod_actions` purge.
- Games `test-shell.js` 68 → 78: the panel markup, load order, the `play:view` hook, no polling, the
  only API paths used, badges via `textContent`.
- Pool `test-admin-panel.js` 142 → 153 (section [13]): the NAV group, all calls through the proxy
  prefix, create / update FAST and cancel / finalise step-up per the pool's own `requiresStepUp`, the
  401 split, delegated row buttons, no native dialogs, escaped rows, date inputs with the last day
  included.
- A one-shot headless-Edge probe over CDP (127.0.0.1 server serving the real shell under the real
  shell CSP header, stubbed `/play/api/`, Edge killed with its process tree after): 58/58 at 1280 and
  390 px, dark and light, signed in and out — 0 script errors and 0 CSP violations, no horizontal
  overflow, own row + "you" line, the week range, an event title of `<b>…<img onerror>` rendered as
  text in the list and the detail, provisional / final / scheduled detail states, the Reward column
  hidden until final. `games-events.html` was checked statically only (its inline script parses);
  it has not been opened in a browser.

Games `npm test`: **519 → 630 passed, 0 failed** (4 → 5 suites). Pool `npm test`: **2290 → 2301**,
exit 0.

**Owed on the VPS** (with checkpoint A): the Games → Events page through the real proxy (create,
edit, cancel with the step-up dialog, finalise now); one event from schedule to rewards on the live
activity sync (Part 13's list already has it); the boards and events through nginx in preview.

### As built vs the design (§19.15)

**Part 7 — leaderboards, events, the admin Events page (2026-09-28, not VPS-tested).** Games service:
NEW `play/server/lib/{leaderboard,events,admin,badges}.js` + `lib/events/`; the /play/ G-06 panel
(`play/shell/js/play-boards.js`); pool: NEW `admin-panel/games-events.html` + a NAV group, **no
backend code**. As built in impl §10.13 *Leaderboards, events*. What changed against §19.3, §19.9, §19.11 and the plan:

1. **Modules beyond the plan's list.** `admin.js` is the games side of the admin proxy (every
   `/internal/admin/*` route goes through it; Parts 8–9 add theirs with `admin.add()`); `badges.js`
   holds the badge list; `events/_rules.js` the kind helpers; `events/index.js` the kind LIST.
   **Kinds are listed, not discovered:** the service never `require()`s a computed path
   (test-skeleton [h]), so a directory scan was refused. D17 still holds — a new kind is a module plus
   one line in `events/index.js`; `events.js` is not touched.
2. **The admin guard runs before the body is read** (a new route `guard` option in `http.js`), so a
   caller without the secret never gets 16 KB parsed — §19.3's "secret first" mirrored on this side.
   Order: `X-Forwarded-For` / `X-Real-IP` or a non-loopback peer → 404 (the pool's third guard,
   copied); secret → 503 `link_not_configured` / 401 `unauthorised`; `X-Admin-User` (printable
   ASCII, 1–64) → 400; `X-Admin-Stepup: 1` on every non-FAST write → 403 `step_up_required`. The
   secret is compared **inside** `pool-link.js` (`checkSecret` returns a verdict), so it never leaves
   that module. `FAST_WRITES` is copied verbatim from the pool, and `test-events.js` compares the two
   lists as text.
3. **Leaderboard parameters, exactly.** `board` = `points` (default) | `rating` | `wins`.
   `board=points` with no `game` is **points held** (`players.points`, so event rewards and
   `admin_adjust` count), all time only. `rating` needs a game with `pvp` and is all time only.
   `wins` / `points` with a game need `mode`; `period` = the CURRENT UTC day, ISO week (Monday–
   Sunday) or month, or `all` — there is no date parameter (past periods live on in events). An
   unknown or repeated parameter, or an unknown game, is 400 with `field`. Response:
   `{ board, game, mode, period, from, to, unit, computed_at, total, rows:[{ rank, name, value, games?, own? }], you }`.
4. **What is not ranked:** a zero value (a wins board of people with no wins is noise) and a banned
   address, on every board and in every event. The rank is the position after the §19.9 tie-break, so
   two equal values never share a rank. The 60 s cache also expires when the UTC day rolls over, and
   its key space is closed (a validated game × fixed enums), so requests cannot grow it.
5. **Rating and PvP boards are API-only until Part 10.** The shell offers points held plus wins and
   points against the bot; Part 10 adds the rating board and the `pvp` options when PvP ships.
6. **Event validation.** Windows are whole UTC days, at most 366 long, starting today or later and at
   most 366 days ahead (no backdated events). An event starting today is created `running`, not
   `scheduled`-then-flipped. The title is NFC, 1–60 chars, and a control, bidi-override/isolate or
   zero-width character **refuses** the save (not stripped: the operator should see why). Unknown
   keys anywhere are refused, as in every other games body.
7. **Rewards.** Up to 10 tiers, ranks 1–1000, in rank order and non-overlapping (so "the first tier
   holding the rank" is also the only one), 0–10 000 points each. **Participation gained an optional
   `badge`** (§19.9 edited): without it the "Took part" badge could not exist. A tier winner does not
   also get the participation reward. Badge ids: `gold`, `silver`, `bronze`, `top10`, `champion`,
   `marathon`, `regular`, `took_part`.
8. **Editing.** `scheduled`: every field. `running`: title, last day and rewards only — kind, rules
   and first day are what players are competing on (re-sending them unchanged is fine; the form posts
   every field). The last day may be moved earlier, but not to a day already over. Later states:
   409 `not_editable`.
9. **Finalise-now** (`POST events/:id/finalise`, step-up) needs the window to be over (409
   `not_ended`): it skips the 10-min grace and retries a stuck `finalising` event; it never ends a
   competition early. Cancel is `POST events/:id/cancel {reason?}` (step-up). `GET event-kinds` (kinds
   with their form fields, the badge list, the games, the limits) was added for the admin form.
10. **Exactly once, three guards:** the state flip `finalising → done` must change one row; the ledger
    ref `e:<id>` is unique per address (`uq_ledger_ref`); `event_results`' primary key refuses a
    second row. The test forces an event back to `finalising` and checks the re-finalise fails
    whole and pays nothing. A compute that throws leaves the event `finalising`; every 5-min tick
    retries it (20 per tick).
11. **Badges** are stored as `badges_json = [{ id, event }]`: one per event per address, at most 500
    per address (past that, the event's results still record it). `/me` gains
    `badges: [{ id, label, event_id }]`; the shell shows them on the account strip.
12. **Admin page.** Date inputs, not `datetime-local` (§19.11 edited): the window IS whole days, so a
    time field would show something that means nothing. The last day is inclusive and is sent as the
    next midnight. **Every proxied call uses `adminFetch`, not `API.*`:** `Auth.fetch` sends the
    admin to the login page on any 401, and the proxy passes the games service's own 401 (a
    link-secret mismatch) through. A 401 whose body has `ok: false` is shown as "rotate the link
    secret"; only the pool's own 401 (never carries `ok`) goes to login. **Part 9's games pages need
    the same.** NAV: a Games group between Dashboard and Settings, parent `games-events.html` until
    Part 9's `games.html` exists.
13. **Public visibility.** The list is every scheduled / running / finalising event plus done or
    cancelled ones that ended in the last 90 days (older ones stay readable by id). A cancelled event
    that never started was never shown as running, so it is hidden from the list AND the detail.
    Running standings are cached 60 s; the admin detail computes fresh (full addresses, ≤ 1 000), so an
    operator read neither sees nor pins a stale board.
14. **`mod_actions` retention is built here** (hourly, 365 days, §19.10) because this part writes the
    first rows; each admin write adds its row inside the write's own transaction. Part 8 need not add
    it. Jobs: `event_transitions` (5 m, registered after `activity_sync`), `mod_actions_purge` (1 h).
15. **Self-review (the plan's questions).** (a) *Can an event reward be paid twice?* No — #10, tested
    with a second tick, a direct call, a forced replay and a duplicate ledger ref. (b) *Can a cancelled
    event pay?* No: cancel and finalise both flip the state under the write lock, and finalise acts only
    on `finalising`; tested for a cancel after the window ended and a cancel from `finalising`.
    (c) *Does any leaderboard query scan `matches`?* No: every board and kind reads `players`,
    `ratings`, `results_daily` or `activity_daily` on its index (`EXPLAIN`-tested), and a source
    check forbids `FROM matches|match_moves|ledger` in these modules. **For Part 11 (§19.13 #19):**
    `event_results` is kept forever — one row per ranked address per event, bounded by the addresses
    that mined or played in the window.

## Chat backend, moderation, and moderators (games service only)

**Status:** built 2026-09-28, not VPS-tested

Built on Parts 1–7 with nothing run on a box. Contract: design §19.10 + §19.11 + D9 + **D21 (new:
moderators)**; deltas: §19.15 *Part 8*. **No pool code changed** — the pool's `FAST_WRITES` already
names the four fast chat routes, and every new admin write is step-up by its fail-closed rule.

| File | What |
|---|---|
| `play/server/lib/chat.js` (NEW) | `GET /play/api/chat` (page, or `after` + `rev` + `epoch` → new messages + `changes`), `POST /play/api/chat`, `POST /play/api/chat/:id/report`; body normalisation, the hold rules (word list, links, Grin addresses, reports), the per-address (DB) and per-IP (memory) limits, the in-memory change log, the state helpers moderation uses (`remove` / `approve` / `restore` / `operatorPost`), hourly retention |
| `play/server/lib/moderation.js` (NEW) | the operator's routes under `/internal/admin/` (messages, reports, delete / approve / restore / post, word list, players + mute / unmute / ban / unban / purge / adjust, moderators, settings, mod log) and the moderators' `/play/api/mod/{queue, messages/:id/delete, …/approve, …/mute}` |
| `play/server/lib/db.js` | migration **v2**: `moderators`, `chat_words` (new tables only) |
| `play/server/lib/auth.js` | the recent-mining gate in `chatStatus` (reason `no_recent_mining`); `modStatus` → `/me.moderator` |
| `play/server/lib/settings.js` | nine chat / moderator keys; `setMany` (validate all, write in one transaction) and `meta` |
| `play/server/lib/app.js`, `http.js` | wiring, `GET /play/api/rules`, the `chat_retention` job; the new error messages |
| `play/server/scripts/test-chat.js` (NEW) | 171 checks: normalisation units, every gate and limit, holds, reports, the change feed, the operator routes + step-up, bans revoking sessions, purge, adjust, settings, moderators and every limit on them, retention, no full address in any public answer, `EXPLAIN` on every read |

**How a moderator is set up** (operator): Games → Chat & moderation → *Moderators* → paste the
helper's mining address → *Appoint* (asks for your password). Tell them to sign in to /play/ with their
**rig password** (not an IP) — by default the tools stay off for an IP sign-in — and to have mined
recently enough to chat. They then see a *Moderator queue* under the chat. To stop it: *Remove*, or ban
the address. What they did is in the moderation log as "Moderator grin1…".

Games `npm test`: **630 → 803 passed, 0 failed** (5 → 6 suites; `test-skeleton.js` +2 for the v1 → v2
upgrade, `test-auth.js` pins `chat_min_minutes` 0 where it tests the proof gate alone).

### As built vs the design (§19.15)

**Part 8 — chat backend + moderation, and moderators (2026-09-28, not VPS-tested).** Games service only:
NEW `play/server/lib/{chat,moderation}.js`, migration v2 in `lib/db.js`, the mining gate + `modStatus` in
`auth.js`, settings in `settings.js`, wiring in `app.js`; **no pool code**. As built in impl §10.13 *Chat backend*.
What changed against §19.4, §19.10, §19.11 and the plan:

1. **Schema v2 = migration 2, new tables only** (`moderators`, `chat_words`; §19.4's block edited in the
   same change, as Part 1 requires). No `ALTER`, so the stored text of every v1 table is unchanged. A DB
   left at v1 upgrades in place (tested). The word list is a table, not a setting: it is edited a word
   at a time and has its own bound (500 entries, 1–40 characters).
2. **Moderators (D21)** — the operator's question during this session; the whole feature is D21 plus
   the routes in §19.10 and the admin routes below.
3. **The change feed** (§19.10 edited). Without it, a scam message the operator deletes stays on every
   page that already drew it until a reload. The log is per process and bounded (1 000 entries); a poll
   with an unknown `epoch` or an out-of-range `rev` gets `reset: true` and a fresh page. A message
   approved or restored arrives in `changes.shown` if it is older than the client's `after`, and as an
   ordinary new message if it is newer, so it is delivered exactly once.
4. **Normalisation, refined.** Control characters (Cc) and line/paragraph separators become a **space**,
   not nothing, so a control between two words cannot glue them into one. Every format character (Cf)
   is removed through a Unicode property escape: that covers §19.10's list plus LRM/RLM, U+061C and the
   soft hyphen. Hangul fillers (letters that render as nothing) are removed. A run of more than 3
   combining marks is cut to 3 ("Zalgo"). The hold checks compare an NFKC-folded, lower-cased copy, so
   fullwidth `ｗｗｗ．` is caught; the stored body stays NFC.
5. **A Grin address is held with links** (under `chat_hold_links`): "send 5 GRIN to grin1…" is this
   chain's scam link.
6. **Limits.** Per address: the 5 s floor, `chat_posts_per_hour` (default 30, max 60), slow mode — all
   read from the DB, so they hold across restarts and every session of an address. Per IP: 60 an hour,
   in memory. Moderators skip slow mode only. The recent-mining gate comes **before** the proof wait in
   `chatStatus` (reason `no_recent_mining` + `mining: { have_minutes, need_minutes, days }`), because it
   is the one the player can act on; its window is today plus `chat_recent_days − 1` days before.
7. **Reports need a chat-capable session**, not just a session (§19.10 edited): 3 "distinct reporters"
   must be 3 aged, mining addresses, or one fresh proof per address could hide anyone. 20 reports an hour
   per reporter; operator and own messages are not reportable.
8. **Reading with chat off** answers `200 { enabled: false, messages: [] }`, not an error, so the page
   can show "closed" without treating it as an outage.
9. **Admin routes added** (all step-up by the fail-closed rule; `FAST_WRITES` unchanged): message
   restore, unmute, ban / unban, purge, `admin_adjust`, the word list, settings, moderator appoint /
   remove. Reads: messages by state or address, the report queue, players (one, or muted / banned /
   moderators), moderators, settings, the mod log. **Approve doubles as "keep"** for a visible,
   reported message: it resolves the reports and changes nothing else — no new fast route was needed.
10. **Ban** revokes every session at once (closes §19.15 *Part 4* #14), blocks login before the pool
    call, and ends a moderator appointment. An operator mute is set exactly (it may shorten one); a
    moderator's never shortens a mute already in place.
11. **Settings** (`lib/settings.js SPEC`): `chat_min_minutes` 60, `chat_recent_days` 7,
    `chat_posts_per_hour` 30, `chat_slow_seconds` 0, `chat_hold_links` true, `chat_report_threshold` 3,
    `chat_retention_days` 7, `chat_retention_max` 2000, `mod_requires_password` true. A save validates
    every key first and writes them in one transaction (a quoted `"false"` for a bool refuses the whole
    save). The floors are constants shown by the admin page, never settings.
12. **`GET /play/api/rules`** — the live plays, points and chat rules, nothing per player. Closes
    §19.15 *Part 6* #10.
13. **Jobs:** `chat_retention` (1 h, batched 5 000 rows a run, reports deleted before their message).
14. **Accepted, recorded:** the admin message list filtered by address pages approximately (the
    `before` filter applies after the address read's limit); the players lists scan `players`
    (admin-only, at most 200 rows returned).
15. **Self-review (the plan's questions).** (a) *Can a public request create an operator message?* No:
    `role` is not an input (a body carrying it is refused), the operator role is set only by
    `chat/post` behind the link secret, and the moderator badge is computed from the moderators table
    (tested). (b) *Can a muted user post from a second session?* No: `muted_until` is on `players`,
    joined into every session lookup, and the per-address limits count rows in the DB (tested with two
    sessions). (c) *What does a 1 000-client poll storm cost?* One bounded index range read per request
    (`EXPLAIN`-tested on `idx_chat_room` / `idx_chat_address` / the `activity_daily` key), a scan of the
    ≤ 1 000-entry change log in memory, and no write except the 5-minute session touch.

## The chat UI and the admin pages

**Status:** built 2026-09-28, not VPS-tested

| File | What |
|---|---|
| `play/shell/js/play-chat.js` (NEW) | the G-07 panel: polling with the change feed, textContent-only rows, Operator / Mod badges from `role`, the author's own held messages, Report, the gate sentence per reason, the moderator queue + Delete / Mute 1 h, the live rules in the "How plays are earned" fold |
| `play/shell/index.html`, `css/play.css` | the G-07 section (anti-scam line first), `#rule-*` spans in the fold, the script tag; chat styles on the theme tokens only |
| `play/shell/js/play-shell.js` | `announceMe()` → the `play:me` event on every `/me` render and on sign-out; the login path passes `moderator` through |
| `back-end-pool/admin-panel/games-admin.js` (NEW) | shared by the three pages: the proxy `call()` (Part 7's 401 rule), `el()` (textContent builder), the confirm dialog, address chips, the mod-log actor ("Moderator grin1…") |
| `back-end-pool/admin-panel/games.html` (NEW) | the Games NAV parent: links + the games-owned settings form built from the service's spec, the fixed floors listed |
| `back-end-pool/admin-panel/games-chat.html` (NEW) | tabs Held / Reports / Visible / Deleted / All with row actions; operator post; moderators; word list; moderation log |
| `back-end-pool/admin-panel/games-players.html` (NEW) | lookup (also `?address=`), Muted / Banned / Moderators lists, mute / unmute, ban / unban, delete recent messages, adjust plays or points, appoint / remove moderator; recent messages, matches, 14 days of activity |
| `back-end-pool/admin-panel/admin-shell.js` | NAV: Games → Overview & settings, Chat & moderation, Players, Events |
| tests | `test-shell.js` +12 (the panel, `play:me`, text-only rendering, API paths, polling, no native dialogs); `test-admin-panel.js` [14] +21 (proxy-only calls, no HTML sink, fast vs step-up paths against the pool's own `requiresStepUp`, NAV); Part 7's NAV pin loosened for the new parent |

**Verified locally:** a one-shot headless-Edge probe over CDP (127.0.0.1 server with the real shell under
the real `/play/` CSP header, stubbed `/play/api/`, Edge killed with its tree after; the script lived in
the session scratchpad only): **58/58** at 1280 and 390 px, dark and light, signed out and as a
moderator — 0 CSP violations, 0 console errors, no horizontal overflow; an `<img onerror>` body, a
`<script>` post and a `<b>` report reason all rendered as text with no element created; badges, the held
flag, the Report / Delete placement, the moderator queue, the live rules, a post appended once across the
next poll. The three admin pages were checked **statically only** (their scripts parse, the test rules
above); they have not been opened in a browser.

Games `npm test`: **803 → 815 passed, 0 failed**. Pool `npm test`: **2301 → 2322**, exit 0.

**Owed on the VPS** (with checkpoint A, in `preview` with `chat_enabled` on): post / hold / report /
approve / delete from the admin panel and see it leave an open /play/ page within one poll; mute and ban
(sessions signed out); appoint a moderator, act from /play/ with a password sign-in, and confirm the IP
sign-in is refused; the three admin pages through the real proxy, including every step-up dialog.

### As built vs the design (§19.15)

**Part 9 — the chat UI and the admin pages (2026-09-28, not VPS-tested).** NEW
`play/shell/js/play-chat.js` + the G-07 panel in `shell/index.html` + chat styles; one hunk in
`play-shell.js`; pool admin: NEW `games.html`, `games-chat.html`, `games-players.html`,
`games-admin.js`, the NAV group in `admin-shell.js`. **No pool backend code.** As built in impl §10.13
*Part 9*. What changed against §19.10, §19.11 and the plan:

1. **`play:me`.** `play-shell.js` announces every rendered `/me` (and `null` on sign-out) as a DOM
   event, the same pattern as Part 7's `play:view`; the chat panel follows it, so the shell never has
   to know the panel exists.
2. **Polling:** 4 s signed in and visible, 15 s signed out (reading is public, §19.10), 30 s while the
   tab is hidden, 60 s while chat is closed; `setTimeout`, one request in flight. "Stop on logout" in the
   plan became "reset on logout": the panel keeps showing the public room.
3. **Rendering:** every message node is built with `createElement` + `textContent`; no `<a>` is ever
   created, so a link is inert text. The badges come from `role`. The panel says a masked name can be
   imitated and only the Operator badge is proof (§19.13 #10). Report and the moderator buttons are
   two-click in-page confirms, as everywhere on /play/.
4. **Moderators in the shell (D21):** a "Moderator queue" fold for an appointed address, plus Delete and
   Mute 1 h on ordinary players' messages; the server re-checks everything.
5. **Live rules:** the "How plays are earned" fold now shows the live settings from `/play/api/rules`
   (the HTML keeps the defaults for a failed fetch), plus a chat line.
6. **Admin text rule.** §19.10 says chat bodies are never `innerHTML` on the admin pages either. The pool
   panel's `AdminTable` renders rows from HTML strings, so these pages build every row that carries
   player or moderator text (bodies, report reasons, mod-log details) with DOM calls through
   `games-admin.js el()` and do not use `AdminTable`. `test-admin-panel.js` [14] fails on any HTML sink
   in the helper or the three page scripts.
7. **`games-admin.js`** carries the proxy call (with Part 7's 401 rule), the confirm dialog and the DOM
   builders for the three new pages. `games-events.html` keeps its own copy of `call()` (unchanged).
8. **`games.html` builds its form from the service's setting spec** (labels and groups on the page), so a
   key added later still gets a field. The proof age is shown in hours and stored in seconds.
9. **Match void** is not on the Players page: it arrives with PvP (Part 10), which owns `void`.
10. **Self-review.** (a) *Any path rendering a chat body as HTML?* No: shell — `play-chat.js` has no HTML
    sink (`test-shell.js`), and the probe planted `<img src=x onerror=…>` and `<script>` in bodies and a
    report reason: they showed as text, the handler never ran, no `<img>`/`<a>`/`<script>` element was
    created. Admin — no HTML sink in `games-admin.js` or the three page scripts (tested). (b) *Does the
    admin CSP stay unchanged?* Yes: the pages use only inline script, already allowed there, and no new
    origin. The probe ran the shell under the real `/play/` CSP header: 0 violations, 0 console errors,
    at 1280 and 390 px, dark and light, signed out and as a moderator.

## PvP correspondence chess + the "add a game" checklist

**Status:** built 2026-09-28, not VPS-tested

Built on Parts 1–9 with nothing run on a box (2026-09-28). Contract: design §19.6 + §19.8 + §19.9 + D20;
deltas: §19.15 *Part 10*. **No pool backend code** — match void is one more `/internal/admin/*` write,
step-up by the proxy's fail-closed rule; `FAST_WRITES` is unchanged. **No schema change** — PvP uses the
v1 columns (`target`, `draw_offer_by`, `rated`, `idx_matches_pair` …) Part 0 already put in §19.4.

| File | What |
|---|---|
| `play/server/lib/matches.js` | PvP create (seek = no target, challenge = a full target address) with the open / active caps; `accept` / `decline` / `cancel`; `draw` (offer / accept / decline — an offer meeting the other side's accepts, a move clears one); `abort` (ply < 2, both refunded); a PvP resign at ply < 2 becomes an abort; the 72 h seek/challenge expiry on `turn_deadline` (lazy + the sweep, now per state); the rated rule at settle + Elo; `GET /play/api/lobby`, `GET /play/api/matches/turns`; `actions` / `open_seat` / `invited` / `target_label` / `rated` / `draw_offer_by` / `expires_at` on every view; admin `POST matches/:id/void` |
| `play/server/lib/ratings.js` (NEW) | Elo K = 24 from 1200, integer and zero-sum; `apply` at settle, `recompute(game)` after a void |
| `play/server/lib/settings.js` | `pvp_play_cost` 1, `pvp_active_max` 10, `pvp_open_max` 5, `pair_rated_daily` 3 |
| `play/server/lib/app.js`, `http.js`, `moderation.js` | admin built before matches (void registers through it); `/play/api/rules` gains the PvP numbers; ten error messages; the admin player view's match list carries `rated` + `ply` |
| `play/shell/js/play-lobby.js` (NEW) | the G-08 "Play a person" panel: post a seek or challenge (game / colour / time per move from the manifest), open seeks, challenges for you, Accept / Decline / Cancel as two-click buttons; talks to the shell only through `play:open` / `play:changed` / `play:me` / `play:turns` |
| `play/shell/js/play-shell.js` | board buttons shown from the view's `actions`; open-seek / challenge / draw-offer status lines; the board poll (5 s, visible, opponent to move, `since_ply`) and the turns poll (15 s / 60 s) with the "N to move" badge; seek / challenge rows in My games; a Game picker on the bot form (hidden while one game offers bot play) |
| `play/shell/js/play-boards.js` | rating, PvP wins and PvP points boards per game with a `pvp` mode |
| `play/shell/js/frame-host.js` | an empty seat's label is "Open seat" |
| `play/shell/index.html`, `css/play.css` | the G-08 panel, eight board buttons, the My games badge, the PvP lines in the fold, the script tag |
| `back-end-pool/admin-panel/games-players.html` | a Void button per voidable match (step-up, confirm with reason), the rated flag |
| `back-end-pool/admin-panel/games.html` | a "Games between players (PvP)" group for the four new settings |
| `play/README.md` | the layout table brought up to date + the **"Add a game" checklist** |
| tests | NEW `test-pvp.js` (90); `test-shell.js` +13 (the lobby panel, its API paths, body-only target, no polling, the event contract, every action button, both polls, since_ply, the PvP boards); `test-matches.js` one check replaced (PvP is no longer refused) |

**The void, for an operator** (Games → Players → look the address up → Matches → *Void*): an active game
ends without a result and every seat gets its play back; an open seek or challenge closes and its creator
gets the play back; a finished game keeps its result on record but loses the points it paid (taken back
with `admin_void` rows, never below 0), leaves `results_daily`, and — if it was rated — every rating in
that game is recomputed without it. Event rewards already paid are not clawed back (as a `done` event's
cancel). Aborted / declined / expired / void matches answer 409 `not_voidable`.

**Verified locally:** a one-shot headless-Edge probe (127.0.0.1 stub server, the real shell and chess
frame under the real `/play/` and frame CSP headers, stubbed `/play/api/`, the server closed and Edge
gone after — the script lived in the session scratchpad only): signed in on an active PvP game with the
opponent's draw offer and on the player's own open seek — 0 page console errors, 0 CSP violations; the
board showed exactly Accept draw / Decline draw / Abort, then exactly Cancel seek; the "1 to move" badge,
the live PvP cost and pair cap in the fold and the form hint; an `<img onerror>` seek name rendered as
text with no element created; at 390 px (the iframe probe) every panel fits with no horizontal overflow.
Dark theme only; the admin pages were checked **statically only** (their scripts parse, the pool tests).

Games `npm test`: **815 → 918 passed, 0 failed** (6 → 7 suites). Pool `npm test`: **2322/2322**, exit 0 (no pool test added: the void is a proxied step-up write the existing `test-admin-panel.js` rules already cover).

**Owed on the VPS** (Part 13): one PvP correspondence game between two addresses (one IP-proof, one
password-proof) with a draw offer, a decline and an accept; a timeout; a seek that expires and refunds;
a challenge declined; the pair cap on a 4th game the same UTC day; the rating board after 5 rated games;
a void of a finished rated game from the admin panel (step-up dialog), with the points and the rating
seen to change back.

### As built vs the design (§19.15)

**Part 10 — PvP correspondence chess + the "add a game" checklist (2026-09-28, not VPS-tested).** Games
service: `play/server/lib/matches.js` (PvP), NEW `lib/ratings.js`, four settings; shell: NEW
`play/shell/js/play-lobby.js` + the G-08 panel, the board in `play-shell.js`, PvP boards in `play-boards.js`;
pool admin: the Void button on `games-players.html`, a PvP group on `games.html`; **no pool backend code and
no schema change**. As built in impl §10.13 *PvP correspondence chess*. What changed against §19.4, §19.6, §19.8, §19.9,
§19.11 and the plan:

0. **Scope question, recorded.** The operator opened this session asking for "Grin 2048 (a skill game, the
   server replays the moves), proving a new game needs no platform code". That contradicts D20 (2048 dropped
   from v1) and §19.8 (the `skill` kind is reserved and is built WITH its first game: migration 3 `rounds`,
   a registry kind, round routes, a score board) — so a 2048 folder cannot prove "no platform code". Asked;
   the operator chose to run Part 10 as planned. The "add a game" checklist in `play/README.md` now says
   exactly this: a new `match` game is one folder; a `skill`/`chance` game is a design + build session first.
1. **No schema change.** PvP uses the v1 columns Part 0 designed in. A PvP `params_json` is
   `{ move_seconds, colour, cost }` (no `bot_level`); `target` stays set after acceptance. `reason` gains the
   values `cancelled`, `declined`, `expired`, `abort`, `agreement` and `void` (the column is free text; §19.4's
   comment lists the common ones and is left alone because the block is test-bound).
2. **A seek/challenge's `turn_deadline` is its 72 h expiry.** One index (`idx_matches_state`) and one sweep
   cover move clocks and expiries; the sweep now walks each of `active`, `seek`, `challenge` with its own
   batch. Lazy expiry: any write on an open match (accept / decline / cancel) finalises it first and answers
   409 `expired`; the lobby and turns reads are read-only and just filter past deadlines out.
3. **Rated also gates `results_daily`.** An unrated PvP result writes no points, no rating AND no
   `results_daily` row, so a pair past `pair_rated_daily` cannot farm the wins boards or a `game_results`
   event either (the plan's self-review c). The match row keeps the full history. `pair_rated_daily` 0 = no
   PvP match is rated.
4. **A PvP resign at `ply < 2` is an abort** (both refunded, no result) — a result at ply 0 would hand over
   a rated win without a game. `POST /abort` itself answers 409 `too_late` from ply 2.
5. **Draws.** Offering while the opponent's offer stands accepts it (a draw by `agreement`). A move by
   either side clears an offer (§19.8 step 5 — also the offerer's own move). Draw actions share the move
   limiter (burst 3, 1/s per address), which bounds offer spam.
6. **Caps.** The open cap counts on the seat indexes (a creator always holds a seat). The active cap is
   checked at create AND for both sides at accept: a full acceptor → 409 `too_many_matches`, a full creator
   → 409 `opponent_busy`. The caller's own lapsed matches are finalised first (creator at create, acceptor
   at accept), so a dead game never counts. A challenge target is shape-checked only (this network's
   prefix, not the challenger's own address → 400 `self_match`) — never looked up: a "banned" or "unknown"
   answer would be an oracle on other addresses. A challenge to an address that never plays expires and
   refunds.
7. **Shapes for the shell.** Every view and summary gains `actions` (what THIS viewer may do next),
   `open_seat`, `invited`, `target_label` (the target MASKED, and only to the challenger and the target),
   `expires_at`, `rated`, `draw_offer_by`. `GET /play/api/lobby` → `{ seeks, challenges }`, rows
   `{ id, game_id, name (masked), you_play, move_seconds, created_at, expires_at, own }`, no query
   parameters; `GET /play/api/matches/turns` → `{ your_turn, active, draw_offers, challenges,
   last_move_at }`. New error codes: `self_match` 400, `not_invited` 403, `not_open` 409, `expired` 409,
   `too_many_open` 409, `too_many_matches` 409, `opponent_busy` 409, `no_draw_offer` 409, `too_late` 409,
   `not_voidable` 409.
8. **Query plans.** The incoming-challenge reads name their index (`INDEXED BY idx_matches_target`, then
   `ORDER BY id DESC`, no sort): with no table statistics the planner chose `idx_matches_state`, which walks
   every open challenge in the pool to find one address's. `INDEXED BY` also fails the prepare loudly if the
   index is ever dropped. The lobby orders by `turn_deadline DESC` (= newest, with no sort). All `EXPLAIN`-tested.
9. **Ratings** (`lib/ratings.js`) are zero-sum by construction (seat 2 moves by the negation of seat 1's
   rounded change). `recompute(game)` replays finished, rated, non-void matches in `(finished_at, id)` order
   and lands on the incremental result (tested), with one recorded exception: two rated matches of one game
   that share a player and settle in the same second, the later-settled having the smaller id, replay in the
   other order — a point or two for those players; ratings are derived and never money.
10. **Void** (`POST /internal/admin/matches/:id/void {reason?}`, step-up by the fail-closed rule): active →
    `void` with every seat refunded; seek/challenge → `void` with the creator refunded; finished → `void`
    **keeping** its result and reason for the record, the points it paid reversed with `admin_void` rows
    (the amount credited, clamped to the current balance — the ledger refuses an overdraft), its
    `results_daily` counts removed, and the game's ratings recomputed if it was rated. Event rewards already
    paid are not clawed back (as cancelling a `done` event). One `mod_actions` row, action `match_void`,
    target `m:<id>`. Anything else → 409 `not_voidable`.
11. **Settings** (`lib/settings.js`): `pvp_play_cost` 1 (0–10), `pvp_active_max` 10 (1–50), `pvp_open_max`
    5 (1–20), `pair_rated_daily` 3 (0–20); `/play/api/rules` reports them. The move-time options stay
    manifest values (a game defines its own pace), so §19.11's "chess move-time options" setting was not
    built. PvP point values stay manifest values (§19.15 *Part 5* #3).
12. **Shell.** The lobby is its own file and talks to the page only through events (`play:open`,
    `play:changed`, and it listens to `play:me` / `play:turns`), as the boards and chat panels do. The board
    shows exactly the view's `actions`. Polls: the open board every 5 s while the opponent is to move (or
    one's own seek/challenge waits), visible tabs only, with `since_ply`; turns every 15 s visible / 60 s
    hidden, reloading My games only when its signature changes. **Both forms gained a Game picker, hidden
    while one game offers that mode** — without it the checklist's "a new game needs no shell change" was
    false (the forms took the first game). A public spectator page (Part 6 #12) was NOT added: the board is
    still signed-in only; the API serves spectators masked views, for Part 11 to weigh.
13. **Self-review (the plan's questions).** (a) *Can a player move in a match that has timed out?* No: the
    deadline check runs first for every action on an active match (move, resign, draw, abort), finalises it
    in that transaction and answers 409 `timeout`; a second try is 409 `not_active` (tested). (b) *Can a
    refund and a settle both happen for one match?* No: settle and abort/void both move a row out of
    `active` with `WHERE state = 'active'` that must change one row, open matches leave through `WHERE state
    IN ('seek','challenge')`, and every ledger row carries a unique `m:<id>:<seat>` ref — tested with a
    join (no seat has both a refund and points) and "no seat refunded more than it paid". (c) *Paid for a
    match against yourself or beyond the pair cap?* The same address is refused at create and at accept.
    Two addresses of one person cannot be told apart; what bounds it: both sides pay a play per game (from
    mining minutes), 3 rated games per pair per UTC day, `points_daily_cap` per address, and unrated games
    counting nowhere (#3). Resigning right after ply 2 to feed a partner is within those bounds — accepted,
    recorded. (d) *Engine assistance* is undetectable — accepted (D20); the "How plays are earned" fold now
    says so to players.

## Approved nicknames

**Status:** built 2026-09-28, not VPS-tested

The contract is design §19.16; the departures from the plan are §19.15 *Part 12*. No pool backend code:
the three admin writes are step-up by the existing `FAST_WRITES` rule, so the pool's admin proxy carries
them unchanged — this part ships with the games deploy (`P → 2`) plus the pool's static admin files.

| File | Change | Test |
|---|---|---|
| `play/server/lib/names.js` | NEW. The name rule, the request lifecycle, `label()` (the ONE public name: the mask or `Nick (mask)`), `meView` for `/me`, the admin queue + flags, `removeLiveOf` for a ban, the 180-day purge | `test-names.js` (NEW, 78) |
| `play/server/lib/db.js` | Migration **v3**: `nicknames` + three partial unique indexes + three indexes | `test-skeleton.js` (v1 → v3, v2 → v3, §19.4 == schema) |
| `play/server/lib/settings.js` | `nicknames_enabled` (bool, default on) | `test-names.js` (b, d) |
| `play/server/lib/auth.js` | `chatStatus(s, { ignoreChatSwitch })`; `/me` carries `nickname` | `test-names.js` (b) |
| `play/server/lib/{chat,leaderboard,events,matches}.js` | Every public name through `names.label` (fallback: the mask, so a module built without names behaves as before) | `test-names.js` (d, e) |
| `play/server/lib/moderation.js` | A ban removes the live nickname and refuses a pending one; the Players view carries `nickname` | `test-names.js` (c, d) |
| `play/server/lib/app.js` | Builds `names` before the modules that display names; routes; the hourly `nickname_purge` job | all suites |
| `play/shell/index.html`, `css/play.css`, NEW `js/play-names.js` | The Nickname fold in the account strip (state, "others see you as", pending / refused lines, the request form, withdraw / remove); the "How plays are earned" line on names | `test-shell.js` +9 |
| `back-end-pool/admin-panel/games-names.html` | NEW. Games → Nicknames: queue / Live / Rejected, approve / reject / remove (step-up), flags, text-only rendering | `test-admin-panel.js` [15] |
| `admin-panel/admin-shell.js`, `games.html`, `games-players.html`, `games-admin.js` | NAV entry; the page link + the switch's label; the nickname line on a player; three error texts | `test-admin-panel.js` [15] |

Games `npm test`: **921 → 1010 passed, 0 failed** (8 suites). Pool `npm test`: **2330 → 2341**, exit 0.
Mutation-checked: showing a nickname without its mask, removing the gate, and removing the approve-time
"taken" check each turn `test-names.js` red (the last is still refused by the unique index, as a 500).
**Not done:** no browser probe of the fold or of `games-names.html` (static checks only); nothing on a VPS.

**For the operator:**
- Nothing to install: the next `9) Deploy new code` (which ends with the games deploy) migrates the games DB
  to v3 on the service's restart. Nicknames are **on** by default; switch them off under Games → Overview &
  settings → Nicknames.
- Requests arrive in **Games → Nicknames**. Approve, reject (the reason is shown to the player on /play/)
  or remove; each asks for your admin password. A red "Same as a live name" flag means approve will be
  refused. A ban also ends the address's nickname; an unban does not bring it back.
- What players see: `Night Shift (grin1abcd…wxyz)` — the nickname never appears without the mask.

### As built vs the design (§19.15)

**Part 12 — approved nicknames (2026-09-28; not VPS-tested).** The contract is §19.16; these are the
places the build departs from the plan's one-paragraph prompt ("reuse §18.5 … display nickname + masked
suffix … admin queue"), and why.

1. **The display is composed on the SERVER, into the one `name` field.** `names.label(address)` returns the
   mask, or `Nick (grin1abcd…wxyz)`, and every public surface — chat, the three boards, event standings,
   the lobby, a match's seat labels and a challenge's target — calls it. No response carries a nickname
   without its mask, so no client can drop the mask (§19.13 #10: a mask costs ~2^40 key generations, a
   nickname nothing). The full 9…4 mask is kept rather than a shorter suffix: four characters would cost
   2^20. The shell never composes a name either (`test-shell.js` pins it).
2. **The rule is §18.5's, copied (D5: games never load pool code), with four changes.** 2–**20** characters,
   not 32 (a chat line and a board row have less room); **no dot** — a nickname sits beside chat, and
   `free-grin.io` as a name would be the scam link the chat's link hold exists to stop; **at least one
   letter**, not letter-or-digit; and two refusals before the queue: an **address-like** name (`grin1…` /
   `tgrin1…`, separators ignored, checked before the leet fold) and the **role words** `operator`, `admin`,
   `moderator` (leet + separators folded) — the words the page's own badges say.
3. **"No two live nicknames alike" is a database fact.** The matching form (lower-case, separators out,
   six leet digits folded — `donor-names.js normalise`, copied) is stored as `norm`, and `uq_nick_norm` is
   a partial unique index over the live rows. Submit and approve both check first (409 `nickname_taken`),
   and the index is the backstop a race cannot slip past (mutation-checked: with the approve check deleted
   the index still refuses, as a 500).
4. **The gate is the chat gate minus the chat switch.** `auth.chatStatus(s, { ignoreChatSwitch: true })`:
   an aged, non-anchor, recently-mining, unmuted session (and the password rule when it is on). The switch
   is ignored because nicknames show on the boards too, so closing chat must not freeze everyone's name.
5. **A games-owned switch `nicknames_enabled` (default on).** Off = no new requests AND every surface
   shows the bare mask; nothing is deleted, so on brings the approved names back. It is in `SPEC`, so
   `games.html` shows it (its own group, "Nicknames").
6. **Every admin write is STEP-UP; `FAST_WRITES` is unchanged, so there is no pool backend change.** The
   three writes are not in the fast list, so the pool asks for the password — the same as its own donor
   queue (§18.6 `freshAdmin`). Moderators (D21) have no nickname powers.
7. **A ban ends the nickname** (and refuses a pending one), inside the ban's own transaction; the ban's
   `mod_actions` row names it. An unban does not restore it: the player asks again and it is reviewed again.
8. **Bounds.** 5 submissions per address per 24 h, counted from the table (a restart does not reset it);
   one pending + one live per address (partial unique indexes); decided rows (`rejected` / `replaced` /
   `withdrawn` / `removed`) are purged after 180 days by an hourly job (`nickname_purge`) — §19.13 #19.
9. **Schema v3** (§19.4): one table, five indexes, no `ALTER` — the v1/v2 `CREATE` text is unchanged.
   `test-skeleton.js` compares §19.4 with the migration, and upgrades a v1 and a v2 DB in place.
10. **The pending text is shown to its author only.** `/me` is session-bound, so unlike the pool's account
    page (public to anyone holding the address, §18.6) it can show the pending name back. It never reaches
    any other response (`test-names.js` scans every public response for it).
11. **Verified:** games `npm test` 921 → 1010 (NEW `test-names.js` 78; `test-skeleton.js` +2, the v2 → v3 upgrade;
    `test-shell.js` +9: six for the fold and the three per-file checks on the new script), pool 2330 → 2341
    (`test-admin-panel.js` [15], +11). Three mutations each turned `test-names.js` red (nickname shown
    without its mask; the gate removed; the approve-time taken check removed). **Not done:** no browser
    probe of the fold or the admin page (both were checked statically only), and nothing ran on a VPS.
12. **Part 13 must:** submit a nickname from a password-proof session, approve it in the panel, and see
    `Nick (mask)` in chat, on a board and in the lobby; reject one with a reason and see it on /play/; ban a
    named test address and see the name gone.

## Operator code removed from the pool origin (option B)

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.1 D22 + threat note #22; the departures and findings are §19.15 *Part C1*.
Pool only — no games code, no schema change, no bash. Ships with the next `9) Deploy new code` (pool
restart + static files); nothing to migrate.

| File | Change | Test |
|---|---|---|
| `public_html/js/branding.js` | `custom_head_html` / `custom_body_html` render path and `cloneScript()` deleted; `GA_ID_RE` / `PLAUSIBLE_DOMAIN_RE` / `UMAMI_ID_RE` / `MATOMO_SITE_RE` + `httpsScriptUrl()` re-check every provider value before a loader builds its `<script>` | `test-branding-sinks.js` [6] [7]; `test-operator-code-sinks.js` [1] [2] |
| `public_html/js/ads.js` | The `code` renderer and `activateScripts()` deleted; `safeUrl()` (site path or http(s), never `//` / `/\`) gates every link and image | `test-operator-code-sinks.js` [5] |
| `public_html/js/public-shell.js` | Comment only: why exempt pages still get no ads | — |
| `back-end-pool/lib/ads.js` | `AD_TYPES` = banner, text; `code` refused on create/update naming D22; a legacy code row is delete-only; `SERVABLE` predicate in both `publicByPlacement()` and `recordEvents()`; `html_code` never written, selected or returned (`_adminRow()` → `removed: true`); `checkUrl()` on `link_url` / `image_url` | `test-operator-code-sinks.js` [3]; `test-admin-panel.js` [8] |
| `back-end-pool/lib/pool-settings.js` | Two keys out of `analytics` defaults and the branding payload; `RETIRED_KEYS` hides a stored row from `getSection()` and refuses a write; `ANALYTICS_PATTERNS` + `isHttpsScriptUrl()` in the validators (`plausible_domain`, `umami_website_id` gained one); `publishAnalytics()` re-checks on publish, including the legacy `seo.ga_tracking_id` fallback | `test-operator-code-sinks.js` [4]; `test-admin-guards.js` [4] |
| `back-end-pool/index.js` | The two keys out of `STEP_UP_SETTINGS_KEYS`; the ads-route comment | `test-admin-guards.js` [4] |
| `admin-panel/ads.html` | No Code option / snippet field / preview hint; a legacy code row shows "Unsupported (removed)", Delete only | `test-admin-panel.js` [8b] |
| `admin-panel/settings-analytics.html` | The custom-HTML textareas replaced by one line: "Custom HTML was removed for security — design §19.17 D22."; script URLs must be `https://` | `test-admin-panel.js` [8b] |
| `scripts/test-operator-code-sinks.js` | NEW (92): script/iframe creator allowlist keyed by function + guard, forbidden string-to-code idioms, the exact per-file `innerHTML` table, `lib/ads.js` + `lib/pool-settings.js` on a throwaway DB, `ads.js` in a DOM shim. Registered in `package.json` after `test-branding-sinks.js` | itself |

Pool `npm test`: **2536 → 2662 passed, 0 failed** (27 files). Mutation-checked against the four product files
at HEAD (18 and 49 failures, controls green). **Not done:** no browser probe of the two admin pages; nothing on
a VPS.

**For the operator:**
- **Settings → Analytics** no longer has the custom HTML boxes. Anything saved there before is kept in the
  database but is never used, never sent to the site and not shown in the panel. A site-verification tag that
  lived there must move — most providers also accept a DNS TXT record.
- **Ads**: banner and text only. An old code ad shows as *Unsupported (removed)*; it is not displayed — delete
  it. Ad links must be a site path (`/donate.html`) or a full `http(s)://` URL.
- Analytics script URLs must be `https://`. GA4, Plausible, Umami and Matomo all still work.
- ⚠ **Open, your call before the chat bubble (C7):** blog posts and pages are still raw HTML on the site
  (design §19.15 *Part C1* item 10).

### As built vs the design (§19.15)

**Part C1 — Option B: the operator-code sinks removed (2026-10-04; not VPS-tested).** The contract is
§19.17.1 D22 and threat note #22. Pool front + back end only; no games code changed. What the build added to,
or found beyond, the plan's prompt:

1. **Deleted as D22 says.** The `code` ad type (the renderer, `activateScripts()`, create/update, the admin
   option, field and preview hint) and `analytics.custom_head_html` / `custom_body_html` (the render path,
   `cloneScript()`, the defaults, the branding payload, the admin textareas, the two `STEP_UP_SETTINGS_KEYS`
   entries — removed because the keys are gone, not un-gated; the existing "every gated key exists in a real
   section" test would have failed had they stayed). Image and text ads are untouched.
2. **A stored legacy value is HIDDEN, not deleted — and the hiding is stricter than the prompt.** The prompt
   said "never sent to a browser"; threat note #22 says "never reaches a browser", which includes the admin
   panel. So `pool-settings.js RETIRED_KEYS` keeps the two keys out of `getSection()` (hence out of the admin
   GET, `getAll()` and the public payload), and `updateSection()` refuses a write to either with "Custom HTML
   was removed for security (design §19.17 D22)". A legacy code ad is excluded from serving AND counting by one
   shared `SERVABLE` predicate spliced into both `publicByPlacement()` and `recordEvents()` (audit §J14-9: the
   two must not drift); `html_code` is no longer written, selected for the public, or returned to the admin
   (`_adminRow()` strips it and adds `removed: true`); such a row can only be deleted — even switching it off is
   refused, because an edited dead row would read as a live ad. Rows stay in the DB: nothing reads them.
3. **Found: the GA id could break out of the GA4 init text.** `loadGa4()` spliced the id into a `<script>`'s
   text with only `'` stripped, so a trailing `\` escaped the closing quote (`gtag('config','G-ABC\',{…`).
   The write validator (`^G-[A-Z0-9]+$`) blocked that for `analytics.ga_tracking_id`, but the payload's legacy
   fallback `seo.ga_tracking_id` has no validator at all. Every provider value is now checked three times:
   on write (`pool-settings.js` validators), on publish (`publishAnalytics()` turns a non-matching stored
   value into `''`) and in the browser (`branding.js`, same patterns) — `GA_ID_RE`, a domain list for
   Plausible, a token for Umami, digits for the Matomo site id.
4. **Found: the provider script URLs accepted any scheme.** `plausible_src`, `umami_src` and `matomo_url` were
   checked with `new URL()`, which parses `javascript:` and `data:` happily; either would have become the
   `<script src>`. Now https only, with a host and no credentials (http would be mixed content anyway), on the
   same three layers.
5. **Found: ad URLs had no check at all.** `link_url` reached an `<a href>` and `image_url` an `<img src>` on
   every page, so a `javascript:` link was code on click — the same class D22 removes. `lib/ads.js checkUrl()`
   now refuses anything but `''`, `#`, a site path (`/x`, never `//host` or `/\host`, which a browser reads as
   another origin) or an http(s) URL without credentials; `ads.js safeUrl()` re-checks, so a legacy row's bad
   link renders as no link and a bad image draws no banner. All shipped seeds pass (tested).
6. **Matomo stays, though D22 names three providers.** The code had four loaders. Matomo is the same class as
   Plausible and Umami (an https script origin plus an ID), so it was kept and given the same patterns rather
   than deleted on a list the C0 text may simply have abbreviated. Deleting it is a few lines if the operator
   wants exactly three.
7. **Unchanged on purpose.** The credential-page guard (`isCredentialPage()`) still withholds the CSS sinks and
   the provider script on `login.html` and any `data-untrusted-html="exempt"` page; its comment now records
   that the script sink it was written for is gone. `public-shell.js` still mounts no ads on exempt pages — the
   reason changed (a banner from an operator-chosen origin is a visit beacon, and a sign-in page has no use for
   one), the behaviour did not. **CSP was not touched** (item 9).
8. **Self-review — every remaining hit in `public_html` + `play/shell`, justified** (all pinned by NEW
   `scripts/test-operator-code-sinks.js`, which fails on any new one):
   - `createElement('script')` — **7**: `branding.js` `injectStructuredData` (a JSON-LD data block, a
     non-executing type filled with `textContent`), `loadGa4` ×2, `loadPlausible`, `loadUmami`, `loadMatomo`
     (each guarded as items 3–4); `public-shell.js` `mount` (`/js/ads.js`, a fixed path). C7's bubble loader is
     the next expected entry. `createElement('iframe')` — **1**: `play/shell/js/frame-host.js` `create`, the game
     frame, `sandbox="allow-scripts"` without same-origin.
   - `insertAdjacentHTML`, `document.write`, `srcdoc`, `createContextualFragment`, `new Function`, `eval`, a
     string timer, `setAttribute('on…')` — **0**. `outerHTML` — **1**, inside vendored Quill
     (`public_html/js/vendor/quill.js`), which only the admin CMS editor loads; no public page loads it (pinned).
   - `innerHTML` — **94** assignments in 20 script units (the per-file table is pinned exactly): clearing or
     constant markup; templates whose every interpolated string passes `esc` / `escHtml` / `escapeText` /
     `attr` or is a number formatter; and `Explorer.link()`, which escapes. **Except two — item 10.** `play/shell`
     has none (pinned).
9. **CSP inventory (prompt step 5) — dropping `'unsafe-inline'` from the public `script-src` is FEASIBLE
   later, as a mechanical follow-up.** Today: `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com
   https://plausible.io https://cloud.umami.is` (`07_grin_mining_public_pool.sh`). What depends on
   `'unsafe-inline'`: **11 inline `<script>` blocks**, one each in 11 of the 13 public pages (account-settings,
   api-docs, blocks, blog, donate, fortune-board, login, miners-stats, page, payment-history, post); **11 inline
   handler attributes** in 4 pages (login 7, blog 2, donate 1, fortune-board 1); and **the GA4 init script** that
   `loadGa4()` builds with `textContent` — its text carries the page URL, so a hash cannot cover it; it needs a
   static `/js/ga-init.js` reading its values from a data attribute. No script template writes an inline handler,
   and the 5 JSON-LD blocks are data blocks that `script-src` does not govern. The `/play/` shell already runs
   without `'unsafe-inline'`. Noted in passing: the public `img-src` is `'self' data:` + Google, so an ad image on
   another origin is already refused by the browser — existing behaviour, not changed.
10. **⚠ OPEN — CMS page and post bodies are raw operator HTML on the origin, and D22 does not cover them.**
    `page.html` sets `page-body`.innerHTML to `json.data.html` (`lib/pages.js`) and `post.html` sets
    `post-body`.innerHTML to `p.body_html` (`lib/posts.js`, the Quill editor's output), both unsanitised, so an
    `<img onerror>` in a page or post runs on the origin for every visitor of it — exactly the class D22 deleted
    elsewhere. The writes are `secureAdmin` (no step-up), so a stolen admin session reaches it, the same
    escalation §J1-1 closed for custom HTML. It is worse after C7: both pages load `public-shell.js`, so the
    sign-in bubble will be on them, and a page body could read a guest password typed into it. Option B cannot
    delete these (they are the blog and the pages), so C1 records them, names them in the test (so a third raw
    sink cannot hide behind them), and stops. **For the operator, before C7 ships:** sanitise on render with a
    DOM allowlist (or a vendored sanitiser), move CMS bodies into a sandboxed frame, or restrict the editor to a
    markup subset rendered server-side. R1 cannot answer #22 "complete" while this stands.
11. **Verified:** pool `npm test` **2536 → 2662**, 0 failed (each file's own "N passed" line summed, 27 files;
    the per-file figures differ in method from earlier rows): NEW `test-operator-code-sinks.js` 92 (static
    allowlist + ratchet; `lib/ads.js` and `lib/pool-settings.js` against a throwaway DB; `ads.js` in a DOM shim);
    `test-branding-sinks.js` 25 → 47 (its control is now the GA4 loader; [6] a legacy payload injects nothing on
    three normal pages; [7] every loader refuses bad values, each with a passing control); `test-admin-panel.js`
    +10 ([8] the type predicate in both statements, [8b] the two admin pages); `test-admin-guards.js` +2 (the keys
    stay deleted). **Mutation-checked:** with the four product files reverted to HEAD, `test-branding-sinks.js`
    fails 18 and `test-operator-code-sinks.js` fails 49 (controls still pass). **Not done:** no browser probe of
    `ads.html` or `settings-analytics.html` (checked statically), nothing ran on a VPS.
12. **C9 must:** create a banner and a text ad and see both rotate; `POST /api/admin/ads` with `ad_type: "code"`
    → 400 naming D22; on a pool upgraded with a stored `custom_head_html`, confirm `/api/public/branding` has no
    such key and Settings → Analytics shows the one line; GA4 still records a page view, address scrubbed.

## The Community group, games default on, the launch state

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.2 + §19.17.8 (D30, D31); the departures and findings are §19.15 *Part C2*.
Games service + pool front/back end + the menu-P bash lib. No schema version change (the launch state is a
`meta` row). Ships with the pool's `9) Deploy new code` (pool restart + static files) **and** a games code
update from menu P (games restart); either order is safe — a pool that meets an older games build without
`launch` in its health reads preview (menu hidden), and an older pool ignores the field.

| File | Change | Test |
|---|---|---|
| `play/server/lib/mode.js` | `effectiveMode()`, `LAUNCH_STATES`; `createLaunchState()` (reads `meta.launch` live; `GET`/`POST /internal/admin/launch`, step-up, one `mod_actions` row per real change, idempotent); `withLaunch()` wraps the pool-mode cache; the cache's log line now says "the pool's games mode" | `test-launch.js` [a] [c] |
| `play/server/lib/app.js` | Admin router built first; `modeCache` handed to every consumer is the effective wrapper; health returns `launch`; `services.launch` | `test-launch.js` [b]; `test-skeleton.js` [e] |
| `play/server/lib/db.js` | v1's transaction also writes `meta.launch = 'preview'` (`ON CONFLICT DO NOTHING`) | `test-launch.js` [a] |
| `back-end-pool/lib/games-link.js` | `effectiveMode()` (copy; exported for the parity test); `probe.launch`; `publicFlag()` returns the effective mode; a launch flip calls `onHealthChange`; a 200 `POST launch` through the proxy fires one un-awaited `probeOnce()`; `status()` carries `launch` | `test-games-link.js` [8] [9]; `test-public-leakage.js` |
| `back-end-pool/lib/pool-settings.js` | `games` defaults `mode: 'on'`, `chat_enabled: true`; the comment gives D30's reasoning | `test-games-link.js` [7] |
| `public_html/js/public-shell.js` | `NAV`: `Community` (👥) holding Fortune Board, Contribute (`incentives`) and Play (`games`); `gateAttrs()` replaces `gamesAttrs()`; `groupAttrs()` marks a gated group `data-nav-gated` | `test-games-link.js` [13] |
| `public_html/js/branding.js` | `applyNavGroups()` after the two gates; comments | `test-games-link.js` [13] (behavioural matrix) |
| `admin-panel/games.html` | Launch card (badges, explanation, Go live / Back to preview, confirm dialog) | static only |
| `admin-panel/settings-games.html`, `settings-common.js` | Two-switch help text; *launch state* in the status line | static only |
| `scripts/lib/07_lib_pool_games.sh` | Post-install hint; P → 5 *Pool mode* + *Launch*; menu subtitle | `bash -n` |
| `play/server/scripts/test-launch.js` | NEW (50), picked up by `run-tests.js` | itself |

Pool `npm test`: **2662 → 2693 passed, 0 failed**. Games `npm test`: **1010 → 1060 passed, 0 failed** (9 suites).
Mutation-checked (14 pool failures, 1 games failure, all green restored). **Not done:** no browser render of the
header or the Overview card; nothing on a VPS.

**For the operator:**
- The menu now has a **Community** group: Fortune Board, Contribute and — once the games are live — Play. If
  incentives are off and the games are not live, the group is not shown at all.
- Games and chat are **on by default** in Settings → Games, but a new games install starts in **preview**:
  /play/ works by its direct link and nothing on the pool points to it. When you have tried it, go to
  **Games → Overview → Go live** (it asks for your password). **Back to preview** takes Play out of the menu
  again at once; nobody loses anything.
- If you saved Settings → Games before, your saved choice still applies — check it there.

### As built vs the design (§19.15)

**Part C2 — the Community header group, games default on, the launch state (2026-10-04; not VPS-tested).**
The contract is §19.17.2 (launch state, truth table), §19.17.8 (header group) and D30/D31. Pool front + back end,
games service, the admin panel and the menu-P bash lib. What the build added to, or found beyond, the prompt:

1. **The rule lives in two copies, and a test holds them together.** `effectiveMode(pool, launch)` is in
   `play/server/lib/mode.js` and, copied (D5: never a require), in `back-end-pool/lib/games-link.js`. Both read
   an unknown pool mode as `off` (own-property lookup, so `constructor`/`__proto__` cannot pass) and any launch
   value but the exact string `on` as `preview`. `test-games-link.js` runs both over a 9 × 9 input grid,
   junk included, and fails on any disagreement.
2. **Games side: a wrapper, not a rewrite.** `createLaunchState({ db, admin, poolMode })` reads `meta.launch`
   live on every call (one primary-key row — a restore or a second admin tab can never leave the process on a
   stale answer); `withLaunch(poolCache, launch)` gives every consumer the same `{ get, isOff }` it always used,
   now returning the effective mode, with `chat_enabled` forced false when effective is `off`. `app.js` builds
   the admin router first (the launch routes register on it) and hands the wrapper to auth, chat, the rules and
   `publicRoute()`. The raw cache stays reachable as `mode.pool()` for the Overview.
3. **What the launch state changes on the games side: nothing a player can see today.** The launch can only
   LOWER the pool's mode, never raise it; and the games service treats `preview` and `on` alike (both serve
   every public route — §19.1 D12's difference is the nav). So `publicRoute()` still 404s exactly on the pool's
   `off`. The state matters for the pool's nav now and the bubble (C7) later. Recorded so R1 does not look for a
   games-side preview behaviour that the design never asked for.
4. **A fresh DB writes `launch = preview` in the v1 migration's own transaction** (beside `created_at`; `ON
   CONFLICT DO NOTHING`). That is code next to a migration, not migration SQL, so the "SQL is never edited after
   it shipped" rule holds and the §19.4 schema contract is unchanged (no new table or column). An upgraded DB
   has no row and reads as preview — the same answer, so no migration was needed.
5. **Health gains `launch`, nothing else.** The plan's prompt said health should report "`launch` and the
   effective mode"; §19.17.2 (the contract) says health gains `launch` and the **pool computes the effective
   mode itself** — the pool's own setting is authoritative, while the games' cached copy of it can be ten
   minutes old. §19 wins: health is `{ ok, net, schema, launch, uptime_s }`. It is read in the same try as the
   schema version, so a DB that stopped answering is still a 503.
6. **Pool side: the probe records the launch, and a LAUNCH flip flushes the branding memo too.** `probe.launch`
   is `null` while unhealthy (the flag is off anyway) and is forgotten on a wrong-network answer.
   `onHealthChange` now fires on a health flip **or** a launch flip while healthy — the callback keeps its name
   (index.js wiring and its test are unchanged); its comment says it means "the flag may have moved". An
   unchanged answer flushes nothing (tested).
7. **Beyond the prompt: Go live shows in seconds, not at the next 60 s tick.** After the admin proxy relays a
   `POST launch` that games answered 200, it fires one `probeOnce()` — not awaited, so "no request handler awaits
   the probe" still holds (that test is unchanged and passes). A GET or a refused POST re-probes nothing.
8. **The admin routes.** `GET /internal/admin/launch` → `{ launch, pool_mode, pool_chat, effective }`;
   `POST /internal/admin/launch { state }` with exactly one key, `preview` | `on` (`off` is refused — it is the
   pool's switch), body ≤ 256 B. Step-up by the fail-closed rule on BOTH sides (no `FAST_WRITES` edit);
   one `mod_actions` row `launch` / target `launch` / `{ from, to }` per real change, inside the same
   transaction as the write; the same state again is 200 with `changed: false` and no row. The pool's step-up
   audit row (`games_admin`) comes from the proxy as for every step-up path.
9. **Admin UI.** Games → Overview gets a **Launch** card above *Pages*: three badges (*Players see*, *Launch
   state*, *Pool master switch*), one explanatory line for the four reachable combinations, and one button —
   **Go live** in preview, **Back to preview** once live — behind the in-page confirm dialog (copied from
   `games-chat.html`) and then the pool's step-up. Built with `G.el`/`textContent` only (the games-admin rule).
   Settings → Games: the mode help text now explains the two switches; its status line gains *launch state*
   (from `/api/admin/games-link`, which now carries `launch`).
10. **Pool defaults `games.mode = 'on'`, `chat_enabled = true`**, with the old "OFF on purpose" comment replaced by
    D30's reasoning. **A SAVED Settings → Games row still overrides the default** — `getSection()` layers stored
    rows over defaults, and a row exists as soon as the page has been saved once; tested ("a SAVED row overrides
    the default"). **C9 must check the live pool's stored row**: if the operator ever saved `off`, the default
    change does nothing there. *Restore Defaults* on that page now restores `on` + chat on.
11. **Header (§19.17.8).** `NAV`: the group is `Community` (👥 — the 🎁 was the prize pool's; it stays on the
    footer's Fortune Board link), children Fortune Board + Contribute (`incentives: true`) and Play
    (`games: true`); the standalone Play item is gone. Gates moved from the group to the children:
    `gateAttrs()` (was `gamesAttrs()`) writes `data-incentives` or hidden `data-games` on each link; a group with
    any gated child gets `data-nav-gated`, and starts hidden only if every child starts hidden. `branding.js`
    gains `applyNavGroups()`, run AFTER `applyIncentivesNav` + `applyGamesNav`: it shows a gated group while at
    least one of its links is shown and hides it otherwise — re-evaluated on every apply, not latched. Neither
    flag function touches the group any more. Side effect, wanted: Community is now the nav's **last** child, so
    the existing ≤ 640 px rule `.nav-group:last-child > .nav-dropdown { right: 0 }` opens it leftward on a phone.
    The active state needs no change: on `/play/`, `fileOf('/play/') === '/play/'`, so the group lights.
    Footer: Play stays in the Pool column with its `data-games` (Fortune Board + Contribute were already skipped
    there and live in the brand column with `data-incentives`).
12. **Menu P (bash, display only — no bash writes a pool setting).** The post-install hint now says a new games
    DB starts in preview and points at Go live; P → 5 Status labels the pool's value *Pool mode* and adds a
    *Launch* line parsed from the health answer it already fetched. `bash -n` clean.
13. **Self-review — every place that still reads the RAW pool mode, justified:**
    - `games-link.js handleConfig` → `/internal/games/config` sends the raw pool settings to games: by design,
      games combines them with its own launch state (§19.17.2).
    - `games-link.js status()` → `/api/admin/games-link` reports raw `mode` / `chat_enabled` **beside**
      `launch` and the effective `public_mode`: an admin view of both inputs.
    - `games-link.js publicFlag()` reads the raw setting only as the input to `effectiveMode()`.
    - `mode.js createModeCache` (the pool-mode cache): its transition log line now says "the pool's games
      mode" so a log reader does not take it for the effective one.
    - `mode.js createLaunchState view()` → the Overview's *Pool master switch* badge: an input, shown as one.
    - `menu P → 5 Status` prints the raw pool mode, now labelled *Pool mode*, beside *Launch*.
    Everything a visitor or player meets reads the effective mode: `/api/public/branding` (`cfg.games =
    publicFlag()`), `applyGamesNav`, and on the games side `publicRoute()`, `auth.chatStatus`, `chat.read` and
    `/play/api/rules` (all through the wrapper). `grep` found no other reader of `getSection('games')`.
14. **Verified:** pool `npm test` **2662 → 2693**, 0 failed — `test-games-link.js` 181 → 212 ([7] the new
    defaults + a saved row overriding them; [8] rewritten: no-`launch` health reads preview, the launch flip
    flushes branding, junk launch values, the whole truth table through the real `publicFlag()`, the two
    `effectiveMode` copies agree; [9] `POST launch` is step-up, re-probes once on 200, not on GET or 400; [13]
    the NAV shape plus a **behavioural** nav matrix — the real `NAV`, `gateAttrs`, `groupAttrs` from
    `public-shell.js` and the real `apply*` functions from `branding.js`, run on a small fake DOM over all six
    incentives × games rows, the pre-fetch state, and a hidden → shown re-apply); `test-public-leakage.js`'s
    `publicFlag` shape check accepts `{ mode, chat }` in shorthand. Games `npm test` **1010 → 1060**, 0 failed —
    NEW `scripts/test-launch.js` 50 (truth table, stored-value parsing, the wrapper, routes 404 only on effective
    off, health, the admin routes: step-up, strict body, audit, idempotence); `test-skeleton.js` health shape.
    **Mutation-checked:** reverting `publicFlag` to the raw mode and making `applyNavGroups` a no-op fails 14
    pool checks; handing the raw cache to the games consumers fails 1 games check (item 3 is why only one).
    **Not done:** no browser render of the header or of the Overview card (checked statically + the fake-DOM
    matrix), nothing ran on a VPS.
15. **C9 must:** on the live pool read the stored `games` row first (a saved `off` stays off); install/update
    games and see /play/ answer by URL while the header shows no Play; Go live → Play appears under Community
    within seconds on a fresh page load; Back to preview → it leaves; incentives off + games live → Community
    holds only Play; both off → no Community group at all; on a 390 px phone the group opens leftward.

## Names v2 — auto-checked nicknames, the pool's blocked-word list, schema v4

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.5 (D27, D28) + threat notes #24/#25; the departures and findings are §19.15
*Part C3*. Games service + the /play/ shell + pool back end + admin panel. **Games schema v3 → v4** (applied on
the first start of the new games build, in one transaction with its data step). Ships with the pool's
`9) Deploy new code` (pool restart + static files) **and** a games code update from menu P (games restart);
either order is safe — an older pool sends no name fields and the games keep their last copy (the seed always
applies), an older games build ignores the new fields.

| File | Change | Test |
|---|---|---|
| `play/server/lib/name-rule.js` | NEW, pure: shape (3–20 `[A-Za-z0-9]`, ≥ 1 letter), matching form, the Scunthorpe rule (≤ 4 whole on two forms, ≥ 5 substring minus `EXCEPTIONS`, `*`/`=`), `RESERVED` + the `guest` prefix + the pool name, `SEED`, `check()` → `{ code, list, entry }` | `test-names.js` [a] |
| `back-end-pool/lib/name-rule.js` | NEW, the same code (header differs) | `test-name-rule.js` [1] [2] |
| `play/server/scripts/fixtures/name-rule.json` | NEW, the ONE fixture both suites run | both |
| `play/server/lib/db.js` | Migration 4: `banned_names`; `players.nick_blocked/nick_changed_at/nick_refused_day/nick_refused_n`; `idx_players_nick_blocked`; a `run()` data step re-checking Part 12's rows; `migrate()` calls `m.run` inside the migration's transaction | `test-skeleton.js` [b] (incl. a v3 file) |
| `play/server/lib/names.js` | Rewritten: submit → live at once; gate (switch, block, chat bar minus the chat switch, cooldown); refusal cap on the players row; `name_not_allowed` / `name_unavailable`; admin list/search, remove, ban/unban name, block/unblock; `hit` on live rows; `updatePoolLists()` + persistence (`settings` key `pool_name_lists`); withdraw route removed | `test-names.js` [b]–[g] |
| `play/server/lib/settings.js` | `nickname_change_days` (7, 0–90) | `test-names.js` [b] |
| `play/server/lib/pool-link.js` | `config()` passes `blocked_words` / `pool_name` through, malformed → dropped | `test-names.js` [d] |
| `play/server/lib/mode.js`, `lib/app.js` | `createModeCache({ onConfig })` → `names.updatePoolLists` (a throw is caught); `createNames` gets `log` | `test-names.js` [d] |
| `play/server/lib/moderation.js` | `POST /play/api/mod/messages/:id/remove-name` | `test-names.js` [e] |
| `play/shell/index.html`, `js/play-names.js` | The fold: Set / Change, the cooldown line, generic refusal texts, who removed a name; no pending / withdraw | `test-shell.js` |
| `play/shell/js/play-chat.js` | **Remove name** (two-click) on a nicknamed author, in the chat row and the moderator queue | `test-shell.js` |
| `back-end-pool/lib/pool-settings.js` | `names` section, `blocked_words` default `''` + validator (fold, prefixes, dedupe, ≤ 500 × 32, refuse unmatchable lines) | `test-name-rule.js` [3]; `test-games-link.js` [7] |
| `back-end-pool/lib/games-link.js` | `/internal/games/config` + `blocked_words` (re-filtered, ≤ 500) + `pool_name`; omitted when unreadable | `test-games-link.js` [7] |
| `back-end-pool/index.js` | `names` added to `STEP_UP_SETTINGS_SECTIONS` | `test-name-rule.js` [3] |
| `admin-panel/settings-names.html`, `admin-shell.js` | NEW Settings → **Names** page (textarea + how matching works); nav entry after Games | `test-name-rule.js` [3] |
| `admin-panel/games-names.html` | Rewritten: Live / Removed / Banned names / Blocked players, search, Remove · Ban name · Block player · Unban · Unblock, "Now refused by …" hints | `test-admin-panel.js` [15] |
| `admin-panel/games-admin.js`, `games.html`, `games-players.html` | Error/field texts; the two nickname settings labelled; the Players card shows live + blocked | `test-admin-panel.js` [15] |
| `play/README.md`, `lib/auth.js`, `lib/chat.js` | Comments / the module list | — |

Pool `npm test`: **2693 → 2719 passed, 0 failed** (NEW `test-name-rule.js` 20). Games `npm test`: **1060 → 1111
passed, 0 failed** (9 suites). Mutation-checked (the code-identity and innocent-list checks both bite).
**Not done:** no browser render of the fold, the moderator button or the two admin pages; nothing on a VPS.

**For the operator:**
- Players now choose a nickname on /play/ and it shows **at once** — there is no queue to work any more. A name
  is 3–20 letters and digits; reserved words, a built-in slur list and your own words are refused with a plain
  "that nickname isn't allowed".
- Add your own words under **Settings → Names** (asks for your password). An entry of 4 letters or fewer only
  refuses a name that *is* that word; start it with `*` to refuse it anywhere in a name.
- Games → **Nicknames** lists live and removed names, banned names and blocked players. **Remove**, **Ban name**
  (every spelling of it, for everyone) and **Block player** each ask for your password. Your moderators can
  remove a name from /play/ (the **Remove name** button on a chat message), but cannot ban or block.
- A player can change their name once a week (Games → Overview & settings → *Nicknames*).

### As built vs the design (§19.15)

**Part C3 — names v2: auto-checked nicknames, the pool-owned blocked-word list, schema v4 (2026-10-04; not
VPS-tested).** The contract is §19.17.5 (D27, D28) and threat notes #24/#25. Games service, the /play/ shell, the
pool back end and the admin panel. What the build added to, or changed against, the contract and the prompt:

1. **One rule, two copies, one fixture — and a code-identity test on top.** `play/server/lib/name-rule.js` and
   `back-end-pool/lib/name-rule.js` are pure (no state, no I/O) and identical from `const NAME_MIN` down; only
   their headers differ. Both suites run every case of `play/server/scripts/fixtures/name-rule.json` (75 cases,
   40 innocent names, 40 adversarial — the contract's ten innocents among them; R1 adds its 30). The pool's
   `test-name-rule.js` also compares the two files' code **line for line** — a stronger check than the fixture,
   which only sees the inputs someone thought of. Mutation-checked: changing one constant in the pool copy fails
   3 pool checks; dropping `badminton` from the games copy's exceptions fails the games innocent list.
2. **The Scunthorpe rule, as built.** An entry of ≤ 4 characters matches the WHOLE name, tested on **two** forms:
   the name with leading/trailing digit runs stripped then folded (`Mod1` → `mod`), *and* the whole name folded
   (`A55` → `ass`). The contract named only the first; stripping first turns `A55` into `a` and `5hit` into
   `hit`, so a leading or trailing leet digit would have walked past every short word. Both forms are equality
   tests, so no innocent name pays for it. ≥ 5 characters match as a substring unless every occurrence sits
   inside an `EXCEPTIONS` word (matched as a substring too, so `prickl` covers prickly/prickle): `badminton`,
   `staffy`, `staffie`, `stafford`, `therapist`, `snigger`, `retardant`, `prickl`. `*` / `=` override.
3. **The seed.** `SEED` = the pool's `STARTER_BLOCKLIST` word for word (tested), with **`*fuck` and `*jizz`
   forced to substring**: no innocent name contains either, and whole-only would let `FuckYou` by. Every other
   ≤ 4-letter seed word stays whole-only on purpose — `shit` (Kshitij, Shitake), `cock` (Peacock, Hancock), `dick`
   (Dickens), `rape` (Grape), `anal` (Analyst), `coon` (Raccoon), `spic` (Spice), `pedo` (Torpedo). **Known,
   accepted limit for R1 to judge:** `ShitHead`, `DickFace` pass. The operator can add `*shit` and pay the
   false positives; the moderators can remove what slips through. The fold covers the contract's six leet
   digits only (no `8`→b, `vv`→w, `ph`→f).
4. **Shape keeps "at least one letter"** (Part 12's rule, not in §19.17.5's text): an all-digit name reads as a
   number on a leaderboard. `name_no_letter` is a shape refusal, so it explains itself. **Address-like is
   "starts with"** `grin1`/`tgrin1` as the contract says (Part 12 refused it anywhere in the name).
5. **Answers.** Shape: `400 name_length|name_charset|name_no_letter|name_invalid` + `hint`; address-like:
   `400 name_address` + `hint`; reserved / blocked: `400 name_not_allowed`, **no hint, byte-identical whatever
   the list** (tested); banned / taken: `409 name_unavailable` (the same body for both, tested); `409
   unchanged`; `403 nickname_refused { reason: cooldown | nick_blocked | <chat-gate reason>, available_at }`;
   `403 nicknames_off`; `429 too_many_refusals` + `Retry-After` to the next UTC midnight. `nickname_taken` and the
   withdraw route are gone. **Which refusals count toward the 10/day cap:** not-allowed and unavailable (the two
   that could probe a list). Shape and address refusals explain themselves and do not count; neither does a
   gate refusal. The cap is checked BEFORE the rule, so the 11th attempt is refused even for a good name, and
   the counter is written in its own transaction because the request is about to fail. The refused text is
   stored nowhere (tested).
6. **Order inside `submit`:** session → gate (switch, `nick_blocked`, the chat bar minus the chat switch,
   cooldown) → shape → `unchanged` → refusal cap → rule → banned → taken → one transaction (old live row →
   `replaced`, new row inserted as `approved`, `players.nick_changed_at = now`). A case change of your own name
   is a change (taken excludes your own address). A `UNIQUE` error from `uq_nick_norm` is answered
   `name_unavailable`; the handler is synchronous, so two simultaneous requests serialise and the second sees the
   first through the ordinary check — the index is the guarantee, the catch is the fallback, and only the
   index's refusal is tested directly.
7. **Cooldown** (`nickname_change_days`, games setting, default 7, 0–90): counted from the last OWN change. A
   removal by the player, an admin or a moderator does **not** reset it — a player whose name was removed waits
   out the rest of the week with the mask, which is also the brake on "set an offensive name, get it removed,
   set the next". Removing your own name needs only a session (allowed while muted, blocked or in cooldown).
8. **Moderator route — changed against the contract.** §19.17.5 sketched `POST /play/api/mod/nickname/remove
   { target }`. Built as **`POST /play/api/mod/messages/:id/remove-name { reason? }`**, keyed by a message like
   `mute`: a moderator never holds a full address (D21's views are masked), so a `target` address is something
   the UI could not even supply. Same protections as mute (operator message, another moderator, own message →
   403 `mod_protected`), same 120/h bucket, one `mod_actions` row `nickname_remove` as `mod:<address>`. The
   chat row and the moderator queue show **Remove name** only on a label that carries a nickname.
9. **Admin routes as built** (all via `admin.add`, all step-up — `FAST_WRITES` unchanged on both sides, tested
   on both): `GET nicknames?state=live|removed&q=` (q = a name fragment, folded, or an address start; `%`/`_`
   literal; ≤ 64), `POST nicknames/:id/remove`, `GET banned-names`, `POST banned-names {name, reason?}` (bans the
   matching form — anything folding to 1–32 of a–z 0–9 — and removes its holder in the same transaction),
   `POST banned-names/:norm/unban`, `GET nick-blocked`, `POST players/:addr/nick-block {reason?}` (creates the
   player row if needed, removes the live name), `POST players/:addr/nick-unblock`. Every live row carries
   **`hit`**: what the rule would answer today. A word added after a name went live is **hinted, never applied
   by itself** — removing a live name is a human decision; the admin page shows "Now refused by …".
10. **Schema v4 as built (§19.4 is the binding text):** `banned_names (norm PK, name, banned_at, banned_by,
    reason)` — `banned_by`, not the sketch's `by` (a keyword); players gains `nick_blocked` (CHECK 0/1),
    `nick_changed_at`, and **two columns the sketch did not have**, `nick_refused_day` + `nick_refused_n` (the
    refusal cap survives a restart, as Part 12's submit limit did), plus a partial index for the blocked list.
    The migration gained a **data step** (`run(raw, now)`, same transaction as its SQL): Part 12's rows are
    re-checked with the seed + reserved words + the chat word list (the pool's half is not known at migration
    time) — live failing → `removed` / `rule_v2`, pending passing and untaken → `approved` (an older live row →
    `replaced`), pending taken → `rejected` / **`taken`** (the contract named only `rule_v2`), pending failing →
    `rejected` / `rule_v2`; `decided_by = 'system'`. Tested on a hand-built v3 file.
11. **The pool's half of the lists (D28).** Pool: a new `names` settings section, `blocked_words` (empty
    default — the seed applies anyway), a textarea on the new **Settings → Names** page; the validator folds each
    line to the matching form, keeps `*`/`=`, drops duplicates, caps 500 × 32, and **refuses** (with the line
    number) an entry that can never match a name, rather than dropping it silently. The section is **step-up**:
    emptying it is how a stolen session would let offensive names go live unseen. `/internal/games/config`
    gains `blocked_words` (re-filtered on read, ≤ 500) and `pool_name` (`pool_info.pool_name`); an unreadable
    names section OMITS both rather than sending an empty list. Games: `pool-link.config()` passes them on
    (malformed → dropped, never fatal to the mode fetch); `createModeCache({ onConfig })` hands every
    successful answer to `names.updatePoolLists()`, which persists a change in the games `settings` table under
    `pool_name_lists` (outside `SPEC`, so the settings reader and the admin form never see it) and reloads it at
    boot. Old pool + new games: no fields → the games keep their copy. New pool + old games: extra fields ignored.
12. **Display unchanged** (`names.label`): `Nick (grin1abcd…wxyz)` or the mask. `/me`'s `nickname` lost
    `pending` and gained `can_remove`, `change_days` and `refused.by` (`pool` | `moderator` | `rule`).
13. **Not in this part:** guests (C5 — sign-up names, `Nick · guest`, the login-name uniqueness rule), donor
    names (C4 — the pool copy's `check()` is unused at runtime until then; only `matchForm` serves the
    validator), the `plays_balance_cap` 999 change (§19.17.9 lists it; it lands with the guest tickets).
14. **Self-review against #24/#25.** #24: the copies cannot drift unseen (fixture + code identity on the pool
    side, fixture on the games side); every uniqueness, ban and word check compares the matching form — `submit`
    uses the rule's `norm`, the ban route folds its input, `banned_names` and `uq_nick_norm` are keyed on it,
    and the v4 migration rewrites a passing pending row's `norm` from the rule. #25: the 40-name innocent list
    passes in both copies; what it cannot promise is item 3's limit, recorded rather than fixed.
15. **Verified:** games `npm test` **1060 → 1111**, 0 failed — `test-names.js` rewritten (81 → 117: [a] the
    fixture, Scunthorpe, entry parsing; [b] every gate, live at once, cooldown, the generic answers, the
    refusal cap; [c] lists, search, remove, ban across spellings, unban, block; [d] the pool lists applied,
    persisted, kept across a rebuild, and the real `pool-link` against a loopback "pool"; [e] the moderator
    route and its three refusals; [f] display, two simultaneous submits, the index, a player ban; [g] retention,
    query plans, the leakage scans); `test-skeleton.js` v4 + the v3 → v4 data migration (156 → 169);
    `test-shell.js` +2. Pool `npm test` **2693 → 2719**, 0 failed — NEW `test-name-rule.js` 20,
    `test-games-link.js` +4 (the config payload), `test-admin-panel.js` [15] rewritten (+2).
    **Not done:** no browser render of the Nickname fold, the moderator button or the admin pages; nothing ran
    on a VPS.
16. **C9 must:** set a nickname on /play/ and see it in chat at once; hit a seed word and a pool word (generic
    answer); add a word on Settings → Names and see it refuse within a minute, and the hint appear on Games →
    Nicknames for a live name it hits; ban a name and try two spellings; block and unblock a player; as a
    moderator, Remove name from a chat message; restart the games with the pool stopped and see the list kept.

## Donor names auto-checked

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.6 (D29); the departures and findings are §19.15 *Part C4*. Pool back end + admin
panel + two public pages, plus one option in the shared name rule (the games copy carries it so the copies stay
identical — no games behaviour changes). **No schema migration beyond one `CREATE TABLE IF NOT EXISTS`**
(`banned_donor_names`), and two idempotent start-up steps. Ships with the pool's `9) Deploy new code` (pool restart +
static files); the games copy ships with the next games code update and changes nothing a nickname gets.

| File | Change | Test |
|---|---|---|
| `back-end-pool/lib/name-rule.js`, `play/server/lib/name-rule.js` | `SHAPES` (`nick` default, `donor`), `DONOR_RESERVED`, `DONOR_RULE(_TEXT)`; `checkShape(raw, shape)`; `wholeForms` adds each separated word; `EXCEPTIONS` + cooperator / supporter / breadwinner; an unknown shape throws | `test-name-rule.js` [1] [2]; `test-names.js` [a] |
| `play/server/scripts/fixtures/name-rule.json` | `donor` context, 37 new cases (34 donor-shape, 3 nickname), `donor_innocent` (30), `donor_adversarial` (28) | both |
| `back-end-pool/lib/donor-profiles.js` | `validateName` → the rule's donor shape; NEW `nameRuleContext`, `namePrecheck`, `nameChangeAvailableAt`, `submitName` (live at once), `banName` / `unbanName` / `bannedNames`, `migratePendingNames`, `adminNames`; `adminQueue` `kind` filter, no flags, `id` fix; `profileFor` `name.change_available_at`; `audit()` takes a target type | `test-donor-profiles.js` [1] [3] [9] |
| `back-end-pool/lib/donor-names.js` | The matchers and `donorSettings().listText` removed; `STARTER_BLOCKLIST` kept as the record | `test-donor-names.js` |
| `back-end-pool/lib/pool-settings.js` | `incentives.donor_name_blocklist` default + validator removed, added to `RETIRED_KEYS`; NEW `retireDonorNameBlocklist()` (the one-time carry into `names.blocked_words`) | `test-donor-names.js` (carry block) |
| `back-end-pool/lib/db.js` | `banned_donor_names (norm PK, name, banned_at, banned_by, reason)` | `test-donor-profiles.js` [3] |
| `back-end-pool/index.js` | `donorNameRule()`; start-up carry-over → pending-name migration (logged, never fatal); the name route (precheck → proofs → submit, new refusal codes, `status: 'approved'`); `?kind=` on the queue read; NEW `GET /api/admin/donors/names`, `GET` + `POST /api/admin/donors/banned-names`, `POST …/:norm/unban`; four `API_DOC_META` rows | `test-donor-profiles.js` [8]; `test-public-leakage.js` §9 |
| `admin-panel/donors.html` | Banner review queue (no Flags), NEW Donor names section (Live / Removed / Banned, Remove · Ban · Block, Ban-a-name form, hints), flag-word textarea removed | `test-admin-panel.js` [9] |
| `admin-panel/settings-names.html`, `index.html`, `admin-shell.js` | Names copy covers donor names + both reserved lists; "Donor Banners (to review)"; badge title | `test-admin-panel.js` |
| `public_html/donate.html`, `public_html/account-settings.html` | D-01b / D-03 / expiry copy; P-09 lead, buttons, next-change line, success line, demo profile | `test-public-leakage.js` §9; `test-donor-profiles.js` (page block) |

Pool `npm test`: **2719 → 2795 passed, 0 failed** (28 suites). Games `npm test`: **1111 → 1114 passed, 0 failed**.
Mutation-checked (the copy-identity and the donor-innocent checks both bite). **Not done:** no browser render of the
Donor names section or the two public panels; nothing on a VPS.

**For the operator:**
- A donor's **name now shows at once** if it passes the automatic check — the same blocked-word list as game
  nicknames (Settings → Names), the reserved words, no address-like name, and no name another donor already uses in
  any spelling. A donor can change it once a week. **Banners still wait for you** in the Banner review queue.
- Donors → **Donor names** lists every live name. **Remove** (your reason is shown to the donor), **Ban name** (every
  spelling, everyone who holds it), **Block** (no more names or banners from that address). A *Now refused by …* hint
  means a word you added later would refuse that name today; it stays live until you remove it.
- Your old **flag words** moved to Settings → Names on the first start of this version (the start log says how many).
  Words of 4 letters or fewer now refuse only a whole name or a whole word of it; prefix one with `*` to match it
  anywhere.
- Names that were waiting for review when you upgraded were checked automatically on that first start; a refused one
  shows its donor a plain reason.

### As built vs the design (§19.15)

**Part C4 — donor names auto-checked (2026-10-04; not VPS-tested).** The contract is §19.17.6 (D29). Pool only,
plus one option in the shared rule that the games copy carries so the two stay one code. Banners are untouched. What
the build added to, or changed against, the contract and the prompt:

1. **The donor shape is an OPTION of the shared rule** (the C3 note said so): `check(name, { shape: 'donor' })` = §18.5's
   set (2–32 of `A–Z a–z 0–9 space - _ . & '`, ≥ 1 letter or digit, ASCII whitespace collapsed) + §16.4's reserved
   words (`DONOR_RESERVED`: admin, official, operator, support, staff, pool, grinium, prize, jackpot, winner; no `guest`
   prefix). The matching form, the Scunthorpe rule, the seed and the operator's list are the nickname's. Both copies
   stay identical (`test-name-rule.js` [2]); an unknown shape THROWS rather than fall back to the looser one.
   `donor-profiles.validateName` now takes its shape from the rule (one definition), so a `null`/`undefined` name
   answers `name_invalid` (it was `name_length`). The fixture gained 37 cases (34 with the donor shape), 30 donor innocents and 28
   donor adversarials; both suites run them.
2. **Departure R1 must judge — a separated WORD counts as "whole".** For a name with separators (only donor names have
   any), `wholeForms` adds each word's two forms, so a ≤ 4-character entry also matches one word of the name:
   `Big Ass Rigs`, `Moon Boys`, `Acme Pool Fans` refuse; `Classic Rigs`, `BobsPool` pass. The contract says "the
   whole name"; a word boundary the donor drew is the name's own, so an equal word IS the word. No nickname verdict
   changes (a nickname has no separators). **Known, accepted limit:** `Moby Dick` refuses (a short seed word as a
   separate, innocent word) — in the fixture, labelled.
3. **Three EXCEPTIONS added (both copies): `cooperator`, `supporter`, `breadwinner`.** `operator`, `support` and
   `winner` are ≥ 5 letters, so substring-matched: without them `Grin Supporters` and `Cooperator` refused. The
   nickname rule gains the same three (fixture cases).
4. **Order — what runs before the proofs and what after.** Before (cheap, reads no list): donations off → account →
   blocked → not a donor → shape → `409 unchanged` → the 7-day limit (`429 name_cooldown` + `available_at`) →
   `400 name_address`. After both proofs: reserved / pool name / seed / `names.blocked_words` → `400 name_not_allowed`;
   banned or taken → `409 name_unavailable` (one body for both). §18.11 Part 2 #4 put the input before the proofs so a
   typo never spends a proof attempt — still true for every refusal that explains itself — but a word-list answer
   before the proofs would let anyone holding the (public) address probe the operator's list. The owner can probe it
   at the `withdraw` rate; there is **no 10/day refusal cap** as the games have, because every probe costs both aged
   proofs. Recorded for R1.
5. **Live at once, one transaction:** gate → the precheck again (the proof check awaits in between) → rule → banned →
   taken → a pre-C4 pending name (if any) and the previous approved → `replaced` → INSERT `approved` (`decided_by`
   NULL = the automatic check, `decided_at = submitted_at`). The route answers `status: 'approved'`.
   `uq_donor_req_approved` stays the race guard; a real constraint hit is `conflict` (tested with a trigger). A refused
   name is stored nowhere: the owner-proof audit row records the proof as ok with `refused: <code>` — never the text
   or the list.
6. **Taken** = another address's APPROVED name — expired included, it returns with the next donation — with the same
   matching form; a case change of your own name is a change. A scan of the approved name rows (one per donor), not an
   index: the matching form is the rule's JS, and a unique index on it would refuse the pre-C4 collisions the contract
   keeps.
7. **The 7-day limit** (`NAME_CHANGE_DAYS`, a code constant as the contract asks) counts from the newest own name row
   that was ever live or submitted (`approved` / `replaced` / `removed`). An admin removal keeps that row's
   `submitted_at`, so it does not reset the clock (as the games' cooldown, §19.15 *Part C3* #7). `unchanged` spends
   nothing. `donor_profile.name.change_available_at` (null = now) is new on `/api/account/:addr`.
8. **Ban table — `banned_donor_names (norm PK, name, banned_at, banned_by, reason)`, the pool's own, not one table
   with a scope column:** the pool has exactly one name namespace — game nicknames are banned in the games' DB (D5) —
   so a scope column would hold one value forever. A ban folds the admin's input (1–32 a–z 0–9), removes every live
   holder in the same transaction (the reason is shown to them) and writes ONE audit row (`donor_name_ban`, target
   `donor_name` / the form, holders listed). Unban restores nothing.
9. **Admin routes (new):** `GET /api/admin/donors/names?state=live|removed&q=` (secureAdmin; a live row carries `hit`
   — what the rule answers TODAY — plus `banned`, `same_as`, `blocked`, `approved_by`: a word added after a name went
   live is a HINT, never applied, as in C3), `GET /api/admin/donors/banned-names` (secureAdmin),
   `POST /api/admin/donors/banned-names {name, reason?}` and `POST …/banned-names/:norm/unban` (freshAdmin). Remove
   and block are the §18.6 routes. `GET /api/admin/donors/requests` gained `?kind=`; the page asks for banners.
10. **Admin page `donors.html`:** the **Banner review queue** (no Flags column — `adminQueue` no longer computes the
    §18 flag hints), a new **Donor names** section (Live / Removed / Banned, Remove · Ban name · Block, a Ban-a-name
    form, the hints), and the flag-word textarea gone (a line points at Settings → Names). Settings → Names, the
    Overview tile ("Donor Banners (to review)") and the nav-badge title follow.
11. **`donor_name_blocklist` retired** into `RETIRED_KEYS` (never read back; a write is refused with a pointer to
    Settings → Names). `PoolSettings.retireDonorNameBlocklist()` runs at every start: it reads the RAW row, keeps the
    entries that do not fold to a starter word, passes each through the names validator (one that can never match a
    name is skipped and logged; overflow past 500 is logged), and merges them in ONE transaction with the row's
    DELETE — the deletion is the "once" marker, so a word the operator later removes never returns. A carried entry
    gets the DEFAULT matching (v1 matched substrings only to flag a name for a human); the operator can add a `*`.
    `donor-names.js` lost `RESERVED`, `normalise`, `parseList`, `poolNameEntry`, `matchEntries`, `nameFlagContext`,
    `nameFlags` and `donorSettings().listText`; it keeps `STARTER_BLOCKLIST` as the record the carry-over and the
    SEED test read.
12. **Migration (startup, after the carry-over, idempotent):** each pending name, oldest first, through the same check
    minus the 7-day limit → `approved` by the system (the previous approved → `replaced`) or `rejected`. The reason
    stored is a sentence ("…did not pass" / "…is not available"), not the contract's `rule_v2` code: a reject reason
    is SHOWN on the account page. One system audit row per decision (`donor_name_auto_v2`). Approved names are kept;
    the list's `same_as` flags any pre-C4 collision. A failed run is logged and retried at the next start — mining
    does not wait for it.
13. **Fixed beside it:** `adminQueue` selected the approved rows without `id`, so in the Approved history view a row
    was shown as "replaces" itself.
14. **Copy:** donate D-01b (names checked at once, banners reviewed, the 7-day limit), the D-03 disclaimer and the
    expiry-0 line; the account P-09 panel (lead, "Set this name" / "Change the name", the next-change line, the
    success line, the demo profile); `API_DOC_META` for the name route, the DELETE route, `/api/account/:addr` and
    `/api/pool/donors`. **CMS defaults:** no seeded CMS page mentions donor-name review (searched), so no operator
    note is owed.
15. **Self-review (#24, #25, banners).** #24: the donor option is in both copies — mutation-checked: dropping `prize`
    from the games copy, and `supporter` from the pool copy, each fail the pool suite. #25: the 30 donor innocents
    pass; item 2's limit is recorded. Banners: `submit` / `insertPending` / `submitBanner` / `approve` / `reject` /
    `withdraw` / `removeLive` / `block` have no hunk in the diff, and a test asserts a banner still lands pending and
    reaches no public view.
16. **Verified:** pool `npm test` **2719 → 2795**, 0 failed (28 suites; the C4 checks sit in `test-donor-profiles.js`
    — names v2, bans, migration, the names list, route order —, `test-donor-names.js` — the carry-over; its matcher
    tests went with the code —, `test-name-rule.js`, `test-public-leakage.js` §9 and `test-admin-panel.js` [9]).
    Games `npm test` **1111 → 1114**, 0 failed. **Not done:** no browser render of the Donor names section, D-01b or
    P-09; nothing ran on a VPS.
17. **C9 must:** set a donor name and see it on the wall at once; try a seed word, a Settings → Names word and another
    donor's name in leet (one generic answer each); change it again inside 7 days (refused, with the date); ban it in
    another spelling (gone from the wall, the reason on the account page) and unban; on the live pool, find the
    carry-over line in the first start's log and the old flag words on Settings → Names.

## Guest accounts backend

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.3 / §19.17.4 (D24–D26, D32); the departures and the #26–#29 self-review are §19.15
*Part C5*. Games service + one nginx zone + the admin pages' player paths. **Schema v5** (one migration, one
transaction): `guests`, `guest_signups`, `players.kind` / `deleted_at` / `guest_day`, and a rebuild of `sessions` so
`proof_kind` accepts `'guest'` (copy out → drop → create → copy back). Ships with the games code update (`P → 3`, which
also rewrites the nginx snippet and adds the zone) and the pool's `9) Deploy new code` for the admin pages (static
files; no pool backend code).

| File | Change | Test |
|---|---|---|
| `play/server/lib/guests.js` (NEW) | `createPow` (stateless HMAC challenge, /24-bound, 5 min, single-use set, bits 14–26), `createScryptCap` (4 + 64), the pool's `v1$salt$hash` scrypt copied, `passwordProblem`; routes `GET /signup/challenge`, `POST /signup`, `POST /login/guest`, `POST /account/password`, `POST /account/delete`; admin `POST guests/:gid/delete`; `deleteGuest`, `idleSweep`, `meFor`, `adminFor` | `test-guests.js` [a]–[d] |
| `play/server/lib/tickets.js` (NEW) | `topUp(address)`: a live guest's plays SET to `guest_daily_plays` once per UTC day, ledger `guest_daily` / `gd:<day>`, `players.guest_day` the marker | `test-guests.js` [e] |
| `play/server/lib/db.js` | Migration 5 (above) | `test-skeleton.js` [b] (v4 → v5, the rebuild keeps every row; §19.4 contract) |
| `play/server/lib/settings.js` | `plays_balance_cap` 100 → **999**; NEW `guest_signup_enabled`, `guest_signups_per_ip`, `signup_pow_bits`, `guest_daily_plays`, `chat_guests_enabled`, `guest_chat_min_age`, `guest_idle_days` | `test-guests.js` |
| `play/server/lib/ledger.js` | Reason `guest_daily` | `test-guests.js` [e] |
| `play/server/lib/sessions.js` | A guest session (`proof_kind 'guest'`, `chat_ok_after` = sign-up + the gate); `lookup` refuses a deleted player and a guest without its `guests` row; the session row carries `kind`, `deleted_at`, `guest_created_at` | `test-guests.js` [b] [d] |
| `play/server/lib/auth.js` | `chatStatus` guest branch (live account age, `guests_off`, `account_too_new`); `/me` tops up a guest, gains `kind` + the `guest` block | `test-guests.js` [b] [f] |
| `play/server/lib/chat.js` | Guest pace 15 s / 10 h; a guest's link always held; `countedReports` ignores `g:` reporters for the auto-hold | `test-guests.js` [f] |
| `play/server/lib/names.js` | `label()` guest branch; `checkSignupName` / `availableForSignup` / `setSignupName`; a guest renames with a session only; admin params take `g.<16>`, an unknown guest is 404 | `test-guests.js` [f] [g]; `test-names.js` [g] |
| `play/server/lib/mask.js` | `guestTag` (4 base32 of sha256(id)), `isGuestId`, `playerParam` (`g.<16>` / `g:<16>` / a pool address) | `test-guests.js` [a] |
| `play/server/lib/matches.js` | `tickets.topUp` before each `match_cost`; NEW `closeOpenOf` (a delete cancels open seeks/challenges, refunded) | `test-guests.js` [d] [e] |
| `play/server/lib/moderation.js` | Player routes take guests (`playerParamOf`, 404 for an unknown guest); moderator routes miner-only with an explicit guest refusal; `playerView` gains `kind`, the guest's dates, `sessions.guest`; three new floors | `test-guests.js` [g] |
| `play/server/lib/leaderboard.js`, `lib/events.js`, `lib/events/mining_minutes.js`, `lib/events/active_days.js` | A deleted guest is not ranked; the two mining kinds filter `g:%` | `test-guests.js` [g] |
| `play/server/lib/plays.js`, `lib/pool-link.js` | The activity sync skips a `g:` row; `verifyProof` refuses a non-pool address (`not_pool_address`) before connecting | `test-guests.js` [g] |
| `play/server/lib/app.js` | Wiring; `rules.guests`; the hourly `guest_idle` job; the limiter sweep covers guests | `test-guests.js` |
| `admin-panel/games-admin.js`, `games-players.html`, `games-chat.html`, `games-names.html`, `games.html` | `GamesAdmin.playerSeg` / `isPlayer` / `GUEST_RE`; guests looked up, muted, banned, blocked by `g.<16>`; Delete guest account; Appoint disabled for a guest; the "Guest accounts" settings group + floors | `test-admin-panel.js` [14] |
| `scripts/lib/07_lib_pool_games.sh` | `PGS_ZONE_SIGNUP` (`…_gamesignup`, 6 r/m), the `^~ /play/api/signup` location (burst 4, 4 KB), the zone file regenerated when it lacks any of the three zones | `bash -n` |

Games `npm test`: **1114 → 1276 passed, 0 failed** (10 suites; NEW `test-guests.js` 151). Pool `npm test`: **2795 → 2797
passed, 0 failed** (28 suites). **Not done:** no browser render of the admin additions; nothing on a VPS; the /play/
sign-up and account UI is C6.

**For the operator:**
- People who do not mine can now **create a guest account** on /play/ (C6 adds the form): a name and a password, no
  email. Each one gets **5 tickets a day**, reset at 00:00 UTC. They can post in chat once the account is a day old.
- **Games → Overview → Guest accounts** holds the switches: close sign-up (existing guests keep signing in), sign-ups
  per network a day (3), the sign-up puzzle's difficulty, the daily tickets, guest chat on/off and its age wait, and
  how long an unused guest account is kept (180 days).
- **Games → Players** finds a guest by its `g:` id (shown in Chat & moderation beside its messages). You can mute,
  ban, adjust and **delete** a guest account. You never see a guest's login name — only when it was created and last
  signed in.
- Miners can now save up to **999** tickets (was 100). A **saved** value in Games → Overview wins over this new
  default.
- After deploying, run **`P → 3`** so nginx gets the new sign-up limit.

### As built vs the design (§19.15)

**Part C5 — guest accounts backend (2026-10-04; not VPS-tested).** The contract is §19.17.3 / §19.17.4 (D24–D26,
D32), threat notes #26–#29. Games service (NEW `lib/guests.js`, NEW `lib/tickets.js`, schema v5, hooks in `auth`,
`sessions`, `chat`, `names`, `matches`, `moderation`, `leaderboard`, `events`, `plays`, `pool-link`, `mask`), one nginx
zone in `07_lib_pool_games.sh`, and the admin pages' player paths (pool static files, no pool backend code). What the
build added to, or changed against, the contract and the prompt:

1. **Guest login is its own route, `POST /play/api/login/guest { name, password }`** — not a `kind` on
   `/play/api/login`. The miner login's body schema is exact-key and it is the one handler that calls the pool; a
   `kind` switch would make every key conditional there. A second handler keeps both schemas exact, and nginx's
   `^~ /play/api/login` is a PREFIX match, so the guest route gets the login zone (20 r/m) and the 4 KB cap with no
   nginx change. A guest body sent to the miner route is still `400 field: body`.
2. **`guests.created_ip_coarse` became a separate table, `guest_signups (id, ip_coarse, created_at)`.** Counting
   sign-ups from the `guests` table, as the sketch had it, lets a delete hand its /24 a fresh slot: sign up, delete,
   sign up — unlimited a day, one PoW each. The log is not linked to the account (no id column), so an IP is never
   stored beside the account it made — better than "NULLed after 7 days" — and rows older than 24 h (all the count
   reads) are deleted by the hourly job. `guests.id` also gained `REFERENCES players(address)`.
3. **The sessions rebuild is copy out → drop → create → copy back**, not "create new → rename": `ALTER TABLE …
   RENAME` stores the new name QUOTED (`CREATE TABLE "sessions"`) in `sqlite_master`, and §19.4 is compared with the
   live schema as text. A v4 → v5 test proves every row and column survives and the stored text is canonical.
4. **The guest chat age gate is recomputed LIVE** from `guests.created_at` in `auth.chatStatus`; the session's
   `chat_ok_after` is still written (sign-up time + the gate) but is a record. So an operator who raises
   `guest_chat_min_age` mid-flood closes chat to guest sessions already open (tested). New refusal reasons:
   `account_too_new` (with `available_at`) and `guests_off`. `guest_chat_min_age`'s SPEC minimum is the 1 h floor.
5. **The PoW is spent at step 3**, before the per-IP limits and the name check: a refused name costs a new PoW. That
   is the point — it makes sign-up a poor oracle for the login namespace — and C6 checks the shape client-side
   first. Refusals carry a reason the client can act on: `invalid` (malformed, forged, bits outside 14–26 even if
   signed), `expired`, `ip_changed` (the caller's /24 is not the one that fetched it), `used`, `insufficient`; none of
   them says anything about an account. The `ip_coarse` part of the token is base64url-wrapped (an IPv4 /24 is full of
   dots). The used set is bounded (50 000) and **fails closed** (`429 busy`) rather than forget a use. A restart
   changes the HMAC key, so a token from before it is `invalid` — precomputation across restarts is useless.
6. **The per-/24 attempt bucket** is 6 an hour (refusals count too), in memory; the 3-a-day success limit is read
   from `guest_signups` and **re-checked inside the sign-up transaction**, because a scrypt await sits between the
   two (two sign-ups from one /24 could otherwise both pass). The challenge route has its own per-IP bucket (20/h).
7. **Passwords** are NFC-normalised before hashing (the same password typed on two keyboards is the same password);
   the rule codes are `too_short`, `too_long`, `charset` (control / format characters), `same_as_name` (any case,
   leet), `common` (a ~40-entry list + one repeated character), `unchanged` (password change). Each refusal carries
   a hint.
8. **A wrong CURRENT password** (change, delete) counts on a per-guest lockout (5 → 5 min, doubling to 6 h), so a
   stolen session cookie is not an unlimited guesser of the password behind it. The password change is a
   compare-and-set on the old hash, so two racing changes cannot both win.
9. **Delete takes `confirm: "DELETE"`** (an exact string; C6's typed confirmation maps to it). A delete also
   **cancels the guest's open seeks and challenges, refunded** (the ledger stays whole; nobody can accept a game
   against an account that no longer exists). Its ACTIVE games are left to their move clocks — it loses on time,
   like anyone who walks away. A deleted guest is not topped up, not ranked (boards, events), and its sessions are
   refused twice: revoked by the delete, and `sessions.lookup` refuses a deleted player.
10. **Admin, guests by URL form `g.<16>`.** A path segment cannot carry `:` (games `PARAM_RE`, and the pool's
    `PROXY_PATH_RE` refuses it before forwarding), so every admin player route accepts `g.<16>` (`mask.js
    playerParam`), and the admin pages build player paths with `GamesAdmin.playerSeg()`. Mute, ban, unban, purge,
    adjust, the player view, the nickname block — all work on guests; **mute stays FAST** (`players/[^/]+/mute`),
    everything else step-up. NEW `POST guests/:gid/delete` (step-up, audited `guest_delete`). A guest id that names no
    guest is a **404** — an admin write must never create a players row for an id nobody holds. The moderator routes
    keep a miner-only parameter with an explicit `isGuestId` refusal (D32).
11. **`Guest-XXXX` is four base32 characters of sha256(id)**, not characters of the id: the id is private (only its
    owner's `/me` returns it), and the tag must not leak 4/16 of it. `maskAddr()` gained the guest branch, so every
    existing mask call (the moderator queue's reporter column, log lines) is safe without a change at the call site.
    `names.label`: `Nick · guest` / `Guest-XXXX` / `deleted guest`.
12. **A guest cannot be challenged directly** — a challenge targets a full pool address (§19.8: the challenger
    already knows it), and a guest has no shareable id. Guests play the lobby's seeks, and may challenge miners. For
    C6 to say.
13. **Guest renames** need a session and nothing more (no account-age wait); sign-up counts as a change, so the first
    rename is 7 days after sign-up. A rename never checks login names (tested: a guest may take another guest's
    login name as a nickname once it is no longer live; sign-up with it is still refused).
14. **`/me`** gains top-level `kind` and, for a guest only, `guest: { login_name, created_at, daily_tickets,
    resets_at, chat_from }` — the only response that carries a login name. **`/play/api/rules`** gains `guests` (the
    daily tickets, the age gate, the pace, the switches) for C6's "How tickets are earned" fold.
15. **Admin settings:** a "Guest accounts" group on Games → Overview, three new floors (`signup_pow_bits` 14, the guest
    age 1 h, the guest pace); the Players page looks up `g:` ids, shows a guest's dates (never its login name),
    disables Appoint, and has **Delete guest account**.
16. **Not done here, for C6:** the API's `no_plays` message still reads "No plays left. Plays come from mining
    minutes." — the visible word and the guest wording are C6's.
17. **nginx:** zone `…_gamesignup` 6 r/m (burst 4) on `^~ /play/api/signup` (the challenge and the POST); the zone
    file is regenerated when it lacks any of the three names. **C9:** run `P → 3` on the box, or the location is not
    there.

*Self-review against #26–#29 (R2 judges; these are the builder's answers):*
- **#26 — answered.** One wording and one body for an unknown name and a wrong password (tested byte-equal); an unknown
  name runs one scrypt against a dummy hash computed at start-up (tested by counting `crypto.scrypt` calls: 1 and 1);
  the ban answer only after the password (a banned guest + a wrong password gets the plain `login_failed`). The
  login namespace is reachable only through sign-up (PoW + attempt bucket + the 3/day limit), and a rename never
  answers "taken" for a login name. The per-name budget counts failures only and lets an IP whose /24 had a session
  for that guest in 30 days through (tested: 20 stranger failures from 20 /24s, then the owner from a known /24 gets
  in, a first-time IP waits). One scrypt cap (4 + 64 waiting, then 429) serves sign-up, login, change and delete.
- **#27 — answered.** Single-use, 5-minute, /24-bound, HMAC-signed; replay, another /24, expiry, a forged bits field,
  a forged IP field, a token under the floor and a token from before a restart are all refused (tested); verifying
  costs one HMAC + one SHA-256 (tested by counting).
- **#28 — answered, with residues.** Guest reports reach the queue and never hold a message (tested: 3 guest reports
  leave it visible, 3 miner reports hold it); guest posts 1 per 15 s and 10 an hour, links always held; the age gate
  makes a flood cost a day per account; `mining_*` events skip guests; `game_results` is bounded by 5 tickets a day;
  PvP Elo by the pair cap; name squatting by the idle job and the sign-up limit. **Residues:** the 3/day/24 limit
  counts per carrier NAT, so many honest mobile users behind one /24 can be refused (the operator can raise it to 10);
  `Guest-XXXX` collides at 20 bits (a label, never an identity); a deleted guest's `players` row is kept forever
  (small, and history needs it).
- **#29 — answered.** `pool-link.verifyProof` refuses a non-pool address with `not_pool_address` before any connection
  (tested against a real client); the activity sync skips a `g:` row (tested with a planted one); the moderator
  routes refuse a guest (tested); `mining_minutes` / `active_days` filter `g:%` (tested with a planted activity row);
  `names.label` covers guests and deleted guests, and the scans in `test-guests.js` and `test-names.js` find no guest
  id, no `login_name` and no bare guest nickname in any public response; the admin player view carries no login name.
  Nothing money-adjacent exists in the games service.

*Verified:* games `npm test` **1114 → 1276**, 0 failed (NEW `test-guests.js` 151; `test-skeleton.js` +8 — the v4 → v5
rebuild; `test-names.js` +3 — a guest in the leakage scan); pool **2795 → 2797**, 0 failed (`test-admin-panel.js` +2 —
the guest path form and its step-up); `bash -n scripts/lib/07_lib_pool_games.sh` clean. **Not done:** no browser
render of the admin pages' guest additions; nothing ran on a VPS.

## The guest UI on /play/

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.3 / §19.17.4 / §19.17.5; the departures (the solver above all) and the self-review are §19.15
*Part C6*. Shell files, three sentences in the games service and one pool admin label. The shell ships with the games code update
(`P → 2`/`P → 3` stage and stamp it); the label with the pool's `9) Deploy new code` (a static file, no restart). No
schema, no nginx change.

| File | Change | Test |
|---|---|---|
| `play/shell/js/play-guest.js` (NEW) | Miner · Guest tabs (arrow keys, remembered in `localStorage grin_play_login_tab`); guest sign-in (`POST login/guest`); sign-up inside the Guest tab — live name-shape hint, password ×2, then `GET signup/challenge` → `PlayPow.solve` → `POST signup`, every C5 refusal mapped; `/play/#signup`; the Guest account box (`POST account/password`, `POST account/delete` with typed `DELETE`); the guest lines of the fold from `rules.guests`. Events out: `play:signed-in`, `play:signed-out` | `test-shell.js` [1]; probe |
| `play/shell/js/play-pow.js` (NEW) | `PlayPow.solve(challenge, bits, {onProgress, cancelled})`: SHA-256 in plain JS over a midstate of the challenge, 12-character nonce (4 random + 8-digit base36 counter bumped in place), 40 ms slices; `sha256hex` for the tests | `test-shell.js` [5] |
| `play/shell/index.html` | Sign-in card → `#login-note` + two tabs; guest sign-in + sign-up forms; "Tickets" placard + `#acct-guest-line`; the Guest account box; guest nickname example; lobby guest note; chat guest-link note; "How tickets are earned" rewritten for miners and guests; the two script tags | `test-shell.js` [1] |
| `play/shell/js/play-shell.js` | `signedIn(r.me)` (the full `/me`); listens to `play:signed-in` / `play:signed-out` / `play:refresh-me`; guest "Signed in as" + day line; `signedOut(note, kind)` writes `#login-note`; per-kind out-of-tickets sentence; "ticket" wording | `test-shell.js` [1]; probe |
| `play/shell/js/play-chat.js` | `account_too_new` (date + "in …") / `guests_off` sentences; guest-link note; `play:refresh-me` when a wait runs out (≤ 6 h); rules via `PlayApi.rules()`; "ticket" wording | `test-shell.js` [1] |
| `play/shell/js/play-lobby.js` | Guest note (no challenges to a guest); per-kind out-of-tickets; "ticket" / "player" wording; `PlayApi.rules()` | `test-shell.js` [1] |
| `play/shell/js/play-names.js` | Guest example + "Removed. Others now see you as …"; `nick_blocked` says "your account" | probe |
| `play/shell/js/play-api.js` | `PlayApi.rules()` — one cached `GET rules` per page, a failure not cached | `test-shell.js` [3] |
| `play/shell/css/play.css` | Tabs reuse `.play-tabs`; `.play-link`, `.play-lead`, `.play-warn`, name hint states, progress line, account forms | probe (1280 + 390) |
| `play/server/lib/http.js` | `no_plays` and `expired` say tickets; `banned` says "account" | `test-shell.js` [1] |
| `back-end-pool/admin-panel/games.html` (pool) | The `signup_pow_bits` label: "at 18 a desktop browser needs about half a second" (was "18 ≈ a few seconds") | `test-admin-panel.js` |

Games `npm test`: **1276 → 1316 passed, 0 failed** (`test-shell.js` 114 → 154). Pool `npm test`: **2797 passed, 0 failed**
(unchanged; the one pool change is a label). Headless-Edge probe **95/95** at 1280 and 390 px against the real games app on 127.0.0.1 (what it
covered: §19.15 *Part C6*, *Verified*); the probe lived in the session scratchpad and every process it started was killed.
**Not done:** nothing on a VPS; the PoW not timed on a phone; the bubble's storage hints (`grin_play_signed_in`,
`grin_play_preview`) are C7's.

**For the operator:**
- **/play/ now has a Guest tab.** Anyone can make an account with a name and a password — no email — and play with
  5 tickets a day. Miners sign in exactly as before on the Miner tab.
- **"Plays" are now called "tickets"** on the page. Nothing changed in how they work; the admin pages still say "plays".
- Making an account runs a short "checking you're not a bot" step in the browser — about half a second on a desktop.
  If sign-up spam ever shows up, raise **Games → Overview → Guest accounts → Sign-up proof-of-work difficulty** a step or two (each step doubles it).
- A guest who forgets their password cannot get it back (there is no email). The page says so twice; they can make a
  new account.

### As built vs the design (§19.15)

**Part C6 — the guest UI on /play/ (2026-10-04; not VPS-tested).** The contract is §19.17.3 / §19.17.4 / §19.17.5 (D24–D27).
Shell only: NEW `play/shell/js/play-guest.js` (tabs, guest sign-in, sign-up, the Guest account box, the guest lines of
the fold) and NEW `play/shell/js/play-pow.js` (the sign-up proof-of-work), edits to `index.html`, `play-shell.js`,
`play-chat.js`, `play-lobby.js`, `play-names.js`, `play-api.js`, `play.css`; three sentences in the games `lib/http.js`; one
label in the pool's admin `games.html` (the PoW setting no longer promises "18 ≈ a few seconds" — #1). No schema, no route. What the build added to, or changed against, the contract and the prompt:

1. **The proof-of-work runs in plain JavaScript, not WebCrypto** (the prompt said "WebCrypto SHA-256 in chunks"; §19.17.3
   said C6 measures it). Measured in headless Edge on the dev box: `crypto.subtle.digest` managed **34–38 k hashes/s** — it is
   one promise round trip per hash — so 18 bits took 2.8 s, 4.5 s, 10 s and **25 s** in four runs (the search is
   geometric: an unlucky run is several times the mean), and a phone would be several times slower. `play-pow.js` instead
   hashes the challenge part of the message (always ≥ 64 bytes) once into a midstate and runs only the last one or two
   blocks per try, with the nonce's counter bumped in place: **~570 k/s** in Node, and the full sign-up (challenge + solve +
   POST) took **510 ms** at 18 bits in the Edge probe. No secret is involved, and the server verifies with Node's own
   SHA-256, so a solver bug can only make a sign-up FAIL; `test-shell.js` [5] checks the SHA-256 against Node's on 300
   lengths + the `abc` vector and every answer against the real `createPow().verify`. Time-sliced (40 ms, then
   `setTimeout(0)`), no Worker. The nonce is 4 random base36 characters + an 8-digit base36 counter, always 12 characters,
   so the padding never moves. **The default stays 18 bits** — but at this speed it is ~0.5 s on a desktop, so C9's phone
   timing may well show room to raise `signup_pow_bits` (20 bits ≈ 4× the cost to a sign-up farm).
2. **Sign-up lives inside the Guest tab**, not as a third tab: the card has exactly two tabs (Miner · Guest, a real tablist
   with arrow keys), and "Create a guest account" (in the Guest tab, and a line under the miner form: *"Don't mine here?"*)
   swaps the Guest panel to the sign-up form. **`/play/#signup` opens it** (C7's bubble links there); the hash is set while
   the form is open and cleared on success or "I already have a guest account". The last tab used is remembered per viewer
   (`localStorage grin_play_login_tab`, every access in `try/catch`); Miner is the default.
3. **The name's SHAPE is checked in the page before any request**, with a live hint (`3–20`, letters and digits, a letter,
   not address-like — `name-rule.js checkShape` + the address test). The PoW is spent the moment the server verifies it
   (§19.15 *Part C5* #5), so a shape refusal after it would cost a new one. The hint never says a name is free — "the pool
   checks that nobody has it and that it is allowed". Every attempt fetches a fresh challenge.
4. **Every C5 refusal has one sentence**: `signup_closed` (the form is swapped for the "closed" notice), `pow_failed` by reason
   (`expired`, `ip_changed` — "a VPN, or a phone switching between Wi-Fi and mobile data" — else one generic line),
   `too_many_requests` (`signup_limit` vs the attempt bucket, with the wait), `busy`, `name_not_allowed` / `name_unavailable`
   (the server's vagueness kept: no word, no list), `password_weak` (the server's hint), `name_*` (its hint). Guest sign-in:
   `login_failed`'s own hint, the wait on 429, `banned`.
5. **A card-level note line (`#login-note`) above the tabs** carries why the card is showing (signed out, session ended,
   account deleted). It used to be the miner form's message line, which is hidden while the Guest tab is open — so a guest
   who deleted their account saw nothing. `signedOut(note, kind)`: the player's own sign-out reads as `ok`.
6. **"Signed in as" for a guest is the sign-in name + "· guest"** (from `/me`, its owner only — §19.13 #29); a miner still sees
   the mask. A line under the placard: "*N tickets a day — the count goes back to N at 00:00 UTC (… from now)*".
7. **The Guest account box** (a fold in the account strip, guests only): the sign-in name and creation date, change password
   (current + new twice; "other devices are signed out"), delete (password + typed `DELETE`). The typed word is compared
   case-insensitively in the page and the body always carries exactly `DELETE` (`test-shell.js` compares it with the server's
   `DELETE_CONFIRM`); there is no two-click on top. `wrong_password`, its lockout wait, `conflict` and a gone session each have a
   sentence. Every password box is wiped after every attempt, and no input on the page has a `name=`.
8. **"Tickets" is the visible word everywhere on /play/** (placard, fold title + body, buttons, refund lines, errors) and in the
   games service's own sentences: `no_plays` ("No tickets left. Miners earn them from mining minutes; a guest account gets
   new ones at 00:00 UTC."), `expired` ("The ticket was refunded."), and `banned` now says "This **account**" (it reaches guests).
   `test-shell.js` fails on "plays" / "a play" in the page text or in any sentence a shell script writes. The admin pages keep
   the internal name (§19.17.4 allows "(tickets)" on a label; not added). The out-of-tickets sentence is per kind: a guest gets
   the 00:00 UTC refill and the wait, a miner the mining pointer.
9. **"How tickets are earned"** is rewritten for both kinds, cost first: miners (mining minutes, now "999 held"), guests (the
   daily SET, no saving up, no password recovery, idle deletion), PvP, points, events ("the mining ones are for miners only"),
   chat for both, names for both. The guest numbers come from `rules.guests` (`play-guest.js`), the rest as before.
10. **`PlayApi.rules()`**: one cached `GET rules` per page load, shared by the chat panel, the lobby and the guest forms (it was
    fetched twice before C6 and would have been three times); a failure is not cached.
11. **Chat:** `account_too_new` reads "*You can post from <date> UTC (in …). A guest account has to be <age> old before it can
    post, so nobody can flood the chat with fresh accounts. Reading is open now.*"; `guests_off` "*open to miners only right
    now*"; a guest sees "*a message with a link in it waits for a moderator*" under the form. **When a wait runs out** (account
    age, or a miner's proof age, ≤ 6 h away) the panel fires `play:refresh-me` and the shell refreshes `/me`, so the form
    appears without a reload — before, a miner's `proof_too_new` waited for the 5-minute refresh too.
12. **Lobby:** a guest sees why nobody can challenge them (no address to type) and that they can still challenge a miner;
    "another miner" → "another player", "two addresses" → "two players".
13. **Nickname fold:** a guest sees the `NightShift · guest` example and that changing the nickname never changes the sign-in
    name; "Removed" says what others now see (the server's `shown_as`); `nick_blocked` says "your account".
14. **Not done here, for C7:** the shell does not yet write the bubble's localStorage hints (`grin_play_signed_in`,
    `grin_play_preview`, §19.17.7). They belong to the bubble's contract; C7 adds them to the shell with the bubble.

*Self-review — the copy read once as someone who has never mined and never heard of Grin:* the header says a free guest
account exists before the card does; "tickets" and "points" are explained where they first matter; "proof-of-work" never
appears (the page says "*checking you're not a bot*"); the no-email / no-reset warning sits on the form, not in a fold.
**Accepted:** the default tab is **Miner** (the pool's own audience) — a non-miner sees a "GRIN address" form first, with the
"*Don't mine here? Create a free guest account*" line right under it, and C7's bubble links straight to `#signup`. "GRIN",
"UTC" and "seek" stay unexplained (pool-wide words). *Against #26/#29:* the page repeats only the server's vague answers
(no list hit, no "exists" — one sentence for a wrong pair, including a deleted account); the sign-in name is shown only from the
owner's own `/me`; textContent only, no inline script (test-shell [1]); the page stays `data-untrusted-html="exempt"`, which
now also covers the guest passwords typed on it.

*Verified:* games `npm test` **1276 → 1316**, 0 failed (`test-shell.js` 114 → 154: the tabs, no `name=` on any input, password
boxes, load order + stamps, API paths, the DELETE word, the order "shape before challenge", every refusal code, the events,
`#signup`, storage in try/catch, "tickets" in page + scripts + server, the fold; `rules()` caching; [5] the solver);
pool **2797**, 0 failed (the one pool change is a static admin label). **Headless-Edge probe 95/95** (session scratchpad only; the real games app
in-process on an in-memory DB with a stubbed pool link, the shell under the real `/play/` and `/play/games/` CSP from
`07_lib_pool_games.sh`, 127.0.0.1, Edge and the server killed after): at 1280 and 390 px — `#signup` opens the form; shape
refusals send nothing; a reserved name costs a PoW and is refused vaguely; a good name signs up with a NEW challenge (body
exactly `{name, password, challenge, nonce}`), lands signed in with 5 tickets, the guest line, the welcome; chat refused
with the age wait; a bot game costs a ticket and a real click-move through the sandboxed frame is answered; wrong-then-right
password change; log out (note visible on the Guest tab); guest sign-in in another letter case; typed delete; sign-in after
delete refused; tabs by click and arrow key; no horizontal overflow; 0 console errors / exceptions / CSP violations (the only
console lines are the expected 4xx of the refusals). Plus sign-up closed: the notice, both offers hidden, the fold says so.
*Probe traps for later sessions:* Edge runs the sandboxed game frame OUT of process — it is not in `Page.getFrameTree`;
auto-attach and evaluate in its own session; and a click right after `scrollIntoView` can land on the old position — wait for
a paint. `Emulation.setDeviceMetricsOverride` gives a true 390 px layout (`innerWidth` 390), unlike `--window-size`.
**Not done:** nothing on a VPS; no phone timing of the PoW (C9).

## The floating chat bubble + the CMS body sandbox

**Status:** built 2026-10-04, not VPS-tested

The contract is design §19.17.7 (D23) and threat note #30; the departures, the D22-4 decision and the #30 self-review are
§19.15 *Part C7*. Two halves ship on two deploy paths: the bubble, the shared chat core and the shell hints are GAMES files
(`P → 2`/`P → 3` stage and stamp them); the loader, the CMS frame and the two CMS pages are POOL static files (`9) Deploy
new code`, no restart). One games-service line (`rules.mode`) needs the games restart that `P → 2` already does. **No
schema, no nginx change, no setting.**

| File | Change | Test |
|---|---|---|
| `play/shell/js/play-chat-core.js` (NEW) | `PlayChatCore`: the feed (`createFeed({list, actions})` → `path()` / `apply(r)` → `{more, added}` / `reset` / `redraw` / `upsert`), the row builder, `gateText(c, rules, signedOutText)`, `errText(e, rules)`, the two-click `armButton`, the text helpers. No request of its own | `test-shell.js` [1] [6] |
| `play/shell/js/play-chat.js` | Rebuilt on the core: keeps the moderator tools, the rules fold, the panel cadence (4/15/30/60 s). Behaviour unchanged | `test-shell.js` [1] (repointed) |
| `play/shell/js/chat-bubble.js` (NEW) | The bubble (closed button + unread dot; panel / ≤ 600 px sheet; Esc; Miner + Guest sign-in on `login` / `login/guest`; post + report; sign-out; the anti-scam line). Loads `/play/css/chat-bubble.css` and — only when it has something to do — `play-api.js` + `play-chat-core.js`, all with its own `?v=` stamp. localStorage: `grin_play_chat_open`, `grin_play_signed_in`, `grin_play_chat_seen`, `grin_play_login_tab` (shared with /play/) | `test-shell.js` [6]; probe |
| `play/shell/css/chat-bubble.css` (NEW) | Scoped under `.gcb`; pool tokens only; z-index 9990; `--gcb-lift` above the consent bar; the row rules repeated (play.css is not on pool pages) | `test-shell.js` [6]; probe |
| `play/shell/index.html` | `play-chat-core.js` before `play-chat.js`, stamped | `test-shell.js` [1] |
| `play/shell/js/play-shell.js` | The bubble's two hints: `grin_play_signed_in` set in `signedIn`, cleared in `signedOut`; `grin_play_preview` set when `rules.mode` is preview, removed when on. try/catch | `test-shell.js` [6] |
| `play/server/lib/app.js` | `GET /play/api/rules` gains `mode` (the effective mode) | `test-launch.js` [b] [c] |
| `public_html/js/branding.js` (pool) | `loadChatBubble(cfg)` in `apply()` after the banners (so never in maintenance): `cfg.games.chat === true` and mode `on`, or `preview` + `grin_play_preview`; never on `isCredentialPage()`; `/play/version.js` then `/play/js/chat-bubble.js?v=<12 hex>` (unstamped if version.js fails or is malformed) | `test-operator-code-sinks.js` [1] [6] |
| `public_html/js/cms-frame.js` (pool, NEW) | `CmsFrame.mount(host, html, {wrapClass, title})`: a `srcdoc` iframe, `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"`, `<base target="_top">`; on load it clones the page's stylesheets + `<style>`s and the body/html theme attributes in (re-synced by MutationObserver), sizes the frame to its content (load, fonts, ResizeObserver, resize, three timed re-fits), `rel=noopener` on `_blank` links, and scrolls the PAGE for an in-body `#anchor` | `test-operator-code-sinks.js` [1] [2]; probe |
| `public_html/page.html`, `post.html` (pool) | `<script src="/js/cms-frame.js">` before the inline script; the body goes through `showBody()` → `CmsFrame.mount`; without it, a sentence — never innerHTML | `test-operator-code-sinks.js` [2] |
| `back-end-pool/scripts/test-operator-code-sinks.js` | The loader + the bubble's dep loader + the CMS frame on the allowlists; the one `srcdoc`; the sandbox token by token; innerHTML ratchet page 3 → 2, post 4 → 3; NEW [6] the loader in a DOM shim (15 cases) | — |
| `play/server/scripts/test-shell.js`, `test-launch.js` | NEW [6] (static rules + the polling budget measured in a vm with a fake clock); chat checks repointed at the core; `rules.mode` | — |

Games `npm test`: **1316 → 1356 passed, 0 failed** (`test-shell.js` 154 → 191, `test-launch.js` 50 → 53). Pool `npm test`:
**2797 → 2829 passed, 0 failed** (`test-operator-code-sinks.js` 92 → 124). Headless-Edge probe **259/259** (what it covered: §19.15 *Part C7*, *Verified*; scratchpad only, every process killed).
**Not done:** nothing on a VPS; no real phone; the search-engine effect of framing the CMS bodies is unmeasured.

**For the operator:**
- **Every public page now has a chat button** (bottom right) once the games are live — the same chat as /play/. Visitors
  can read without an account and sign in from the button to post; new guest accounts are still made on /play/.
  It does not appear on the admin login page, on /play/ itself, or (in preview) to anyone who has not opened /play/.
- **Pages and blog posts look the same, but their text now sits in a locked frame.** Anything in a page or post that
  tried to run code, submit a form or restyle the rest of the site no longer does. If a post used a form or an
  embedded script, it will not work any more — link to it instead.
- After deploying, check one blog post in Search Console's URL inspection: the post text is now inside a frame, and it is
  worth confirming Google still shows it as the page's content.

### As built vs the design (§19.15)

**Part C7 — the floating chat bubble, and D22-4 closed (2026-10-04; not VPS-tested).** The contract is §19.17.7 (D23) and
threat note #30. Games: NEW `play/shell/js/play-chat-core.js`, `chat-bubble.js`, `css/chat-bubble.css`; `play-chat.js`
rebuilt on the core; one script tag in `index.html`; the two hints in `play-shell.js`; `rules.mode` in `lib/app.js`. Pool:
`loadChatBubble` in `public_html/js/branding.js`; NEW `public_html/js/cms-frame.js`; `page.html` / `post.html`. No schema,
no nginx, no setting. What the build added to, or changed against, the contract and the prompt:

1. **D22-4 — the operator's decision, asked before any C7 code: SANDBOX the CMS bodies** (offered: sandbox / exempt the CMS
   pages from the bubble / an allowlist sanitiser / accept). `cms-frame.js` puts a page or post body in a `srcdoc` iframe with
   `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"` — **no
   `allow-scripts`**, so no `<script>`, `on*` handler or `javascript:` URL in a body runs, whatever the markup; the browser
   enforces it and there is no filter to keep right (D22's argument against a sanitiser holds). `allow-same-origin` is safe
   only because scripts are never allowed (the pair together would undo the sandbox; the sink test pins both). It lets the
   PAGE reach in: it clones the page's stylesheets, `<style>` blocks and the body/html theme attributes into the frame (and
   re-syncs on a theme switch or a late branding stylesheet), sizes the frame to its content, sets `rel=noopener` on
   `_blank` links and scrolls the page for an in-body `#anchor`. `<base target="_top">` makes a plain link navigate the tab
   (on a user's click only). The frame inherits the page CSP (srcdoc), so a body loads exactly what it could before. A
   body's own CSS now stays inside the frame — before, it could restyle or overlay the whole page, the bubble's sign-in
   included. If `cms-frame.js` fails to load, the page shows a sentence, never an innerHTML fallback. **Accepted costs:**
   a `<form>` in a body no longer submits (no `allow-forms`); search engines see the body inside a frame (the server-rendered
   head — title, description, og — is unchanged); C9 checks one post in Search Console.
2. **The loader is in `branding.js`, not `public-shell.js`** — the decision needs `cfg.games`, which lands there (§19.17.7
   allowed either; the sink test's comment had guessed public-shell). It runs inside `apply()` after the banners, so a page in
   maintenance never gets it, and only when `!isCredentialPage()` (the exempt attribute + the page-key list).
3. **The stamp.** The loader inserts `/play/version.js` (a fixed path) and then `/play/js/chat-bubble.js?v=<GRIN_PLAY_VERSION>`,
   the stamp pattern-checked (12 hex) — a bad or missing one loads the bubble unstamped (`/play/` is no-cache anyway). The
   bubble reuses the stamp it was loaded with for its CSS and dependencies. Cost: one extra small revalidated request per
   page view while chat is on.
4. **Lazy dependencies.** The bubble fetches `play-api.js` + `play-chat-core.js` only when it has something to do (opened,
   or a session hint to poll for), so closed + signed out costs no API request AND no script beyond the bubble's own file
   and stylesheet — stricter than §19.17.7 asked.
5. **One chat client.** `PlayChatCore` holds the feed (the change-feed state machine), the row builder, the gate and error
   sentences and the two-click confirm; the /play/ panel keeps only what is /play/'s (moderator tools, the rules fold, its
   cadence) and behaves as before. `gateText` takes the signed-out sentence ("above" on /play/, "below" in the bubble).
   **Accepted duplication:** the row CSS is repeated under `.gcb` in `chat-bubble.css` (`play.css` is not on pool pages),
   and the bubble's sign-in sentences repeat the shell's mapping — the sign-in cards are not the chat client.
6. **`GET /play/api/rules` carries `mode`** (the effective mode, `preview` | `on`): the shell sets `grin_play_preview` when
   it loads in preview and **removes** it when the games are on (so *Back to preview* hides the bubble again from browsers
   that only saw /play/ live). `grin_play_signed_in` is set in `signedIn` (both sign-in kinds pass through it) and cleared in
   `signedOut`; the bubble sets and clears it too, and clears it on a 401 or a ban.
7. **Unread dot:** `grin_play_chat_seen` keeps the newest id the viewer had open; the first sight is the baseline (no dot);
   a newer visible message from someone else lights it and relabels the button "Open chat — new messages"; your own never.
8. **Sign-out in the bubble** (beyond the prompt): on a shared computer the bubble is the only place on the page that says
   you are signed in. "Sign in to post" is a toggle, so the list stays visible while signed out; the tabs share
   `grin_play_login_tab` with /play/. A successful sign-in clears the typed address / name as well as the password (#30).
9. **Moderators** get a line ("Your moderator tools are on the games page") and the header's *Games ↗* link; the bubble
   offers Report only.
10. **Layout:** z-index 9990, below the consent bar (9999) and the banners (9998); the bubble rides above the consent bar by
    its measured height (`--gcb-lift`, MutationObserver on `body`); a 76 / 68 px spacer at the end of the body lets the
    page's last lines scroll clear of the closed button; ≤ 600 px, open = a full-screen sheet with the page scroll locked.
11. **Esc** closes when focus is inside the panel (a non-modal dialog); opening moves focus to the panel title, so Esc
    works at once; closing returns focus to the button.
12. **nginx — no change, the estimate:** the `/play/api/` zone is 600 r/m per IP, burst 40. Per tab the bubble asks 15 r/m
    open + signed in, 4 r/m open + signed out, 1 r/m closed + signed in, 0 closed + signed out or hidden — the /play/
    panel's own budget. One IP reaches 600 r/m only with ~40 signed-in tabs open at once (or 40 people behind one NAT, each
    with the bubble open and signed in); the hidden-tab pause removes background tabs from that count. Server cost: a
    chat read is an id range on an index plus the in-memory change log — the same request /play/ already serves at that
    rate. Revisit only if C9 shows 429s on `/play/api/chat`.
13. **The probe's own lessons** (for R2): the games service refuses a loopback `X-Real-IP` (`client_ip`, by design), one IP
    gets about ten guest sign-ins before the login limit answers 429, a guest may post once per 15 s, and a body containing
    `window.top…` is held as link-like — a probe must vary the IP and the guest, and pick its fixtures with care.
14. **#22 can now be judged complete:** with D22-4 closed, no operator-authored markup reaches the origin as live DOM. R2
    confirms.

*Self-review against #30:* `textContent` only — the bubble builds every node with `createElement`, the rows come from the
core, `test-shell.js` [1] fails on any HTML sink in either file and [6] renders a `<img onerror>` body as a text node; no
session token anywhere (the cookie is `HttpOnly`, the hint is `'1'`); no full address: a miner shows as `address_masked`, a
guest's sign-in name only to its owner (from its own `/me`), and the typed address is cleared on success; no polling while
closed and signed out (measured: 0 requests over 10 fake-clock minutes in the vm, and over 20 s twice in Edge); nothing on exempt pages (the loader and
the bubble both check; Edge: `/play/` and `login.html` carry none); the preview flag honoured (loader test + Edge). The
accepted GA4 residue stands as written in #30.

*Verified:* games `npm test` **1316 → 1356**, 0 failed (`test-shell.js` 154 → 191: [6] the bubble's static rules + the
polling budget measured in a vm with a fake clock — closed + signed out 0 requests in 10 min, closed + signed in /me once
then one read a minute, hidden paused, open 15 / 4 s, a stale hint one 401 then silence, the unread dot; `test-launch.js`
50 → 53, `rules.mode`). Pool `npm test` **2797 → 2829**, 0 failed (`test-operator-code-sinks.js` 92 → 124: the three new
creators listed with guards, the one `srcdoc`, the sandbox token by token, the D22-4 call sites, the innerHTML ratchet down,
NEW [6] the loader in a DOM shim — 15 cases incl. storage that throws, a malformed stamp, maintenance, the login page).
**Headless-Edge probe 259/259** (session scratchpad only; the real games app in-process on an in-memory DB with a stubbed
pool link, a front server playing nginx with the page CSP and the `/play/` CSP read from the bash libs, 127.0.0.1; Edge
and both servers killed after, a process sweep found none left): home, account and a blog post × Reactor, Light, Galaxy ×
1280 / 390 px — the bubble shown with the stamp and no chat script fetched while closed; open, read (a markup body as text,
nothing ran); the anti-scam line; a 360 px panel / a full-screen sheet; a guest sign-in inside the bubble (password wiped,
hint set); a post shown as your own; Esc closes with focus back; closed: no horizontal overflow, no button in `<main>`
covered at a resting scroll, the footer scrolls clear, the button above a consent bar; on the post page the body in the
sandboxed frame with its `onerror`, `<script>` and page-wide `<style>` all contained, the frame sized to content with the
theme copied, an in-body `#anchor` scrolling the page; no new console error against a chat-off baseline of the same page.
Plus: chat off in the payload → no loader; a real-browser budget (0 requests in 20 s closed, a read every 15 s open, 0 again
after close); preview — a fresh browser gets no bubble, opening /play/ leaves the hint and the pool pages then show it;
`/play/` and `login.html` never carry it. **Not done:** nothing on a VPS; no real phone (the sheet with an on-screen
keyboard); the search-engine view of a framed post.

---

# Runbook

## Operator side (bash, menu `P`)

**Status:** built 2026-09-27 (backup in the hub move 2026-10-12), not VPS-tested

**All of it lives in NEW `scripts/lib/07_lib_pool_games.sh`** (prefix `pgs_`, plus the menu
`pool_games_menu`), sourced by the pool script right after the backup lib. The pool script gained
only hooks: the header menu comment, the `P` row + dispatch + no-pause entry, `games_port` in
`pool_write_conf_key`'s numeric set, `pgs_deploy_code` at the end of `pool_deploy_code`, two lines
in the vhost's `:443` block, a third `C) Cron` toggle, and a cleanup group. The backup lib and the
migrate lib gained the games-DB hooks below.

**The rule of the file: nothing under `P` restarts, stops or reloads `grin-pool-manager`.** Every
state-changing `systemctl` call names `$PGS_SERVICE`; the pool unit is only read (`systemctl show`
for its `NRestarts`, printed by P → 5 so the operator can prove the rule). nginx is reloaded, never
restarted. `P → 3` may call `pool_setup_nginx` to add the include to an older vhost, which is itself
a reload only.

| Key | Function | What it does |
|---|---|---|
| 1 | `pgs_install` | Refuses without the pool unit, `grinpool` or Node ≥ 24. Creates `grinplay` (nologin, own group; removed from `grinpool`/`grinsecret` if found there), checks `id -gn grinpool` = `grinpool`, creates the dirs (code `root:grinplay 750`, data `grinplay 700`, `o+x` on `/opt/grin` + `/opt/grin/conf` for traverse), the link secret **once**, the two pool.json keys **only if absent**, deploys code, pre-creates the log, writes the unit + logrotate, enables and (re)starts the games only, waits ≤ 15 s for `/play/api/health`. Refreshes the daily backup wrapper when a schedule is on, so it starts archiving the games DB. |
| 2 | `pgs_deploy_code` | Stages `server/**` + each game's `manifest.json`/`rules.js` (code) and `shell/**` + each game's `frame/**`/`rules.js` (web) in a temp dir, writes `version.js`, then ONE `rsync -a --delete` per tree, then re-applies owners/modes. Restarts only the games service, only if it is running AND its runtime code (`PGS_RUNTIME_PATHS`) changed or an earlier deploy's is still unloaded — a `/play/` web-only change restarts nothing (rule + marker: [`script07_implementation.md`](script07_implementation.md) §1 *Deploy new code*). Also runs at the end of the pool's `9) Deploy new code` when games is installed; a games failure there is a warning, never a failed pool deploy. |
| 3 | `pgs_setup_nginx` | Zones via `nginx_ensure_rate_limit_zones`, the snippet (temp file + rename, the previous copy kept in `/tmp` for rollback), the vhost include check, `nginx -t` + reload (rollback + reload on failure), then the route check. |
| 4 | `pgs_service_menu` | Start / stop / restart the games unit. |
| 5 | `pgs_status` | Unit state + `NRestarts` + last exit (78 named), listener (red unless `127.0.0.1` only), health JSON, DB size + `schema_version`, player + match counts (a fresh DB reads 0 / 0) and its origin (`.restore-info` in the data dir: archive name + UTC time of the last restore), link file owner/mode, mode + chat from the pool, "401 without the secret", snippet + include present, the pool's own `NRestarts` / `ActiveEnterTimestamp`. |
| 6 | `pgs_view_logs` | The last 50 lines, paged. |
| 7 | `pgs_rotate_secret` | `[y/N]`, new secret via temp file + rename, then one probe with the new secret. No restarts. |
| 8 | `pgs_uninstall` | Service, unit, snippet + zones (then test + reload), web + code dirs, logrotate, VACUUM cron, link file. The DB only on a second `[y/N]`. Keeps the `grinplay` user and the pool.json keys. |
| 9 | `pgs_restore_menu` | Games DB ONLY, from a pool archive in `$PBK_BACKUP_DIR`: pick, personal key, decrypt to a `mktemp` file (removed on every path — it holds the wallet seed), then `pgs_restore_db_from_archive`. pool.db, wallet and config are not touched and the pool is not stopped — the fix for a Migrate IN / `2) Restore` whose games question was answered `n` or failed. An archive with no games DB is said, not silently skipped. |

**How the secret is kept out of sight.** It goes `openssl rand -base64 48 > tmpfile` (a redirect,
not argv) in a `umask 077` subshell, is `chown grinplay:grinpool` + `chmod 0440` **before** the
rename, and is never read into a shell variable. P → 5 and P → 7 read it inside `node`, which is
given the file PATH, and print one word. The unit carries only `GAMES_LINK_SECRET_FILE`.

**Unit** (`/etc/systemd/system/grin-games[-testnet].service`): `User=grinplay`, the six variables
`lib/config.js` knows (`GAMES_NET`, `GAMES_PORT`, `GAMES_DB`, `GAMES_LINK_SECRET_FILE`,
`GAMES_GAMES_DIR`, `POOL_INTERNAL_URL` from pool.json `service_port`) + `NODE_ENV`, `ExecStart=node
--disable-warning=ExperimentalWarning index.js`, `Restart=on-failure`, `RestartPreventExitStatus=78`,
`StandardOutput/StandardError=append:` the log, every D16 limit, plus `PrivateDevices`,
`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`,
`LockPersonality`. `ReadWritePaths=-<data dir>` only. No `Requires=`/`BindsTo=` in either direction.
Logrotate uses `copytruncate` (no reopen signal exists; systemd holds the descriptor).

**nginx.** Zones `<svc>_games` 600 r/m and `<svc>_gamelogin` 20 r/m in
`/etc/nginx/conf.d/script07-<svc>-games.conf`. Snippet
`/etc/nginx/snippets/script07-<svc>-games-locations.conf`: `= /play` (301), `^~ /play/api/login`
(4 KB), `^~ /play/api/` (64 KB), `^~ /play/games/` (frames: no common snippet, own nosniff /
Referrer-Policy / HSTS + the frame CSP), `^~ /play/` (shell: common snippet + shell CSP). The two
static locations use the pool's `<svc>_static` zone. In `pool_setup_nginx`'s `:443` block, before
`location /`: `location ^~ /internal/ { return 404; }` and `include
/etc/nginx/snippets/script07-<svc>-games-*.conf;`. **The route check** runs `curl --resolve
<domain>:443:127.0.0.1`, so a CDN cannot answer for the origin: `/play/` (200, or 403/404 = no shell
yet), `/play/api/health` (200, or 502 = games stopped), `/internal/x` and `/internal/games/config`
(both must be 404, else it is an error).

**Backup / restore (D18).** `_pbk_make_tar` adds a snapshot of `$PGS_DB` through the SQLite backup
API, in the same stage dir, appended after `pool.db`. It is best effort: a failure is a warning and
never rc 2. No `cp` fallback, unlike `gbe_snapshot_db`: a raw copy of a live WAL DB is not a
snapshot. `-wal`/`-shm` a root open may create are chowned back to `grinplay`. The daily cron
wrapper does the same, logging `WARN` lines. `_pbk_restore_extract` **excludes** the games DB, and
both `pbk_restore` and Migrate IN then call `pgs_restore_db_from_archive`: `[Y/n]` (EOF declines),
stop games, move the old DB **with its sidecars** aside to `grinium-games.db.pre-restore[-wal|-shm]`,
place the restored file, `chown grinplay` 600, start games again if it was running. On a box without
the games yet, the file lands root-owned and P → 1 takes ownership.

*Hub move (2026-10-12).* Migrate OUT step 4 now stops **and disables** `$PGS_SERVICE` after the pool
(nginx stays up there on purpose, so a running games service kept serving `/play/` on the old box,
and every game finished after the step-6 snapshot was left behind); the state screen and the
rollback list it. Before any stop it removes the games VACUUM cron and refuses while a games VACUUM
runs — that script restarts the games from an EXIT trap, the same trap as the pool's (audit Part 9 P1). `_pmg_verify_archive` requires `$PGS_DB` in the archive whenever the games are
installed and the DB exists — best effort is right for a daily archive, not for a move, and the
usual cause of a missing snapshot is no `python3` (`pgs_snapshot_db` uses it). On the IN side
`pgs_restore_db_from_archive` sets `PGS_RESTORE_RESULT` (`absent` / `declined` / `restored` /
`failed`) and writes `.restore-info`; Migrate IN names the outcome in its "Restored:" line, the
migrate log and a step 7 on its final screen (P → 1 + P → 3 when restored, P → 9 when not).

**Cron.** `C) Cron` → 3 (shown only when games is installed): weekly games VACUUM, Sunday **03:30**
UTC (the pool's is 03:00), stops the games only, runs the VACUUM **as `grinplay`** via `runuser` from
`/`, restarts from a trap.

**Cleanup.** `Z) Cleanup` shows two presence marks and runs group **1b** (everything but the DB,
`[Y/n]`) and **1c** (the DB, `[y/N]`, default KEEP) right after the services group, while the pool
vhost that includes the snippet still exists.

**Verified locally:** `bash -n` on the pool script and the three touched libs; the snippet heredoc
rendered with the mainnet constants and read; `_pgs_stage_trees` run against the checkout (stage
layout + `version.js`). **Owed on the VPS (checkpoint A):** everything else, including that the
glob include matching nothing passes `nginx -t`, `MemoryMax` on the box's cgroup, `runuser` present,
and the frame CSP's `sandbox` directive not breaking the chess frame (Part 6).

### As built vs the design (§19.15)

**Part 3 — operator side (2026-09-27, not VPS-tested).** NEW `scripts/lib/07_lib_pool_games.sh`
plus hooks in the pool script, `07_lib_pool_backup.sh` and `07_lib_pool_migrate.sh`; as built in
impl §10.13 *Operator side*. What changed against §19.3, §19.12, D16 and D18:

1. **The unit writes to the data dir only.** D16 said "the data dir + log dir". stdout/stderr go to
   the log through `StandardOutput=append:`, which systemd opens as root before dropping to
   `grinplay`, so the service never needs write access to `/opt/grin/logs`, and does not get it.
2. **Hardening beyond D16:** `PrivateDevices`, `ProtectKernelTunables`, `ProtectKernelModules`,
   `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`. All are safe for Node. Not
   `MemoryDenyWriteExecute`, which breaks V8's JIT. No `Requires=`/`BindsTo=` on the pool unit in
   either direction. Part 1's open items are closed here: `RestartPreventExitStatus=78` (#2), only
   known `GAMES_*` keys are set (#3), and `--disable-warning=ExperimentalWarning` on `ExecStart`
   (#12).
3. **pool.json is the source of truth for the port and the link path.** The installer writes
   `games_port` / `games_link_secret_file` only if absent (as §19.3 says), and when they ARE present
   the unit follows them rather than the lib's defaults. A value the pool would reject (Part 2 #1)
   stops the install with the reason. `games_port` joined `pool_write_conf_key`'s numeric set, so it
   is stored as a JSON number.
4. **Link secret: temp file + rename, not `install`.** `openssl rand -base64 48` is redirected into
   a `mktemp` file in the same directory under `umask 077`, which gets `grinplay:grinpool 0440`
   before the rename. The secret never enters argv or a shell variable. P → 5 and P → 7 read it
   inside `node`, given only the path. The installer also adds `o+x` to `/opt/grin/conf`: `grinplay`
   must traverse it to reach its file. `mkdir`'s default 755 usually gives that already, but nothing
   in the toolkit guaranteed it.
5. **Deploy stages both trees, then one `rsync --delete` each.** A second rsync into
   `<code>/games/` after the first would have deleted and recreated it on every deploy. Game folder
   names must match `^[a-z0-9][a-z0-9_-]{0,31}$`, or they are skipped. A stray `node_modules` in
   `server/` is dropped. `pgs_deploy_code` refuses outright if the data dir ever sits inside a deploy
   target, which is D3 enforced where it could break.
6. **`version.js` is `window.GRIN_PLAY_VERSION = "<12 hex>"`**, a sha256 over both staged trees.
   **Part 6 must load `/play/version.js` and use it as its cache-bust query.**
7. **nginx, three refinements.**
   - The frame CSP ends with `sandbox allow-scripts`. That repeats the iframe attribute for a frame
     opened directly in a tab, where no attribute applies.
   - `Cache-Control: no-cache` is on every file under `/play/` and `/play/games/`, not only
     `*.html`, the same as the pool's own `location /`. It covers `version.js` itself.
   - The shell CSP keeps the page CSP's Google Fonts hosts, so the pool's fonts render. It drops
     every analytics host and `'unsafe-inline'`.
   Both static locations use the pool's `<svc>_static` zone. **Frames must use classic scripts**:
   a module script fetched from an opaque origin needs CORS, and this location sends none (Part 6).
8. **The route check goes through the local listener** (`curl --resolve <domain>:443:127.0.0.1`), so
   Cloudflare cannot answer in the origin's place. It also checks `/internal/games/config`, the
   exact path a leak would expose, not only `/internal/x`.
9. **A vhost written before Part 3 has no include.** P → 3 detects that and offers to regenerate
   it through `4) Setup nginx`, which is an nginx reload, not a pool restart. If the operator
   declines, the snippet stays on disk, unused and harmless.
10. **Restore (D18) happens after the main extraction, never inside it.** `_pbk_restore_extract`
    excludes the games DB. Both `pbk_restore` and Migrate IN then call
    `pgs_restore_db_from_archive`. A plain extraction would have written under a running games
    service and next to a stale `-wal`, which SQLite would then replay onto the restored file. The
    function stops games, moves the old DB and its sidecars aside as
    `grinium-games.db.pre-restore[-wal|-shm]` (one generation kept), and places the file. An EOF on
    the `[Y/n]` declines. The question is skipped after a failed pool extraction.
11. **Snapshots use the backup API with no `cp` fallback**, unlike `gbe_snapshot_db` for `pool.db`.
    For a best-effort extra, "no games data" is better than "maybe-torn games data". `-wal`/`-shm`
    created by the root-side open are chowned back to `grinplay`. **The daily cron wrapper includes
    the games DB too**, and P → 1 regenerates the wrapper when a schedule is on, because the wrapper
    is written once and would otherwise never learn about the games.
12. **Weekly games VACUUM: Sunday 03:30 UTC**, half an hour after the pool's, run as `grinplay` via
    `runuser`, so the rewritten file and any sidecar stay the service's. `pgs_status` reads
    `schema_version` the same way, as `grinplay`, for the same reason (the pool's §J16-8 trap).
13. **Cleanup prompts:** group 1b (everything but the DB) is `[Y/n]` like its neighbours. 1c (the DB)
    is **`[y/N]`, default keep**: it is player history, not rebuildable state. Uninstall (P → 8)
    likewise keeps the DB unless confirmed, and keeps the `grinplay` user and the pool.json keys.
    Both remove the link file; the pool then answers `link_not_configured` and the probe hides the
    nav.

---

# Build notes — obstacles & lessons

One entry per real obstacle hit while building `/play/`: **Symptom** · **Cause** · **Fix** ·
**Lesson**, grouped by subject. The hash is the first commit that carries the fix. The per-part status
table and the three review records (the 20 threat notes answered, the probes, the judged departures)
are in git: `git show e8932ab:docs/reference/script07_implementation_games.md`, *Build notes (raw)*.
Audit ids (`P11-1`, `R1-1`, `R2-1`) are rows in the Status roll-up of
[`script07_security_audit.md`](script07_security_audit.md). The pool's own list →
[`script07_implementation.md`](script07_implementation.md).

## Pool link

### A compromised games process could stall the pool
**Symptom:** found in review — unbounded scrypt proof checks and activity queries on the process
that serves stratum. **Cause:** the pool's throttles were per IP, and the games caller supplies
`client_ip`. **Fix:** global caps keyed on nothing a caller controls — verify ≤ 4 in flight and
120/min, activity 60 per 5 min → `429 busy`; a `[games-link] … over its global cap` log line means
stop the games service (`P → 4`) and read its log (`f5bb15c`).
**Lesson:** a limiter keyed on a value the caller chooses limits only honest callers.

## Matches, points & boards

### A free bot game was an unlimited win tap
**Symptom:** with `bot_play_cost` 0, level-1 bot wins fed the wins boards and events, whose rewards
skip the daily points cap. **Cause:** `settle` stopped paying points for a free match but still wrote
`results_daily`. **Fix:** a cost-0 match writes no row; void decrements only rows `settle` counted
(`f5bb15c`). **Lesson:** closing a bypass on one table means checking every table that pays.

### The docs said a settings change never touches the past
**Symptom:** text and code disagreed. **Cause:** credits come from the day's running total, so a
change re-rates the current UTC day. **Fix:** the text now says so (`f5bb15c`).
**Lesson:** "never retroactive" needs the unit: here, never an earlier day.

## Names

### The pool's own name stopped being reserved
**Symptom:** `Night Owl Mining!` or a name with `™` or an emoji let a player or donor take the pool's
name (R1-1). **Cause:** the fold returned `null` — reserve nothing — for any character outside
`a–z 0–9`. **Fix:** strip accents, fold, then drop the rest; both copies of `name-rule.js` + the
shared fixture (`a6b0e1b`). **Lesson:** a protective fold that cannot handle input must fail closed.

### Two real words refused by the substring rule
**Symptom:** `Penistone` and `Supportive` refused (R1-2). **Cause:** substring matches inside longer
words. **Fix:** `peniston` and `supportiv` exceptions, scoped to their own occurrence (`a6b0e1b`).
**Lesson:** keep an innocent-names list in the fixture beside the adversarial one.

## Guest accounts

### A parallel burst raced the per-name password budget
**Symptom:** 60 of 60 concurrent wrong guesses evaluated against a budget of 20 (R2-1).
**Cause:** the budget was peeked before the scrypt `await` and taken after a failure, so a burst
passed on one token. **Fix:** take the token before the await and `refund()` it unless the attempt
was a wrong password; the current-password check is single-flight per account (`a6b0e1b`).
**Lesson:** a check-then-act limiter across an `await` is a race; reserve first.

### The sign-up proof-of-work is a speed bump, not the Sybil control
**Symptom:** WebCrypto was too slow for the browser solver. **Cause:** per-call overhead. **Fix:** a
plain-JS SHA-256 midstate solver; the server verifies with Node's SHA-256 (`a6b0e1b`).
**Lesson:** ~0.5 s in a browser is ~0.02–0.05 s native, so the per-/24 sign-up limit is the real
control; size the difficulty on a real phone.

## Front end & probes

### Relative links broke on blog permalinks
**Symptom:** shell links pointed under `/blog/<slug>/`. **Cause:** relative hrefs in
`public-shell.js`. **Fix:** site-absolute hrefs. **Lesson:** a shared header uses absolute paths.

### The CMS sandbox is the missing `allow-scripts`, not the page CSP
**Symptom:** operator HTML in CMS bodies ran on the pool origin (D22-4). **Cause:** `innerHTML`.
**Fix:** a `srcdoc` frame without `allow-scripts`; attacked in headless Edge with a `javascript:` link
and controls (a plain link navigates; the same link in a scripted frame runs) (`a6b0e1b`).
**Lesson:** an attack probe needs a positive control, or "nothing ran" proves nothing.

### Headless Edge clamps the window to ~492 px
**Symptom:** a "390 px" screenshot looked like the nav caret was cut off. **Cause:** `--window-size`
is clamped, so the shot is a 492 px layout cropped. **Fix:** measure inside a real 390 / 360 px iframe.
**Lesson:** check the viewport a headless browser actually gave you.

### "Within seconds" was really "within 60 s"
**Symptom:** a launch flip moved the server's answer at once but browsers kept the old nav.
**Cause:** `/api/public/branding` is `Cache-Control: public, max-age=60`. **Fix:** acceptance
expects ≤ 60 s. **Lesson:** state a propagation time from the cache header, not the server.

### A test total that missed a suite
**Symptom:** a summed pool total read 2753 / 27 suites instead of 2795 / 28. **Cause:** one suite
prints "42 ownership-gate checks passed", not "N passed". **Fix:** count from each suite's own
result. **Lesson:** a grep-and-sum of test output is not a test count.

---

# Open items

- **Nothing has run on a VPS.** Every part above is built and not VPS-tested; the mainnet acceptance
  run (the first-release list together with the open-community additions) has not been done. Each
  part's own *Owed on the VPS* / *Not done* lines say what it needs.
- **Still to decide at the mainnet acceptance:**
  - **Moderator inheritance (threat note #20, D21).** The aged-proof + password gates *delay* a
    stranger who mines to a moderator's address with their own non-trivial rig password; they do not
    stop one. After `chat_min_proof_age` that stranger holds the moderator's powers, logged as
    `mod:<the moderator's address>` — indistinguishable in the mod log. Bounded: chat only, mutes
    ≤ 24 h, every action reversible and logged, no full addresses. Recommendation: accept for v1; if
    not, record the acting session's `ip_coarse` / `ua_hint` in the mod-log row.
  - **Sign-up PoW difficulty:** after timing a guest sign-up on a real phone, consider raising
    *Games → Overview → Guest accounts → Sign-up proof-of-work difficulty* from 18 to 20 bits; the
    3-sign-ups-per-network-per-day limit is what really stops mass sign-ups.
- **Not tested anywhere yet:** the CMS-body sandbox in Firefox and Safari; a real phone; a browser
  render of Games → Overview's Launch card, Games → Nicknames, Donors' name lists, Settings → Names
  and the /play/ Nickname fold.
- **Accepted (recorded so nobody re-derives them):**
  - Name-rule residues: `F4ck` / `fvck` pass (only six digits fold); `Guesthouse` is refused by
    the `guest` prefix rule that protects `Guest-XXXX`; impersonation words not on the reserved
    list pass (`PoolOwner`, `ModTeam`). Post-moderation is the designed answer.
  - Donor names have no cross-address unique index (the matching form is JS); the guarantee is that
    `submitName` runs as one synchronous transaction in the pool's single process. Revisit if the pool
    ever runs more than one process.
  - Guest residues: a stranger who keeps a name's failure budget drained makes its owner wait on a /24
    it never signed in from, and a stranger inside the owner's /24 skips the per-name budget (per-IP
    locks still apply); the PoW used-set (50 000) fails closed, so ~2,500 IPs could turn sign-up
    `busy` for everyone (`guest_signup_enabled` is the operator's switch); aged guests can fill the
    report queue (noise, never a hold) and farm PvP points/Elo within `pair_rated_daily` and 5
    tickets a day; the bubble header shows the viewer's own sign-in name on every page — a one-line
    change to show the live nickname instead, if preferred.
  - Every match is enumerable (`GET /play/api/matches/:id` is public, ids sequential); the view
    carries masked labels only, and a public read may finalise a passed deadline (idempotent).
  - Plays ledger: kept, no rollup in v1 (≈ 0.5 M rows a year at 50 active miners). The hourly
    `verify()` has a 5 s budget; its `over budget` warning is the trigger to build a checkpoint
    rollup.
  - Rated-pair recompute order within one second, a void that keeps the result and clamps the
    reversal, and multi-address farming bounds: accepted as designed (points are worthless, D1).
