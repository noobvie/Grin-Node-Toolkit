# Script 03 — Chain-Data Snapshot Method Redesign

**Status:** Phases 1-4 **IMPLEMENTED** (1-3 on 2026-08-17, 4 + review fixes on
2026-08-18) — not yet VPS-tested. **Phase 5 (object storage) is DROPPED** — decision
2026-08-18: stay on VPS free space. Everything below is therefore local-only.
**Created:** 2026-08-17

**Decisions taken (2026-08-17):** fullmain cadence = **biweekly** (1st & 15th).
**One nginx mirror stays alive permanently** as the pre-manifest / no-`jq` fallback,
which also doubles as the transition safety net while phase 2 propagates to clients.
**Scope:** `scripts/03_grin_share_chain_data.sh` (producer) and the mirror-discovery
half of `scripts/01_build_new_grin_node.sh` (consumer).
**Driver:** since grin v5.5 the full-archive snapshot costs too much CPU, IO, disk and
node downtime, and the multi-mirror model multiplies all four.

---

## 1. Problem — four costs currently welded together

`compress_chain_data` (03, ~line 1080) is a single `tar -czf`: single-threaded gzip at
level 6, with the node **stopped for the whole run** (`stop_grin_node` step 1 →
`restart_grin_node` step 9), writing the archive into the nginx web dir on the same
volume as `chain_data`.

| Cost | Driver | Today |
|---|---|---|
| CPU | gzip -6, one core | ~18–20 GB at ~40 MB/s |
| Disk IO + space | read 20 GB, write ~16 GB, same volume | needs ~36 GB free |
| Node downtime | the entire compress | 20–40 min + a heavy v5.5 restart |
| Egress | every mirror serves independently | N × |

`get_cron_expression` (03, ~1758) defaults to 2×/week **per network, with no
distinction between full and pruned** — the 20 GB archive and the 6 GB one are treated
identically.

Note the v5.5 interaction: with the peer store merged into the main lmdb
(`reference_grin55_lmdb_peer_store`), a restart also costs a peer-count cliff, so the
node is degraded well past the compress window.

---

## 2. Ordering rule — the answer to "03 first or 01 first?"

Neither. Sort each change by **client visibility**, because Script 01 runs on a
stranger's VPS at a version we do not control:

- **Client-invisible** (output contract byte-for-byte compatible) → change 03 only,
  ship whenever, no coordination. *Phases 1 and 4.*
- **Client-relaxing** (01 must tolerate something new before 03 produces it) →
  **change 01 first, allow propagation, then 03.** *Phases 2 → 3.*
- **Client-breaking** (the contract itself changes) → manifest `schema: 2`, both
  scripts, plus a compatibility window. *Deferred, section 8.*

The trap this rule exists to prevent: moving fullmain's cron to monthly while every
deployed Script 01 still enforces `_MAX_AGE_DAYS=5` (01, line 2814). Every fullmain
mirror would be rejected as stale, all zones would fall through, and the operator sees
*"All known sources are unavailable or have chain data older than 5 days"* — a total
outage of full-archive bootstrap, caused entirely by a server-side cron edit.

---

## 3. The contract between 03 and 01 — six hard couplings

| # | Script 01 location | Assumption |
|---|---|---|
| 1 | `_try_chaindata_manifest` ~2521 | `archive` matches `^[A-Za-z0-9._-]+\.tar\.gz$` |
| 2 | `_check_and_add_host` ~2612 | fallback greps autoindex for `href="*.tar.gz"` |
| 3 | `_check_and_add_host` 2617–2626 | filename contains full/pruned + mainnet/testnet |
| 4 | `download_chain_data` 2814 | `_MAX_AGE_DAYS=5`, uniform across all site_keys |
| 5 | stream + file modes | extraction is literally `tar -xzf` (`-z` hardcoded) |
| 6 | `verify_checksum` ~2966 | `sha256sum -c`; the `.sha256` filename field must match |

**Unchanged by everything in phases 1–5:** `site_key` (derived by `_get_site_key` from
network+mode only) and the URL shape (`base="https://$host"`).

---

## 4. Phase 0 — measurements that gate the rest

