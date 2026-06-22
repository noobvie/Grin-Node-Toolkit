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

  // Generic vertical bar chart (e.g. per-worker hashrate). `labels` + `data` are parallel
  // arrays. opts.valueFmt(v) formats the tooltip/y-axis (defaults to fmtGps for hashrate).
  // Returns the Chart instance, or null if Chart.js / the canvas is missing.
  function renderBarChart(canvasId, labels, data, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    labels = Array.isArray(labels) ? labels : [];
    data = Array.isArray(data) ? data.map(Number) : [];
    const col = accent();
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: opts.label || 'Value',
          data,
          backgroundColor: col + 'cc',
          borderColor: col,
          borderWidth: 1,
          borderRadius: 4,
          maxBarThickness: 48
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => valueFmt(ctx.parsed.y) } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, ticks: { callback: (v) => valueFmt(v) } }
        }
      }
    });
    return _charts[canvasId];
  }

  // Doughnut chart for categorical breakdowns (e.g. share quality valid/stale/reject).
  // `labels`+`data` parallel; opts.colors is a same-length slice colour array. Tooltips show
  // count + percent of total. Returns the Chart instance, or null if unavailable.
  function renderDoughnutChart(canvasId, labels, data, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    labels = Array.isArray(labels) ? labels : [];
    data = Array.isArray(data) ? data.map(Number) : [];
    const colors = Array.isArray(opts.colors) && opts.colors.length
      ? opts.colors : [accent(), '#d29922', '#f85149', '#58a6ff', '#a371f7'];
    const total = data.reduce((a, b) => a + (Number(b) || 0), 0);

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      ch.data.datasets[0].backgroundColor = colors;
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = Number(ctx.parsed) || 0;
                const pct = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '0%';
                return ctx.label + ': ' + v.toLocaleString('en-US') + ' (' + pct + ')';
              }
            }
          }
        }
      }
    });
    return _charts[canvasId];
  }

  global.PoolCharts = { renderHashrateChart, renderBarChart, renderDoughnutChart, fmtGps };
})(window);
