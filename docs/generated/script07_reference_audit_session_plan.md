# Script 07 — Public Mining Pool: Pre-Mainnet Security Review Session Plan

**Created:** 2026-08-25 · **Branch:** `add-ons` · **Status:** **ALL 17 SESSIONS RUN** (J1 2026-08-25 → J17 2026-09-04). Findings live in `script07_security_audit.md` §J1–§J17.
**§J17's verdict is NO-GO for mainnet** — see its Phase 0 list. This file stays as the map and the record of what each session was asked to cover; the tracker in section 4 is the current state.

This is a **run plan**, not a findings document. Findings from every session below go into
`docs/generated/script07_security_audit.md` as a new **§J** pass (§J1 … §J17), continuing the
existing §A–§I lettering. Keep the two files separate: the audit doc is the evidence record,
this file is the map of what still needs looking at and in what order.

---

## 0. Why this pass exists

The pool has had eight prior audit passes (§A–§I, last 2026-08-21). All of them were
**desk audits of code that has never handled real money.** The pool is about to touch
mainnet, so this pass is deliberately structured as **one narrow scope per chat session**,
because the backend is too large for a single context:

| Surface | Size |
|---|---|
| `back-end-pool/index.js` | 6,247 lines, ~180 Express routes (102 under `/api/admin`) |
| `back-end-pool/lib/` | 40 modules, ~17,400 lines |
| `back-end-pool/admin-panel/` | 21 HTML pages + 2,409 lines of JS |
| `public_html/` | 13 HTML pages + ~5,900 lines of JS |
| **Total in scope** | **~35,000 lines** |

A single "review the backend" session reads maybe 15% of that and reports confidently on
the rest. Seventeen scoped sessions read all of it.

---

## 1. Session table

Run **J1 first** — it produces the route/guard matrix that five later sessions consume.
Run **J17 last**. Everything between J2 and J16 is independent and can run in any order or
in parallel chats.