Two cheap measurements decide the shape of phases 1 and 5. **Run these before writing
any code.**

**0a. Compression ratio on the dominant data.** An archive node's bytes are mostly
rangeproofs (Bulletproofs), Pedersen commitments and kernel signatures — cryptographic
output, near-incompressible. If levels 1 and 6 land within a couple of percent, level 1
is free speed:

```bash
cd /opt/grin/node/mainnet-full/chain_data
head -c 2G txhashset/rangeproof/pmmr_data.bin > /tmp/s.bin
for l in 1 6; do /usr/bin/time -f "gzip -$l: %es" gzip -$l -c /tmp/s.bin | wc -c; done
rm -f /tmp/s.bin
```

**0b. Which artifact actually consumes bandwidth.** Determines where phase 5 pays off.
Run on any mirror:

```bash
for s in fullmain prunemain prunetest; do
  echo -n "$s: "
  awk '$0 ~ /\.tar\.gz/ && $9 ~ /^(200|206)$/ {n++; b+=$10}
    END {printf "%d dl, %.1f GB\n", n, b/1073741824}' /var/log/nginx/${s}*access.log*
done
```

**0c. Pruned staleness cliff — the decisive question for cadence.** A pruned node more
than the cut-through horizon (~1 week) behind tip is expected to abandon block sync and
fall back to txhashset state sync, discarding the snapshot it just downloaded. If so,
pruned snapshots have a hard deadline that archives do not, and **pruned cadence is
locked at 2×/week**. Verify on testnet: boot a deliberately old pruned snapshot and
watch whether the log shows state sync or body sync.

---

## 5. Phase 1 — parallel compression (client-invisible, 03 only)

**Change:** `compress_chain_data` uses `pigz` instead of gzip. Output remains a valid
gzip stream named `.tar.gz`, so couplings 1, 2, 3 and 5 are all satisfied and **no
Script 01 change is required**. This is the entire reason for choosing pigz over zstd.

**Level is a separate knob from parallelism** — do not conflate them:

| site_key | level | rationale |
|---|---|---|
| fullmain | `-1` | few downloads; CPU is the binding cost |
| prunemain | `-6` | high download volume; a bigger file costs real egress |
| prunetest | `-6` | volume irrelevant; keep one default |

A lower level means a *larger* file. On prunemain that trades egress for CPU in the
wrong direction, which is why level varies by artifact while pigz applies to all three.

**Implementation notes:**

1. **`PIPESTATUS` is mandatory.** Script 03 has **no `set -euo pipefail`** (only 01
   does, line 183). Today `$?` after `tar -czf` is tar's status. In a pipeline it
   becomes pigz's, so a failing tar publishes a truncated archive with a *valid*
   checksum and a *valid* manifest — the silent-failure shape CLAUDE.md warns about.

   ```bash
   tar -cf - --exclude="${dir_name}/lmdb/lock.mdb" \
             --exclude="${dir_name}/peer/lock.mdb" "$dir_name" \
     | nice -n19 ionice -c3 pigz -"$level" -p "$(nproc)" > "$out"
   local _st=("${PIPESTATUS[@]}")
   [ "${_st[0]}" -ne 0 ] && error_exit "tar failed (status ${_st[0]})"
   [ "${_st[1]}" -ne 0 ] && error_exit "pigz failed (status ${_st[1]})"
   ```

2. **Graceful fallback.** `ensure_package pigz pigz` (03, line 197) may fail on a
   minimal image. Fall back to the existing `tar -czf` path rather than aborting a
   scheduled run — same rationale as the cronie note at line 209.
3. **`nice`/`ionice`** matter even with the node stopped: nginx, the wallet listener and
   the pool are still serving.
4. `size_bytes` in the manifest self-adjusts (`stat -c %s`), and Script 01's disk check
   reads the real file size, so the larger `-1` output needs no downstream change.

**Risk:** low. **Rollback:** revert one function; already-published archives stay valid.

---

## 6. Phase 2 — per-site_key freshness in Script 01 (client-relaxing, 01 only)

**This must ship and propagate before phase 3.** It is the only mandatory Script 01
edit in the whole plan.

