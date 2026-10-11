// payments.html <head> deep-link redirect — moved BYTE-verbatim out of the inline <script> (code-layout F3).
// MUST stay the FIRST script in <head>, before every stylesheet and script (H18): it is a blocking
// classic <script src>, so it still runs before the queue paints.
  // Old deep links (2026-10 split): the section rail slugged these headings while they lived on
  // this page (admin-shell.js slugify of each h2's data-sec / text). Two now have pages of their
  // own; the request audit is a section of the Security page, where the same data-sec gives the
  // same slug. replace(), so Back does not bounce here again. It sits in <head>, ahead of every
  // stylesheet and script, so the queue does not paint first — but replace() only STARTS the
  // navigation: the body's scripts may still run (and fire their read-only GETs) until it lands.
  (function () {
    const MOVED = {
      '#sec-reconciliation':     '/admin/treasury.html',
      '#sec-abandoned-balances': '/admin/dormant.html',
      '#sec-request-audit':      '/admin/users.html#sec-request-audit',
    };
    const to = MOVED[location.hash];
    if (to) location.replace(to);
  })();
