// app.js — GrinScan frontend: index.html + block.html logic

// ── Utilities ────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtHash(h) {
  if (!h) return '—';
  return '0x' + h.slice(0, 8) + '…' + h.slice(-4);
}

function fmtAge(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 0) return 'just now';
  if (secs < 60) return secs + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

function ageClass(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 300) return '';
  if (secs < 1800) return 'age-warn';
  return 'age-old';
}

function fmtFee(nano) {
  if (!nano) return '—';
  const grin = nano / 1_000_000_000;
  return grin.toFixed(6).replace(/\.?0+$/, '') + ' ツ';
}

function fmtHashrate(gps) {
  if (gps == null) return '—';
  if (gps >= 1e6)  return (gps / 1e6).toFixed(2) + ' MG/s';
  if (gps >= 1e3)  return (gps / 1e3).toFixed(2) + ' kG/s';
  return gps.toFixed(2) + ' G/s';
}

function fmtDifficulty(d) {
  if (d == null) return '—';
  if (d >= 1e15) return (d / 1e15).toFixed(2) + ' P';
  if (d >= 1e12) return (d / 1e12).toFixed(2) + ' T';
  if (d >= 1e9)  return (d / 1e9).toFixed(2)  + ' G';
  if (d >= 1e6)  return (d / 1e6).toFixed(1)  + ' M';
  if (d >= 1e3)  return (d / 1e3).toFixed(1)  + ' K';
  return String(d);
}

function kernelBadgeClass(features) {
  if (!features) return 'badge-plain';
  const f = features.toLowerCase();
  if (f === 'coinbase') return 'badge-coinbase';
  if (f.includes('locked') || f.includes('height')) return 'badge-height-locked';
  return 'badge-plain';
}

function kernelBadgeLabel(features) {
  if (!features) return 'PLAIN';
  const f = features.toUpperCase();
  if (f === 'COINBASE') return 'COINBASE';
  if (f.includes('LOCKED') || f.includes('HEIGHT')) return 'HEIGHT_LOCKED';
  return 'PLAIN';
}

// ── Toast ────────────────────────────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('gs-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ── Copy to clipboard ────────────────────────────────────────────────────────

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
  }).catch(() => {});
}

// ── Stall banner ─────────────────────────────────────────────────────────────

function setStallBanner(stalled) {
  let banner = document.getElementById('stall-banner');
  if (stalled) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'stall-banner';
      banner.className = 'gs-stall-banner';
      banner.textContent = '⚠  No new blocks for 2+ minutes — node may be syncing or offline';
      document.body.insertBefore(banner, document.body.firstChild);
    }
  } else {
    if (banner) banner.remove();
  }
}

// ── INDEX PAGE ───────────────────────────────────────────────────────────────

let _prevTipHeight      = 0;
let _currentPage        = 1;
let _totalCached        = 0;
let _latestBlockTs      = 0; // Unix timestamp of the most recent block (page-1 first row)
const _LIMIT = 20;

function _totalPages() { return Math.max(1, Math.ceil(_totalCached / _LIMIT)); }

function updatePagination() {
  const total = _totalPages();
  const el   = document.getElementById('page-info');
  const prev = document.getElementById('page-prev-btn');
  const next = document.getElementById('page-next-btn');
  if (el)   el.textContent   = `Page ${_currentPage} of ${total}`;
  if (prev) prev.disabled    = _currentPage <= 1;
  if (next) next.disabled    = _currentPage >= total;
}

