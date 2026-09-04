const { getDb } = require('./db');
const IncentivesManager = require('./incentives');
const { compareBlockToHeader } = require('./block-identity');

class OrphanDetector {
  constructor(config, grinNode) {
    this.config = config;
    this.grinNode = grinNode;
    this.db = getDb();
    this.incentives = new IncentivesManager(config);
  }

  // `block` is the whole stored row, not just its nonce: the comparison is by HASH wherever
  // both sides can supply one, and only falls back to the (irreducibly approximate) nonce
  // otherwise. See lib/block-identity.js — that comparator is shared with rewards.js so the
  // two readers of "is this our block?" can never disagree again (audit §J5-3).
  async verifyBlockOnChain(block) {
    try {
      const header = await this.grinNode.getHeader(block.height);
      const cmp = compareBlockToHeader(block, header);

      if (cmp.verdict === 'match') {
        return { onChain: true, by: cmp.by, hash: header.hash };
      }
      if (cmp.verdict === 'mismatch') {
        return {
          onChain: false,
          reason: cmp.by === 'hash' ? 'hash_mismatch' : 'nonce_mismatch',
          detail: cmp.detail
        };
      }

      // ⚠ 'unknown' — we could not compare at all. This is NOT a mismatch, and the caller's
      // else-branch reverses miner credits, so it must never reach it. Throwing keeps this
      // block immature for the next tick.
      //
      // `unverifiable` marks it as a PER-BLOCK data problem (a row whose hash is not 64-hex
      // and whose nonce was destroyed by the pre-§J5-1 INTEGER column), as opposed to the
      // node-level failures below. The callers skip just this block on it, rather than
      // aborting the whole sweep — otherwise one unverifiable legacy row would hold up every
      // other block's maturity forever, which is the §J5-1 stall in a new costume.
      const e = new Error(`cannot verify block at height ${block.height}: ${cmp.detail}`);
      e.unverifiable = true;
      throw e;
    } catch (err) {
      // ⚠ MONEY PATH. Returning onChain:false here makes the caller orphan the block and
      // REVERSE every miner's credit for it, so this branch may only fire when the node has
      // actually told us the height carries no header (err.nodeReplied && err.notFound —
      // both set by lib/grin-node.js). A 401, ECONNREFUSED or timeout means we do not KNOW;
      // rethrow so the caller aborts and retries on the next tick, leaving the block immature.
      //
      // This used to read `err.message.includes('height')` — which every message
      // grin-node.js builds for getHeader() satisfies, including the transport failures.
      // The effect was that any node outage silently orphaned every immature block past
      // confirm depth and reversed the payouts, and they stayed orphaned once it came back.
      if (err && err.nodeReplied === true && err.notFound === true) {
        return {
          onChain: false,
          reason: 'height_not_found'
        };
      }
      throw err;
    }
  }

  async detectOrphans() {
    // Declared outside the try so the catch can report partial progress on an abort.
    let results = null;
    try {
      const tip = await this.grinNode.getTip();
      const confirmDepth = this.config.network === 'mainnet'
        ? this.config.confirm_depth_mainnet
        : this.config.confirm_depth_testnet;

      const stmt = this.db.prepare(`
        SELECT * FROM blocks
        WHERE status = 'immature' AND height <= ?
        ORDER BY height ASC
      `);

      const immatureBlocks = stmt.all(tip.height - confirmDepth);

      results = {
        checked: 0,
        confirmed: 0,
        orphaned: 0,
        unverifiable: 0,
        details: []
      };

      for (const block of immatureBlocks) {
        results.checked++;

        let verification;
        try {
          verification = await this.verifyBlockOnChain(block);
        } catch (err) {
          // A per-block data problem skips the block; anything else (unreachable node, an
          // unclassifiable reply) is sweep-wide and must abort — see verifyBlockOnChain.
          if (!err || err.unverifiable !== true) throw err;
          console.error(`[block ${block.id}] skipped: ${err.message}`);
          results.unverifiable = (results.unverifiable || 0) + 1;
          continue;
        }

        if (verification.onChain) {
          // Money moves ONLY if the status claim landed — see confirmBlock/orphanBlock.
          if (!this.confirmBlock(block.id)) continue;
          this.incentives.payBlockFinderJackpot(block);
          results.confirmed++;
          results.details.push({
            block_id: block.id,
            height: block.height,
            status: 'confirmed'
          });
        } else {
          if (!this.orphanBlock(block.id, verification.reason)) continue;
          this.reverseBlockPayouts(block.id);
          results.orphaned++;
          results.details.push({
            block_id: block.id,
            height: block.height,
            status: 'orphaned',
            reason: verification.reason
          });
        }
      }

      return results;
    } catch (err) {
      // A throw here is normally verifyBlockOnChain refusing to guess about an unreachable
      // node (see above). The sweep is ABORTED, not clean — return whatever was already
      // verified so the caller can say so instead of printing a reassuring "0 checked".
      console.error(`Error detecting orphans: ${err.message}`);
      return {
        error: err.message,
        aborted: true,
        checked: results ? results.checked : 0,
        confirmed: results ? results.confirmed : 0,
        orphaned: results ? results.orphaned : 0
      };
    }
  }