`_MAX_AGE_DAYS=5` (line 2814) is enforced on both discovery paths — the manifest path
(~2552) and the fallback probes (~2591, ~2638) — and is already threaded through
`_check_and_add_host` as `$2`. So the change is a small helper plus one call-site edit:

**As implemented** (01, near `_get_site_key`):

```bash
_max_age_for_site_key() {
    case "$1" in
        fullmain) echo 70 ;;
        *)        echo  5 ;;   # prunemain + prunetest — unchanged
    esac
}
```

**Derivation — size the limit to the RAREST preset offered, not to the default.**
Otherwise an option the operator can legitimately pick from 03's menu silently ages
their mirror out of client tolerance. Verified arithmetic across a full year:

| schedule | max normal gap | + one missed run |
|---|---|---|
| prunemain 2×/week (Mon+Thu) | 4 days | — (limit 5 = gap + 1 grace) |
| fullmain biweekly (1,15) | 17 days (15th→1st, 31-day month) | 31 days |
| fullmain monthly (1st) | 31 days | **62 days** (Jul 1 → Sep 1) |

70 = the 62-day worst case + 8 days grace. **An earlier draft of this doc said 45,
and the first implementation used 60 — both are wrong**, because both were sized to
the default rather than to the monthly preset. Adding any rarer preset to 03 means
re-checking this constant first; the code comments in both files say so.

Note also the original rule was misstated as "cadence + one missed run". The real
relationship for the 5-day constant is **max normal gap (4) + 1 day grace**.

**prunetest stays at 5**, not the 10 originally proposed — subject to 0c it has the
same cut-through-horizon cliff as prunemain, so tightening is the fail-safe default
until that is measured. Changing it was also not asked for.

**Rollout lag is real.** Clients run whatever Script 01 they downloaded. Until phase 2
propagates, old clients keep enforcing 5 days regardless of what the manifest says.

**Risk:** low, and it fails safe — a *more* permissive limit never rejects a mirror that
works today. **Rollback:** revert the helper.

---

## 7. Phases 3–5

### Phase 3 — fullmain cadence to biweekly (IMPLEMENTED)

`get_cron_expression` and `list_presets` now take a node type. New helper
`_node_type_for_network` reads `DETECTED_NODE_TYPES` from the saved nginx config
(`"mainnet:full testnet:pruned"`), defaulting to `pruned` when the field is absent so
a legacy config gets the tighter, safer schedule.

This works because **the share pipeline is keyed by PORT**
(`run_nginx_share_for_port "$GRIN_PORT_MAINNET"`), so a given box's mainnet port hosts
either a full node or a pruned one, never both — which is what lets a per-network
schedule loop produce a per-artefact cadence.

Full-archive preset set (pruned presets **unchanged**):

| key | schedule | expression |
|---|---|---|
| 1 | 1st & 15th at 00:00 **(default)** | `0 0 1,15 * *` |
| 2 | Biweekly, random time | `M H 1,15 * *` |
| 3 | Monthly, random time | `M H 1 * *` |
| 4 | 2×/week — marked `[heavy]`, escape hatch only | `M H * * p,q` |

**Biweekly is `1,15`, not a step.** Cron's `*/14` on day-of-month restarts the count
each month — 1, 15, 29, then 1 again, a 3-day gap at the boundary. That is not
fortnightly.

**Transition:** one nginx mirror stays on the old cadence (decision above) until
phase 2 has propagated to clients.

### Phase 4 — REDIRECTED, then implemented (client-invisible, 03 only)

**The original plan was wrong for this problem and was dropped.** It proposed cutting
node downtime via a two-pass rsync into a staging dir, with LVM/ZFS/btrfs snapshots
preferred where available. Both were rejected on inspection:

- **Two-pass rsync makes every stated cost worse.** rsync's delta-transfer algorithm is
  **disabled by default when both paths are local** (`--whole-file` is the default there),
  so the "incremental" second pass is a plain full copy. For fullmain that is **+20 GB
  disk and ~+40 GB of IO** — against a driver that names IO, CPU *and* disk. It buys
  only downtime, which was never part of the complaint.
