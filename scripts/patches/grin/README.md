# `scripts/patches/grin/` — toolkit patches for the grin node

Applied by **Script 01 → key G → 1 (compile from source)** after the checkout, in file-name
order, one at a time (`git apply --check`, then `git apply`). The build offers them with a
`[Y/n]` prompt. Declining, or a patch that does not apply to the chosen ref, builds plain
upstream instead, and says so. A patched binary is named `grin-<ver>-<ref>-tkp<N>-<sha>`, and
its `.info` sidecar lists every patch with its sha256, so it can never pass for a release.

These are **workarounds we carry until upstream ships an equivalent**, not a fork. Each one is a
`git format-patch` file with the reasoning in its commit message. Drop a patch as soon as the
upstream release you build contains the fix.

| Patch | What | Applies to (checked 2026-09-25) |
|---|---|---|
| `0001-init-output-pos-index-search-forward.patch` | Chain compaction's output_pos repair reads every block header since genesis (4M+ random reads). Replaced with a forward galloping + binary search that places each output at the same height. | v5.5.1, master (= v5.5.1), staging `b66e188` |
| `0002-log-compaction-timings.patch` | Logs compaction start, finish and per-phase timings at `Info`, and promotes the output_pos repair counts from `debug` to `info`. Observability only. Needs 0001 first. | same |

## Why 0001 exists — the archive-node compaction stall

`chain.compact()` runs about once a day at random (a 1/1440 chance per block, in a "compactor"
thread). It also runs in the `sync` thread every time the node finishes syncing. It holds the
txhashset write lock for its whole run. Inside it, `init_output_pos_index()` repairs UTXOs that
have no output_pos index entry. If even one is missing, it walked `for search_height in
0..max_height`, reading a header from the block LMDB per height, and never stopped early.

On a pruned node that LMDB fits in RAM and the walk is quick. On an **archive node** (17 GB+
LMDB) on a 4 GB box it becomes hours of random page faults. Seen on the scan.grin.money VPS,
2026-09-24/25: 8–10 h at ~100 MB/s of reads with the disk 100% busy. The node API timed out
(owner `get_status` included), new blocks queued behind the lock until the node fell ~8 blocks
behind, and Tiny Explorer returned 502 for the whole episode.

Equivalence was checked against a model of the original loop on 20,000 random chains (identical
placement, including zero-growth heights and positions past the head). At mainnet scale
(4,035,199 heights), one missing output takes 44 header reads instead of 4,035,199.

⚠ **Not compiled on the dev box** (no Rust toolchain there). The first real compile is the
VPS build. If the patched build fails, nothing is installed, so the running node is untouched.

## Confirming it on a node

With 0002 applied, every compaction leaves lines like these (numbers are illustrative, not
measured):

```
INFO grin_chain::chain - compact: starting (archive_mode: true)
INFO grin_chain::txhashset::txhashset - init_output_pos_index: 3 utxos with missing index entries
INFO grin_chain::chain - compact: finished in 41s (txhashset 12s, output_pos index 1s)
```

`grep -E 'compact:|init_output_pos_index' grin-server.log*` shows how long each compaction took
and how many index entries it had to repair. **Still unknown:** why any UTXO keeps losing its
index entry in the first place. If none were missing, the walk would never run, even unpatched.
That count answers it.
