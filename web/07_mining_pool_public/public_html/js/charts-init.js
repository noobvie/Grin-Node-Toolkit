// Hashrate line charts (Chart.js, vendored locally at /js/vendor/chart.umd.min.js — no CDN).
//
// Series come from the pool API as [{ t: unixSeconds, gps: number }] oldest→newest. We render
// with a CATEGORY x-axis of pre-formatted time labels (HH:MM) so we don't need the Chart.js
// date adapter (which would be a second vendored file). The y-axis is auto-scaled and ticks are
// formatted in G/s · kG/s · MG/s to match the rest of the site (CLAUDE.md display rule).

(function (global) {
  'use strict';

  function fmtGps(gps) {
    if (!isFinite(gps)) return '—';
    if (gps >= 1e6) return (gps / 1e6).toFixed(2) + ' MG/s';
    if (gps >= 1e3) return (gps / 1e3).toFixed(2) + ' kG/s';
    return gps.toFixed(2) + ' G/s';
  }

  function fmtTimeLabel(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Theme-aware accent: read the CSS custom property the themes set, fall back to a green.
  function accent() {
    try {
      const c = getComputedStyle(document.documentElement).getPropertyValue('--accent') ||
                getComputedStyle(document.documentElement).getPropertyValue('--primary');
      return (c && c.trim()) || '#7cb342';
    } catch (e) { return '#7cb342'; }
  }

  const _charts = {}; // canvasId -> Chart instance (so we can update in place on refresh)

  // Render or update a hashrate line chart. `series` = [{t, gps}]. Returns the Chart instance,
  // or null if Chart.js isn't loaded / the canvas is missing / there's no data.
  function renderHashrateChart(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];

    const labels = series.map(p => fmtTimeLabel(p.t));
    const data = series.map(p => Number(p.gps) || 0);
    const col = accent();

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: opts.label || 'Hashrate',
          data,
          borderColor: col,
          backgroundColor: col + '22',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.25,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmtGps(ctx.parsed.y) } }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, autoSkip: true }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { callback: (v) => fmtGps(v) } }
        }
      }
    });
    return _charts[canvasId];
  }

  global.PoolCharts = { renderHashrateChart, fmtGps };
})(window);