- **Filesystem snapshots almost never apply.** LVM needs free extents in the VG, and
  stock cloud images allocate 100% of the VG to the root LV. btrfs/ZFS need `chain_data`
  to sit in its own subvolume/dataset, which no toolkit install creates. That is a large,
  risky, unattended-cron code path — an orphaned snapshot silently pins or fills the
  origin volume — that would fire on approximately no real host.

**What phase 4 became instead.** Reviewing phase 3 surfaced a regression it had
introduced. The publish sequence deletes the live archive at step 0, long before its
replacement exists at step 5, so a run that cannot finish takes the mirror down with it.
At twice a week that self-healed within 4 days. At the 1st and 15th it leaves a mirror
**dead for up to 17 days** — the same failure, ~4× the blast radius. That is the cost
worth attacking, and unlike staging it costs nothing.

Three changes, all in `03`:

1. **`preflight_disk_space()` — new step 0a, runs before anything destructive.**
   Sizes `chain_data` as it will actually be tarred (excluding the state-sync zips step 2
   deletes — counting them would inflate the estimate into a false abort), estimates the
   archive via `COMPRESS_RATIO_*`, and compares against free space on **OUTPUT_DIR's**
   filesystem — the only one that must hold the archive, since `chain_data` may sit on
   another disk. Three outcomes:

   | condition | result |
   |---|---|
   | free ≥ need, and a previous archive exists | `RETAIN_PREVIOUS=true` |
   | free + reclaimable ≥ need | `RETAIN_PREVIOUS=false` — historical behaviour |
   | neither | **abort**, having deleted nothing and stopped no node |

   The ratios are deliberately pessimistic (0.95 full / 0.90 pruned). The two errors are
   not equal: guessing high costs a skipped run that logs loudly and leaves the previous
   archive serving, while guessing low fills the disk mid-compress on a box also running
   nginx, a wallet listener and possibly a mining pool.

2. **Retention + atomic swap.** When there is room for both, step 0 leaves the published
   set (archive, checksum, README, manifest) completely untouched, and step 5 builds under
   a **hidden** temp name — nginx autoindex does not list dotfiles, so Script 01's fallback
   href grep can never see the partial file. Only once the new archive is complete *and*
   checksummed does the swap run, and its order is load-bearing: **`chaindata.json` is
   removed first**, because its absence reads as "not ready" and clients fall back to the
   listing, whereas a manifest still naming a just-deleted archive reads as **ready** and
   hands the client a 404 it reports as a broken mirror. Everything after it is a rename
   inside one directory, so the unpublished window is milliseconds instead of the length
   of a compress.

   Net effect: **a failed fullmain run no longer takes the mirror down at all.**

3. **The checksum is written by hand, not by `sha256sum`'s own output.** Hashing the temp
   file would record `.grin_….tar.gz.tmp` in the name field, and Script 01 runs
   `sha256sum -c` against the file *it* has on disk. `printf '%s  %s\n'` — two spaces,
   which is `sha256sum`'s binary-mode separator and what `-c` requires to parse the line.

**The trap this nearly walked into.** The retained-set status note was first worded as
"A new archive is being prepared…". That silently breaks retention, because the literal
string **`Sync completed.`** is the readiness gate in three independent consumers:

| consumer | check | effect of the new wording |
|---|---|---|
| `01_build_new_grin_node.sh` | `grep -q "Sync completed."` | **skips the host entirely** |
| `081_host_monitor_port.sh` | same grep | reports "sync in progress" |
| `lib/02_lib_landing.sh` | `classify()` regex | (survives — falls through to `hasArchive`) |

Script 01 runs on strangers' VPSes at whatever version they downloaded, so a deployed
client can never learn new vocabulary — the exact constraint from section 2. Every such
client would have skipped a mirror serving a complete, checksummed archive: precisely the
outcome retention exists to prevent. The note now opens with the unchanged sentence and
appends the "newer archive is being prepared" clause, which is also simply more accurate —
**this file describes what is published, not what the box is doing.** The suffix must stay
free of the phrase "in progress", which the landing page tests first.

**Incidental fix:** the published archive and checksum are now explicitly `chmod 644`.
They inherit the temp file's mode through `mv`, so under a tightened umask (077) the box
would have served a 403 on the payload itself — the same reasoning already applied to the
manifest.