async function fetchPage(page) {
  const offset = (page - 1) * _LIMIT;
  try {
    const r      = await fetch(`/api/blocks?limit=${_LIMIT}&offset=${offset}`);
    const blocks = await r.json();
    const tbody  = document.getElementById('blocks-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    blocks.forEach(b => tbody.appendChild(renderBlockRow(b)));
    if (page === 1 && blocks.length > 0) _latestBlockTs = blocks[0].timestamp || 0;
    _currentPage = page;
    updatePagination();
  } catch (e) {
    console.error('fetchPage:', e);
  }
}

function initPagination() {
  document.getElementById('page-prev-btn')?.addEventListener('click', () => {
    if (_currentPage > 1) fetchPage(_currentPage - 1);
  });
  document.getElementById('page-next-btn')?.addEventListener('click', () => {
    if (_currentPage < _totalPages()) fetchPage(_currentPage + 1);
  });
}

function renderBlockRow(b) {
  const tr = document.createElement('tr');
  tr.dataset.height = b.height;
  tr.innerHTML = `
    <td class="col-height"><strong>${fmtNum(b.height)}</strong></td>
    <td class="col-hash" title="${b.hash || ''}">${fmtHash(b.hash)}</td>
    <td class="col-age ${ageClass(b.timestamp)}" data-ts="${b.timestamp}">${fmtAge(b.timestamp)}</td>
    <td class="col-txs">${b.tx_count ?? 0}</td>
    <td class="col-fees">${fmtFee(b.fee_total)}</td>`;
  tr.addEventListener('click', () => {
    window.location.href = '/block.html?h=' + b.height;
  });
  return tr;
}


async function pollStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();

    // Tip height with counter animation
    const tipEl = document.getElementById('stat-tip');
    if (tipEl) {
      if (_prevTipHeight > 0 && s.tip_height > _prevTipHeight) {
        showToast('New block #' + fmtNum(s.tip_height));
        // Animate tip counter
        let cur = _prevTipHeight;
        const step = () => {
          if (cur < s.tip_height) {
            cur++;
            tipEl.textContent = fmtNum(cur);
            requestAnimationFrame(step);
          } else {
            tipEl.textContent = fmtNum(s.tip_height);
          }
        };
        requestAnimationFrame(step);
        // Refresh block list only if user is viewing the latest page
        if (_currentPage === 1) fetchPage(1);
      } else {
        tipEl.textContent = fmtNum(s.tip_height);
      }
    }

    // Keep pagination total in sync
    if (s.cached_blocks != null) {
      _totalCached = s.cached_blocks;
      updatePagination();
    }

    const hrEl   = document.getElementById('stat-hashrate');
    const diffEl = document.getElementById('stat-difficulty');
    if (hrEl)   hrEl.textContent   = fmtHashrate(s.hashrate_gps);
    if (diffEl) diffEl.textContent = fmtDifficulty(s.difficulty);

    const peersEl = document.getElementById('stat-peers');
    if (peersEl) peersEl.textContent = s.peer_count != null ? fmtNum(s.peer_count) : '—';

    const mcapEl = document.getElementById('stat-marketcap');
    if (mcapEl && s.price_usd != null && s.tip_height) {
      const supply = s.tip_height * 60;
      mcapEl.textContent = fmtMarketCap(supply * s.price_usd);
    }

    const priceEl = document.getElementById('stat-price');
    if (priceEl) {
      priceEl.textContent = (s.price_usd != null && s.price_btc != null)
        ? '$' + s.price_usd.toFixed(4) + ' / ' + Math.round(s.price_btc * 1e8) + ' sat'
        : '—';
    }
    const changeEl = document.getElementById('stat-change24h');
    if (changeEl) {
      if (s.change_24h_pct != null) {
        const pct = s.change_24h_pct;
        changeEl.textContent  = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        changeEl.style.color  = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--red)' : '';
      } else {
        changeEl.textContent = '';
        changeEl.style.color = '';
      }
    }

    const volEl    = document.getElementById('stat-volume');
    const volBtcEl = document.getElementById('stat-volume-btc');
    if (volEl) volEl.textContent = fmtVol(s.volume_usdt);
    if (volBtcEl) {
      const btcStr = fmtBtcVol(s.volume_btc);
      volBtcEl.textContent = btcStr ? '+ ' + btcStr + ' (BTC pair)' : '';
    }

    const supplyEl = document.getElementById('stat-supply');
    if (supplyEl && s.tip_height) {
      supplyEl.textContent = fmtNum(s.tip_height * 60) + ' ツ';
    }

    setStallBanner(s.stalled);
    _prevTipHeight = s.tip_height;

    const liveEl = document.getElementById('live-indicator');
    if (liveEl) {
      if (_latestBlockTs > 0) {
        const ts = new Date(_latestBlockTs * 1000).toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        liveEl.textContent = 'Updated ' + ts;
      }
    }
  } catch {}
}

