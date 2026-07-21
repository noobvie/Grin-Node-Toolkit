# 02_lib_landing.sh — decorated landing page for chain-data file servers
#
# Replaces the bare nginx autoindex on fullmain / prunemain / prunetest with a
# styled download page. The page is NOT a static snapshot of the file list: it
# polls Script 03's chaindata.json manifest, falling back to nginx's own JSON
# autoindex (/__listing/) plus the status note, so it tracks the archive going
# away and coming back during a sync WITHOUT a reload.
#
# Sourced by 02_nginx_fileserver_manager.sh — no shebang, no set -e.
#
# Public entry point:  landing_menu
#
# Files written into the web root (all survive Script 03's step-0 cleanup,
# which only removes *.tar.gz, *.sha256, README.txt and the status note):
#   index.html      the page
#   mirrors.json    copy of extensions/grinmasternodes.json (mirror fallbacks)
#   grin-logo.svg   og:image + favicon
#   robots.txt      SEO
#   sitemap.xml     SEO
#
# Nginx shape after install:
#     location /__listing/ { alias <root>/; autoindex on; autoindex_format json; }
#     location /          { autoindex on; ...; index index.html; }

LANDING_MARKER="__listing"                       # "vhost already patched" token
LANDING_CONF="/etc/grin-toolkit/landing.conf"    # remembers the GA4 id

# ── identity ─────────────────────────────────────────────────────────────────

# Map a web dir basename to display identity + neon pair. Sets:
#   _LND_LABEL _LND_SUB _LND_CHAIN _LND_MODE _LND_KEY _LND_A1 _LND_A2
_landing_identity() {
    case "$1" in
        fullmain)
            _LND_LABEL="Mainnet Archive"
            _LND_SUB="Every block since genesis. Serves any height."
            _LND_CHAIN="mainnet"; _LND_MODE="archive"; _LND_KEY="fullmain"
            _LND_A1="#ffb300"; _LND_A2="#ff2a6d" ;;
        prunemain)
            _LND_LABEL="Mainnet Pruned"
            _LND_SUB="Compact chain. The fastest way onto mainnet."
            _LND_CHAIN="mainnet"; _LND_MODE="pruned"; _LND_KEY="prunemain"
            _LND_A1="#05d9e8"; _LND_A2="#a742ff" ;;
        prunetest)
            _LND_LABEL="Testnet Pruned"
            _LND_SUB="Testnet chain for building and breaking things."
            _LND_CHAIN="testnet"; _LND_MODE="pruned"; _LND_KEY="prunetest"
            _LND_A1="#c77dff"; _LND_A2="#ff2a6d" ;;
        *)
            _LND_LABEL="Grin Chain Data"
            _LND_SUB="Snapshot mirror."
            _LND_CHAIN="mainnet"; _LND_MODE="pruned"; _LND_KEY=""
            _LND_A1="#05d9e8"; _LND_A2="#a742ff" ;;
    esac
}

_landing_root_of() {
    grep -oP '(?<=root\s).*?(?=;)' "$1" 2>/dev/null | head -1 | xargs
}