**Still open (unchanged by this):** `error_exit` is `exit 1`, so a fullmain abort in
`--cron-nginx` ends the whole run before later networks are processed. Pre-existing, and
now more visible because step 0a can abort deliberately. Worth a per-port `continue`.

### Phase 5 — object storage origin (gated on 0b)

Converts N independent producers into **1 producer + 1 CDN**. Egress economics decide
the provider, and this is the whole question:

| Provider | Storage | Egress | Verdict |
|---|---|---|---|
| **Cloudflare R2** | ~$0.015/GB-mo | **$0** | best fit |
| Backblaze B2 | ~$6/TB-mo | free via CF Bandwidth Alliance | good behind CF |
| DO Spaces | $5/mo (250 GB) | 1 TB included | workable |
| Hetzner Storage Box | ~€3.81/TB-mo | generous | cheap; SFTP/rsync, not S3 |
| AWS S3 | cheap | **$0.09/GB** | ~$130/mo at 1.4 TB — no |
| Wasabi | $6.99/TB-mo | "free" but capped at stored volume | wrong tool |

*(List prices from memory — re-verify, they move.)*

**Three sharp edges:**

1. **Use a custom domain per site_key.** `_check_and_add_host` builds
   `base="https://$host"` with **no path component**, so a bucket-with-prefix URL
   (`pub-xxx.r2.dev/fullmain/`) cannot be expressed in the registry. A custom domain
   mapped to the bucket root is a drop-in.
2. **R2 has no autoindex**, so Script 01's fallback path (`GET /` → grep hrefs) dies.
   Current clients survive via the manifest fast path — but that opens with
   `command -v jq || return 1`, so a box without `jq` cannot discover an R2 mirror at
   all, and pre-manifest toolkit versions cannot either. Both fail with a misleading
   *"directory listing failed"*.
   **Fix:** have 03 publish a small static `index.html` into the bucket carrying
   `href="...tar.gz"` and `href="...sha256"`. This restores the fallback path exactly.
   Note this is the **inverse** of the nginx rule in `project_chaindata_landing_page`:
   on nginx you must *not* set `index index.html` because it replaces the autoindex
   Script 01 greps; on R2 there is no autoindex to replace, so the index.html is the
   only way to feed that same grep. Same mechanism, opposite conclusion — write it down
   before someone "fixes" one to match the other.
3. **Streaming upload** removes the local 16 GB write entirely and kills the ~36 GB
   free-space requirement:

   ```bash
   tar -cf - "$dir" | pigz -"$level" -p "$(nproc)" \
     | tee >(sha256sum | sed "s|-|$base.tar.gz|" > "$base.sha256") \
     | rclone rcat "r2:grin-chaindata/$base.tar.gz"
   ```

   The `sed` is **load-bearing, not cosmetic**: `tee >(sha256sum)` writes `-` as the
   filename field, and `verify_checksum` (01, ~2966) runs `sha256sum -c` in `$GRIN_DIR`,
   where a `-` makes it read stdin. Same `PIPESTATUS` discipline as phase 1.

New code belongs in `scripts/lib/03_lib_objectstore.sh`. Per
`project_lib_errexit_suppression`, guard **every** create/copy/move in that lib with its
own `|| { error "..."; return 1; }` — the caller's errexit does not protect it.

---

## 8. Deferred — needs manifest `schema: 2`

Not part of this plan. Listed so they are not mistaken for cheap:

- **zstd** — `.tar.zst` breaks couplings 1, 2 **and** 5 (`tar -xzf`), and Windows
  bundled `bsdtar` does not reliably read zstd. Only viable as an opt-in *second*
  artifact alongside the `.tar.gz`.
- **Delta transfer** (`pigz --rsyncable` + `.zsync`, or rsync of the raw tree) —
  collapses egress but is a client protocol change. Note that if 0a shows gzip buying
  only a few percent, "do not compress at all, rsync the tree" becomes seriously
  competitive, losing only on client simplicity.
- **base + delta split** — breaks coupling 3 and the single-tar assumption; needs new
  site_keys. Also unreliable for lmdb, which is a B-tree with page reuse, not
  append-only.

---

## 9. Test plan