// ── Volume formatting helpers ─────────────────────────────────────────────────

function fmtMarketCap(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n >= 1_000_000_000) return '$' + (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function fmtVol(n) {
  if (n == null || isNaN(n) || n === 0) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

function fmtBtcVol(n) {
  if (n == null || isNaN(n) || n === 0) return '';
  if (n >= 0.001) return n.toFixed(4) + ' BTC';
  return (n * 1e8).toFixed(0) + ' sat';
}

function startAgeCountdown() {
  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      el.textContent = fmtAge(ts);
      el.className = el.className.replace(/age-\w+/g, '').trim() + ' ' + ageClass(ts);
    });
  }, 1000);
}

// Search
function initSearch() {
  const form = document.getElementById('search-form');
  const inp  = document.getElementById('search-input');
  if (!form || !inp) return;
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = inp.value.trim();
    if (!q) return;
    window.location.href = '/block.html?h=' + encodeURIComponent(q);
  });
  // "/" shortcut
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== inp) {
      e.preventDefault();
      inp.focus();
    }
    if (e.key === 'Escape') inp.blur();
  });
}

// ── BLOCK DETAIL PAGE ────────────────────────────────────────────────────────

function setBlockDetail(block) {
  const h = block.header;
  const kernels = block.kernels || [];
  const outputs = block.outputs || [];
  const ts = Math.floor(new Date(h.timestamp).getTime() / 1000);
  const txCount = kernels.filter(k => k.features !== 'Coinbase').length;

  // Title
  document.title = `Block #${fmtNum(h.height)} — GrinScan`;

  // Breadcrumb
  const bc = document.getElementById('block-breadcrumb');
  if (bc) bc.textContent = `Block #${fmtNum(h.height)}`;

  // Header rows
  function setRow(id, val, copyVal) {
    const row = document.getElementById(id);
    if (!row) return;
    row.querySelector('.gs-detail-value-text').textContent = val;
    const btn = row.querySelector('.gs-copy-btn');
    if (btn && copyVal) btn.addEventListener('click', () => copyText(copyVal, btn));
    else if (btn && !copyVal) btn.style.display = 'none';
  }

  setRow('row-height',     fmtNum(h.height), null);
  setRow('row-hash',       h.hash || '—',     h.hash);
  setRow('row-prev',       h.previous || '—', h.previous);
  setRow('row-time',       new Date(h.timestamp).toUTCString() + '  (' + fmtAge(ts) + ')', null);
  setRow('row-difficulty', fmtNum(h.total_difficulty), null);
  setRow('row-kernels',    kernels.length + '  (' + txCount + ' transactions + ' + (kernels.length - txCount) + ' coinbase)', null);
  setRow('row-outputs',    outputs.length, null);

  // Block reward (Grin: 60 GRIN per block, constant linear emission)
  const COIN = window.GRINSCAN_NETWORK === 'testnet' ? 'tGRIN' : 'GRIN';
  setRow('row-reward', '60 ' + COIN, null);

  // Block time (seconds since previous block)
  if (block._prev_timestamp) {
    const blockTimeSec = ts - block._prev_timestamp;
    setRow('row-blocktime', blockTimeSec + 's', null);
  }

  // Extra header fields
  if (h.version     != null) setRow('row-version',       h.version, null);
  if (h.nonce       != null) setRow('row-nonce',         String(h.nonce), null);
  if (h.edge_bits   != null) setRow('row-edge-bits',     'Cuckatoo' + h.edge_bits + ' (C' + h.edge_bits + ')', null);
  if (h.output_root)         setRow('row-output-root',   h.output_root, h.output_root);
  if (h.kernel_root)         setRow('row-kernel-root',   h.kernel_root, h.kernel_root);
  if (h.total_kernel_offset) setRow('row-kernel-offset', h.total_kernel_offset, h.total_kernel_offset);

  // Kernels list
  const kList = document.getElementById('kernels-list');
  if (kList) {
    kList.innerHTML = '';
    kernels.forEach(k => {
      const div = document.createElement('div');
      div.className = 'gs-kernel-row';
      const fee = k.features !== 'Coinbase' && k.fee ? fmtFee(k.fee) : '—';
      const lockTag = k.lock_height
        ? `<span style="color:var(--muted);font-size:12px;">lock: ${fmtNum(k.lock_height)}</span>`
        : '';
      div.innerHTML = `
        <span class="badge ${kernelBadgeClass(k.features)}">${kernelBadgeLabel(k.features)}</span>
        <span style="color:var(--muted);font-size:12px;">fee: ${fee}</span>
        ${lockTag}
        <span class="gs-kernel-excess">${k.excess || ''}</span>`;
      kList.appendChild(div);
    });
  }

  // Inputs list
  const inputs = block.inputs || [];
  const iHeading = document.getElementById('inputs-heading');
  const iList    = document.getElementById('inputs-list');
  if (iHeading) iHeading.textContent = `Inputs (${inputs.length})`;
  if (iList) {
    if (inputs.length === 0) {
      iList.innerHTML = '<span style="color:var(--muted);font-size:13px;padding:8px 0;display:block;">No inputs — coinbase-only block</span>';
    } else {
      iList.innerHTML = '';
      inputs.forEach(inp => {
        const commit = typeof inp === 'string' ? inp : (inp.commit || JSON.stringify(inp));
        const div  = document.createElement('div');
        div.className = 'gs-kernel-row';
        const span = document.createElement('span');
        span.className   = 'gs-kernel-excess';
        span.textContent = commit;
        const btn  = document.createElement('button');
        btn.className   = 'gs-copy-btn';
        btn.textContent = '📋 Copy';
        btn.addEventListener('click', () => copyText(commit, btn));
        div.appendChild(span);
        div.appendChild(btn);
        iList.appendChild(div);
      });
    }
  }

  // Outputs list
  const oHeading = document.getElementById('outputs-heading');
  const oList    = document.getElementById('outputs-list');
  if (oHeading) oHeading.textContent = `Outputs (${outputs.length})`;
  if (oList) {
    oList.innerHTML = '';
    outputs.forEach(o => {
      const isCoinbase = (o.output_type || '').toLowerCase() === 'coinbase';
      const commit = o.commit || '';
      const div    = document.createElement('div');
      div.className = 'gs-kernel-row';

      const badge = document.createElement('span');
      badge.className   = 'badge ' + (isCoinbase ? 'badge-coinbase' : 'badge-plain');
      badge.textContent = isCoinbase ? 'COINBASE' : 'PLAIN';

      const spentSpan = document.createElement('span');
      spentSpan.className   = 'gs-spent-tag ' + (o.spent ? 'spent' : 'unspent');
      spentSpan.textContent = o.spent ? 'SPENT' : 'UNSPENT';

      const commitSpan = document.createElement('span');
      commitSpan.className   = 'gs-kernel-excess';
      commitSpan.textContent = commit;

      div.appendChild(badge);
      div.appendChild(spentSpan);
      div.appendChild(commitSpan);

      if (commit) {
        const btn = document.createElement('button');
        btn.className   = 'gs-copy-btn';
        btn.textContent = '📋 Copy';
        btn.addEventListener('click', () => copyText(commit, btn));
        div.appendChild(btn);
      }

      oList.appendChild(div);
    });
  }

  // Raw JSON toggle
  const rawToggle = document.getElementById('raw-toggle');
  const rawJsonEl = document.getElementById('raw-json');
  if (rawToggle && rawJsonEl) {
    rawToggle.addEventListener('click', () => {
      const open = rawJsonEl.style.display !== 'none';
      rawJsonEl.style.display = open ? 'none' : 'block';
      rawToggle.textContent = (open ? '▶' : '▼') + ' Raw Block Data';
      if (!open && !rawJsonEl.textContent) rawJsonEl.textContent = JSON.stringify(block, null, 2);
    });
  }

  // Prev / Next nav
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  if (prevBtn) {
    if (h.height > 0) {
      prevBtn.href = '/block.html?h=' + (h.height - 1);
      prevBtn.textContent = '← Block #' + fmtNum(h.height - 1);
    } else {
      prevBtn.removeAttribute('href');
      prevBtn.style.opacity = '0.3';
      prevBtn.style.pointerEvents = 'none';
    }
  }
  if (nextBtn) {
    nextBtn.href = '/block.html?h=' + (h.height + 1);
    nextBtn.textContent = 'Block #' + fmtNum(h.height + 1) + ' →';
  }

  // Keyboard nav
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft'  && h.height > 1) window.location.href = '/block.html?h=' + (h.height - 1);
    if (e.key === 'ArrowRight') window.location.href = '/block.html?h=' + (h.height + 1);
  });
}

