# =============================================================================
# lib/grin_log_signatures.sh — the grin log signature table (shared data)
# =============================================================================
# ONE table, two readers:
#   · 086 Diagnostics (lib/086_lib_diag.sh dg_triage) — per-signature counts and
#     a likely-origin finding for each match;
#   · the node event recorder (lib/grin_node_events.sh) — the same counts in an
#     evidence bundle's summary.txt. Its failure-class refinement (086 design
#     §8.6) is its OWN table on top of this one, because a class needs a scope
#     (start window, kernel log, live pid) that a per-line origin does not.
#
# Moved here verbatim from 086_lib_diag.sh (Part 3 of the recorder build) so the
# two cannot drift. Editing an entry changes 086's output: keep the four arrays
# index-aligned, and the recorder's copy in /opt/grin/lib/ picks the edit up on
# the next recorder install.
#
# Sourced data only — no shebang, no `set -e`, no functions, no side effects.
# =============================================================================

[[ -n "${_GRIN_LOG_SIGNATURES_SH_LOADED:-}" ]] && return 0
_GRIN_LOG_SIGNATURES_SH_LOADED=1

# ─── Log triage ───────────────────────────────────────────────────────────────
# Known grin log signatures → likely origin + where to look. FIRST MATCH WINS,
# so the order matters: specific causes before generic words like "peer".
# Regexes are lower-case ERE, matched against tolower(line), and must stay
# mawk-safe (no {n} intervals).
DG_SIG_RE=(
    'panicked at'
    'incompletemessage'
    'too many open files'
    'no space left|mdb_map_full|enospc'
    'permission denied|error loading config'
    'lock file|already locked|another grin process|failed to lock'
    'out of memory|memory allocation of|cannot allocate'
    'invalid ?root|corrupt|txhashset.*(invalid|fail)'
    'lmdb|mdb_|store error|db error'
    'too far in the future|clock'
    'wallet_listener|build_coinbase'
    'stratum'
    'api http server error'
    'header_sync|body_sync|state_sync|sync.*(error|fail|stall)'
    'peer|connection refused|connection reset|timed out|broken pipe|ban'
)
DG_SIG_NAME=(panic incomplete-message fd-limit disk-full permission node-lock
             out-of-memory chain-corrupt lmdb clock wallet-listener stratum
             api-other sync p2p)
DG_SIG_ORIGIN=(upstream client host host toolkit toolkit host chain chain host
               config consumer client network network)
DG_SIG_HINT=(
    "A Rust panic inside grin: an upstream bug or an unhandled condition. The backtrace is in the tmux pane capture. Search github.com/mimblewimble/grin/issues for the message before suspecting the toolkit."
    "An API client hung up before the node answered — a slow node (disk/RAM pressure) or a client timeout shorter than the call. Check which process holds connections to the API port. Not a node fault on its own."
    "File-descriptor limit exhausted. Raise LimitNOFILE / ulimit -n for the grin user (Host Optimization, hub 08 key 3, checks this)."
    "Disk or LMDB map full. Free space on the node's filesystem (Disk Cleanup, hub 08 key 7)."
    "Root-owned files in the node dir, or grin started as root / without HOME=<node dir>. Restart the node through the toolkit — it chowns the dir and relaunches as grin. Never test by running grin as root."
    "Two grin processes on one node dir (a root-socket and a gtmux session). Stop the node through the toolkit — it kills both tmux servers — then start it once."
    "The kernel or the allocator ran out of memory. Check the OOM lines in the host section and the swap size."
    "Chain-state validation errors. A PEER sending bad data (during sync or a fork) produces the same words, so first check whether the node is stuck or behind. If it is, restore chain data (Script 03) or resync; if it recurs on FRESH data, it is an upstream issue."
    "LMDB/store error. Check disk health and free space first; if the disk is fine, compare against upstream issues."
    "Block timestamps rejected — check the host clock (NTP sync in the host section)."
    "The node cannot reach the wallet listener that builds coinbase. Only matters for stratum mining (pool / solo)."
    "Stratum-side errors — a miner or the pool proxy. Look at the mining service, not the node."
    "Other API server errors — read the grouped lines below."
    "Sync errors. Only matters if the node is behind the reference tip."
    "P2P noise — normal in small numbers. Only matters with a low peer count or a node that is behind."
)