Run every change through **prunetest first, prunemain second, fullmain last** — the
reverse of the pain ordering, deliberately. prunetest saves the least and is the only
artifact where a botched compressor, manifest or staging rsync harms nobody. It is also
where 0c gets answered.

Per-phase gates:

- `bash -n` on every edited script (CLAUDE.md, non-negotiable).
- Phase 1: byte-level — `tar -xzf` the pigz output, diff the extracted tree against
  source; confirm `sha256sum -c` passes; confirm a **deliberately failed** tar aborts
  and publishes no manifest.
- Phase 2: point a test Script 01 at a deliberately stale fullmain mirror; confirm
  accept at 45 days and reject at 46.
- Phase 3: end-to-end `download_chain_data` against each site_key, both transfer modes
  (stream and full-download).
- Phase 5: run discovery **with `jq` removed** to confirm the index.html fallback works.

Local-testing rule applies (CLAUDE.md): none of this runs on the Windows workstation,
and any probe started locally is killed in the same session.

---

## 10. Open questions

**Answered 2026-08-17:** fullmain cadence = biweekly (was Q4); one nginx mirror stays
alive permanently (was Q3).

Still open:

1. **0c result** — does a beyond-horizon pruned node discard the snapshot? Locks or
   unlocks pruned cadence, and decides whether `prunetest` can be loosened past 5.
2. **0b result** — is prunemain or fullmain the bandwidth cost? Decides which artefact
   phase 5 targets first. Current expectation: prunemain (6 GB × many) exceeds fullmain
   (20 GB × few), meaning **the CPU problem and the egress problem are on different
   artefacts**.
3. **0a result** — `COMPRESS_LEVEL_FULL=1` is reasoned, not measured. If the ratio gap
   between levels 1 and 6 turns out to be material, raise it (the constant is
   env-overridable, so no code edit is needed to test on a live host).
4. Is `pigz` acceptable as a new dependency on mirror hosts, given the gzip fallback?

---

## 11. Implementation log

**2026-08-17 — phases 1-3.** `bash -n` clean on both scripts. Helper logic and cadence
arithmetic verified locally with one-shot tests (no lingering processes).

`scripts/01_build_new_grin_node.sh`
- Added `_max_age_for_site_key` beside `_get_site_key`; `download_chain_data` now
  derives `_MAX_AGE_DAYS` from it instead of the hardcoded 5.
- Incidental fix: the "Checking zone hosts" line said **≤ 7 days** while the constant
  was 5. It now interpolates the real value.

`scripts/03_grin_share_chain_data.sh`
- Added `COMPRESS_LEVEL_FULL` / `COMPRESS_LEVEL_PRUNED` (env-overridable).
- `compress_chain_data`: `tar -czf` → `tar -cf - | pigz -p $(nproc)` with `nice -n 19`
  + `ionice -c 3`, gzip fallback, `PIPESTATUS` check, and partial-archive cleanup.
- Added `_node_type_for_network`; `get_cron_expression` / `list_presets` take a node
  type and branch the preset set.
- Incidental fix: `cd "$OUTPUT_DIR" && sha256sum …` was an unguarded `&&`. With no
  errexit in this script a failed `cd` would have skipped the checksum silently and
  left step 7 publishing a manifest naming a `checksum_file` that does not exist.

**Verified locally:** a failing tar in the pipeline reports `tar=2 compressor=0` — the
precise case where the old single-command `$?` test read 0 and would have published a
truncated archive beside a valid `.sha256` and a valid manifest. The `PIPESTATUS` check
catches it and removes the partial. Round-trip extract diffs clean against source and
`sha256sum -c` passes.

**2026-08-18 — phase 4.** `bash -n` clean across every script and lib. Verified with a
30-assertion isolated harness (functions extracted, no script execution, no servers, no
network, temp dir removed).

`scripts/03_grin_share_chain_data.sh`
- Added `COMPRESS_RATIO_FULL` / `COMPRESS_RATIO_PRUNED` / `DISK_HEADROOM_MB`
  (env-overridable) and the `RETAIN_PREVIOUS` run flag, reset per instance.