  // CAS on 'immature', and RETURN whether the claim succeeded. Both callers follow the
  // transition with a money move (jackpot on confirm, reversal on orphan) and used to make it
  // unconditionally: a swallowed UPDATE failure left the row 'immature', so the very next tick
  // re-ran the same transition and paid/clawed a second time. The status flip is the claim —
  // if it did not land, nothing downstream of it may run. See audit §J5-6.
  confirmBlock(blockId) {
    try {
      const r = this.db.prepare(`
        UPDATE blocks SET status = 'confirmed', confirmed_at = unixepoch()
        WHERE id = ? AND status = 'immature'
      `).run(blockId);
      if (r.changes !== 1) {
        console.warn(`[block ${blockId}] confirm skipped — no longer 'immature' (already settled?)`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`Error confirming block ${blockId}: ${err.message}`);
      return false;
    }
  }

  orphanBlock(blockId, reason = 'unknown') {
    try {
      const r = this.db.prepare(`
        UPDATE blocks SET status = 'orphaned' WHERE id = ? AND status = 'immature'
      `).run(blockId);
      if (r.changes !== 1) {
        console.warn(`[block ${blockId}] orphan skipped — no longer 'immature' (already settled?)`);
        return false;
      }
      console.log(`Block ${blockId} marked as orphaned (reason: ${reason})`);
      return true;
    } catch (err) {
      console.error(`Error orphaning block ${blockId}: ${err.message}`);
      return false;
    }
  }

  // Raise an alerts-table row directly. AlertMonitor owns delivery and runs on its own loop;
  // this writes the row so the alert survives even though the reversal happens on the block
  // monitor's tick, with no AlertMonitor instance in scope. Deliberately synchronous and
  // best-effort — a failure to alert must never roll back the reversal itself.
  _alertLockedClawback(height, address, fromLocked, shortfall) {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO alerts (type, level, message, data, status, triggered_at, last_seen)
        VALUES ('orphan_clawback_locked', 'critical', ?, ?, 'active', ?, ?)
      `).run(
        `Orphan reversal for block ${height} clawed ${fromLocked} GRIN out of ${address}'s ` +
        `LOCKED balance` + (shortfall > 0 ? `, and ${shortfall} GRIN could not be recovered` : ''),
        JSON.stringify({ height, grin_address: address, from_locked: fromLocked, shortfall }),
        now, now
      );
    } catch (e) {
      console.error(`[orphan] failed to raise orphan_clawback_locked alert: ${e.message}`);
    }
  }

  reverseBlockPayouts(blockId) {
    try {
      const block = this.db.prepare('SELECT * FROM blocks WHERE id = ?').get(blockId);
      if (!block) return;

      // Reverse EXACTLY what was credited for this block, by reading back the original
      // balance_log credit rows (keyed by reference_type IN ('block','pool_fee') and
      // reference_id = block.height, matching rewards.js#creditBalances). This mirrors the
      // real difficulty-weighted PPLNS split (minus pool fee) instead of re-deriving it —
      // so it's correct even if the shares were pruned by retention, and it never reverses
      // more than was actually paid.
      //
      // Note: blocks are only distributed AFTER on-chain maturity verification, and orphan
      // detection only targets still-immature (never-distributed) blocks, so in normal
      // operation there are zero credit rows here and this is a safe no-op — we never deduct
      // a balance that was never credited (the previous equal-split logic did, and used the
      // wrong amount and miner set).
      const credits = this.db.prepare(`
        SELECT grin_address, COALESCE(SUM(amount), 0) AS amount
        FROM balance_log
        WHERE event_type = 'credit'
          AND reference_type IN ('block', 'pool_fee')
          AND reference_id = ?
        GROUP BY grin_address
      `).all(block.height);

      // Idempotency guard, mirroring incentives.reverseJackpot(). Without it a second call for
      // the same height re-reads the SAME credit rows (a reversal row does not cancel them out)
      // and debits again, clamping down to zero across a couple of ticks. See audit §J5-6.
      const alreadyReversed = this.db.prepare(`
        SELECT 1 FROM balance_log
        WHERE event_type = 'reversal' AND reference_type = 'block' AND reference_id = ? LIMIT 1
      `).get(block.height);
      if (alreadyReversed) {
        console.warn(`Reversal for block height=${block.height} already recorded — skipping`);
        return;
      }

      if (credits.length > 0) {
        const reverse = this.db.transaction(() => {
          for (const c of credits) {
            const before = this.db.prepare(
              'SELECT balance, balance_locked FROM miner_accounts WHERE grin_address = ?'
            ).get(c.grin_address);
            if (!before) continue;

            // Claw back from SPENDABLE first, then from LOCKED for the remainder.
            //
            // Reading `balance` alone (as this did) silently under-clawed exactly the miner
            // most likely to be mid-payout: their credited GRIN sits in balance_locked, so
            // `balance` is near zero and the clamp returned ~0 — the orphaned reward then
            // went out on the wire. Worse, the reversal row logged the clamped amount, so the
            // reconciliation integrity invariant stayed at 0 by construction and only the
            // aggregate coverage gap ever noticed. Audit §J5-11.
            //
            // Still clamped at the total the account actually holds: a reversal must never
            // drive a balance negative. A residual shortfall means the GRIN has already left
            // the pool, which is a solvency event, not a bookkeeping one — hence the alert.
            const want = c.amount;
            const fromBalance = Math.min(want, before.balance);
            const fromLocked = Math.min(want - fromBalance, before.balance_locked);
            const clawback = fromBalance + fromLocked;
            const shortfall = want - clawback;

            if (fromLocked > 0) {
              // A locked balance means a withdrawal is in flight for money this block was
              // supposed to fund. The scheduler owns that row's state machine, so we do not
              // touch it here — but the operator must know, because `locked_owed` and the
              // pending-withdrawal total have just diverged (reconciliation's locked_drift).
              console.error(
                `[CRITICAL] Orphan reversal for height=${block.height} took ${fromLocked} GRIN ` +
                `from ${c.grin_address}'s LOCKED balance — a payout is in flight for reversed ` +
                `funds. Freeze payouts and reconcile this address before resuming.`
              );
              this._alertLockedClawback(block.height, c.grin_address, fromLocked, shortfall);
            }
            if (shortfall > 0) {
              console.error(
                `[CRITICAL] Orphan reversal for height=${block.height} could only recover ` +
                `${clawback} of ${want} GRIN from ${c.grin_address} — ${shortfall} GRIN has ` +
                `already left the pool. This is a solvency shortfall, not a rounding error.`
              );
            }
            if (clawback <= 0) continue;

            this.db.prepare(`
              UPDATE miner_accounts
              SET balance = balance - ?, balance_locked = balance_locked - ?, updated_at = unixepoch()
              WHERE grin_address = ?
            `).run(fromBalance, fromLocked, c.grin_address);

            this.db.prepare(`
              INSERT INTO balance_log
              (grin_address, event_type, amount, balance_before, balance_after,
               locked_before, locked_after, reference_type, reference_id)
              VALUES (?, 'reversal', ?, ?, ?, ?, ?, 'block', ?)
            `).run(c.grin_address, clawback,
                   before.balance, before.balance - fromBalance,
                   before.balance_locked, before.balance_locked - fromLocked,
                   block.height);
          }
        });
        reverse();
      }

      // Claw back any block-finder jackpot paid for this block (idempotent).
      if (this.incentives) {
        this.incentives.reverseJackpot(block.height);
      }

      console.log(`Reversed payouts for orphaned block height=${block.height} (${credits.length} credited address(es))`);
    } catch (err) {
      console.error(`Error reversing block payouts: ${err.message}`);
    }
  }
}

module.exports = OrphanDetector;
