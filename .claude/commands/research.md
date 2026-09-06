Research before implementing the topic or feature in $ARGUMENTS.
Do NOT write any code — research and summarise only.

## 1. Existing patterns in this codebase

- Search `scripts/lib/` for functions that already do something similar
- Check if a config key for this already exists in `web/059_drop/server/config.js` DEFAULTS
- Check `scripts/059_grin_drop.sh` and the relevant lib file for prior art
- `git log --oneline -20` for recent context
- `git log --all --oneline -- <relevant-file>` for history of a specific file

## 2. Grin wallet API

- **Tutorial + examples**: https://github.com/grincc/grin-wallet-api-tutorial
- **Rust API docs**: https://docs.rs/grin_wallet_api/latest/grin_wallet_api/

Key facts to recall:
- Owner API v3: ECDH session — `init_secure_api` → `open_wallet` → AES-256-GCM encrypted calls
- Foreign API v2: `receive_tx`, `build_coinbase` — Basic Auth + secret file, no ECDH
- Foreign port: 3415 (mainnet) / 13415 (testnet)
- Owner port: 3420 (mainnet) / 13420 (testnet)
- Secret files: `.foreign_api_secret` (foreign), `.owner_api_secret` (owner) — both in `$WALLET_DIR/`, created by `grin-wallet init -h`

## 3. Grin ecosystem repos

- **grin-wallet**: https://github.com/mimblewimble/grin-wallet — binary releases + source
- **grin node**: https://github.com/mimblewimble/grin — node config, node API
- **Official docs**: https://docs.grin.mw — slatepack spec, transaction lifecycle

## 4. Network rules (never mix these)

| | Mainnet | Testnet |
|---|---|---|
| CLI flag | *(none)* | `--testnet` |
| Currency label | `GRIN` | `tGRIN` |
| Node API | `https://api.grin.money` | `https://testapi.grin.money` |
| Wallet dir | `/opt/grin/drop-main/` | `/opt/grin/drop-test/` |

`--floonet` is obsolete — never use it.

## 5. Session splitting — propose it, don't wait to be asked

If the research concludes the work is **more than one sitting** — several files, several
products, a shell lib plus a web app, or anything with a VPS step — then **propose a
per-session prompt plan as part of the output**. Do not wait for it to be requested; it is
easy to forget at planning time and expensive to retrofit once a session is already large.

What a good split looks like:

- **One coherent unit per session** — one tool, one page, one lib. Two features in one
  session is what balloons the context and makes the review shallow.
- **Each prompt is pasteable into a COLD session.** `CLAUDE.md` and `MEMORY.md` load
  automatically, but the prompt must still name the design doc and section to read first,
  and name the files it may touch. Do not make a cold session infer scope.
- **State what NOT to touch.** Most scope creep between sessions comes from a prompt that
  said what to build but not what to leave alone.
- **Split research away from build** when a wire format, byte layout or third-party API has
  to be confirmed from source. That session writes no code, and it is allowed to conclude
  "not confirmable" — which is a result, not a failure.
- **Name the shippable checkpoints.** Say which sessions end in a deployable state and which
  are mid-flight, so a build can be paused without leaving something half-wired.
- **Isolate a known trap into its own small session** rather than burying it in a large one
  (an nginx zone that silently no-ops on an upgraded box, a migration, a port change).
- **Put the VPS acceptance last, as its own session**, and make it report what actually
  happened per check — a check that could not be run is not a pass.

**Write the plan OUTSIDE the repo**, to `D:/tmp/grin-toolkit-plans/script<XX>_<service>_plan.md`.
A session plan is scaffolding that dies once every part is run — it is not documentation, and
committing it is what turned `docs/generated/` into a dump (five such files, ~164 KB, three of
them long finished, cleared 2026-09-06). `docs/generated/` is the durable reference library:
design, architecture, flows.

Cross-link **one way only**: the design doc may say the work is "broken into nine sessions" and
that the plan is kept outside the repo, but it must never link to a `D:/tmp/...` path — that is a
dead link for anyone who clones. The plan links *into* the design doc freely.

When every part has been run, fold the durable outcome — what was decided, what shipped, what is
still open — into that product's `script<XX>_design.md` or `script<XX>_implementation.md`, then
delete the plan file. See `D:/tmp/grin-toolkit-plans/README.md`.

## 6. Output format

Return:
1. What already exists in the codebase that's relevant
2. What the Grin API / docs say about this area
3. Gaps that need to be filled
4. Recommended approach (no code)
5. A per-session prompt plan, if §5 applies — or one line saying why it is a single session
