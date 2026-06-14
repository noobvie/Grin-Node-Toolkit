'use strict';

// ─── Grin Transporter — payout rail #3 (PLACEHOLDER) ─────────────────────────
//
// Reserved stub for the planned self-hosted store-and-forward slate relay (Script 056).
// It will let the pool deliver payouts to miners who are NOT online/reachable when we pay —
// the slate is dropped into a relay mailbox and the miner picks it up later. This is the
// async rail that benefits small/casual miners most.
//
// NOT IMPLEMENTED YET. Shipping is gated on one open question (see docs/generated/
// script056_design.md): does the wallet the miner already runs support receiving on a relay?
// Standard grin-wallet speaks Tor + manual slatepack, NOT a custom relay — so a Transporter
// payout is useless until that's answered. Until then `transporter_enabled` is forced off in
// the admin panel and this rail throws if invoked.
//
// When implemented this should mirror the WalletTor interface used by withdrawal-scheduler.js
// (probe reachability + send), so it can slot in as a third option alongside Tor and manual.

class WalletTransporter {
  constructor(config) {
    this.config = config || {};
    this.available = false; // never advertise as a usable rail until Script 056 lands
  }

  isAvailable() {
    return false;
  }

  async probeReachable(/* grinAddress */) {
    return { online: false, reason: 'transporter_not_implemented' };
  }

  async send(/* grinAddress, amount */) {
    throw new Error('Grin Transporter payout rail is not implemented yet (Script 056). ' +
      'Use the Tor rail; the admin toggle is reserved and disabled.');
  }
}

module.exports = WalletTransporter;