# Echoes "<domain>|<root>|<installed yes/no>" for every file-server vhost.
_landing_candidates() {
    local conf domain root
    for conf in "$NGINX_AVAILABLE"/*; do
        [[ -f "$conf" ]] || continue
        domain="$(basename "$conf")"
        [[ "$domain" == "default" || "$domain" == "default-ssl" ]] && continue
        grep -q "autoindex on;" "$conf" 2>/dev/null || continue
        root="$(_landing_root_of "$conf")"
        [[ -n "$root" ]] || continue
        if [[ -f "$root/index.html" ]] && grep -q "$LANDING_MARKER" "$conf" 2>/dev/null; then
            echo "${domain}|${root}|yes"
        else
            echo "${domain}|${root}|no"
        fi
    done
}

# ── static assets ────────────────────────────────────────────────────────────

# The Grin mark, recoloured for a dark ground: accent ring + accent glyph with
# the page background punched between them. Source: Grin-Landing-Pages
# web/grin-money-2026/grin_black_white.svg (black/white original).
_landing_write_logo() {
    local dir="$1"
    cat > "$dir/grin-logo.svg" << LND_SVG
<svg xmlns="http://www.w3.org/2000/svg" width="244" height="244" viewBox="0 0 244 244">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${_LND_A1}"/>
      <stop offset="1" stop-color="${_LND_A2}"/>
    </linearGradient>
  </defs>
  <g transform="matrix(1.03804,0,0,1.03804,-19.1739,-16.0598)">
    <circle cx="136" cy="133" r="92" fill="url(#g)"/>
  </g>
  <g transform="matrix(1.06897,0,0,1.06897,-29.7347,-25.25)">
    <circle cx="141.75" cy="137.75" r="79.75" fill="#07060f"/>
  </g>
  <g transform="matrix(1,0,0,1,0.208873,-2)">
    <path fill="url(#g)" fill-rule="nonzero" d="M162,92C159.966,87.434 158.071,78.413 152.855,76.407C146.14,73.825 141.989,90.729 141,95L140,95C138.307,87.682 136.035,77.31 128,75C124.28,90.624 131.886,107.479 139,121C146.596,117.37 150.297,106.002 151,98L152,98L160,122C166.436,120.15 168.675,113.781 170.999,108C175.988,95.592 180.174,80.332 177,67C167.395,69.72 164.473,83.455 162,92M66,124C74.595,119.896 78.685,106.906 80,98L81,98C82.017,102.293 84.736,113.368 90.1,114.079C96.934,114.983 100.517,99.819 101,95L102,95C104.179,102.529 106.475,112.32 114,116C116.776,104.34 113.452,91.905 109.188,81C108.092,78.196 105.841,70.636 101.975,70.636C95.641,70.636 92.08,87.332 91,92L90,92L82,68C67.928,74.72 60.284,110.453 66,124M51,136C61.443,181.551 109.612,207.374 153,188.138C168.791,181.137 181.317,168.663 188.539,153C190.405,148.953 194.07,141.628 191.933,136.318C189.805,131.029 169.166,139.671 164.009,141.928C163.285,142.25 162.774,142.918 162.655,143.702C162.655,143.702 162.655,143.702 162.655,143.702C162.486,144.811 162.786,145.941 163.485,146.82C164.183,147.699 165.216,148.247 166.335,148.333C170.116,148.624 175,149 175,149C159.313,179.365 116.899,192.791 87,168.532C80.308,163.103 74.338,156.652 70.32,149C68.377,145.3 66.575,140.568 63.272,138.029C60.099,135.589 55.285,134.753 51,136Z"/>
  </g>
</svg>
LND_SVG
}

# Mirror registry — the page falls back to these while this host is rebuilding.
# Copied from the repo so the page never has to reach off-host to find peers.
_landing_write_mirrors() {
    local dir="$1" src="$SCRIPT_DIR/../extensions/grinmasternodes.json"
    if [[ -f "$src" ]]; then
        cp "$src" "$dir/mirrors.json" && return 0
    fi
    print_warn "extensions/grinmasternodes.json not found — mirror fallback list will be empty."
    echo '{}' > "$dir/mirrors.json"
}

_landing_write_seo() {
    local dir="$1" domain="$2"
    cat > "$dir/robots.txt" << LND_ROBOTS
User-agent: *
Allow: /
Disallow: /__listing/

Sitemap: https://${domain}/sitemap.xml
LND_ROBOTS

    cat > "$dir/sitemap.xml" << LND_SITEMAP
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://${domain}/</loc>
    <lastmod>$(date -u +%Y-%m-%d)</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
LND_SITEMAP
}

# ── the page ─────────────────────────────────────────────────────────────────

# _landing_write_html <dest_dir> <domain> <ga4_id>
_landing_write_html() {
    local dir="$1" domain="$2" ga4="${3:-}"
    _landing_identity "$(basename "$dir")"

    local title="Grin ${_LND_LABEL} — chain data snapshot"
    local desc="Download a ready-made Grin ${_LND_CHAIN} chain_data snapshot (${_LND_MODE}). Sync a Grin node in minutes instead of days. Checksummed, rebuilt daily."

    # ── head: SEO, Open Graph, structured data ──────────────────────────────
    cat > "$dir/index.html" << LND_HEAD
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="https://${domain}/">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#07060f">
<meta name="author" content="noobvie">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Grin Chain Data">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="https://${domain}/">
<meta property="og:image" content="https://${domain}/grin-logo.svg">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://${domain}/grin-logo.svg">

<link rel="icon" type="image/svg+xml" href="/grin-logo.svg">
<link rel="apple-touch-icon" href="/grin-logo.svg">

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "Grin ${_LND_LABEL} chain data snapshot",
  "description": "${desc}",
  "url": "https://${domain}/",
  "license": "https://opensource.org/licenses/Apache-2.0",
  "keywords": ["Grin", "Mimblewimble", "blockchain", "chain_data", "${_LND_CHAIN}", "${_LND_MODE}", "node bootstrap"],
  "creator": { "@type": "Person", "name": "noobvie", "url": "https://github.com/noobvie" },
  "isAccessibleForFree": true,
  "distribution": {
    "@type": "DataDownload",
    "encodingFormat": "application/gzip",
    "contentUrl": "https://${domain}/"
  }
}
</script>

<script id="cfg" type="application/json">
{
  "label":  "${_LND_LABEL}",
  "sub":    "${_LND_SUB}",
  "chain":  "${_LND_CHAIN}",
  "mode":   "${_LND_MODE}",
  "siteKey":"${_LND_KEY}",
  "domain": "${domain}"
}
</script>
<style>:root{--a1:${_LND_A1};--a2:${_LND_A2};}</style>
LND_HEAD

    # ── optional GA4 ────────────────────────────────────────────────────────
    if [[ -n "$ga4" ]]; then
        cat >> "$dir/index.html" << LND_GA
<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${ga4}');
  gtag('set', 'user_properties', { network: '${_LND_CHAIN}', node_mode: '${_LND_MODE}' });
</script>
LND_GA
    fi

    # ── everything below is host-independent ────────────────────────────────
    cat >> "$dir/index.html" << 'LND_TAIL'
<style>
*{box-sizing:border-box}
:root{
  /* ground carries a violet bias — a neutral grey would flatten the neon */
  --bg:#07060f; --panel:#0e0c1a; --panel2:#141127; --line:#2a2440;
  --fg:#e6e4f5; --dim:#8f88b8;
  --ok:#00ff9f; --warn:#ffb300; --bad:#ff2a6d;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --notch:polygon(0 14px,14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%);
}
html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden}
body{
  background:var(--bg); color:var(--fg);
  /* mono is the primary voice — this is a terminal artefact, not a brochure */
  font-family:var(--mono); font-size:15px; line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
/* ambient: perspective grid + neon bloom, fixed so it never scrolls */
body::before{
  content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background:
    radial-gradient(680px 420px at 8% -6%, color-mix(in srgb,var(--a1) 20%,transparent), transparent 68%),
    radial-gradient(620px 400px at 96% 2%, color-mix(in srgb,var(--a2) 18%,transparent), transparent 68%),
    linear-gradient(color-mix(in srgb,var(--a1) 6%,transparent) 1px, transparent 1px) 0 0/100% 34px,
    linear-gradient(90deg, color-mix(in srgb,var(--a1) 6%,transparent) 1px, transparent 1px) 0 0/34px 100%;
}
/* scanline sweep */
body::after{
  content:"";position:fixed;left:0;right:0;height:34vh;z-index:-1;pointer-events:none;
  background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--a1) 7%,transparent),transparent);
  animation:sweep 9s linear infinite;
}
@keyframes sweep{0%{top:-34vh}100%{top:100vh}}
@media(prefers-reduced-motion:reduce){
  body::after{animation:none;display:none}
  *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}