| # | Session | Primary scope | Core question | Tier |
|---|---|---|---|---|
| **J1** | **Route & guard matrix** | `index.js` (all ~180 routes), `lib/auth-middleware.js` | Is every route on the *correct* tier — `public` / `secureAdmin` / `freshAdmin` / owner-gated? Produce the committed table. | **P0** |
| **J2** | **Auth, session & 2FA** | `lib/auth.js` (702), `lib/totp.js`, `lib/captcha.js`, `scripts/admin-reset.js`, `/api/auth/*`, `/api/admin/2fa/*`, `/api/admin/reauth` | Can anyone get an admin session they shouldn't have, or keep one after they should have lost it? | **P0** |
| **J3** | **Ownership gate & account API** | `lib/owner-proof.js` (486), `index.js:2832–3798` (`/api/account/:addr/*`) | Can miner A act on miner B's balance? Can an address be spelled two ways? | **P0** |
| **J4** | **Payout execution** | `lib/withdrawal-scheduler.js` (1512), `lib/wallet.js`, `lib/wallet-tor.js`, `lib/nostr-payout.js`, `lib/dormancy.js` | Can one balance be paid twice, or a lock leak, or a send land without being recorded? | **P0** |
| **J5** | **Reward & orphan ledger** | `lib/rewards.js`, `lib/blocks.js`, `lib/block-monitor.js`, `lib/orphan-detector.js`, `lib/reconciliation.js`, `lib/ledger-rollup.js` — **includes the 4 uncommitted files** | Can GRIN be credited that the chain never paid, or an orphan reversal double-charge? | **P0** |
| **J6** | **Stratum & share intake** | `lib/stratum-server.js` (714), `lib/stratum-protocol.js`, `lib/node-stratum-client.js`, `lib/shares.js`, `lib/hashrate-tracker.js` | Can a miner forge share weight, or one connection exhaust the box? | **P0** |
| **J7** | **DB layer, SQL & amount arithmetic** | `lib/db.js` (1148), `lib/sqlite-compat.js`, every call site | Any unparameterised SQL, dynamic `ORDER BY`, or float arithmetic on nanogrin? | **P0** |
| **J8** | **Secrets & key management** | `.env`/config load, JWT signing key, `.api_secret` handling, wallet password on disk, `lib/alert-delivery.js` creds, file modes | Where does every secret live, who can read it, and does any of it reach a response body or a log line? | **P0** |
| **J9** | **Settings & config integrity** | `lib/config.js`, `lib/pool-settings.js` (1456), `/api/admin/settings/:section*`, `.config.sha256` | Can a settings write turn a security switch off, or a quoted `"false"` turn one on? | P1 |
| **J10** | **Uploads, assets, CMS & ads** | `lib/asset-manager.js`, `lib/ads.js`, `lib/pages.js`, `lib/posts.js`, `/uploads` static, multer config | Path traversal on delete, SVG/HTML upload → stored XSS, CMS content into public pages. | P1 |
| **J11** | **Public API leakage & privacy** | All `/api/public/*`, `/api/pool/*`, `lib/geoip.js`, `lib/retention.js`, `lib/ip-filter.js` | What does an anonymous scraper learn — addresses, balances, IP linkage, node internals? | P1 |
| **J12** | **Rate limiting & resource exhaustion** | `lib/rate-limiter.js` (394), bucket assignment across all routes, `trust proxy` chain | Which route is the cheapest way to burn the box's CPU, RAM, or disk? | P1 |
| **J13** | **Outbound calls, SSRF & dependencies** | `lib/grin-node.js`, `lib/poolstats-reporter.js`, `lib/alert-delivery.js`, `lib/nostr-payout.js`, price fetch, `package.json` | Can an operator-set URL be pointed at the node's Owner API or a cloud metadata endpoint? Are the 12 deps clean? | P1 |
| **J14** | **Admin panel front-end** | `admin-panel/admin-shell.js` (1008), `settings-common.js` (1274), `cms-editor.js`, 21 HTML pages | DOM XSS from server data, token handling, the settings harvester, clickjacking. | P1 |
| **J15** | **Public front-end** | `public_html/` — 13 pages, `js/` (~5,900 lines), esp. `account-settings.html` (1799) | XSS from CMS/branding/region labels; does the money UI ever trust a server string? | P1 |
| **J16** | **Deployment & infra** | `scripts/07_grin_mining_public_pool.sh`, `lib/07_lib_hub.sh`, `lib/07_lib_gateway.sh`, `lib/07_lib_gwctl.sh` (**not** `07_lib_satellite.sh` — that role and file were removed in the Model C refactor), generated nginx vhost, systemd units, file modes | Headers, HSTS, TLS, bind addresses, de-rooting, admin allowlist, gateway/WG edge. (There is no satellite Central-API shared secret to review — see §J16's plan correction.) | **P0** |
| **J17** | **Pre-mainnet operational gate** | All of the above + testnet run | Does the thing actually behave on a box — and is the launch sequence safe? | **P0** |

**Tier meaning.** **P0** = a finding here can move money incorrectly or hand over admin;
mainnet does not start until the session is closed. **P1** = must be closed before the pool
is *advertised*, but a P1 finding does not by itself lose funds.

---

## 2. Shared rules for every session

Paste these into each chat along with the session brief.

1. **Evidence before conclusion.** Every claim cites `file:line`. "Looks fine" is not a
   result — say what you read and what it does. This mirrors the CLAUDE.md debugging rule:
   a plausible suspect is not a confirmed cause.
2. **Do not re-litigate §A–§I.** Items marked FIXED there are closed. Re-open one *only*
   with a concrete demonstration that the fix is wrong or incomplete — and then it is a new
   §J finding, not an edit to the old section.
3. **Report, then fix.** Write the finding first. Apply a fix in the same session only when
   it is small and local; anything structural gets written up and left for a decision.
4. **Append to the audit doc.** New `### §Jn — <topic>` section in
   `docs/generated/script07_security_audit.md`, using its existing severity scale
   (Critical / High / Medium / Low / Info) and its `— FIXED <date>` / `— OPEN` suffix
   convention. Mark everything `add-ons, NOT VPS-TESTED` unless J17 proved otherwise.
5. **Nothing runs on a VPS, and nothing long-running runs locally.** Static reading plus
   one-shot `node -e` / `bash -n`. No `node index.js`, no `http.server` — per CLAUDE.md's
   local-process rule.
6. **Scope discipline.** Read outside your file list to *understand*; report findings only
   inside it. A cross-cutting observation goes in a `Handoff` note naming the session that
   owns it, so the same bug isn't written up three times.
7. **State the threat actor.** Anonymous internet / registered miner / satellite gateway /
   logged-in admin / on-box root. A "finding" that requires root on the box is an Info note.

### Session prompt template

```
Security review session §J<N> for the Grin public mining pool, pre-mainnet.

Read docs/generated/script07_reference_audit_session_plan.md — its §J<N> row in the session
table and the matching detail block in section 3. Execute exactly that scope.

Then read the prior passes in docs/generated/script07_security_audit.md (§A–§I) so you do not
re-report closed items, and recall the relevant project_pool_* memories.

Follow the shared rules in section 2 of the plan. Append your findings to
script07_security_audit.md as §J<N>. Report the threat actor for each finding.
```

---

## 3. Session detail — what each one actually checks

### J1 — Route & guard matrix *(run first)*

The map the rest of the pass reads from. Current state, measured 2026-08-25:
`secureAdmin` 68 routes, `freshAdmin` 31, `freshAdminEnroll` 2, bare `requireAdmin` 1
(`/api/admin/_authcheck`), `rateLimiter`-first 44, remainder unguarded-by-design public GETs.
All 102 `/api/admin` routes carry *a* guard — so this session is about the **right tier**,
not missing ones.

- Build the full table: method · path · first middleware · effective tier · money-touching? ·
  destructive? · expected tier · verdict. Commit it into the audit doc as §J1.
- Every route that moves GRIN, changes a payout destination, or is destructive must be
  `freshAdmin` (step-up + mandatory-2FA gate) — or must call `stepUpRefused()` on the
  sensitive branch. `index.js:822–840` explains why the inline variant exists; §I7 was the
  bug where an inline copy dropped `requireTotpEnrolled`. **Grep for every remaining inline
  `isTokenFresh(` call** and confirm each one is `stepUpRefused`, not a hand-rolled copy.
- Check the `secureAdmin` vs `freshAdmin` split against intuition for: withdrawals
  retry/cancel, payout freeze/resume, dormancy manual-payout/send-payout, wallet
  adopt-identity, miner ban/inject, incentives award, prize-pool topup, lottery draw-now,
  campaign run, database cleanup, revoke-sessions, ip-allowlist mutations, settings restore.
- Verify the 404 fallthrough (`index.js:6237`) cannot leak route existence, and that
  `/api/admin/_authcheck`'s deliberately-cheap guard (documented `index.js:4925`) is
  genuinely side-effect-free.
- **Deliverable other sessions need:** the committed matrix + a list of every money-touching
  route path.

### J2 — Auth, session & 2FA

Threat actor: anonymous internet, and a stolen-session attacker.

- **JWT:** where does the signing secret come from, what is its entropy, is it persisted or
  regenerated on restart, is `algorithm` pinned on *verify* (alg-confusion / `none`), is
  `expiresIn` set, are `iss`/`aud` checked?
- **Token lifecycle:** §C3 is the known open item — access tokens survive logout and
  password change until expiry. Re-confirm the bound (memory `project_pool_admin_session_idle`
  caps idle at ≤24h *because* tokens are unrevocable) and check whether
  `/api/admin/security/revoke-sessions` actually revokes anything or only clears cookies.
- **Refresh:** `/api/auth/refresh` — is the refresh token rotated, single-use, bound to the
  session, and does it re-mint `pwa` (password-freshness) freely? A refresh that resets `pwa`
  would defeat every step-up gate.
- **Login:** lockout is per-`(username,IP)` (memory `project_pool_admin_login_security`) —
  confirm the counter can't be reset by rotating IPs against one username, that timing is
  constant-ish between "no such user" and "bad password", and that `login_failed` is the
  audit action actually written.
- **TOTP:** window size (replay inside the step window?), secret storage at rest, recovery
  codes single-use and hashed, enrollment-confirm binds the secret to the *confirming* user,
  `disable` requires step-up.
- **CAPTCHA:** `lib/captcha.js` is 59 lines — check the challenge can't be replayed or
  solved offline, and that `isLocalRequest()` (`index.js:247`) is the only bypass.
- **First-admin race:** `/api/auth/register` is a `SELECT COUNT(*)` then `registerAdmin()` —
  a documented TOCTOU. Decide whether to close it in code or hold the launch procedure
  (see J17); the audit doc's re-test note currently relies on procedure.
- **Break-glass:** `scripts/admin-reset.js` — on-box only, no network path, and does it log?

### J3 — Ownership gate & account API

Threat actor: a registered miner attacking another miner. Read memory
`project_pool_account_page` and audit §E, §E.1, §E.2, §F2 first.

- **Address canonicalisation.** The single highest-value check in this session: is
  `:addr` normalised identically at every call site — the gate, the balance read, the
  withdrawal write, and the audit row? Case, whitespace, URL-encoding, unicode. Two
  spellings that hash differently but resolve to the same wallet = a gate bypass.
- Gate v2 = IP match **or** stratum password. Verify: the password compare is constant-time,
  the IP match uses the same `req.ip` the rate limiter does, and the gate is on **every**
  money route (cross-check against J1's matrix — not a per-route memory).
- One-pending-withdrawal rule and the 30-min failed-payout cooldown (§E.2): can either be
  raced with two concurrent requests? Where is the transaction boundary?
- `/api/account/:addr/tor-check` was a public wallet-uptime oracle (§H3, FIXED) — re-verify
  the fix didn't leave a timing oracle.
- Enumeration: does `/api/account/<garbage>` distinguish "no such account" from "not yours"?
- Nostr destination set/delete (`index.js:3683`, `3763`) — this changes *where money goes*.
  Confirm it is gated at least as hard as `withdraw`.

### J4 — Payout execution

Threat actor: mostly *the system itself* — crashes, retries, races. This is the session where
GRIN actually leaves the pool.

- Re-verify §H1 (retry re-sent without checking the first send landed) and §H2 (finalize +
  TTL sweep both settling one row) — these were Critical, fixed on paper only.
- Draw the **full withdrawal state machine** from the code: every state, every transition,
  who can trigger it, and the DB transaction that guards it. Look for any transition that
  writes the ledger and the status in two separate statements.
- Idempotency: is there a key that makes a re-sent slatepack a no-op? What happens on a
  process kill between "wallet says sent" and "DB says paid"?
- Balance locking: when is a balance locked, when released, and is there a path where a
  crash leaks a lock forever (miner's funds frozen)?
- Fee model (memory `project_pool_fee_model`): % fee at **block maturity**, flat 0.04 at
  payout confirm, `_feeFor` must **not** clamp. Confirm no fee is applied at withdrawal —
  that would replay on orphan reversal.
- Tor pre-flight (memory `project_pool_tor_preflight_gate`): **fails open** when the probe
  can't run. Confirm fail-open is still fail-open and not fail-*silent*.
- Freeze kill-switch: does `payouts/freeze` stop the *scheduler loop*, or only the API? A
  freeze that leaves the background sweeper running is not a freeze.
- Dormancy (`lib/dormancy.js`, 551 lines): the 24-month sweep sends to the **prize pool**,
  never the operator (memory `project_pool_dormant_balances`, marked FINAL). Verify the
  destination is not operator-settable, and that `manual-payout` / `send-payout` can't be
  aimed elsewhere.

### J5 — Reward & orphan ledger *(includes uncommitted work)*

⚠ Four files are modified in the working tree right now — `index.js`,
`lib/block-monitor.js`, `lib/grin-node.js`, `lib/orphan-detector.js` (+197/−38). **Review the
working tree, not HEAD**, and say in the write-up which revision was read.

- §I3 (chain-verify before crediting was dead code), §I4 (distribution not atomic with the
  `confirmed → paid` flip), §I5/§I6 (placeholder zeros, missing account guard) were all fixed
  2026-08-21 — verify the fixes against the *current* working tree, since these files moved.
- Node error classification (memory `project_pool_node_error_classification`): classify by
  **origin, never by message string**. A message-matched guess previously orphaned live
  blocks and reversed payouts. The `grin-node.js` diff is the biggest of the four — check it
  against this rule specifically.
- Orphan reversal: can a reversal debit a balance that was already withdrawn? What happens
  when the reversal makes a balance negative?
- PPLNS window: can a miner influence which shares land in the window (clock, ordering,
  late submission)?
- Reconciliation invariants (memory `project_pool_reconciliation`): coverage / flow /
  integrity. Confirm they'd actually *detect* each of the failures above, not just report a
  total.
- Maturity: 1440 blocks. Confirm the credit path can't run before maturity on a reorg.

### J6 — Stratum & share intake

Threat actor: anyone who can open a TCP socket to :3333.

- Re-verify the hardening from memory `project_pool_stratum_hardening`: dedup key is
  **`pre_pow`, not `job_id`**; 16KB line cap; per-IP and global connection caps; per-message
  token bucket. Confirm each cap is enforced *before* allocation, not after.
- Re-verify `project_pool_stratum_node_jobid`: the pool→node job-id map and nonce-as-string.
  These caused 100% stale/reject, which is an availability bug that looks like an attack.
- Share validation: is difficulty checked server-side against the job's target, or trusted
  from the client? Can a share be replayed against a *different* job?
- Worker names and the login string flow into the DB and then into the admin UI and public
  leaderboards — trace one end to end (hand the render half to J14/J15).
- Memory growth: per-connection state, the job map, the dedup set — what bounds each one?
- Disconnect handling: does a half-open socket hold a slot forever?

### J7 — DB layer, SQL & amount arithmetic

- Mechanical sweep: every `db.prepare`/`.run`/`.all`/`.get` call site for string-concatenated
  SQL. Pay special attention to sort/filter/pagination params on the admin list endpoints
  (`AdminTable` sends `page`/`query` — memory `project_pool_admin_table`).
- **Amounts.** Grin is 10⁹ nanogrin. Find every place an amount is a JS `Number`, and every
  place one is parsed from a request body. `parseFloat` on money is a finding. Check
  rounding direction on fee and on the 0.04 flat.
- Bounds: `LIMIT`/`OFFSET` from user input, negative values, `NaN`, huge values. A missing
  cap here is the DoS in J12 as well.
- `express.json()` is mounted with **no explicit size limit** (`index.js:224`) → default
  100 KB. Confirm that is intentional for every POST body (CMS content? asset metadata?).
- Prototype pollution: `__proto__` / `constructor` keys in any body that gets spread or
  deep-merged — the settings harvester and CMS payloads are the candidates.
- Transactions: are money writes inside `BEGIN`/`COMMIT`, and is the DB in WAL with a busy
  timeout (memory `project_pool_db_capacity` — a full scan on the shared synchronous DB
  stalls **shares**, not just the page).

### J8 — Secrets & key management

- Inventory every secret: JWT signing key, admin password hashes (bcryptjs cost factor),
  stratum passwords, node `.api_secret` / `.foreign_api_secret`, wallet password on disk
  (accepted risk, audit §"Hot wallet"), poolstats API key, alert-delivery SMTP/Nostr creds,
  ads/analytics keys. For each: where stored, file mode, owner, who can read it.
- The pool is de-rooted to a `grinsecret` group (CLAUDE.md) — verify the mode/owner
  expectations in code match what Script 07 actually sets (hand the shell side to J16).
- **Response redaction:** does `GET /api/admin/settings/:section` ever return a secret in
  cleartext to the browser? Same for `/api/admin/poolstats`, `/api/admin/alerts/config`,
  `/api/admin/wallet/identity`. Memory `project_health_api_security` is the reference.
- **Log redaction:** grep every `console.log`/error path for a variable that could hold a
  secret, a slatepack, or a full miner address.
- Wallet identity TOFU pin (memory `project_pool_reconciliation`) — confirm
  `adopt-identity` can't be used to silently re-point the pin.

### J9 — Settings & config integrity

- Memory `project_config_loader_type_traps` is the brief: a **quoted** boolean is truthy, so
  `"false"` turns a security switch **on**, and `key in DEFAULTS` walks the prototype chain.
  Fixed in 052; **this shape is unaudited here.** Check every boolean read in
  `pool-settings.js` and every `getSection(...).x` comparison in `index.js` —
  `totpIsMandatory()` at `index.js:777` already does `String(...) === 'true'`, which is the
  correct shape; find the ones that don't.
- `totpIsMandatory()` **fails open** on a settings read error (documented, deliberate).
  Enumerate every other security switch and decide fail-open vs fail-closed per switch.
- Settings write path: the harvester sends every `id` in `.settings-form` and unknown keys
  throw (memory `project_pool_admin_settings_form`) — confirm the server-side validator is
  the authority, not the form.
- `POST /api/admin/settings/:section/restore` — what does it restore from, and can it roll a
  security setting back without step-up?
- `.config.sha256` integrity check (`hashConfig`, `index.js:239`): what does the app do when
  it mismatches — refuse to start, or warn and continue?
- Section allowlist: is `:section` validated against a fixed list, or does it index an object?

### J10 — Uploads, assets, CMS & ads

- `DELETE /api/admin/assets/:filename` (`index.js:6228`) — **path traversal is the first
  thing to check**; then `POST /api/admin/assets/upload` and `/api/admin/media`.
- multer config: file size, file count, field size, accepted MIME, and whether the extension
  is derived from the client-supplied name.
- **SVG.** Promo art lives in `/promo/` (memory `project_pool_ads_system`) and SVG is
  script-capable. If SVG upload is allowed, the `/uploads` static handler's
  `default-src 'none'; sandbox` CSP (`index.js:765`) is the only thing between it and stored
  XSS — verify that header is on *every* served path including errors, and that nginx doesn't
  serve `/uploads` directly, bypassing Express entirely (hand to J16).
- CMS: `lib/pages.js`, `lib/posts.js` → `/blog/:slug`, `/page.html`, `/blog/rss.xml`,
  `/sitemap.xml`, `/manifest.json`. Operator-authored HTML is presumably trusted, but check
  XML escaping in RSS/sitemap and that `:slug`/`:key` can't traverse or read arbitrary files
  (`fs.readFileSync(path.join(config.web_dir, name))` at `index.js:1420` is the site to read).
- `POST /api/public/ads/event` is an unauthenticated write — what does it insert and what
  bounds it?

### J11 — Public API leakage & privacy

- Known open item (memory `project_pool_ip_privacy`): **`/api/pool/miners` leaks address +
  balance**. §C1 says rate-limiting was added 2026-07-28, not redaction. Decide the final
  disposition before mainnet — on mainnet these are real balances tied to real addresses.
- Sweep every public route for: full addresses, balances, per-miner hashrate, IPs,
  worker names, node internals (peer count, sync state, wallet height), version strings.
- IP privacy: miner IPs scrypt-hashed, geo country-only, audit masked to /24 and /48, 180-day
  retention. Verify each is enforced at the **write** side, not just hidden at read.
- `project_peer_map_location_grouping`: `node_id` must be **salted** or it undoes the /24
  mask. Re-verify.
- `/api/pool/topology`, `/api/network/peers`, `/api/pool/locations` — do these expose the
  satellite/gateway layout an attacker would use to target the hub?
- CORS is `*` on the public prefixes with no credentials (`index.js:268–277`) — confirm the
  prefix list contains nothing that reads a cookie.
- Network map ships **sample data** when feeds are off (memory `project_pool_network_map`) —
  confirm sample data is labelled and can't be mistaken for real on mainnet.

### J12 — Rate limiting & resource exhaustion

- §F1 (money-write routes rode the loose 1200/min `public` bucket) and §F2 (proof throttle
  was per-address only → distributed sweep + scrypt CPU lever) were fixed. **Re-run the
  sweep against J1's matrix**: for every route, name its bucket and justify the limit.
- 44 routes carry `rateLimiter` as the first middleware; the rest inherit or have none.
  Identify the "none" set and confirm each is safe.
- `trust proxy: 'loopback'` (`index.js:223`) — correct and documented. Verify the
  **satellite/gateway** path doesn't arrive over a non-loopback hop that breaks `req.ip`
  (this is where model-C gateways interact with the limiter; memory
  `project_pool_gateway_model_c`).
- Expensive endpoints: `/api/pool/topology`, `/api/pool/metrics/history`,
  `/api/admin/export/*.csv`, `/api/pool/blocks/history`, `/api/pool/effort`. What bounds the
  row count and the response size? Memory `project_pool_db_capacity`: a full scan stalls
  share processing.
- Limiter memory: are the per-IP maps bounded/swept, or is the limiter itself the DoS?

### J13 — Outbound calls, SSRF & dependencies

- Every outbound HTTP: `lib/grin-node.js` (node API), `lib/poolstats-reporter.js`,
  `lib/alert-delivery.js` (SMTP + webhooks), `lib/nostr-payout.js` (relays), the CoinGecko
  price fetch, captcha. For each: is the URL operator-settable, and can it be aimed at
  `127.0.0.1:3413/v2/owner`, a link-local metadata IP, or a unix socket?
- Timeouts, redirect limits, response size caps on every one. `node-fetch@2` follows
  redirects by default — an allowed host that 302s to localhost is the classic bypass.
- CoinGecko **403s without a descriptive User-Agent** and Node's https sends none
  (memory `project_grin_btc_price_source`) — verify the UA is set and that a price-feed
  failure degrades rather than throwing into a money path.
- Nostr relays: `nostr-tools` connects out to operator-listed relays. Goblin rail is **OFF by
  default via four layers** (memory `project_pool_nostr_payouts`) — verify all four.
- Dependencies: `npm audit` on the 12 prod deps; specifically check `multer@2`
  (`^2.0.2` — DoS advisories exist in the 2.x line), `jsonwebtoken@9`, `ws@8`,
  `node-fetch@2` (EOL), `bcryptjs@2` (unmaintained; cost factor matters). Note
  `engines: node >=24` and confirm the target VPS runs that.

### J14 — Admin panel front-end

- DOM XSS sweep: every `innerHTML` / `insertAdjacentHTML` / template write in
  `admin-shell.js`, `settings-common.js`, `cms-editor.js` and the 21 pages, checking whether
  the interpolated value came from the server (miner-controlled worker names, addresses,
  region labels, CMS titles, alert messages, audit-log rows). §I10 was exactly this bug on
  the public map — the same pattern almost certainly exists here.
- The page CSP allows `script-src 'self' 'unsafe-inline'` (`index.js:252`), so CSP will
  **not** stop an injected inline handler. Say so in the write-up: XSS here is unmitigated.
- Token handling: does any admin JS put a token in `localStorage`, a URL, or a log?
  Cookies are `httpOnly` + `sameSite: 'strict'` (`index.js:883,892`) — confirm no JS path
  reintroduces a Bearer token that escapes that protection.
- `AdminTable` (memory `project_pool_admin_table`) renders every admin list — one escaping
  bug there is 15 pages at once. Audit its cell renderer first.
- Step-up UX: when a route returns `challenge_required`, does the client re-auth and
  **retry**, or silently drop a money action?
- Clickjacking: `X-Frame-Options: DENY` is set globally — confirm nginx doesn't strip it
  (J16 owns the nginx half).

### J15 — Public front-end

- Same `innerHTML` sweep across `public_html/js/` (~5,900 lines) and 13 pages. Highest-value
  targets: `branding.js` (1003 — operator-set strings), `reactor-dashboard.js` (1011 — live
  pool data incl. worker names), `network-map.js` (473 — §I10's file), `ads.js` (358 —
  operator HTML), `charts-init.js`.
- `account-settings.html` is 1,799 lines and is where a miner sets a **payout destination**.
  Verify: the address the user sees is the address that gets submitted; no autocomplete/paste
  transform; the confirm step shows the canonical form; nothing sensitive in `localStorage`.
- `payout-methods.js` / `payout-goblin.js` — no public page may name an optional rail in
  static copy (memory `project_pool_nostr_payouts`); confirm the rail list is server-driven.
- `login.html` (608) — admin login page; check for credential leakage into URL/history, and
  that the TOTP step can't be skipped client-side (server is authoritative — verify).
- Third-party: confirm zero external script/font/analytics loads beyond what CSP allows
  (`default-src 'self'`; GA4 is in the SEO settings — reconcile with the CSP or it silently
  fails, memory `project_frontend_seo_standards`).

### J16 — Deployment & infra

Shell + nginx, not Node. Threat actor: anonymous internet hitting the box.

- **The generated nginx vhost.** §I1 (every security header dropped on the two HTML-serving
  locations) and §I2 (no HSTS) were fixed 2026-08-21 — re-verify in the generator, and check
  the general trap from CLAUDE.md: **`add_header` in a child block discards the parent's
  set.** Every `location` that adds any header of its own must re-emit the full set.
  ⚠ **There are now THREE header snippets, not two** (§J14-4, fixed 2026-09-03): common,
  page, and a new **admin** one — `/admin/` is static-served, so whatever the vhost sends *is*
  the admin panel's CSP, and it used to be the public page's (jsdelivr + four analytics
  origins the panel never loads). `location /admin/` includes `$hdr_admin`; `location /` still
  includes `$hdr_page`. Re-read the header section as one unit, and note that only the admin
  snippet sets `frame-ancestors` / `base-uri` / `form-action` / `object-src` — whether the
  public pages should get them too is J16's call. **Nothing here has ever been `nginx -t`'d**:
  the snippets are asserted statically by `scripts/test-admin-panel.js` §7, and the first real
  proof is a live response-header read on a deployed box.
- Bind addresses: Central API `8080`/`8090` must be **localhost-bound**; stratum `3333` is
  public; the node's stratum upstream is `127.0.0.1:3416`/`13416`. Confirm nothing else
  listens publicly, and that the three-port rule isn't collapsed.
- Central API reachability from satellites: IP allowlist + shared secret over the nginx HTTPS
  vhost. Verify the secret's entropy, its comparison (constant-time), and that the allowlist
  is enforced in nginx *and* in the app.
- `admin_allowlist` **ships open by default** — this is the launch-sequence risk that makes
  the `/api/auth/register` TOCTOU exploitable. J17 owns the procedure; J16 owns deciding
  whether the default should change.
- systemd unit: user/group (de-rooted), `NoNewPrivileges`, `ProtectSystem`,
  `PrivateTmp`, restart policy, and that it doesn't run as root.
- File modes on the DB, uploads dir, config, and every secret from J8.
- Rate-limit zones: `script07-` prefixed conf in `/etc/nginx/conf.d/`, created via
  `nginx_ensure_rate_limit_zone` — never inline (CLAUDE.md). Verify zone names are globally
  unique against Scripts 04 and 06.
- Model-C gateway edge (WG + haproxy, memory `project_pool_gateway_model_c`): what does the
  WG peer set allow, and does a compromised satellite reach more than the Central API?
- `bash -n` every touched script; `07_lib_hub.sh` / `07_lib_satellite.sh` run **without
  errexit** in practice (memory `project_lib_errexit_suppression`) — check that every
  create/copy/move/delete carries its own `|| { error; return 1; }`.

### J17 — Pre-mainnet operational gate *(run last)*

Not a code review — the go/no-go. Runs on **testnet first**, then a controlled mainnet start.

1. All P0 sessions closed; every P1 finding either fixed or explicitly accepted in writing.
2. `npm test` green (`check-syntax` + `test-proxy-v2` + `test-stratum-guards` +
   `test-money-path`), and `test-money-path` extended to cover anything J4/J5 found.
3. **Launch sequence** that closes the first-admin TOCTOU: install → register admin while
   the vhost is not yet publicly resolvable (or `admin_allowlist` still restricted) → enable
   mandatory 2FA → *then* publish DNS.
4. Drills, each performed and recorded: payout **freeze** and resume; a forced payout
   **retry** on an already-sent withdrawal (proves §H1); an **orphan** on testnet through to
   reversal (proves §I3/§I4 and J5); DB **backup and restore** (089); a **reconciliation**
   run reporting clean.
5. Mainnet soak: start with a low payout threshold and the operator as the only miner,
   confirm one real block → maturity → credit → withdrawal → chain-confirmed payout, and
   reconcile, **before** any third-party miner is invited.
6. Monitoring live before miners: AlertMonitor thresholds, alert delivery tested
   (`/api/admin/alerts/test`), and someone actually receiving them.

---

## 4. Progress tracker

| # | Session | Owner/date | Findings | Status |
|---|---|---|---|---|
| J1 | Route & guard matrix | 2026-08-25 | 10 (1 High, 2 Med, 5 Low, 2 Info) · **6 fixed, 4 open** (J1-2 partial, J1-4, J1-5, J1-7) | ☑ done |
| J2 | Auth, session & 2FA | 2026-08-25/26 | 8 (1 High, 4 Med, 2 Low, 1 Info) · **all closed**; §C3 still carried | ☑ done |
| J3 | Ownership gate & account API | 2026-08-26 | 9 (4 High, 1 Med, 3 Low, 1 Info) · **all fixed** | ☑ done |
| J4 | Payout execution | 2026-08-26/27 | 11 (1 Crit, 3 High, 2 Med, 4 Low, 1 Info) · **6 fixed, 5 open** — J4-3 + J4-10 are **High** | ☑ done |
| J5 | Reward & orphan ledger | 2026-08-27 | 11 (1 Crit, 2 High, 5 Med, 2 Low, 1 Info) · **all fixed**; J5-11 post-distribution reorg is an accepted risk | ☑ done |
| J6 | Stratum & share intake | 2026-08-27 → 09-01 | 13 (2 Crit, 1 High, 4 Med, 5 Low, 1 Info) · **all fixed** | ☑ done |
| J7 | DB, SQL & amounts | 2026-09-01 | 10 (1 High, 5 Med, 2 Low, 2 Info) · **6 fixed, 4 open** — J7-1 is **High**; J7-8 closed by J9-5 | ☑ done |
| J8 | Secrets & key management | 2026-09-01 | 7 (1 High, 3 Med, 1 Low, 2 Info) · **3 fixed, 3 open**; J8-1 shell half done in J16 | ☑ done |
| J9 | Settings & config integrity | 2026-09-02 | 9 (1 High, 3 Med, 4 Low, 1 Info) · **6 fixed** (J9-1 by deletion), 3 open | ☑ done |
| J10 | Uploads, assets, CMS & ads | 2026-09-02 | 6 (4 Med, 1 Low, 1 Info) · **3 fixed, 2 open** (J10-2, J10-3; J10-3 partly taken by J14-9) | ☑ done |
| J11 | Public API leakage & privacy | 2026-09-02 | 9 (1 High, 4 Med, 1 Low, 3 Info) · **all fixed**; J11-6 nginx half taken by J16 | ☑ done |
| J12 | Rate limiting & exhaustion | 2026-09-02 | 12 + 2 Info · **all 14 closed** | ☑ done |
| J13 | Outbound, SSRF & deps | 2026-09-03 | 10 (1 High ruling, 4 Med, 3 Low, 2 Info) · **4 fixed, 6 open/partial**; J13-2 is a standing ruling, not a bug | ☑ done |
| J14 | Admin panel front-end | 2026-09-03 | 11 (2 Med observability, 1 Med CSP, 6 Low, 2 Info) · **9 fixed, 0 open** (7 in-session + J14-4/-9 in a same-day follow-up) | ☑ done |
| J15 | Public front-end | 2026-09-03 | 12 (3 Med, 7 Low, 2 Info) · **10 fixed**; J15-3's static-HTML half + J15-10's third-party link left as product decisions | ☑ done |
| J16 | Deployment & infra | 2026-09-03 | 14 (1 High, 3 Med, 7 Low, 3 Info) · **9 fixed, 2 open**; J16-2 (hostile gateway holds both ownership-proof legs) and J16-4 (three disconnected admin allowlists) are dispositions for the operator. §J8-1 items 1+3 applied, **item 2 refused with reason (J16-12)** | ☑ done |
| J17 | Pre-mainnet operational gate | 2026-09-04 | 8 (2 High, 3 Med, 1 Low, 2 Info) · **7 fixed, 1 open** (J17-5, procedure). **VERDICT: NO-GO on desk audit**, then a resolution pass closed 10 findings across §J1/§J4/§J7/§J8/§J9/§J13/§J17 — including all three single-box High blockers. No code blocker remains; what is left is the runbook on a real box | ☑ done |
