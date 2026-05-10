// media.js — Partner/sponsor banner display.
// Banner data is injected server-side as window.GRINSCAN_BANNERS (from banners.json
// in the config dir). No HTTP request — data arrives with the page HTML.
//
// To add or edit banners:
//   nano /opt/grin/grinscan/<network>/banners.json
//   No restart needed — server re-reads the file every 300 s.
//
// Banner entry fields:
//   active  boolean  false = skip this entry (default: true when omitted)
//   type    string   "image" — linked image banner
//                    "code"  — raw HTML embed (ad-network script tags etc.)
//   src     string   Image URL, e.g. /img/partners/mybanner-728x90.png
//   href    string   Click-through URL
//   alt     string   Alt text for the image
//   weight  number   Relative pick chance; weight:2 = twice as likely as weight:1
//   html    string   Raw HTML string (type "code" only)
//
// Image files → upload to /opt/grin/grinscan/app/public/img/partners/
(function () {
  const el = document.getElementById('gs-promo');
  if (!el) return;

  const items = window.GRINSCAN_BANNERS;
  if (!Array.isArray(items) || !items.length) return;

  // Filter to active entries (default active when field is absent)
  const pool = items.filter(b => b.active !== false);
  if (!pool.length) return;

  // Weighted random pick — weight:2 means twice the chance of weight:1
  const total = pool.reduce((s, b) => s + (b.weight || 1), 0);
  let rand = Math.random() * total;
  const item = pool.find(b => (rand -= (b.weight || 1)) < 0) || pool[0];

  if (item.type === 'image' && item.src) {
    // Build with DOM APIs — no raw-HTML injection risk on the image path
    const a   = document.createElement('a');
    a.href    = item.href || '#';
    a.target  = '_blank';
    a.rel     = 'noopener';
    const img = document.createElement('img');
    img.src   = item.src;
    img.alt   = item.alt || '';
    img.width  = 728;
    img.height = 90;
    img.style.cssText = 'display:block;width:100%;height:auto;';
    a.appendChild(img);
    el.appendChild(a);
  } else if (item.type === 'code' && item.html) {
    // Ad-network embed codes require innerHTML (script tags etc.)
    el.innerHTML = item.html;
  }
})();