.wrap{max-width:940px;margin:0 auto;padding:30px 20px 70px}
a{color:var(--a1)}
:focus-visible{outline:2px solid var(--a1);outline-offset:3px}

/* ── header ─────────────────────────────────────────────────────────────── */
.top{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.logo{width:54px;height:54px;flex:none;filter:drop-shadow(0 0 14px color-mix(in srgb,var(--a1) 55%,transparent))}
.eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim);margin:0 0 4px}
h1{
  font-size:clamp(27px,5.4vw,44px);line-height:1.05;margin:0;letter-spacing:-.015em;
  font-weight:750;text-transform:uppercase;text-wrap:balance;
  background:linear-gradient(96deg,var(--a1),var(--a2));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.sub{color:var(--dim);margin:14px 0 0;font-family:var(--sans);font-size:15.5px;max-width:60ch}
.host{margin:6px 0 0;font-size:12.5px;color:var(--dim);letter-spacing:.04em}
.host b{color:var(--a1);font-weight:600}

/* ── status HUD ─────────────────────────────────────────────────────────── */
.hud{
  margin:26px 0 0;padding:14px 16px;background:var(--panel);
  border:1px solid var(--line);border-left:3px solid var(--st,var(--dim));
  clip-path:var(--notch);
}
.hud .row{display:flex;align-items:center;gap:11px;flex-wrap:wrap}
.chip{
  display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;
  letter-spacing:.15em;text-transform:uppercase;color:var(--st,var(--dim));
}
.led{width:8px;height:8px;flex:none;background:var(--st,var(--dim));
  box-shadow:0 0 10px var(--st,var(--dim));animation:blink 1.9s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
.hud.is-ready{--st:var(--ok)} .hud.is-busy{--st:var(--warn)} .hud.is-down{--st:var(--bad)}
.hud .tick{margin-left:auto;font-size:11px;color:var(--dim);letter-spacing:.04em}
.hud .msg{margin:9px 0 0;font-family:var(--sans);font-size:14px;color:var(--dim);
  white-space:pre-wrap;line-height:1.5}

/* ── sections ───────────────────────────────────────────────────────────── */
h2{font-size:16px;letter-spacing:.16em;text-transform:uppercase;color:var(--fg);
  margin:44px 0 16px;font-weight:700;display:flex;align-items:center;gap:14px}
h2::after{content:"";flex:1;height:1px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--a1) 45%,transparent),transparent)}

/* ── hero ───────────────────────────────────────────────────────────────── */
.hero{border:1px solid var(--line);background:linear-gradient(168deg,var(--panel2),var(--panel));
  padding:22px;position:relative;clip-path:var(--notch)}
.hero::before{content:"";position:absolute;inset:0 0 auto;height:2px;
  background:linear-gradient(90deg,var(--a1),var(--a2))}
.fname{font-size:15px;word-break:break-all;margin:0;color:var(--fg);font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:6px 20px;color:var(--dim);font-size:12.5px;margin:10px 0 18px}
.meta b{color:var(--fg);font-weight:600;font-variant-numeric:tabular-nums}
.btnrow{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;gap:9px;min-height:44px;padding:11px 22px;
  font-family:var(--mono);font-weight:700;font-size:14px;letter-spacing:.06em;
  text-transform:uppercase;text-decoration:none;border:1px solid transparent;cursor:pointer;
  background:linear-gradient(96deg,var(--a1),var(--a2));color:#07060f;
  clip-path:polygon(0 9px,9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%);
  transition:filter .13s ease,transform .13s ease}
.btn:hover{filter:brightness(1.12) saturate(1.1);transform:translateY(-1px)}
.btn.ghost{background:none;border-color:var(--line);color:var(--dim);font-weight:600}
.btn.ghost:hover{color:var(--fg);border-color:var(--a1)}
.btn[aria-disabled="true"]{background:var(--panel2);color:var(--dim);border-color:var(--line);
  cursor:not-allowed;filter:none;transform:none}
.hash{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);font-size:11.5px;color:var(--dim)}
.hash code{color:var(--a1);word-break:break-all}
.halt{margin:0;font-family:var(--sans);font-size:14.5px;color:var(--dim);line-height:1.55}
.halt b{color:var(--warn)}

/* ── tabs + code ────────────────────────────────────────────────────────── */
.tabs{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:-1px;position:relative;z-index:1}
.tab{display:inline-flex;align-items:center;gap:7px;
  padding:9px 15px;font-family:var(--mono);font-size:12px;letter-spacing:.08em;
  text-transform:uppercase;cursor:pointer;color:var(--dim);background:none;
  border:1px solid transparent;border-bottom:none}
.tab .ti{font-size:15px;line-height:1;letter-spacing:0;filter:saturate(.9)}
.tab[aria-selected="true"]{color:var(--a1);background:var(--panel);
  border-color:var(--line);border-bottom-color:var(--panel)}
.pre{position:relative;border:1px solid var(--line);background:var(--panel);
  padding:16px 54px 16px 16px;overflow-x:auto}