async function loadBlockDetail() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('h');
  if (!ref) { showBlockError('No block reference in URL.'); return; }

  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');

  try {
    const r = await fetch('/api/block/' + encodeURIComponent(ref));
    if (r.status === 404) {
      const data = await r.json().catch(() => ({}));
      if (data.hint === 'cache_miss') {
        showCacheMiss();
      } else {
        showBlockError('Block not found.');
      }
      return;
    }
    if (!r.ok) { showBlockError('Server error ' + r.status); return; }
    const block = await r.json();
    if (detailBox) detailBox.style.display = '';
    if (errBox) errBox.style.display = 'none';
    setBlockDetail(block);
  } catch (e) {
    showBlockError('Failed to load block: ' + e.message);
  }
}

function showBlockError(msg) {
  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');
  if (detailBox) detailBox.style.display = 'none';
  if (errBox) {
    errBox.style.display = '';
    const msgEl = errBox.querySelector('.error-msg');
    if (msgEl) msgEl.textContent = msg;
  }
}

function showCacheMiss() {
  const errBox = document.getElementById('block-error');
  const detailBox = document.getElementById('block-detail-wrap');
  if (detailBox) detailBox.style.display = 'none';
  if (errBox) {
    errBox.style.display = '';
    const isMain = window.GRINSCAN_NETWORK === 'mainnet';
    const archiveUrl   = isMain ? 'https://grincoin.org'         : 'https://testnet.grincoin.org/';
    const archiveLabel = isMain ? 'grincoin.org'                 : 'testnet.grincoin.org';
    errBox.innerHTML = `
      <h3>Block not found</h3>
      <p>This block is outside the local cache window.</p>
      <p>Try an archive explorer: <a href="${archiveUrl}" target="_blank" rel="noopener">${archiveLabel}</a></p>`;
  }
}

