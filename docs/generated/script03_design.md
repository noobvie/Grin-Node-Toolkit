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

---

## 14. Plan — remaining fixes, and the rsync proposal

### 14.1 The open items, smallest first

| # | item | size | blocks anything? |
|---|---|---|---|
| **A** | **VPS acceptance run of phases 1-4.** Nothing built since 2026-08-17 has executed on a real server. Run `--cron-nginx` on testnet first, watch step 0a's numbers against reality, confirm the swap, confirm `chmod 644` (untestable locally — Git-bash fakes POSIX modes), confirm the node restarts after a *deliberately* failed compress. | 1 session | **yes — everything** |
| **B** | Measurement **0a**: `pigz -1` vs `pigz -6` vs `pigz -0` ratio on real `chain_data`. Decides `COMPRESS_LEVEL_FULL`, now a pure env-var change. | 20 min | no |
| **C** | Measurement: `du -sk --apparent-size` vs `du -sk` on `chain_data`. Decides whether `tar --sparse` is worth pursuing at all. | 1 min | no |
| **D** | `pigz --rsyncable` for the SSH-share path (see 14.3). Verify with `pigz --help \| grep -i rsyncable` before relying on it. | small | no |
| **E** | `ensure_package` re-attempts an install every run when a package is absent from the distro's repos, costing an `apt-get update` per run. Pre-existing; applies to pigz/nocache/tmux/rsync. | small | no |

**A gates everything.** Nothing else should ship before phases 1-4 have run once on a real
box, because every failure mode they address is a *runtime* one.

### 14.2 Why remote rsync is a different question from the staging I rejected

Phase 4's original plan died because **rsync disables delta-transfer when both paths are
local** — `--whole-file` is the default there — so same-box staging degenerates into a plain
full copy: +20 GB disk and ~+40 GB IO on the box that already has the problem.

**None of that applies to a remote destination.** Over SSH the delta algorithm is on by
default, and — this is the part that matters — the 20 GB of *disk* the copy needs lands on
the mirror, not on the node box. The rejection was about where the cost lands, not about
rsync.

### 14.3 The cheap version — keep today's architecture, add one flag

Today `run_ssh_share_for_combo` already rsyncs the **finished archive** to remote mirrors,
which is already a "1 producer, N thin mirrors" model. Its weakness: **gzip output is
chaotic**, so a one-block change to the input changes the whole rest of the stream and rsync
can find no delta at all. Every biweekly run therefore pushes the full ~17 GB to every
mirror.

`pigz --rsyncable` (`-R`) resets the compressor at content-defined boundaries, so an input
change perturbs only its own neighbourhood of the output. The result is still a standard
gzip stream — `tar -xzf` and every client contract are untouched — at roughly a 1% size
penalty. Upload per mirror per run drops from 17 GB to the size of the actual chain delta.

**This is the highest value-per-risk item on the page.** It is one flag, it is
client-invisible, and it does not change the architecture at all.

### 14.4 The real proposal — move compression off the node box

The node box currently does all four expensive things: read 20 GB, compress, write 17 GB,
serve. Split them:

```
  NODE BOX (runs grin, has the problem)        MIRROR BOX (thin, no grin node)
  ──────────────────────────────────────       ────────────────────────────────
  pass 1: rsync chain_data --> mirror          receives raw chain_data
          (node RUNNING, zero downtime)
  stop node
  pass 2: rsync delta                          receives the delta
  start node          <-- downtime is only pass 2
                                               compress at leisure, nice'd
                                               publish .tar.gz + .sha256 + manifest
                                               serve over HTTPS exactly as today
```

What the node box pays afterwards: **one 20 GB read, no compression, no archive on disk,
and downtime measured in a couple of minutes instead of half an hour.** The original
complaint — IO, CPU, and disk for the big `.gz` — is answered on all three, and
**Script 01 never learns anything changed**, because the mirror still publishes the same
`.tar.gz`, the same `.sha256`, the same `chaindata.json` and the same status note.

That last property is what makes this worth doing rather than the object-storage route:
it is entirely a producer-side change, so it sits in the *client-invisible* class from
section 2 and can ship without waiting for anything to propagate.

### 14.5 Sharp edges