.pre pre{margin:0;font-family:var(--mono);font-size:12.5px;line-height:1.8;color:#cdc9ec}
.pre .c{color:var(--dim)}
.copy{position:absolute;top:10px;right:10px;padding:6px 11px;font-family:var(--mono);
  font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;
  border:1px solid var(--line);background:var(--panel2);color:var(--dim)}
.copy:hover{color:var(--a1);border-color:var(--a1)}
.copy.done{color:var(--ok);border-color:var(--ok)}

/* ── mirrors ────────────────────────────────────────────────────────────── */
.mirrors{border:1px solid var(--line);background:var(--panel);padding:6px 18px 18px}
.mirrors.hot{border-color:color-mix(in srgb,var(--warn) 50%,var(--line));
  box-shadow:0 0 26px color-mix(in srgb,var(--warn) 11%,transparent)}
.zone{margin:16px 0 0}
.zone h3{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);
  margin:0 0 9px;font-weight:700}
.zone ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}
.zone a{display:inline-flex;align-items:center;min-height:38px;padding:8px 14px;font-size:13px;
  text-decoration:none;color:var(--fg);border:1px solid var(--line);background:var(--panel2)}
.zone a:hover{color:var(--a1);border-color:var(--a1)}
.zone a::after{content:"\2197";margin-left:8px;color:var(--dim);font-size:11px}
.zone a:hover::after{color:var(--a1)}

/* ── table ──────────────────────────────────────────────────────────────── */
.scroll{overflow-x:auto;border:1px solid var(--line);background:var(--panel)}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:460px}
th{text-align:left;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);
  font-weight:700;padding:13px 14px;border-bottom:1px solid var(--line)}
