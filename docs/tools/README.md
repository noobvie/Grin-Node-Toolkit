# docs/tools — instruments for keeping the reference library honest

Not documentation. These are small repo tools that check `docs/generated/` against the code
it describes. They are not part of the numbered VPS toolkit in `scripts/` and never run on a
server.

| File | What it does |
|---|---|
| [check_doc_drift.sh](check_doc_drift.sh) | Finds repo file paths named in `docs/generated/*.md` that do not exist |
| [doc_drift_allowlist.txt](doc_drift_allowlist.txt) | The paths that are *expected* to be absent, each with a mandatory reason |

---

## Why the drift checker exists

A doc names `scripts/lib/07_lib_satellite.sh` in a status table with a green tick. The file
was deleted on 2026-06-22 in `f2ebade`. The prose still reads correctly, so nobody notices,
and an auditor reads a ticked table as verified fact. That is not hypothetical — it is the
case the tool was built from, and it survived for two and a half months.

Two things had already failed to catch it, which is why the check is mechanical:

- **A read-through does not catch it.** A comment-audit pass swept these very docs on
  2026-08-22 and left the satellite rot untouched. Prose checked against prose reads fine, and
  a filename that is simply not on disk any more reads fine too.
- **File dates cannot measure it.** 15 docs carried a git date of 2026-08-22 because one bulk
  commit touched them all. The dates said "fresh"; a path-existence check said otherwise in
  seconds. This is also why every doc carries a hand-written freshness header rather than
  relying on `git log` — see `docs/generated/README.md`.

## Running it

```bash
docs/tools/check_doc_drift.sh              # all docs
docs/tools/check_doc_drift.sh --verbose    # also list loose (other-product-tree) resolutions
docs/tools/check_doc_drift.sh docs/generated/script07_design.md   # one doc
```

Exit `0` = no unexplained miss, `1` = at least one genuine miss, `2` = tool error. It is
gate-able on a commit, **but it does not currently exit 0** — see the open list below.

## How a path is resolved

Four cases, in order. Only the first is a plain repo-root lookup; the rest are why a naive
`test -f` reports scores of false positives.

1. **Repo-root-relative** (`web/…`, `scripts/…`) — resolved directly. Highest signal.
2. **Bare relative**, against the product tree the doc is about. `lib/db.js` in a script07 doc
   means `web/07_mining_pool_public/back-end-pool/lib/db.js`. A first pass without this rule
   reported 50 misses and every one was wrong.
3. **Upstream paths inside a vendored tree.** `scripts/language.js` in a script052 doc is
   Accio's vendored upstream wallet, plus a patched twin under `web/052_accio/patches/`.
4. **Allowlisted** — the path is absent on purpose (below).

The index is built from `git ls-files`, so **an untracked file reads as drift.** That is
deliberate — a doc should not point at something that is not in the repo yet — but it means a
doc written in the same session as the file it describes will fail the check until both are
committed. Confirm with `git add -N` before concluding a path is genuinely missing.

One regex trap is handled and should stay handled: an extension alternation containing `js`
matched against `package.json` yields a phantom `package.js`. The extension is anchored at a
word boundary.

## Allowlist discipline

Format is `<path-or-glob> | <category> | <reason>`, and **the reason is mandatory** — the
checker refuses to run without one. A bare allowlist rots exactly as silently as the docs it
protects; the reason is what lets the next reader tell "still true" from "was true once".

| Category | Means |
|---|---|
| `planned` | Documented on purpose, deliberately not built (the 092 mixer, the free 054–058 band) |
| `not-a-path` | Looks like a path, is not a claim about a repo file — a library name, an example or attacker filename, a VPS runtime artifact, a path inside a negative statement |
| `external` | A real file in someone else's repo or on the operator's box (floonet-rs, WordPress, local memory) |
| `deleted` | Genuinely gone, and the doc names it **in order to record that it went** — an append-only audit finding, or a status row saying a feature was removed |

`deleted` is the one to watch: it is for a doc that is *reporting* a removal, never a parking
space for a live dead link. If the sentence would mislead a reader who arrived mid-document,
fix the doc instead.

The checker warns when an entry matches no doc, or when its file exists again. Both mean the
entry should be deleted — do that rather than leaving the warning to become background noise.