1. **Pass 2 must not trust mtime.** rsync's quick check is size + mtime. `lmdb/data.mdb` is
   written **in place through an mmap**, so a page can change without the size changing, and
   mmap mtime updates are not prompt in the way an ordinary `write()` is. Worse, grin
   *compacts* the MMR, which can rewrite a `pmmr_*.bin` to the same size. A missed byte here
   does not fail loudly — it produces a chain_data that opens and is subtly wrong.
   **Pass 2 runs with `--ignore-times` over the whole tree.** That costs a full 20 GB read
   on each side during downtime — call it ~2 minutes on ordinary disks — and is still an
   order of magnitude better than compressing. Correctness first; the win is large enough
   that it does not need shaving.

2. **The acceptance test is "a node starts from it", not "rsync exited 0".** The only proof
   a copied chain_data is intact is a fresh node opening it and syncing to tip. That test is
   mandatory before this replaces the current path for real, and it must be run on testnet.

3. **`--delete` pointed at raw chain_data is a loaded gun.** The destination must be a
   dedicated directory that no grin node ever runs from. Getting this wrong deletes a node's
   chain data rather than a stale archive.

4. **Where does the permanently-alive nginx mirror live?** If it stays on the node box, that
   box still has to compress and still has to hold 17 GB — and this whole change buys
   nothing. **Recommendation: make the permanent mirror one of the thin boxes.** The node box
   then serves nothing and keeps no archive. This is the one decision the plan actually needs.

5. **Two products must not both drive the node.** Step 0a, retention and the swap all live in
   the nginx pipeline. An rsync-of-chain_data path needs its own stop/start bracket with the
   same guarantee F4 just added — **the node gets restarted on every exit path** — or it
   reintroduces the exact bug that was just fixed.

### 14.6 Suggested order

1. **A** — VPS acceptance of phases 1-4. Blocks the rest.
2. **B, C, D** — three measurements and one flag. Cheap, independent, informs everything.
3. **14.4 on testnet only**, behind a new config switch, with the existing nginx path left
   completely intact as the fallback. Prove edge 2 (a node starts from the copied data)
   before mainnet is discussed.
4. Mainnet cutover only once testnet has completed a full biweekly cycle unattended.

Steps 1-2 are worth doing regardless of whether 14.4 ever happens. Step 3 is the one that
needs a real decision (edge 4) before any code is written.

---

## 15. Spec — remote copy (option C) rework

Requirements from the operator, plus what review turned up around them. Nothing here is
implemented yet.

### 15.1 Gate the copy on the archive being complete — but not on the status *text*

**Requirement:** read `check_status_before_download.txt` before copying, so a corrupt or
half-built archive is never pushed.

Right, and the current code is weaker than that: `run_ssh_share_for_combo` only checks that
*some* `*.tar.gz` exists in the source dir. It would happily upload a half-written one.

But the status note is the **weakest** of the three signals available locally, because it is
a human-facing string — "Sync completed." proves a line was written, not that the tarball is
whole. Gate on all three, cheapest first:

| # | gate | proves |
|---|---|---|
| 1 | `chaindata.json` exists | the publish reached step 7 |
| 2 | status note contains `Sync completed.` | same signal, second source |
| 3 | manifest's `archive` / `sha256` match the files on disk | names agree |
| 4 | **`sha256sum -c` the local archive** | **the bytes are actually intact** |

Only #4 answers "is it corrupted". It costs a ~17 GB read (a couple of minutes), which is
cheap next to uploading 17 GB of garbage — and cheaper than the alternative, which is
discovering the corruption on the mirror after it has replaced a good archive.

**Also needed: a lock.** Nothing today stops the SSH job firing while the nginx pipeline is
mid-swap. A shared lock file (`flock` on `/opt/grin/.share-<site_key>.lock`) held by both
pipelines is the fix. The same lock stops two SSH pushes overlapping, which a slow uplink
makes likely at 17 GB.

### 15.2 Target identity — the `<type><net>` key must match

**Requirement:** the target location must carry the same `<type><net>` key so the wrong
network cannot be overwritten.

