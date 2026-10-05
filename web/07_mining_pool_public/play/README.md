# /play/ — the pool's games platform

Games, events and a moderated chat for the public pool, served under `/play/` on the pool's
own domain. **The contract is [`docs/generated/script07_design.md` §19](../../../docs/generated/script07_design.md)**
— decisions D1–D20, the pool ↔ games routes, the schema, the threat notes and the build
status. This file only tells you where things are.

It is a **separate service** from the pool (`grin-games`, user `grinplay`, its own
`grinium-games.db`), because the pool's stratum server shares one process and one
synchronous database connection with its API: anything slow in there stalls share
submission for every miner (§19.2). Nothing in this folder may slow, restart or endanger
mining.

## Layout

| Path | Deploys to (§19.12) | What |
|---|---|---|
| `server/` | `/opt/grin/pubgames/<net>/` | the service: `node:http` + `node:sqlite`, **zero npm dependencies** |
| `server/lib/` | | `config` (env, validated) · `db` (open, pragmas, migrations) · `http` (router, body cap, cookies, client IP, same-origin, errors) · `app` (services, public-route gate, jobs, server, shutdown) · `maintenance` (5-min + hourly jobs) · `log` · `pool-link` (the ONLY way to the pool) · `auth` + `sessions` (login, cookie sessions) · `ratelimit` · `mode` (the pool's off/preview/on) · `plays` (activity sync) · `ledger` (plays/points, Σ invariant) · `settings` (games-owned knobs) · `mask` · `registry` (loads `games/<id>/`; rules.js runs in a sandboxed vm context) · `matches` (the `match` kind: bot games and PvP correspondence — seeks, challenges, draw/abort/timeout, the rated pair cap, admin void) · `ratings` (Elo, derived, recomputable) · `leaderboard` · `events` + `events/` · `chat` · `moderation` · `names` + `name-rule` (nicknames, checked automatically and live at once; `label()` is the ONE public name — the mask, or `Nick (mask)`; the rule is copied in `back-end-pool/lib/name-rule.js`, both run `scripts/fixtures/name-rule.json`, design §19.17.5) · `admin` (the `/internal/admin/*` guard) · `badges` |
| `server/scripts/` | | `check-syntax.js`, `run-tests.js`, `test-*.js` |
| `shell/` | `/var/www/grin-play[-testnet]/` | the `/play/` page: `index.html` (the pool header/footer via `/js/public-shell.js`, no inline script — its CSP has no `unsafe-inline`) · `js/play-api.js` (the only API client; non-JSON = offline) · `js/frame-host.js` (the sandboxed frame + §19.7 message filter) · `js/play-shell.js` (the page controller, the board, the PvP polls) · `js/play-boards.js` (leaderboards + events) · `js/play-chat.js` (chat + the moderator queue) · `js/play-lobby.js` ("Play a person": seeks + challenges) · `js/play-names.js` (the Nickname fold) · `css/play.css`. Own asset URLs end `?v=__GRIN_PLAY_VERSION__`, stamped at deploy |
| `games/<id>/` | manifest + `rules.js` → code dir; `frame/` + `rules.js` → web dir | one folder per game: `manifest.json` + `rules.js` (pure, deterministic, UMD) + `frame/` (`index.html` + `game.js` + `game.css`: runs in `<iframe sandbox="allow-scripts">`, classic scripts only, draws the `state` it is sent and posts back a `move` — never an authority). `chess/` is the first |

The database lives in `/opt/grin/pubgames-data/<net>/`, **outside** the code dir: the code
dir is `rsync --delete`d on every deploy, and the config refuses a DB path inside it.

## Rules

- **Never import from `../back-end-pool/`**, and never open `pool.db`. The pool is reached
  only through its three internal routes (§19.3). The two services deploy separately; copy
  a pattern if you need one, with a comment saying where it came from.
- **Zero dependencies.** Every `require` is `node:*` or a relative path inside `server/`.
  The test suite enforces it.
- The service binds `127.0.0.1` only; nginx is the only way in.
- Schema changes are a new numbered migration in `server/lib/db.js` — never an edit to a
  shipped one — plus the matching change to §19.4's SQL block. The suite checks the two
  against each other.

## Add a game

A game is **one folder** under `games/`. Nothing in `server/`, `shell/` or the bash lib changes
for a game of a kind the platform already runs — today that is only `match` (two seats, turn by
turn, the server applies every move; D20, §19.7–§19.8). Work through this list in order.

1. **Check the kind first.** A turn-based, deterministic game with two seats is a `match`. A
   single-player score game (`skill`: the server replays an input log) or a drawn-outcome game
   (`chance`: commit, then reveal) is **not buildable as a folder yet**: those kinds are
   reserved and the registry refuses them. Their platform part is built WITH their first game —
   migration 3 (`rounds`), the registry kind, round start/submit routes, a score board, shell
   support — as its own design + build session (§19.8 "Reserved kinds"). Do not bend a score
   game into `match` to dodge that: `match` settles win/draw/loss, never a score.
2. **Folder** `games/<id>/`, `<id>` matching `^[a-z0-9-]{2,32}$` (the registry's rule; the deploy's
   own regex is looser, so a folder the registry refuses is copied and then skipped with a log
   line — read the service log after a deploy).
3. **`manifest.json`** — every key below, and no other (an unknown key refuses the game):

   | Key | Rule |
   |---|---|
   | `id` | the folder name |
   | `title` | 1–40 printable characters |
   | `kind` | `"match"` |
   | `version` | 1–16 of `[A-Za-z0-9._-]`; recorded per match, never enforced (a bump continues live matches under the new rules) |
   | `seats` | `2` |
   | `modes` | a non-empty subset of `["bot","pvp"]` |
   | `bot_levels` | distinct integers 1–9 — only with `"bot"` |
   | `move_pattern` | an anchored regex source `^…$`, ≤ 200 chars; the server and the frame both check moves against it |
   | `move_seconds_options` | 1–8 distinct integers, 60 s – 30 days; the PvP form offers exactly these |
   | `default_move_seconds` | one of the options |
   | `max_plies` | 2–2000; the platform draws the game there whatever rules.js says |
   | `points` | `{ "bot": { "<level>": n, … } }` for bot, `"pvp_win"` + `"pvp_draw"` for pvp, each 0–1000 |

4. **`rules.js`** — UMD, pure, deterministic: no I/O, no `Date`, no `Math.random` (seed your own
   PRNG from the `seed` argument), no globals. The registry evaluates it in a sandboxed `vm`
   context that enforces this, and smoke-tests it on the start position at boot. The API:
   `initial(params) → position` · `toMove(position) → 1|2` · `legal(position) → move[]` ·
   `apply(position, move) → position | null` (null = illegal; apply ONLY the one matching
   move — every move replays the whole match through it) · `status(position, history) →
   { over:false } | { over:true, result:'seat1'|'seat2'|'draw', reason }` (`reason`
   `^[a-z_]{1,16}$`) · `bot(position, level, seed, ply) → move` when `modes` has `"bot"`
   (deterministic, inside a node budget). Positions ≤ 512 chars, moves ≤ 16. A throw is caught:
   the match is left unchanged and the request answers 500 `game_error`.
5. **`frame/`** — `index.html` + `game.js` + `game.css`, classic scripts only, own URLs ending
   `?v=__GRIN_PLAY_VERSION__`, no inline script or handler, no HTML sink. It runs in
   `<iframe sandbox="allow-scripts">` with `connect-src 'none'`: it gets no cookie and can reach
   nothing. Protocol `1`, exact keys, from `window.parent` only: it posts `ready {protocol}` and
   `move {move}`, and draws every `state` it is sent (`position, last_move, you, to_move, legal?,
   status, labels`) and `theme {mode}`. Resign, draw, abort and accept are shell buttons, never
   frame messages. Copy `games/chess/frame/` as the starting point — its validators are the
   pattern (§19.7).
6. **Tests** — copy `server/scripts/test-matches.js` [a]–[c] for the rules (a perft-style count
   or an exhaustive small-board check proves legality better than examples), determinism of the
   bot across runs, and "a forged body is refused". The platform's own tests (bot and PvP flows,
   refunds, ratings) already cover every game of the kind. Run `npm test`.
7. **Deploy** — the pool menu's `P` deploy (or `9) Deploy new code`, which deploys the games at
   its end) stages `games/<id>/{manifest.json,rules.js}` into the service and
   `games/<id>/{frame/**,rules.js}` into the web root, then restarts `grin-games` only — never
   the pool. The registry reads game folders at boot, so a game appears after that restart; the
   picker, the leaderboards and the admin pages list it on their own.

## Tests

```bash
cd web/07_mining_pool_public/play/server
npm test          # syntax check of every .js (server, shell, games), then every scripts/test-*.js
```

The suites start servers only on `127.0.0.1:0` and close them, use temp DB files under the
OS temp dir, and leave nothing running.