// ── API reference page ───────────────────────────────────────────────────────

function initApiPage() {
  const base = window.GRINSCAN_BASE_URL || window.location.origin;
  const isMain = window.GRINSCAN_NETWORK === 'mainnet';

  const endpoints = [
    // ── Internal API (no CORS) ──
    { path: '/api/stats',     desc: 'Latest tip, hashrate, difficulty, peers, price, pool size, DB size', cache: 'live',      link: true  },
    { path: '/api/blocks',    desc: 'Paginated block list — <code>?limit=N&amp;offset=M</code> (max 100)',           cache: 'live',      link: true  },
    { path: '/api/block/:id', desc: 'Single block by height or hash — includes <code>_prev_timestamp</code>',        cache: 'live',      link: false },
    { path: '/api/history',   desc: 'Hashrate/difficulty samples — <code>?days=N</code> (max 5000) or <code>?days=0</code> for full range. Returns <code>{ ok, rows }</code>. Data range limited to cached blocks window.', cache: 'live', link: true },
    { path: '/api/peers',     desc: 'Connected peer list (addr, direction, user_agent)',                              cache: 'live',      link: true  },
    { path: '/api/price',     desc: 'GRIN price (USD + BTC), 24h change, price history',                             cache: '2 min',     link: true  },
    { path: '/api/tip',       desc: 'Current tip height + hash',                                                     cache: 'live',      link: true  },
    { path: '/api/network',   desc: 'Returns the network this instance serves — <code>mainnet</code> or <code>testnet</code>', cache: 'live', link: true },
    { path: '/events',        desc: 'Server-Sent Events stream — subscribe to get instant block notifications without polling. Fires <code>{ type:"block", height }</code> on each new block. Use <code>new EventSource(\'/events\')</code> in browser or any SSE client.', cache: 'streaming', link: false },
    // ── Public REST (CORS-enabled) ──
    { path: '/rest/stats.json',      desc: 'Core chain stats (CORS-enabled public snapshot)',                           cache: '30s',   link: true, cors: true },
    { path: '/rest/supply.json',     desc: 'Circulating supply = height × 60 GRIN',                                    cache: '30s',   link: true, cors: true },
    { path: '/rest/height.json',     desc: 'Block height only',                                                         cache: '30s',   link: true, cors: true },
    { path: '/rest/difficulty.json', desc: 'Network difficulty + hashrate (GPS)',                                        cache: '30s',   link: true, cors: true },
    { path: '/rest/emission.json',   desc: 'Static emission schedule — yearly milestones, no halving',                  cache: '24h',   link: true, cors: true },
    { path: '/rest/node.json',       desc: 'Connected peers, version distribution (CORS-enabled)',                       cache: '30s',   link: true, cors: true },
    { path: '/rest/price.json',      desc: 'Price data (gate.io + nonlogs.io) + 24h change + history (CORS-enabled)', cache: '2 min', link: true, cors: true },
  ];

  // Only include price endpoints on mainnet
  const filtered = isMain ? endpoints : endpoints.filter(ep => !ep.path.includes('price'));

  const container = document.getElementById('api-cards');
  if (!container) return;

  container.innerHTML = filtered.map((ep, i) => {
    const url = base + ep.path;
    const linkBtn = ep.link
      ? `<a class="gs-api-btn" href="${url}" target="_blank" rel="noopener">↗ Open</a>`
      : '';
    const copyBtn = ep.link
      ? `<button class="gs-api-btn" data-copy="${url}">📋 Copy</button>`
      : '';
    const tryBtn = ep.link && ep.path !== '/events'
      ? `<button class="gs-api-btn gs-api-try-btn" data-idx="${i}">▶ Try</button>`
      : '';
    const corsBadge = ep.cors ? '<span style="font-size:10px;background:var(--green);color:#000;border-radius:3px;padding:1px 5px;margin-left:6px;">CORS</span>' : '';
    return `
      <div class="gs-api-card">
        <div class="gs-api-card-header">
          <span class="gs-api-method">GET</span>
          <span class="gs-api-path">${ep.path}</span>${corsBadge}
          <div class="gs-api-actions">${linkBtn}${copyBtn}${tryBtn}</div>
        </div>
        <div class="gs-api-desc">${ep.desc} &nbsp;·&nbsp; Cache: <strong>${ep.cache}</strong></div>
        <div class="gs-api-response" id="api-resp-${i}" style="display:none;"></div>
      </div>`;
  }).join('');

  // Store URLs for Try buttons
  window._apiUrls = filtered.map(ep => base + ep.path);

  // Copy buttons
  container.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  // Try buttons
  container.querySelectorAll('.gs-api-try-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = parseInt(btn.dataset.idx);
      const respEl = document.getElementById('api-resp-' + i);
      if (!respEl) return;
      if (respEl.style.display === 'block') { respEl.style.display = 'none'; btn.textContent = '▶ Try'; return; }
      respEl.style.display = 'block';
      btn.textContent = '▼ Hide';
      respEl.innerHTML = '<span class="gs-api-spinner"></span>';
      try {
        const r = await fetch(window._apiUrls[i]);
        const data = await r.json();
        respEl.innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
      } catch (e) {
        respEl.innerHTML = `<pre class="api-error">Error: ${e.message}</pre>`;
      }
    });
  });
}