This is the most important item on the page, because the failure is **destructive**: rsync
runs with `--delete`, so one wrong path in the config does not merely misfile an archive —
**it deletes another network's mirror.** Script 01 would eventually reject the mismatched
host (its step 3b checks the tar name against the expected `site_key`), but only after the
good archive is already gone.

Three parts:

1. **One shared `_site_key_for <ntype> <net>` helper.** The `full_mainnet -> fullmain`
   mapping is currently written out at least twice (`write_chaindata_manifest`, and again in
   the nginx setup around line 441). A third copy for the SSH path is how they drift.

2. **Fix the default.** Line 629 falls back to `/var/www/${ntype}${net:0:4}`, which yields
   `prunedmain` and `pruned` + `test` = **`prunedtest`** — neither is a real site_key
   (`prunemain`, `prunetest`). It is currently **unreachable**, because the defaults block
   sets every `REMOTE_WEB_DIR_*` correctly before the config loads, so `${!var_rdir:-…}`
   never falls through. Latent, not live — but it is wrong code sitting exactly where
   someone will one day rely on it. It should be `/var/www/$(_site_key_for …)`.

3. **Verify identity on the remote, every run, before transferring.** Write a marker on
   first successful upload and check it thereafter:

   ```
   <remote web dir>/.grin-mirror.conf     site_key=prunetest
                                          source_host=<producer>
                                          first_seen=<utc>
   ```

   A dotfile on purpose: nginx autoindex hides it, and the existing `--exclude='.*'` already
   shields it from `--delete`, so it survives every publish cycle. Logic:

   - marker present and `site_key` matches → proceed
   - marker present and **mismatched** → **refuse, loudly**, transfer nothing
   - no marker, remote has a `chaindata.json` → compare its `site_key` instead
   - no marker, remote has `*.tar.gz` → compare the filename the way Script 01's step 3b does
   - no marker, remote dir empty → genuine first use; write the marker. In interactive setup,
     confirm explicitly; in cron, proceed (an empty dir cannot be someone else's mirror)

### 15.3 Scheduling — offset is the right UX, state is the right gate

**Requirement:** schedule the copy 2-3 hours after the archive was built.

Good as a default, dangerous as the only mechanism: if a build runs long, is skipped, or
fails, a fixed clock fires anyway. With retention now in place the failure is quiet rather
than loud — the previous archive is still sitting there complete, so the copy would succeed
and burn a full 17 GB upload re-sending an archive the mirror already has.

Two changes make the offset safe:

1. **Derive the offset from the nginx cron, do not ask for a second clock.** The script
   already knows that network's schedule, so the menu should offer *"3 hours after the build
   (auto: 1st & 15th at 03:00)"* rather than a bare cron prompt. Change the build time later
   and the copy follows.

2. **Record what was last uploaded, and no-op when it has not changed.** Keep the manifest's
   `generated_utc` (and sha) per target in a state file. On each run, compare; identical →
   exit 0 having done nothing. That makes the job **idempotent**, so it can safely run hourly,
   self-heals a late or failed build, and makes the exact offset stop mattering. Belt and
   braces: the offset for humans, the state check for correctness.

### 15.4 Key management

Today the setup asks for a key **path** per combo and tests it with `BatchMode=yes`. Missing:

- **Generate** if absent — `ssh-keygen -t ed25519 -N "" -f /root/.ssh/grin_share_ed25519`
  (ed25519, not the `id_rsa` default the prompts currently suggest)
- **Install** — `ssh-copy-id`, the one and only time a password is typed. Must run against a
  real TTY; never route the password through the script
- **Test** as a standalone menu action, not only as a side effect of setup
- **Key is a property of the host, not of the combo.** Three combos to one mirror currently
  store three copies of the same path. Group connection settings per host and let each combo
  reference one

Restrict what the key can do on the mirror: a dedicated user, and ideally a
`command=`-restricted `authorized_keys` entry (rrsync) so a stolen producer key cannot become
a shell on every mirror.

### 15.5 Transfer flags — four real problems in the current rsync

```bash
rsync -az --progress --delete --exclude=… -e "ssh -i $key -p $port" "$src/" "$host:$rdir/"
```

| problem | fix |
|---|---|
| **`--delete` defaults to `--delete-during`** — stale files are removed *as the transfer runs*, so a failure partway can leave the mirror with neither the old archive nor the new one. The same failure this repo just fixed locally, still live on the remote | **`--delete-after`** |
| **No resume.** An interrupted 17 GB upload restarts from zero, which on a flaky link may never converge | **`--partial-dir=.rsync-partial`** — a dotdir, so partials stay out of the autoindex and out of `--delete`'s way |
| **No bandwidth cap.** The upload can saturate the producer's uplink and starve the node's P2P and the pool's stratum | **`--bwlimit`**, operator-set |
| **No timeouts.** A stalled transfer hangs forever and the next cron fires on top of it | `--timeout`, `ssh -o ConnectTimeout= -o ServerAliveInterval=` — plus the 15.1 lock |

Two smaller ones: `-z` compresses an already-gzipped payload (modern rsync auto-skips `.gz`
via its default `--skip-compress` list, so this is wasted CPU only on older rsync — worth
setting explicitly); and `--progress` in a cron job writes a progress line per file into the
log, where `--info=progress2` or nothing is wanted.

### 15.6 Verify after the copy, and keep a status the operator can read

**Requirement:** be able to check whether the last copy completed properly.

- **Verify remotely:** `ssh host "cd <rdir> && sha256sum -c <base>.sha256"`. rsync verifies
  its own stream, but only this proves what actually landed on the mirror's disk. Run it
  *before* publishing the remote `chaindata.json`, so a bad copy never gets advertised.
- **Per-target state file** — `/opt/grin/state/share_ssh_<site_key>.json`: last attempt,
  last success, archive name, sha, bytes, duration, exit status, error text.
- **Menu shows a table** built from those files: target, site_key, last success, age, result.
  That is the "did last night's copy work" answer, at a glance, without reading logs.
- Keep the dated per-run logs; the state file is the summary, not a replacement.

### 15.7 Proposed menu

```
  Remote Copy (SSH)
  1) Targets            add / edit / remove   [table: host, site_key, last OK, age]
  2) Keys               generate / install / test
  3) Schedule           offset after build, per target
  4) Copy now           one target or all
  5) Status & logs      last result per target, tail a run log
  6) Verify remote      re-check the mirror's checksum without copying
```

Per the hub conventions: rows show names, keys are positional here (03 is not hub 05 or 08),
and every dispatch is `||`-guarded.

### 15.8 Things not in the original list

1. **A mirror should be able to state its own identity** — the `.grin-mirror.conf` marker in
   15.2 also lets 081's monitor and a human answer "what is this box supposed to be serving?"
2. **`--delete` needs an allow-list of what it may remove**, not just the current exclude
   list. The excludes protect `index.html`, `robots.txt`, `sitemap.xml`, `grin-logo.svg`,
   `mirrors.json` — anything a mirror gains later is unprotected by default.
3. **Fan-out is not supported.** `REMOTE_HOST_<NET>_<TYPE>` is singular; the "1 producer, N
   mirrors" model needs a list. That is a config schema change — decide before building the UI
   around the singular form.
4. **Failure notification.** A copy that silently fails for six weeks is indistinguishable
   from one that works, at biweekly cadence. 082 already has off-box alerting to reuse.
5. **Remote free space pre-flight**, mirroring step 0a: `ssh host df -Pk <rdir>` before
   transferring. Same reasoning, and `--delete-after` makes it necessary — the space is not
   reclaimed until the end.
6. **Clock skew.** The state check compares the manifest's `generated_utc` against a recorded
   value, so it is immune. But the *offset* schedule is not; `check_timezone_utc` already
   guards the producer, and the mirror's clock does not matter as long as nothing derives
   freshness from it.

### 15.9 Open decisions

- **Fan-out now or later?** It changes the config schema, so it is cheaper to decide before
  the UI is written than after.
- **Does the copy stay a separate cron, or become step 10 of the nginx pipeline?** Chaining
  removes the scheduling question entirely and inherits the lock for free, at the cost of
  making a slow upload part of the build window. The state check makes the separate cron safe,
  so this is a preference, not a correctness call.

---

## 16. Review of the §15 implementation (2026-08-21)

A read-through of the shipped code, then a re-test against reality rather than
against my own assumptions. Nine findings, all fixed. The interesting part is
why the first test pass missed the worst of them.

### 16.1 The blocker, and why the tests said it was fine

`_rc_derive_schedule` **never matched anything**, so menu option 5 failed every
time with *"Could not derive a schedule from the build cron"* and then advised
setting a build schedule that already existed.

The nginx installer writes a cron entry as **one line with the marker appended
at the end**:

```
0 0 1,15 * * bash …/03_….sh --cron-nginx-main >> …log 2>&1 # grin-node-toolkit: grin_share_nginx_main
```

The implementation looked for the marker on a line *of its own* and then took
the line after it (`grep -A1 -x -F`) — a layout this script has never written.

The first harness constructed its fixture crontab in that same imagined
two-line format, so it exercised the code against the assumption instead of
against the code that produces the input. Ten green tests, zero coverage. The
rule this breaks is already in CLAUDE.md: *a test that can't observe the thing
you're checking is not evidence.*

The replacement harness lifts the format out of the source — it greps the
installer's own `cron_line="…"` assignment and `eval`s it to build fixtures —
so the test now fails if either side changes independently.

The legacy-prefix hazard that motivated the original `-x` is real
(`…grin_share_nginx` is a prefix of both per-network markers, so a plain `-F`
returns the testnet line when asked about mainnet). The correct fix is the
end-of-line anchor the installer *already* uses when it retires that line:
`grep -E 'grin_share_nginx[[:space:]]*$'`.

### 16.2 The producer never took the lock

The lib documented mutual exclusion with the nginx pipeline. `grep -n flock
scripts/03_*.sh` returned nothing: only copy-vs-copy was serialised. The window
is real — preflight verifies archive N, a build starts, and the swap deletes the
manifest and the archive while rsync is still reading them.

Fixed as an asymmetric lock, which is better than the symmetric one the comment
had claimed:

- the **copy** holds it for its whole run — it is the reader;
- the **build** takes it only around the publish swap (`rm`+`mv`, seconds), not
  around the ~30 min compression, which writes to `.tmp` files no reader looks
  at. Serialising the compression would delay builds behind uploads for nothing.
- the build waits a bounded 30 min and then swaps anyway rather than stall
  behind a stuck upload. `rc_push_target` re-reads `generated_utc` after its
  transfer and aborts rather than publish a set spanning two builds, which is
  what makes proceeding safe.

### 16.3 A failed copy took a healthy mirror out of rotation

The remote manifest was removed and a *"DO NOT download"* note written **before**
rsync, and never restored on failure. The mirror still held a complete previous
archive — `--delete-after` had not run — but Script 01's discovery greps for
`Sync completed.`, so it skipped that mirror entirely. At the fullmain cadence,
one network blip = **up to 14 days** of a working mirror unused.

That is the same regression `RETAIN_PREVIOUS` exists to prevent locally, and the
mirror now gets the same rule: the manifest is stashed to `.chaindata.json.prev`
(a dotfile, so `--exclude='.*'` shields it from `--delete`), and every failure
path restores it along with a status note that still says `Sync completed.` and
explains it is the previous build.

### 16.4 Smaller ones

| | Was | Now |
|---|---|---|
| `RC_SCHED_WARN` | set inside `$(…)` — a subshell — so the reason for a refusal was always discarded | function returns via `RC_SCHED_EXPR`/`RC_SCHED_WARN` globals, called directly |
| "Copy now" | `rc_should_push` trusted our own state file; a wiped mirror was skipped as "current" | confirms `generated_utc` **on the mirror**, plus an explicit force prompt |
| `rc_target_valid` | accepted `/var/www`, `/srv`, `/usr/share/nginx/html` — which `--delete` would erase | remote dir must end in `/<site_key>` |
| metacharacters | `/var/www/x';id;'` and host `-oProxyCommand=…` both accepted | rejected, along with whitespace and a leading `-` |
| `enabled` | unvalidated; `yes` silently meant *disabled* | must be `true`/`false`; ssh key path must be non-empty |
| enable/disable | remove-then-add — a write failure between them deleted the mirror | `rc_target_set_enabled` rewrites in place |
| corrupt marker | refusal read *"is a 'marker' mirror"* — named no file, suggested no fix | names the file and says to delete it |
| copy schedule | no way to remove one; `remove_nginx_schedule` greps `grin_share_nginx`, which by design misses `grin_share_remote` | menu option 7, per-site_key or all |
| remote chown | hardcoded `www-data:www-data`, absent on RHEL mirrors, failed into `2>/dev/null` | dropped; `rsync -a` preserves the producer's 644, which is what nginx needs |

### 16.5 Checksum gates — off by default (operator decision)

`RC_VERIFY_LOCAL` and `RC_VERIFY_REMOTE` now default to **false**. Reading a
17–20 GB archive twice locally is exactly the IO this redesign exists to remove,
and the wire is already covered: rsync checksums every file it transfers and
exits non-zero if the reconstruction does not match, so a corrupt *transfer*
fails the run on its own.

What is given up, stated plainly: a source archive that was already corrupt on
disk will be fanned out to every mirror, and nothing proves what is sitting on a
mirror afterwards. The `.sha256` ships with the archive, so downloaders verify
for themselves. Either knob flips back to `true` without other changes.

### 16.6 Verification status

52 local tests pass — 28 covering schedule derivation, target validation,
in-place enable/disable and the unschedule patterns; 24 covering the transfer
lifecycle with `ssh` executing its command locally against a simulated mirror
directory, so the success path, the restore-on-failure path and the
rebuilt-mid-transfer abort are all exercised end to end.

**Not covered locally:** Git-bash has no `flock`, so the lock itself only runs
its degrade-to-no-op branch here. Real transfers, key auth and the remote
identity probe need the VPS. Both remain part of the acceptance session.

---

## 17. Closing the open items (2026-08-21)

Everything left in §14.1 and §15 that does not require the VPS is now built.

### 17.1 Failure notification — `lib/grin_alerts.sh`

An unattended fortnightly job that fails leaves a mirror stale for a fortnight,
and the only evidence is a log nobody opens.

The obvious implementation is to call into Script 082, which already knows how
to reach the operator. **That is the wrong move**: 082 deliberately compiles a
*self-contained* worker to `/opt/grin/access-watch.sh` so a tamper alert never
depends on the rest of the toolkit still being intact. Making it source a lib
would undo the one property it is built for.

So the new lib duplicates the delivery code and shares **the thing that actually
matters — the same `alert.conf`**. Channels are configured once, in 082's menu,
and any product that sources the lib can reach them. The cost is stated in the
lib header: a channel added to 082 will not appear here on its own.

Behaviour worth knowing:

- **Driven off the per-target state files**, not off this run's results — so a
  mirror that failed two runs ago and was skipped this time is still counted.
  A run-scoped summary would quietly omit it.
- **Standing failures do not re-alert.** The failure set is hashed; a new or
  changed failure speaks, an unchanged one stays quiet. Same rule 082 uses.
- **Recovery gets exactly one message**, and only to someone who was told about
  the failure.
- **An undeliverable alert does not record the hash** — otherwise the first
  failed delivery would silence every repeat of that failure.
- `last_result=running` is reported as a failure: it means a run died without
  reaching either branch (kill, reboot, OOM), which is a failure that never got
  to say so.
- The menu path sets `RC_NOTIFY=false`. Alerting an operator about something
  they just watched fail on screen trains them to ignore the channel.

A test that loaded two different confs in one shell caught a real bug here:
`set -a; . conf` **exports** every key, so a channel removed from the conf kept
resolving from the previous load — CLAUDE.md's documented `source` trap. The
keys are now unset before each load.

### 17.2 `--delete` allow-list

`--exclude` protects the files we thought to name and nothing else. rsync filter
rules are first-match-wins, and `R` (risk) marks a file deletable while `P`
(protect) exempts it, so:

```
--filter='R *.tar.gz' --filter='R *.sha256' --filter='P *'
```

inverts the default: `--delete` can remove a superseded archive and its
checksum, and **literally nothing else**. Together with the path rule from
§16.4, a wrong `remote_dir` is now a misfiling rather than an erasure.

### 17.3 `pigz --rsyncable` (§14.1 D)

Enabled when present, on both pigz and gzip. It resets the compressor at
content-defined boundaries, so one changed block near the start of the stream
does not shift every byte after it — without it rsync ships all ~18 GB again on
every build.

This matters *because the copy goes over ssh*: rsync's delta transfer is on by
default there, and only local→local implies `--whole-file`. chain_data grows
mostly by append, so most of the archive genuinely is unchanged between builds.
Costs a few % ratio, which at level 1 is noise.

**Probed, never assumed.** It is a build-time option missing from some distro
pigz builds, and an unknown flag makes pigz exit non-zero — which would fail the
whole pipeline rather than degrade.

### 17.4 `ensure_package` no longer retries for ever (§14.1 E)

When a package genuinely is not available — `nocache` is in no RHEL base repo —
the old version ran a full `apt-get update` plus a failing install on **every
cron run, for ever**: minutes of network and disk on a box this redesign exists
to keep quiet, to reach last run's answer.

A failure now writes a marker and is not retried for `PKG_RETRY_HOURS` (24).
Only *failure* is cached, and only for a while, so a package that appears in a
repo later is still picked up. An installer that exits 0 without producing the
command counts as a failure — what the caller needs is the binary.

### 17.5 Compression benchmark — menu key `J` (§14.1 B and C)

`COMPRESS_LEVEL_FULL=1` was chosen from how Bulletproof rangeproofs behave in
general, not from a measurement. Settling it properly means compressing the same
bytes at several levels, and a full run is ~30 min with the node stopped — so
nobody does it twice and the question stays open.

Key `J` samples instead: it takes the largest files in chain_data (the PMMR data
files, which dominate both the size and the ratio), compresses a few hundred MB
of them at 0/1/3/6/9, and prints ratio, seconds, MB/s and a projected archive
size. **The node keeps running** — this only reads. A warm-up pass runs first,
or the first level would pay for the disk read and every later one would read
from page cache, making level 0 look slowest.

It also prints `du` vs `du --apparent-size`, which answers §14.1 C directly:
apparent > allocated means the files are sparse and `tar --sparse` has something
to save; equal means it has nothing to save, so its Windows-bsdtar
incompatibility buys us nothing and the question is closed.

Finally it times `--rsyncable` at the shipped level, so the mirror discount has
a measured price rather than an assumed one.

**§14.1 B was already half-closed** and this was missed in the earlier summary:
`preflight_disk_space` self-calibrates, preferring a ratio measured from the
published archive over the `COMPRESS_RATIO_*` constant. What was actually open
was the *level* choice, which is what `J` answers.

### 17.6 Verification

**75 local tests pass** — 38 for schedule derivation, target validation,
in-place enable/disable and the transfer lifecycle; 37 for alert dispatch,
notification dedupe/recovery, the `ensure_package` cache and the filter argv.

Still needs the VPS, and only the VPS:

| | why |
|---|---|
| `flock` | not in Git-bash, so the lock only runs its degrade-to-no-op branch here |
| rsync filter semantics | no rsync locally — the `R`/`P` ordering is documented behaviour, not observed |
| real transfers, key auth, identity probe | need two hosts |
| the benchmark's actual numbers | needs real chain_data |
| the phases 1-4 acceptance run | §14.1 A, unchanged |

---

## 18. Pre-test review — logic, flow, syntax, UI (2026-08-21)

A read-through of §15–§17 before the first VPS run. Nine defects, all found by
reading the code against the file it lives in rather than against my memory of
it. Three would have been visible immediately on the VPS; four were silent.

### 18.1 Silent — would have shipped unnoticed

**Rescheduling the copy stacked a second cron entry.** `menu_remote_schedule`
de-duplicated by removing the *exact line* it was about to write. Changing the
offset from 3h to 5h produced a line that no longer matched, so the old one
survived: the copy then ran twice a night, on two schedules, for ever. The tag
line *was* removed, so the survivor was untagged and did not appear in the
"installed copy schedules" list. Now filtered on `--cron-remote <site_key>`,
the same predicate `menu_remote_unschedule` already used.

**`rc_target_remove` reported success for a mirror that did not exist.** It
returned 0 unconditionally, so the menu printed "Removed." after a mistyped
name — an operator retiring a mirror could walk away believing it was gone
while it was still enabled and still receiving every upload. `rc_target_set_enabled`
already refused an unknown alias; the two now agree. An empty site_key is also
refused: `rc_target_exists` treats empty as "any", so it matched on the alias
alone and then deleted nothing, reported as success.

**The compression benchmark's pick-list could never populate.** It called
`load_nginx_config` and read `${k}_CHAIN_DATA`, but those live in
`$INSTANCES_CONF`; the nginx conf holds `LOCAL_WEB_DIR_*`, which are the *output*
directories. Every run fell through to "type a path", which reads as a design
choice rather than the bug it was. It now sources `$INSTANCES_CONF` as well.

**`menu_remote_schedule` was the only cron writer in the file that piped
`crontab -l` straight into `crontab -`.** Every sibling captures into a variable
first. Real `crontab -` consumes stdin before writing, so this was probably
survivable — but reading and writing one store in a single pipeline is the exact
shape that truncates if the writing end ever opens its target first, and there
was no reason for this one to differ from the other eight.

### 18.2 Visible — would have shown up on the first run

**The "Copy to mirrors now" screen promised checksum verification that no
longer happens.** It still said each archive is verified locally before upload
and again on the mirror. Both gates were turned off by default in §16 (they read
a 17–20 GB file twice more, which is the IO this redesign exists to avoid). A
screen claiming a gate nobody is running is worse than no screen. It now states
what is actually true: rsync verifies what it transfers, and the `.sha256` ships
for the downloader.

**The sparseness report could emit a raw bash error mid-table.** The guard tested
`"${real_kb}${app_kb}"` as one string, so one `du` failing left the surviving
digits looking numeric and the comparison printed
`[: : integer expression expected` into the middle of a formatted report. Tested
separately now.

**The `--rsyncable` row was timed at the wrong level.** It read `$NODE_TYPE`,
which detection has not set when the menu is reached, so it silently used the
pruned level even when benchmarking the archive node. It now uses the instance
the operator actually picked, and says which.

### 18.3 UI consistency

**Remove and enable/disable were the only prompts asking for typed input.**
Everything else in the remote menu is a numbered choice; those two asked the
operator to type a `site_key` — internal jargon appearing in no other prompt —
and an alias, from memory. Replaced with `_rc_pick_target`, a numbered list that
shows site_key, name, host and `(disabled)`, and returns the fields directly.
This is also what removed the class of bug in §18.1: with no free text there is
no typo to mis-handle.

### 18.4 Two flow changes

**The copy now waits 60s for the share lock instead of giving up instantly.**
The two holders are not alike: a build holds it only for the publish swap (a few
seconds of rm+mv), so failing immediately turned a routine overlap into a
reported failure and a fortnight of staleness. A running copy holds it for
hours, which 60s cannot outlast — so that case still gives up fast, as it should.

**`_rc_restore_remote` is gated on whether a stash was actually taken.** The
first failure path is "ssh connection failed", and restoring over a dead
connection cost a second full `ConnectTimeout` per unreachable mirror.

### 18.5 One security tightening

`_galert_load` sourced `alert.conf` under `set -a`, copying 082. 082 needs the
export because it hands the values to a compiled worker; here they are only read
in-process, so the export put the Telegram bot token and the nostr secret key
into the environment of every child the run spawns afterwards — tar, pigz, ssh,
rsync — for no gain. Dropped.

### 18.6 Verification

110 tests across three harnesses (38 + 37 + 35), full `bash -n` sweep clean. The
new harness lifts `menu_remote_schedule`, `_rc_derive_schedule` and
`_rc_pick_target` out of the script with `awk` and drives the real code, rather
than restating what it is believed to do — the methodology fix from §16, where a
hand-written fixture validated an assumption instead of the code.

The two picker tests failed on first run because the harness piped stdin into
`_rc_pick_target`, which put it in a subshell and discarded the globals it sets.
That was the test's fault, not the code's — the menu calls it directly. Noted
because the same shape is a real trap anywhere the pattern is reused.

### 18.7 Known limit, not fixed

If the *build* never runs, `rc_preflight_local` refuses and no per-target state
is written, so `rc_notify_summary` stays silent — a month of failed builds
leaves every mirror stale with no alert from the copy side. That is arguably
correct division of labour (the build cron owns its own failure surface) and
fixing it here would mean the copy alerting about something it does not run.
Flagged rather than built.
