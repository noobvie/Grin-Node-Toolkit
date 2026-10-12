'use strict';

// Coarse public uptime for the pool process and its wallet link — the homepage P-02 "Pool svc"
// and "Wallet" lamps, beside the node's `up_days`. Same contract as the node (design §20.5):
// an integer of WHOLE UTC DAYS via upDaysFrom (flips only at 00:00 UTC, understates by up to a
// day, never overstates), or null for unknown. Never a timestamp, never seconds, never 0 for
// unknown — a restart time to the minute is exactly what §20.5 exists to keep private.
//
// Both clocks live in memory, so both restart with the pool process: the wallet link can never
// claim more than the pool has seen. That understates after a pool restart, which is the
// direction this contract allows.

const { upDaysFrom } = require('./node-availability');

const nowS = () => Math.floor(Date.now() / 1000);
const PROCESS_START = nowS();

// Longest silence between two observations the wallet clock will vouch for. The observers are
// AlertMonitor's wallet check (60 s by default, but it can be disabled) and /api/pool/status (15 s
// cache, only while someone is looking). A gap past this restarts the clock at the next success
// rather than assume nothing happened while nobody was watching.
const MAX_GAP_S = 300;
// One failed probe is not an outage — same rule as node-availability's DOWN_STRIKES. A payout run
// holds grin-wallet's owner lock and can time a single retrieve_summary_info out.
const DOWN_STRIKES = 2;

class ReachableSince {
  constructor(now = nowS) {
    this.now = now;
    this.since = null;     // first success of the current unbroken run
    this.last = null;      // most recent success
    this.strikes = 0;
  }

  observe(ok) {
    const t = this.now();
    if (ok !== true) {
      this.strikes += 1;
      if (this.strikes >= DOWN_STRIKES) { this.since = null; this.last = null; }
      return;
    }
    this.strikes = 0;
    if (this.since === null || this.last === null || t - this.last > MAX_GAP_S) this.since = t;
    this.last = t;
  }

  // `reachableNow` is the caller's own probe result: not reachable now means null, whatever the
  // history says (same rule as NodeAvailability.upDaysPublic).
  upDays(reachableNow) {
    if (reachableNow !== true || this.since === null || this.last === null) return null;
    const t = this.now();
    if (t - this.last > MAX_GAP_S) return null;
    return upDaysFrom(this.since, t);
  }
}

// One shared instance: AlertMonitor and the status route both feed it.
const walletLink = new ReachableSince();

function poolUpDays(now = nowS()) {
  return upDaysFrom(PROCESS_START, now);
}

module.exports = { ReachableSince, walletLink, poolUpDays, MAX_GAP_S, DOWN_STRIKES };