- Added `preflight_disk_space()` as step 0a, wired ahead of `clean_output_directory`.
- `clean_output_directory` honours `RETAIN_PREVIOUS`; debris patterns moved into an array
  and now include step 5's hidden work files (a bare `*` never matches a leading dot).
- `compress_chain_data` builds to `.<base>.tar.gz.tmp`, hashes it, writes the checksum
  with the **final** name, then swaps: manifest → old archive/checksum → `mv` → `chmod 644`.
- `create_status_in_progress` gained the retained-set branch, worded to keep the
  `Sync completed.` gate intact (see phase 4 above).

**Verified locally (30/30):** preflight picks all three branches correctly and a forced
abort leaves archive *and* manifest byte-untouched; retain-mode clean keeps the published
set and `index.html` while still sweeping hidden temps and debris; the swap leaves exactly
one visible `.tar.gz`, no hidden temp, `sha256sum -c` verifying, the final name in the
checksum line, `lock.mdb` excluded, and the tar readable; **a failed compress leaves the
previous archive byte-identical and its manifest still published.** The status note carries
`Sync completed.` and neither "in progress" nor "DO NOT download", on one line.

One harness bug worth recording: stubbing `error_exit` as `return` instead of `exit` made
tests 7–8 fall through into the swap and "fail". The stub, not the script, was wrong —
but it is the same mistake the code itself would make if `error_exit` were ever softened
to a `return`, so the guard clauses in `compress_chain_data` depend on it staying `exit`.

**Not yet done:** phase 5 (object storage) — it needs the 0b measurement plus account
decisions. Not blocked by anything above.

---

## 12. Review findings (2026-08-18)

A flow/logic/syntax/security pass over phases 1-4, tracing the full circle
`03 publish -> 01 discover -> download -> verify -> extract`. Four defects, all fixed,
all with tests. Two were pre-existing; two I introduced.

### F1 — a disk shortage on one network killed the other (introduced)

`error_exit` is `exit 1`, and `run_cron_nginx` runs mainnet then testnet **in one
process**. Step 0a aborting on fullmain would therefore have taken a perfectly healthy
prunetest publish down with it. Since nothing is stopped or deleted at that point,
returning is clean: `preflight_disk_space || return 1`, and the caller moves on.

### F2 — the partial archive was fetchable by exact name (introduced)

nginx autoindex omits dotfiles from the *listing*, which is what makes the hidden temp
invisible to Script 01's href grep — but nginx still **serves** a dotfile requested by
exact name, and `.grin_full_mainnet_<date>.tar.gz.tmp` is entirely predictable. Both work
files are now created `600` inside a `( umask 077; … )` subshell *before* anything writes
to them; the redirections truncate without changing the mode, and the swap re-opens them
to `644`. This is fixed in the producer rather than the vhost so it also holds on
third-party mirrors we do not configure.

### F3 — `gzip -0` is rejected, and the level is env-overridable (pre-existing, latent)

Verified locally: `gzip -1` is accepted, **`gzip -0` is rejected outright**. pigz accepts
0 (store). So `COMPRESS_LEVEL_FULL=0` — which is a genuinely attractive setting for
near-incompressible archive data — would have built fine on a pigz box and hard-failed at
step 5 on its gzip-fallback twin, with the node already stopped. `_clamp_level` now applies
a floor of 0 for pigz and 1 for gzip, a ceiling of 9, and falls back to 6 on anything
non-numeric (which would otherwise have reached the compressor as a flag).

### F4 — a failed compress left the grin node stopped indefinitely (pre-existing)

The worst one. Step 1 stops the node; every failure path in step 5 called `error_exit`,
i.e. `exit 1`, so **step 9 never ran and the node stayed down** until a human noticed. On
an unattended biweekly mirror that could be a fortnight. Every failure path in
`compress_chain_data` now returns 1, and the pipeline brackets steps 5-8 so step 9 runs on
both paths:

```bash
if compress_chain_data; then
    update_status_completed; change_file_ownership
else
    log "Publish skipped for this run — restarting the node and leaving the published set as it was"
    _SHARE_RC=1
fi
restart_grin_node
```

Combined with retention this closes the circle properly: a failed run now costs *nothing*
— node back up, previous archive still served, next run retries.

### Checked and found sound