// ── Nav active state (shared across all pages) ───────────────────────────────

function setNavActive() {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(a => {
    const page = a.dataset.page;
    let active = false;
    if (page === 'explorer') active = (path === '/' || path === '/index.html' || path === '/block.html');
    if (page === 'info')     active = path === '/info.html';
    if (page === 'api')      active = path === '/api.html';
    a.classList.toggle('active', active);
  });
}

// ── Footer ───────────────────────────────────────────────────────────────────

function renderFooter() {
  const el = document.getElementById('gs-footer-text');
  if (!el) return;
  const ver = window.GRINSCAN_VERSION || '';
  const net = (window.GRINSCAN_NETWORK || 'mainnet').toUpperCase();
  el.innerHTML = `GrinScan${ver ? ' v' + ver : ''} &nbsp;·&nbsp; ${net}
    &nbsp;·&nbsp; <a href="https://grin.mw" target="_blank" rel="noopener">Grin</a>
    &nbsp;·&nbsp; <a href="https://grin.money" target="_blank" rel="noopener">grin.money</a>
    &nbsp;·&nbsp; <a href="https://world.grin.money" target="_blank" rel="noopener">Global Grin Health Live!</a>
    &nbsp;·&nbsp; <a href="https://github.com/noobvie/Grin-Node-Toolkit" target="_blank" rel="noopener">Node Toolkit</a>`;
}

