'use strict';

// In-process maintenance scheduler (design §19.12): two cadences, named jobs, one log
// line per job with its elapsed time. The jobs themselves arrive in later parts —
// activity sync, match timeouts and event transitions on the 5-min tier; session purge,
// chat retention, bot-move purge and ledger.verify() on the hourly tier.
//
// Rules:
//   - Timers are unref'd: a pending tick never keeps the process alive, so shutdown is
//     never held up by the scheduler.
//   - Everything runs SERIALLY through one queue. Jobs are synchronous DB work or awaits
//     on the pool link, and two tiers interleaving at an await would be two writers
//     reasoning about the same rows. A tier that comes due while it is already queued or
//     running is coalesced (it runs once, not twice).
//   - A job that throws is logged and the next job still runs. A job over its budget
//     logs a warning; it is not killed (synchronous work cannot be).
//   - No job is ever started after stop().

const TIERS = {
  '5m': { intervalMs: 5 * 60 * 1000, firstDelayMs: 60 * 1000 },
  '1h': { intervalMs: 60 * 60 * 1000, firstDelayMs: 5 * 60 * 1000 },
};
const DEFAULT_BUDGET_MS = 2000;

function createMaintenance({ log, tiers = TIERS, clock = () => Date.now() } = {}) {
  const jobs = { };
  for (const t of Object.keys(tiers)) jobs[t] = [];
  const timers = [];
  const queued = new Set();
  let chain = Promise.resolve();
  let stopped = false;
  let started = false;

  function register(name, fn, { tier = '1h', budgetMs = DEFAULT_BUDGET_MS } = {}) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error(`maintenance: bad job name ${name}`);
    if (!jobs[tier]) throw new Error(`maintenance: unknown tier ${tier}`);
    if (typeof fn !== 'function') throw new Error('maintenance: job must be a function');
    if (Object.values(jobs).some((list) => list.some((j) => j.name === name))) {
      throw new Error(`maintenance: duplicate job ${name}`);
    }
    jobs[tier].push({ name, fn, budgetMs });
  }

  async function runJob(tier, job) {
    const t0 = clock();
    try {
      await job.fn();
      const ms = clock() - t0;
      if (ms > job.budgetMs) log.warn(`[maint] ${tier} ${job.name} ok ${ms}ms (over budget ${job.budgetMs}ms)`);
      else log.info(`[maint] ${tier} ${job.name} ok ${ms}ms`);
    } catch (err) {
      log.error(`[maint] ${tier} ${job.name} FAILED after ${clock() - t0}ms: ${err && err.message ? err.message : err}`);
    }
  }

  // Queue one run of a tier; resolves when that run has finished. Coalesces.
  function runTier(tier) {
    if (!jobs[tier]) return Promise.reject(new Error(`maintenance: unknown tier ${tier}`));
    if (stopped || queued.has(tier)) return chain;
    queued.add(tier);
    chain = chain.then(async () => {
      queued.delete(tier);
      for (const job of jobs[tier]) {
        if (stopped) break;
        await runJob(tier, job);
      }
    });
    return chain;
  }

  function start() {
    if (started || stopped) return;
    started = true;
    for (const [tier, t] of Object.entries(tiers)) {
      const first = setTimeout(() => {
        if (stopped) return;
        runTier(tier);
        const every = setInterval(() => runTier(tier), t.intervalMs);
        every.unref();
        timers.push(every);
      }, t.firstDelayMs);
      first.unref();
      timers.push(first);
    }
  }

  // Stops scheduling; resolves once a job already running has finished.
  function stop() {
    stopped = true;
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers.length = 0;
    return chain;
  }

  function list() {
    return Object.entries(jobs).flatMap(([tier, l]) => l.map((j) => ({ tier, name: j.name, budgetMs: j.budgetMs })));
  }

  return { register, runTier, start, stop, list, _timers: timers };
}

module.exports = { createMaintenance, TIERS };