td{padding:11px 14px;border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent)}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:color-mix(in srgb,var(--a1) 6%,transparent)}
td.f{word-break:break-all}
td.f a{text-decoration:none;color:var(--fg)}
td.f a:hover{color:var(--a1)}
td.n{text-align:right;color:var(--dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
  padding:2px 7px;margin-left:9px;border:1px solid var(--line);color:var(--dim)}
.empty{color:var(--dim);padding:18px 14px;font-size:13.5px;font-family:var(--sans)}

/* ── footer ─────────────────────────────────────────────────────────────── */
footer{margin-top:54px;padding-top:22px;border-top:1px solid var(--line);font-size:12.5px;color:var(--dim)}
footer a{color:var(--dim);text-decoration:none}
footer a:hover{color:var(--a1)}
.made{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px}
.made .vn{width:21px;height:14px;flex:none;border:1px solid var(--line)}
.made .hrt{color:var(--bad)}

@media(max-width:600px){
  .wrap{padding:22px 15px 54px}
  .logo{width:44px;height:44px}
  .hud .tick{margin-left:0;width:100%}
  .meta{gap:4px 15px}
}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="top">
      <img class="logo" src="/grin-logo.svg" alt="Grin" width="54" height="54">
      <div>
        <p class="eyebrow" id="eyebrow">Grin</p>
        <h1 id="title">Grin Chain Data</h1>
      </div>
    </div>
    <p class="sub" id="subtitle"></p>
    <p class="host">Mirror <b id="hostline"></b></p>
  </header>

  <div class="hud" id="hud">
    <div class="row">
      <span class="chip"><span class="led"></span><span id="stateTxt">Checking</span></span>
      <span class="tick" id="tick">&nbsp;</span>
    </div>
    <p class="msg" id="statusTxt">Reading mirror status&hellip;</p>
  </div>

  <h2>Latest snapshot</h2>
  <div class="hero" id="hero"><p class="empty" style="padding:2px">Loading&hellip;</p></div>

  <h2 id="mirrorsHead">Other mirrors</h2>
  <div class="mirrors" id="mirrors"><p class="empty">Loading mirror list&hellip;</p></div>

  <h2>How to use it</h2>
  <div class="tabs" role="tablist" id="tabs">
    <button class="tab" role="tab" aria-selected="true"  data-t="linux"><span class="ti">&#128039;</span>Linux / macOS</button>
    <button class="tab" role="tab" aria-selected="false" data-t="win"><span class="ti">&#129003;</span>Windows</button>
    <button class="tab" role="tab" aria-selected="false" data-t="stream"><span class="ti">&#9889;</span>Stream extract</button>
  </div>
  <div class="pre">
    <button class="copy" id="copyCmd">Copy</button>
    <pre id="cmd"></pre>
  </div>

  <h2>All files</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>File</th><th class="n">Size</th><th class="n">Modified (UTC)</th></tr></thead>
      <tbody id="files"><tr><td class="empty" colspan="3">Loading&hellip;</td></tr></tbody>
    </table>
  </div>

  <footer>
    <div>Chain-data mirror served by the
      <a href="https://github.com/noobvie/Grin-Node-Toolkit">Grin Node Toolkit</a>.</div>
    <div class="made">
      <svg class="vn" viewBox="0 0 30 20" role="img" aria-label="Vietnamese heritage and freedom flag">
        <rect width="30" height="20" fill="#f2c200"/>
        <rect y="6"  width="30" height="2.4" fill="#da251d"/>
        <rect y="9.4" width="30" height="2.4" fill="#da251d"/>
        <rect y="12.8" width="30" height="2.4" fill="#da251d"/>
      </svg>
      <span>Made with <span class="hrt">&#10084;</span> from Saigon</span>
    </div>
  </footer>
</div>

<script>
(function(){
  "use strict";
  var CFG = JSON.parse(document.getElementById("cfg").textContent);
  var $ = function(id){ return document.getElementById(id); };
  var POLL_MS = 20000;

  document.title = "Grin " + CFG.label + " — chain data snapshot";
  $("title").textContent    = CFG.label;
  $("eyebrow").textContent  = "Grin · " + CFG.chain + " · " + CFG.mode;
  $("subtitle").textContent = CFG.sub;
  $("hostline").textContent = CFG.domain;

  /* ── formatting ─────────────────────────────────────────────────────── */
  function bytes(n){
    if (n === null || n === undefined) return "—";
    var u = ["B","KB","MB","GB","TB"], i = 0;
    while (n >= 1024 && i < u.length - 1){ n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + " " + u[i];
  }
  function when(s){
    var d = new Date(s);
    return isNaN(d) ? "—" : d.toISOString().slice(0,16).replace("T"," ");
  }
  function ago(s){
    var d = new Date(s); if (isNaN(d)) return "";
    var h = (Date.now() - d.getTime()) / 3.6e6;
    if (h < 1)  return "built just now";
    if (h < 24) return "built " + Math.round(h) + "h ago";
    var n = Math.round(h / 24);
    return "built " + n + (n === 1 ? " day ago" : " days ago");
  }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
    });
  }
  /* never serve a cached answer — the whole point is live state */
  function fresh(url){
    return fetch(url + (url.indexOf("?") < 0 ? "?" : "&") + "_=" + Date.now(),
                 { cache:"no-store" });
  }

  /* ── state ──────────────────────────────────────────────────────────── */
  var ARCHIVE = null, STATE = "unknown", MIRRORS_DRAWN = false;
  var BASE = location.origin + location.pathname.replace(/\/+$/, "") + "/";

  /* ── commands ───────────────────────────────────────────────────────── */
  function commands(){
    var f    = ARCHIVE ? ARCHIVE.name : "grin_chain_data.tar.gz";
    var base = f.replace(/\.tar\.gz$/, "");
    var url  = BASE + f;
    var dir  = CFG.chain === "testnet" ? "testnet" : "main";
    return {
      linux:
        '<span class="c"># 1. download the archive and its checksum</span>\n' +
        'wget ' + esc(url) + '\n' +
        'wget ' + esc(BASE + base + '.sha256') + '\n\n' +
        '<span class="c"># 2. verify — must print: OK</span>\n' +
        'sha256sum -c ' + esc(base) + '.sha256\n\n' +
        '<span class="c"># 3. stop your node first, then replace chain_data</span>\n' +
        'rm -rf ~/.grin/' + dir + '/chain_data\n' +
        'tar -xzf ' + esc(f) + ' -C ~/.grin/' + dir + '/',
      win:
        '<span class="c"># 1. download both files</span>\n' +
        'curl.exe -LO "' + esc(url) + '"\n' +
        'curl.exe -LO "' + esc(BASE + base + '.sha256') + '"\n\n' +
        '<span class="c"># 2. verify — compare against the .sha256 contents</span>\n' +
        'Get-FileHash -Algorithm SHA256 ' + esc(f) + '\n\n' +
        '<span class="c"># 3. extract over your chain_data</span>\n' +
        'tar -xzf ' + esc(f),
      stream:
        '<span class="c"># extract while downloading — no .tar.gz kept on disk.</span>\n' +
        '<span class="c"># saves an archive-size of free space; cannot be resumed.</span>\n' +
        'cd ~/.grin/' + dir + '/ &amp;&amp; rm -rf chain_data\n' +
        'wget -O - ' + esc(url) + ' | tar -xzvf -'
    };
  }
  function paintCmd(){
    var t = document.querySelector('.tab[aria-selected="true"]').dataset.t;
    $("cmd").innerHTML = commands()[t];
  }
  $("tabs").addEventListener("click", function(e){
    var b = e.target.closest(".tab"); if (!b) return;
    [].forEach.call(document.querySelectorAll(".tab"), function(x){
      x.setAttribute("aria-selected", String(x === b));
    });
    paintCmd();
  });
  $("copyCmd").addEventListener("click", function(){
    var txt = $("cmd").innerText.split("\n").filter(function(l){
      return l.trim() && l.trim()[0] !== "#";
    }).join("\n");
    var btn = this;
    navigator.clipboard.writeText(txt).then(function(){
      btn.textContent = "Copied"; btn.classList.add("done");
      setTimeout(function(){ btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
    });
  });
  paintCmd();

  /* ── hero ───────────────────────────────────────────────────────────── */
  function paintHero(){
    if (STATE === "busy"){
      $("hero").innerHTML =
        '<p class="halt"><b>This mirror is rebuilding its snapshot right now.</b><br>' +
        'The archive is deleted and recompressed from scratch, so there is nothing ' +
        'complete to download at this moment. This page updates itself the second ' +
        'it is ready — or grab the same chain from another mirror below.</p>';
      return;
    }
    if (!ARCHIVE){
      $("hero").innerHTML =
        '<p class="halt"><b>No snapshot is published here yet.</b><br>' +
        'Try one of the mirrors below, or check back shortly.</p>';
      return;
    }
    var base = ARCHIVE.name.replace(/\.tar\.gz$/, "");
    $("hero").innerHTML =
      '<p class="fname">' + esc(ARCHIVE.name) + '</p>' +
      '<div class="meta">' +
        '<span>Size <b>' + bytes(ARCHIVE.size) + '</b></span>' +
        '<span>Built <b>' + when(ARCHIVE.mtime) + ' UTC</b></span>' +
        '<span>' + ago(ARCHIVE.mtime) + '</span>' +
      '</div>' +
      '<div class="btnrow">' +
        '<a class="btn" href="' + esc(ARCHIVE.name) + '" id="dl">Download snapshot</a>' +
        '<a class="btn ghost" href="' + esc(base) + '.sha256">Checksum</a>' +
        '<a class="btn ghost" href="README.txt">Readme</a>' +
      '</div>' +
      '<div class="hash" id="hashBox" hidden>SHA-256 &nbsp;<code id="hashVal"></code></div>';

    if (window.gtag){
      var d = $("dl");
      if (d) d.addEventListener("click", function(){
        gtag("event", "download_snapshot", { file_name: ARCHIVE.name, network: CFG.chain });
      });
    }
    fresh(base + ".sha256").then(function(r){
      return r.ok ? r.text() : Promise.reject();
    }).then(function(t){
      var h = (t.trim().split(/\s+/)[0] || "");
      if (!/^[0-9a-f]{64}$/i.test(h)) return;
      $("hashVal").textContent = h;
      $("hashBox").hidden = false;
    }).catch(function(){});
  }

  /* ── status HUD ─────────────────────────────────────────────────────── */
  var LABEL = { ready:"Ready to download", busy:"Rebuilding — do not download",
                down:"No snapshot available", unknown:"Status unknown" };
  function paintHud(msg){
    var hud = $("hud");
    hud.className = "hud" + (STATE === "ready" ? " is-ready"
                          : STATE === "busy"  ? " is-busy"
                          : STATE === "down"  ? " is-down" : "");
    $("stateTxt").textContent = LABEL[STATE] || LABEL.unknown;
    $("statusTxt").textContent = msg;
    $("tick").textContent = "checked " +
      new Date().toISOString().slice(11,19) + " UTC · auto-refresh 20s";
  }

  /* ── mirrors ────────────────────────────────────────────────────────── */
  var ZONES = { america:"Americas", europe:"Europe", asia:"Asia", africa:"Africa" };
  function paintMirrors(reg){
    var here = CFG.domain.toLowerCase(), html = "", total = 0;
    Object.keys(ZONES).forEach(function(z){
      var hosts = (reg[z] && reg[z][CFG.siteKey]) || [];
      hosts = hosts.filter(function(h){ return String(h).toLowerCase() !== here; });
      if (!hosts.length) return;
      total += hosts.length;
      html += '<div class="zone"><h3>' + ZONES[z] + '</h3><ul>' +
        hosts.map(function(h){
          return '<li><a href="https://' + esc(h) + '/" rel="noopener">' + esc(h) + '</a></li>';
        }).join("") + '</ul></div>';
    });
    $("mirrors").innerHTML = total
      ? html
      : '<p class="empty">No other mirror is registered for this chain yet.</p>';
    MIRRORS_DRAWN = true;
  }
  function emphasiseMirrors(){
    var hot = (STATE === "busy" || STATE === "down");
    $("mirrors").classList.toggle("hot", hot);
    $("mirrorsHead").textContent = hot ? "Download from another mirror instead"
                                       : "Other mirrors";
  }

  /* ── files ──────────────────────────────────────────────────────────── */
  var SKIP = { "index.html":1, "mirrors.json":1, "grin-logo.svg":1,
               "robots.txt":1, "sitemap.xml":1 };
  function paintFiles(list){
    var rows = list.filter(function(f){
      return f.type === "file" && !SKIP[f.name];
    }).sort(function(a,b){ return new Date(b.mtime) - new Date(a.mtime); });
    $("files").innerHTML = rows.length ? rows.map(function(f){
      var tag = /\.tar\.gz$/.test(f.name) ? '<span class="tag">archive</span>'
              : /\.sha256$/.test(f.name)  ? '<span class="tag">checksum</span>'
              : /\.txt$/.test(f.name)     ? '<span class="tag">info</span>' : "";
      return '<tr><td class="f"><a href="' + esc(f.name) + '">' + esc(f.name) + '</a>' + tag +
             '</td><td class="n">' + bytes(f.size) +
             '</td><td class="n">' + when(f.mtime) + '</td></tr>';
    }).join("") : '<tr><td class="empty" colspan="3">This mirror is empty right now.</td></tr>';
  }

  /* ── poll ───────────────────────────────────────────────────────────── */
  /* Script 03 deletes the archive AND the status note at step 0, then writes
     "…in progress. DO NOT download…" at step 4 and "Sync completed…" at step 7.
     So a missing status note plus a missing archive is the step-0 window —
     treat it as not-downloadable, never as "still loading". */
  function classify(statusText, hasArchive){
    if (statusText){
      if (/DO NOT download|in progress/i.test(statusText)) return "busy";
      if (/Sync completed/i.test(statusText))             return hasArchive ? "ready" : "busy";
    }
    return hasArchive ? "ready" : "down";
  }

  /* chaindata.json (schema 1) is authoritative when present: Script 03 writes it
     at step 7 and deletes it at step 0, so it exists only while the archive is
     complete. It also carries an explicit generated_utc, which beats the mtime
     the autoindex reports. Absent → fall back to listing + status note, which is
     what mirrors running an older toolkit (or someone else's) still serve. */
  function fromManifest(m){
    if (!m || m.schema !== 1) return null;
    if (!m.archive || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(m.archive)) return null;
    return { name:   m.archive,
             size:   m.size_bytes,
             mtime:  m.generated_utc,
             sha256: m.sha256 || "",
             sums:   m.checksum_file || "" };
  }

  function poll(){
    var pMan  = fresh("chaindata.json").then(function(r){
          return r.ok ? r.json() : null;
        }).catch(function(){ return null; });
    var pList = fresh("__listing/").then(function(r){
          return r.ok ? r.json() : Promise.reject(r.status);
        }).catch(function(){ return null; });
    var pStat = fresh("check_status_before_download.txt").then(function(r){
          return r.ok ? r.text() : "";
        }).catch(function(){ return ""; });

    Promise.all([pList, pStat, pMan]).then(function(res){
      var list = res[0], status = (res[1] || "").trim();
      var man  = fromManifest(res[2]);

      if (man){
        var was = STATE;
        ARCHIVE = man;
        STATE   = "ready";
        paintHud(status || "Snapshot published and ready to download.");
        if (Array.isArray(list)) paintFiles(list);
        emphasiseMirrors();
        if (STATE !== was) paintHero();
        paintCmd();
        return;
      }

      if (!Array.isArray(list)){
        STATE = "unknown";
        paintHud("Could not read this mirror's file listing. " +
                 "Try a mirror below, or open /__listing/ directly.");
        emphasiseMirrors();
        return;
      }

      var tars = list.filter(function(f){
        return f.type === "file" && /\.tar\.gz$/.test(f.name);
      }).sort(function(a,b){ return new Date(b.mtime) - new Date(a.mtime); });

      var prev = STATE;
      ARCHIVE = tars[0] || null;
      STATE = classify(status, !!ARCHIVE);

      paintHud(status || (STATE === "down"
        ? "This mirror has not published a snapshot yet."
        : "No status note published by this mirror."));
      paintFiles(list);
      emphasiseMirrors();
      if (STATE !== prev) paintHero();       /* only redraw when it actually flips */
      paintCmd();
    });
  }

  /* mirrors are static — fetch once, keep across polls */
  fresh("mirrors.json").then(function(r){
    return r.ok ? r.json() : Promise.reject();
  }).then(paintMirrors).catch(function(){
    $("mirrors").innerHTML = '<p class="empty">Mirror list unavailable.</p>';
  });

  paintHero();
  poll();
  setInterval(poll, POLL_MS);
  /* catch up immediately when the tab is brought back to the front */
  document.addEventListener("visibilitychange", function(){
    if (!document.hidden) poll();
  });
})();
</script>
</body>
</html>
LND_TAIL

    chown www-data:www-data "$dir/index.html" 2>/dev/null \
        || chown nginx:nginx "$dir/index.html" 2>/dev/null || true
    chmod 644 "$dir/index.html"
}