// ── Network badge ─────────────────────────────────────────────────────────────

function renderNetworkBadge() {
  const badge = document.getElementById('network-badge');
  if (!badge) return;
  const net     = window.GRINSCAN_NETWORK || 'testnet';
  const sibling = window.GRINSCAN_SIBLING_URL;
  if (sibling) {
    const sibNet = net === 'mainnet' ? 'testnet' : 'mainnet';
    badge.className = 'gs-net-switcher';
    badge.innerHTML =
      `<span class="gs-net-pill ${net} active">${net.toUpperCase()}</span>` +
      `<a class="gs-net-pill ${sibNet}" href="${sibling}">${sibNet.toUpperCase()}</a>`;
  } else {
    badge.textContent = net.toUpperCase();
    badge.className = 'gs-network-badge ' + net;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setNavActive();
  renderNetworkBadge();
  renderFooter();

  const page = document.body.dataset.page;

  if (page === 'index') {
    // Hide price/volume/supply cards on testnet — not relevant for test coins
    if (window.GRINSCAN_NETWORK !== 'mainnet') {
      ['stat-price', 'stat-volume', 'stat-supply', 'stat-marketcap'].forEach(id => {
        const card = document.getElementById(id)?.closest('.gs-stat-card');
        if (card) card.style.display = 'none';
      });
    }

    // Remove skeleton loaders once first data arrives
    pollStats().then(() => {
      document.querySelectorAll('.skeleton-cell').forEach(el => el.classList.remove('skeleton'));
    });
    fetchPage(1);
    initSearch();
    initPagination();
    startAgeCountdown();
    setInterval(() => pollStats(), 60000);

    // SSE live push — instant block notifications
    try {
      const es = new EventSource('/events');
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'block') {
            pollStats();
            if (_currentPage === 1) fetchPage(1);
          }
        } catch {}
      };
      es.onerror = () => es.close();
    } catch {}
  }

  if (page === 'block') {
    loadBlockDetail();
    initSearch();
  }

  if (page === 'api') {
    initApiPage();
  }
});