- `du --exclude` matches basenames **recursively** (verified: 396K → 100K with a nested
  match), so step 0a's estimate agrees with step 2's recursive `find`.
- Script 01's step-1 directory `Last-Modified` check is effectively a reachability probe:
  nginx autoindex sends no `Last-Modified`, and the landing page uses Accept-based
  negotiation so `curl` gets the autoindex, not `index.html`. Retention does not perturb
  it. The freshness that matters is step 4's `HEAD /$tname`, and `mv` preserves the temp
  file's mtime, so a fresh archive reports fresh.
- The swap leaves exactly one visible `.tar.gz`, so Script 01's `head -1` on the href grep
  cannot pick the wrong one.
- Between the swap and step 7 the manifest is absent, so clients fall back to the listing
  and find the new archive **and** its new checksum. Consistent at every instant.

### Still open

`ensure_package` re-attempts an install on every run when a package is genuinely
unavailable in the distro's repos (`nocache` on RHEL, for instance), costing an
`apt-get update` per run. Pre-existing, applies to pigz/tmux/rsync too, and cheap at a
biweekly cadence — but it is real.

---

## 13. Reducing load during compression

With phase 5 dropped, everything has to come from the local box. Implemented:

| lever | effect |
|---|---|
| **`nice`/`ionice` now wrap `tar`, not just the compressor** | this was backwards. tar is the process reading the whole ~20 GB off disk, so it is the one whose IO needed deprioritising; the compressor is CPU-bound and reads from a pipe |
| **`nocache` on the read side** | the cost that never shows in `top`: streaming 20 GB through tar evicts nearly everything else the box had cached, so nginx/wallet/pool run cold for a long time afterwards. `nocache` drops those pages as it goes. Optional package, no-op when absent |
| **honest `ionice` logging** | `ionice` is honoured by **CFQ/BFQ only**. Modern kernels default to `mq-deadline` or `none` for virtio-blk and NVMe — i.e. essentially every VPS — where it is accepted and silently ignored. `_io_scheduler` reads `/sys/block/<dev>/queue/scheduler` and the log now says whether the throttle is real |
| **`COMPRESS_THREADS`** | caps pigz's thread count so cores stay free for the services still serving. Independent of level — fewer threads changes load, not output |

`nocache` wraps **tar only**, deliberately: the compressor writes to a shell redirect it
never opens itself, so an `LD_PRELOAD` shim cannot see that fd. And the pipeline must stay
**two elements** — the `PIPESTATUS` check indexes 0 and 1, so slipping in a third stage
(`| nocache dd of=…`, say) would silently stop checking one of them.

### Two more levers — measure before shipping

1. **`COMPRESS_LEVEL_FULL=0`.** Now safe to try (F3). pigz level 0 stores rather than
   compresses: near-zero CPU, output ≈ input. Archive-node bytes are rangeproofs and
   signatures, so the honest question is what level 1 actually buys. If the answer is
   "5%", then at a biweekly cadence with few downloads, 0 is the better trade and the
   compression CPU problem simply disappears. This is measurement 0a, and it is now one
   env var rather than a code change.

2. **`tar --sparse` (`-S`).** LMDB is mapped at a large size and `data.mdb` may be
   substantially sparse; without `-S`, tar reads and compresses gigabytes of holes.
   Check first:

   ```bash
   du -sk --apparent-size /opt/grin/node/mainnet-full/chain_data
   du -sk                 /opt/grin/node/mainnet-full/chain_data
   ```

   A large gap means `-S` is a real win in both CPU and archive size. **Do not ship it
   blind:** `-S` emits GNU sparse entries, and Script 01's README documents extraction with
   Windows `tar` (bsdtar), whose handling of that format is not something to assume. Under
   the section 2 ordering rule this is a **client-breaking** change — it needs a Windows
   extraction test before it goes anywhere near a mirror.

### Rejected

**cgroup caps via `systemd-run --scope -p CPUQuota=…`** would be a harder throttle than
`nice`, but `nice -n 19` already yields whenever anything else wants the CPU, and the node
— the box's real CPU consumer — is stopped for the duration anyway. Not worth the
dependency on systemd being the init in every deployment target.
