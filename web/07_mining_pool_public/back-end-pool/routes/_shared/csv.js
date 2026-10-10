// CSV streaming helpers for the admin exports (H4). Moved VERBATIM from routes/index.js (P2).
// Stateless apart from the rateLimiter binding adminCsvGate needs, hence a factory.

module.exports = function createCsv(ctx) {
  const { rateLimiter } = ctx;


  // ─── FINANCIAL EXPORT (Admin, CSV) ─────────────────────────────────
  // Plain-CSV downloads for accounting/tax. Cookie-authenticated GETs so a normal browser
  // download link works (same-origin sends the httpOnly session cookie); still IP+auth gated.
  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // STREAMED, not accumulated (audit §J12-5). This used to build one string in memory by
  // map+join over every row before writing a byte — on tables that are never pruned, from a
  // handler with no row cap, on the 2400/min `admin` bucket. res.write per row lets Node's
  // own backpressure bound the peak instead of the row count deciding it.
  const sendCsv = (res, filename, header, rows, note = '') => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(header.join(',') + '\r\n');
    for (const r of rows) res.write(r.map(csvCell).join(',') + '\r\n');
    // A capped export that LOOKS complete is worse than one that is visibly capped. The
    // X-Export-Truncated header is correct but invisible to an operator clicking a download
    // link in the admin panel, so the last row says it in the file itself.
    if (note) res.write(csvCell(note) + '\r\n');
    res.end();
  };

  // Row cap + cursor for the two POOL-WIDE admin exports. The public, per-address exports have
  // had `CSV_MAX_ROWS = 50000` and a dedicated 10/min `export` bucket since §C1; the pool-wide
  // ones — over `withdrawals` and `blocks`, neither of which is ever pruned — had neither, and
  // rode the bucket the polling dashboard needs kept loose. An operator who genuinely wants the
  // whole ledger pages with `?before=<cursor>`; truncation and the next cursor are reported as
  // response HEADERS so the body stays valid CSV for a spreadsheet.
  const ADMIN_CSV_MAX_ROWS = 50000;
  const adminCsvGate = (req, res) => {
    const gate = rateLimiter.peek('export', req);
    if (!gate.allowed) { rateLimiter.sendLimited(res, gate); return false; }
    rateLimiter.consume('export', req);
    return true;
  };
  // The cursor is a bare integer (a `confirmed_at` timestamp, or a block height). It is bound,
  // not interpolated, either way — but it is validated as a number because a NaN binds happily
  // and matches nothing, turning a typo into an empty export that reads as "no data".
  const adminCsvBefore = (req) => {
    const raw = req.query.before;
    if (raw === undefined || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  };
  // Returns { page, note }: `note` is the trailing CSV row that makes truncation visible in
  // the downloaded file, since a response header is not.
  const adminCsvPage = (res, rows, nextOf) => {
    const truncated = rows.length > ADMIN_CSV_MAX_ROWS;
    const page = truncated ? rows.slice(0, ADMIN_CSV_MAX_ROWS) : rows;
    res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false');
    let note = '';
    if (truncated && page.length) {
      const next = nextOf(page[page.length - 1]);
      res.setHeader('X-Export-Next-Before', String(next));
      note = `TRUNCATED at ${ADMIN_CSV_MAX_ROWS} rows - continue with ?before=${next}`;
    }
    return { page, note };
  };


  return { csvCell, sendCsv, ADMIN_CSV_MAX_ROWS, adminCsvGate, adminCsvBefore, adminCsvPage };
};