---

## Open misses — triage as of 2026-09-07

The checker currently reports **20 genuine misses in 8 docs, and exits 1.** Script 07 is clean:
its docs were rewritten against the code on 2026-09-07 and every remaining 07 path is
allowlisted with a reason.

Verdicts below were established by hand and re-confirmed on 2026-09-07 against git history
(`git log --all` on each path) and the current tree. What has *not* been done is the product
work each one implies — none of these docs has been read against its code. They are grouped by
what the fix actually is, because that differs per group.

### Rename drift — live dead links, cheapest to fix (4, all `script053_design.md`)

The file exists under a different name. The plugin was renamed `grin-*` → `grinpay-*` and the
doc kept the old names.

| Doc line | Named | Actually |
|---|---|---|
| L80 | `class-grin-gateway.php` | `web/053_woocommerce/plugin/class-grinpay-gateway.php` |
| L813 | `assets/js/grin-block-payment.js` | `plugin/assets/js/grinpay-block-payment.js` |
| L1240 | `lib/grin-wallet-api.js` | `bridge/lib/wallet-api.js` |
| L82 | `bridge-config.php` | No PHP config in `bridge/` — it holds `server.js` + `package.json` only. Rename or removal; read the line before editing. |

### Phantom test files — a doc reporting results for a file that was never committed (4)

| Doc | Named | Claim in the doc |
|---|---|---|
| `script051_implementation.md` L207 | `fid_tsp.js` | test file, 45 assertions |
| `script051_implementation.md` L215 | `fid_routes.js` | test file |
| `script051_implementation.md` L220 | `ui_check.js` | test file |
| `script052_implementation.md` L694 | `t_lastentry.sh` | test script, 8 assertions |

All four have **zero commits in all history**, under any path. Most likely a scratchpad harness
that was run and then killed, per the local-test rule in `.claude/CLAUDE.md` — which is correct
behaviour, but the doc reads as though the file is in the repo and re-runnable. The fix is to
say where it ran and that it was not kept, or to commit it. This group is the most misleading
of the four: it is a green tick on evidence a reader cannot reproduce.

### Never existed — aspirational design, or a rename that lost its target (4)

| Doc | Named | Note |
|---|---|---|
| `script03_design.md` L380 | `scripts/lib/03_lib_objectstore.sh` | 0 commits. Aspirational, or renamed before it landed? |
| `script059_design.md` L13 | `grin-payment-server.js` | 0 commits; sits in the layout diagram |
| `script05_design_goblin.md` L332 | `web/059_drop/server/goblin.js` | 0 commits — the Goblin rail was removed in `dad303b`; check whether it was ever written |
| `script051_design.md` L110 | `web/051_fidelius/README.md` | On the doc's "Add" list; never created |

If triage of one of these turns up a real design decision, that belongs in the relevant
`script##_design.md` as a decision — not in a tools README.

### Pre-toolkit PHP stack — repo-prefixed paths for files never in this repo (4)

`script051_design.md` L15/L115/L116/L117 lists `login.php`, `.api/csrf.php`,
`.js/grin-wallet-client.js` and `css/wallet.css` as the PHP stack Fidelius **replaced**. The
prose is correct — the doc's goal section says the PHP stack is being replaced entirely — but
three of them are written under a `web/051_fidelius/` prefix, so they read as repo files. 0
commits each. Either drop the repo prefix or allowlist them as historical; do not delete the
sentences, they record what the migration was.

### Correct historical prose — probably allowlist, not edit (4)

Each of these names a past state accurately. Confirm the sentence is past-tense, then add a
`deleted` allowlist entry with the commit as its reason.

| Doc | Named | History |
|---|---|---|
| `script059_design.md` L359 | `transactions.html` | Deleted in `429bf1f` / `ecfe42c` |
| `script059_design.md` L360 | `donations.html` | Deleted in `429bf1f` / `ecfe42c` |
| `script05_implementation.md` L338 | `052_grin_drop.sh` | 34 commits; renamed to `059_grin_drop.sh`, quoted in the migration narrative |
| `script05_implementation.md` L385 | `051_grin_private_web_wallet.sh` | 10 commits; renamed to `051_grin_fidelius.sh`, quoted in the rename narrative |
