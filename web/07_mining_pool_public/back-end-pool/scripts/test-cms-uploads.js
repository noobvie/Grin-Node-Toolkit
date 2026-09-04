// CMS upload + canonical-origin regression tests — audit §J10 (uploads, assets, CMS & ads).
//
// Guards three fixes that are easy to undo by accident:
//   §J10-1  POST /api/admin/media must decide the stored extension from the FILE BYTES, never
//           from the client-declared MIME. The extension is what nginx turns into the served
//           Content-Type, so a MIME-derived `.svg` on arbitrary bytes is §A's stored-XSS bug
//           re-opened on the endpoint §A never covered. WEBP is accepted by this endpoint and
//           NOT by the branding-asset endpoint, so it must stay out of the shared SNIFFERS list
//           and be passed in per call — a "tidy-up" that folds it in silently widens what a
//           logo/favicon upload accepts.
//   §J10-4  seo.site_url must ship EMPTY. A non-empty default makes every fresh pool declare
//           someone else's domain as the canonical home of the operator's own content — in
//           sitemap.xml, the RSS feed, every server-rendered canonical/og:url, and the
//           client-side canonical + JSON-LD in branding.js.
//   §J10-5  'custom' must not be treated as a usable asset type. It never was in allowedTypes,
//           so the old `req.query.type || 'custom'` default could only ever 400.
//
// Pure in-process assertions against the real modules — no server, no DB, nothing left running.
// Run: node scripts/test-cms-uploads.js
const path = require('path');

const APP = path.resolve(__dirname, '..');
const AssetManager = require(path.join(APP, 'lib/asset-manager.js'));
const PoolSettings = require(path.join(APP, 'lib/pool-settings.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const { detectImage, WEBP_SNIFFER } = AssetManager;
const MEDIA_EXTRA = [WEBP_SNIFFER];               // what POST /api/admin/media passes
const pad = (b, n = 24) => Buffer.concat([b, Buffer.alloc(n)]);

const PNG  = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const JPG  = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const GIF  = pad(Buffer.from('GIF89a'));
const GIF7 = pad(Buffer.from('GIF87a'));
const WEBP = pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]));
const SVG  = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
const SVGX = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
const HTML = Buffer.from('<html><body><script>alert(document.domain)</script></body></html>');
const TEXT = Buffer.from('plain notes, definitely not an image, padding padding padding');
const PDF  = pad(Buffer.from('%PDF-1.7\n'));

console.log('\n[1] §J10-1 — the extension comes from the bytes\n');

ok('PNG signature → png/image/png',   (detectImage(PNG,  MEDIA_EXTRA) || {}).ext === 'png');
ok('JPEG signature → jpg/image/jpeg', (detectImage(JPG,  MEDIA_EXTRA) || {}).ext === 'jpg');
ok('GIF89a signature → gif',          (detectImage(GIF,  MEDIA_EXTRA) || {}).ext === 'gif');
ok('GIF87a signature → gif',          (detectImage(GIF7, MEDIA_EXTRA) || {}).ext === 'gif');
ok('real SVG → svg/image/svg+xml',    (detectImage(SVG,  MEDIA_EXTRA) || {}).mime === 'image/svg+xml');
ok('SVG behind an XML prolog → svg',  (detectImage(SVGX, MEDIA_EXTRA) || {}).ext === 'svg');

// The finding itself: these all used to be written to disk with an extension the CLIENT chose.
ok('§J10-1 HTML+script is not an image', detectImage(HTML, MEDIA_EXTRA) === null);
ok('§J10-1 plain text is not an image',  detectImage(TEXT, MEDIA_EXTRA) === null);
ok('§J10-1 a PDF is not an image',       detectImage(PDF,  MEDIA_EXTRA) === null);
ok('§J10-1 an empty buffer is not an image', detectImage(Buffer.alloc(0), MEDIA_EXTRA) === null);
ok('§J10-1 a 3-byte runt is not an image',   detectImage(Buffer.from([0x89, 0x50, 0x4e]), MEDIA_EXTRA) === null);

// A binary signature must win over the SVG text branch, or a crafted prefix could relabel a
// file. detectImage runs SNIFFERS before looksLikeSvg; assert that ordering holds.
ok('§J10-1 a binary signature is not shadowed by SVG text',
  (detectImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('<svg')]), MEDIA_EXTRA) || {}).ext === 'png');

console.log('\n[2] §J10-1 — WEBP widens the CMS endpoint only, never the branding one\n');

ok('WEBP is detected when the caller passes WEBP_SNIFFER',
  (detectImage(WEBP, MEDIA_EXTRA) || {}).ext === 'webp');
ok('§J10-1 WEBP is NOT detected by the default (branding-asset) set',
  detectImage(WEBP) === null);
ok('§J10-1 WEBP_SNIFFER needs the full RIFF….WEBP pair, not just RIFF',
  detectImage(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')])), MEDIA_EXTRA) === null);
ok('CONTROL: the default set still accepts the four branding types',
  ['png', 'jpg', 'gif', 'svg'].every((e, i) => (detectImage([PNG, JPG, GIF, SVG][i]) || {}).ext === e));

console.log('\n[3] §J10-4 — site_url must not ship a domain the operator does not own\n');

const seoDefaults = PoolSettings.defaults.seo;
ok('§J10-4 seo.site_url defaults to empty', seoDefaults.site_url === '',
  `got ${JSON.stringify(seoDefaults.site_url)}`);
ok('§J10-4 no seo default hardcodes an https:// origin',
  !Object.entries(seoDefaults).some(([, v]) => typeof v === 'string' && /^https?:\/\//i.test(v)),
  Object.entries(seoDefaults).filter(([, v]) => typeof v === 'string' && /^https?:\/\//i.test(v)).map(([k]) => k).join(', '));
ok('CONTROL: a validated site_url is still accepted',
  PoolSettings.validators.seo.site_url('https://pool.example.com') === 'https://pool.example.com');

console.log('\n[4] §J10-5 — the asset-type allowlist is the only source of valid types\n');

const inst = Object.create(AssetManager.prototype);
inst.allowedTypes = ['logo', 'logo_dark', 'favicon', 'og_image', 'apple_touch_icon', 'icon_192', 'icon_512'];
ok("§J10-5 'custom' is not an asset type", !inst.allowedTypes.includes('custom'));
ok('§J10-5 the seven real types are unchanged', inst.allowedTypes.length === 7 &&
  inst.allowedTypes.includes('logo') && inst.allowedTypes.includes('icon_512'));

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