# ── nginx patching ───────────────────────────────────────────────────────────

_landing_patch_vhost() {
    local conf="$1" root="$2" tmp
    grep -q "$LANDING_MARKER" "$conf" 2>/dev/null && return 0

    tmp="$(mktemp)"
    awk -v root="$root" '
        !done && /^[[:space:]]*location \/ \{[[:space:]]*$/ {
            print "    # JSON file listing consumed by the landing page (index.html)"
            print "    location /__listing/ {"
            print "        alias " root "/;"
            print "        autoindex on;"
            print "        autoindex_format json;"
            print "        autoindex_exact_size on;"
            print "        index _no_index_here_;"
            print "        default_type application/json;"
            print "    }"
            print ""
            print "    # the landing page polls these — never let a proxy pin them"
            print "    location = /check_status_before_download.txt { add_header Cache-Control \"no-store\" always; }"
            print ""
            print "    # Content negotiation on \"/\" — DO NOT simplify to \"index index.html;\"."
            print "    # Script 01 discovers mirrors by GET / (greps href=\"*.tar.gz\") and by"
            print "    # HEAD / (Last-Modified freshness). Serving index.html there breaks both:"
            print "    # the landing page has no static hrefs (the list is JS-rendered from"
            print "    # /__listing/), and index.html'\''s frozen mtime makes every mirror look"
            print "    # stale once it passes the age limit. Browsers send Accept: text/html;"
            print "    # curl/wget/requests send */* — so tools keep the byte-identical"
            print "    # autoindex they see today, including third-party Script 01 copies we"
            print "    # cannot update. \"index\" is pinned to a non-existent name because"
            print "    # nginx defaults to index.html on its own."
            print "    location = / {"
            print "        if ($http_accept ~* text/html) { rewrite ^ /index.html last; }"
            print "        index _no_index_here_;"
            print "        autoindex on;"
            print "        autoindex_exact_size off;"
            print "        autoindex_localtime on;"
            print "        autoindex_format html;"
            print "    }"
            print ""
            print $0
            done = 1
            next
        }
        { print }
    ' "$conf" > "$tmp" || { rm -f "$tmp"; return 1; }

    if ! grep -q "$LANDING_MARKER" "$tmp"; then
        rm -f "$tmp"
        print_warn "Could not locate a 'location / {' block in $(basename "$conf") — vhost left untouched."
        return 1
    fi

    cp "$conf" "$conf.landing-backup"
    cat "$tmp" > "$conf"
    rm -f "$tmp"
}

_landing_unpatch_vhost() {
    local conf="$1" tmp
    grep -q "$LANDING_MARKER" "$conf" 2>/dev/null || return 0
    tmp="$(mktemp)"
    awk '
        /^[[:space:]]*# JSON file listing consumed by the landing page/ { skip=1; next }
        skip && /^[[:space:]]*location \/__listing\/ \{/ { depth=1; next }
        skip && depth {
            if (/\{/) depth++
            if (/\}/) { depth--; if (depth == 0) { skip=0; getline; } }
            next
        }
        /^[[:space:]]*# the landing page polls these/ { getline; getline; next }
        /^[[:space:]]*# Content negotiation on "\/"/ { neg=1; next }
        neg && /^[[:space:]]*location = \/ \{/ { ndepth=1; next }
        neg && ndepth {
            if (/\{/) ndepth++
            if (/\}/) { ndepth--; if (ndepth == 0) { neg=0; getline; } }
            next
        }
        neg { next }
        { print }
    ' "$conf" > "$tmp" || { rm -f "$tmp"; return 1; }
    cp "$conf" "$conf.landing-backup"
    cat "$tmp" > "$conf"
    rm -f "$tmp"
}

_landing_reload() {
    local conf="$1"
    if nginx -t &>/dev/null; then
        systemctl reload nginx
        rm -f "$conf.landing-backup"
        return 0
    fi
    print_error "nginx config test failed — rolling back."
    [[ -f "$conf.landing-backup" ]] && mv "$conf.landing-backup" "$conf"
    nginx -t
    return 1
}

# ── actions ──────────────────────────────────────────────────────────────────

# Ask once for a GA4 id, remember it. Empty = no analytics emitted at all.
_landing_ga4() {
    local saved="" ans
    [[ -f "$LANDING_CONF" ]] && saved="$(grep -oP '(?<=^GA4_ID=).*' "$LANDING_CONF" 2>/dev/null | head -1)"
    if [[ -n "$saved" ]]; then
        read -r -p "Google Analytics 4 ID [$saved] (- to disable): " ans
        [[ -z "$ans" ]] && ans="$saved"
        [[ "$ans" == "-" ]] && ans=""
    else
        read -r -p "Google Analytics 4 ID (blank = none, e.g. G-XXXXXXXXXX): " ans
    fi
    if [[ -n "$ans" && ! "$ans" =~ ^G-[A-Z0-9]+$ ]]; then
        print_warn "That does not look like a GA4 ID (G-XXXXXXXXXX) — skipping analytics."
        ans=""
    fi
    mkdir -p "$(dirname "$LANDING_CONF")"
    printf 'GA4_ID=%s\n' "$ans" > "$LANDING_CONF"
    chmod 600 "$LANDING_CONF"
    _LND_GA4="$ans"
}

_landing_install() {
    local domain="$1" root="$2" conf="$NGINX_AVAILABLE/$domain"

    if [[ ! -d "$root" ]]; then
        print_error "Web root does not exist: $root"
        return 1
    fi
    if [[ -f "$root/index.html" ]] && ! grep -q 'id="cfg"' "$root/index.html" 2>/dev/null; then
        local ow
        read -r -p "An unrelated index.html already exists in $root. Overwrite? (y/N): " ow
        [[ "${ow,,}" =~ ^y ]] || { print_info "Cancelled."; return 0; }
    fi

    _landing_ga4

    print_info "Writing landing page → $root/index.html"
    _landing_identity "$(basename "$root")"
    _landing_write_html    "$root" "$domain" "$_LND_GA4" || { print_error "Failed to write index.html"; return 1; }
    _landing_write_logo    "$root"
    _landing_write_mirrors "$root"
    _landing_write_seo     "$root" "$domain"
    chmod 644 "$root"/grin-logo.svg "$root"/mirrors.json "$root"/robots.txt "$root"/sitemap.xml 2>/dev/null || true

    print_info "Patching vhost → $conf"
    _landing_patch_vhost "$conf" "$root" || return 1
    _landing_reload "$conf" || return 1

    print_info "Landing page live at https://${domain}/"
    print_info "It polls the file list + status note every 20s — during a Script 03"
    print_info "rebuild it blocks the download and points visitors at other mirrors."
    [[ -n "$_LND_GA4" ]] && print_info "GA4 enabled: $_LND_GA4" \
                         || print_info "No analytics embedded."
}

_landing_remove() {
    local domain="$1" root="$2" conf="$NGINX_AVAILABLE/$domain"
    print_info "Removing landing page from $domain"
    rm -f "$root/index.html" "$root/grin-logo.svg" "$root/mirrors.json" \
          "$root/robots.txt" "$root/sitemap.xml"
    _landing_unpatch_vhost "$conf" || return 1
    _landing_reload "$conf" || return 1
    print_info "Reverted to the plain nginx directory listing."
}

# ── menu ─────────────────────────────────────────────────────────────────────

landing_menu() {
    local lines=() line domain root state i sel

    mapfile -t lines < <(_landing_candidates)
    if [[ ${#lines[@]} -eq 0 ]]; then
        print_warn "No file-server domains found (no vhost with 'autoindex on;')."
        print_info "Set one up first with menu option 1 or 2."
        return 0
    fi

    print_section "Chain-Data Landing Page"
    echo ""
    echo "  Replaces the bare nginx file listing with a styled download page that"
    echo "  polls this mirror live — while Script 03 rebuilds the archive it blocks"
    echo "  the download and offers the other mirrors from grinmasternodes.json."
    echo ""

    i=0
    for line in "${lines[@]}"; do
        i=$(( i + 1 ))
        IFS='|' read -r domain root state <<< "$line"
        if [[ "$state" == "yes" ]]; then
            printf "  %2d) %-32s %s  ${GREEN}[installed]${NC}\n" "$i" "$domain" "$root"
        else
            printf "  %2d) %-32s %s\n" "$i" "$domain" "$root"
        fi
    done
    echo ""
    echo "   0) Back"
    echo ""

    read -r -p "Select a domain [0-$i]: " sel
    [[ "$sel" == "0" || -z "$sel" ]] && return 0
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || (( sel < 1 || sel > i )); then
        print_error "Invalid selection."
        return 0
    fi

    IFS='|' read -r domain root state <<< "${lines[$((sel-1))]}"

    if [[ "$state" == "yes" ]]; then
        local act
        echo ""
        echo "  1) Regenerate — refresh the page, mirror list and SEO files"
        echo "  2) Remove — revert to the plain nginx listing"
        echo "  0) Back"
        echo ""
        read -r -p "Choice [0-2]: " act
        case "$act" in
            1) _landing_install "$domain" "$root" ;;
            2) _landing_remove  "$domain" "$root" ;;
            *) return 0 ;;
        esac
    else
        _landing_install "$domain" "$root"
    fi
}
