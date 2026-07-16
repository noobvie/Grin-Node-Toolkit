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

  // Bucket-aware, UTC axis label for the durable trend charts (site-wide UTC rule): hour buckets
  // show HH:MM, day-or-coarser buckets show "MMM D". All formatting is timeZone:'UTC'.
  function fmtBucketLabel(unixSeconds, bucketSeconds) {
    const d = new Date(unixSeconds * 1000);
    if (bucketSeconds && bucketSeconds >= 86400) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  }

  // Plain integer formatter (for the miners-count trend y-axis / tooltips).
  function fmtInt(v) { return Number(v || 0).toLocaleString('en-US'); }

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

  // Generic bar chart (e.g. per-worker hashrate). `labels` + `data` are parallel arrays.
  // opts.valueFmt(v) formats the tooltip/value-axis (defaults to fmtGps for hashrate).
  // opts.horizontal=true lays bars horizontally (value on x) — better for long category labels.
  // Returns the Chart instance, or null if Chart.js / the canvas is missing.
  function renderBarChart(canvasId, labels, data, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    labels = Array.isArray(labels) ? labels : [];
    data = Array.isArray(data) ? data.map(Number) : [];
    const col = accent();
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;
    const horizontal = !!opts.horizontal;

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
        indexAxis: horizontal ? 'y' : 'x',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => valueFmt(horizontal ? ctx.parsed.x : ctx.parsed.y) } }
        },
        scales: horizontal
          ? {
              x: { beginAtZero: true, ticks: { callback: (v) => valueFmt(v) } },
              y: { grid: { display: false } }
            }
          : {
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

  // Generic area/line trend chart for the durable pool metrics. `series` = [{ t, v }] oldest→newest;
  // opts.valueFmt formats the y-axis + tooltip (defaults to fmtGps), opts.bucketSeconds drives the
  // UTC x-axis label granularity, opts.color overrides the theme accent. Returns the Chart instance
  // or null if Chart.js / the canvas is missing.
  function renderTrendLine(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;
    const labels = series.map(p => fmtBucketLabel(p.t, opts.bucketSeconds));
    const data = series.map(p => Number(p.v) || 0);
    const col = opts.color || accent();

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      ch.data.datasets[0].borderColor = col;
      ch.data.datasets[0].backgroundColor = col + '22';
      ch.options.plugins.tooltip.callbacks.label = (ctx) => valueFmt(ctx.parsed.y);
      ch.options.scales.y.ticks.callback = (v) => valueFmt(v);
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: opts.label || 'Value',
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
          tooltip: { callbacks: { label: (ctx) => valueFmt(ctx.parsed.y) } }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, autoSkip: true }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { callback: (v) => valueFmt(v) } }
        }
      }
    });
    return _charts[canvasId];
  }

  // Grouped (side-by-side) bar chart for multi-series buckets, e.g. earnings vs payout per period.
  // `labels` = x categories; `datasets` = [{ label, data[], color }]; opts.valueFmt formats y-axis +
  // tooltips (defaults to integer). Returns the Chart instance or null if unavailable.
  function renderGroupedBarChart(canvasId, labels, datasets, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    labels = Array.isArray(labels) ? labels : [];
    datasets = Array.isArray(datasets) ? datasets : [];
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtInt;
    const palette = [accent(), '#58a6ff', '#d29922', '#a371f7'];
    const mk = (ds, i) => {
      const c = ds.color || palette[i % palette.length];
      return {
        label: ds.label || ('Series ' + (i + 1)),
        data: (ds.data || []).map(Number),
        backgroundColor: c + 'cc',
        borderColor: c,
        borderWidth: 1,
        borderRadius: 3,
        maxBarThickness: 34
      };
    };

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets = datasets.map(mk);
      ch.options.plugins.tooltip.callbacks.label = (ctx) => ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y);
      ch.options.scales.y.ticks.callback = (v) => valueFmt(v);
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: datasets.map(mk) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y) } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { beginAtZero: true, ticks: { callback: (v) => valueFmt(v) } }
        }
      }
    });
    return _charts[canvasId];
  }

  global.PoolCharts = {
    renderHashrateChart, renderBarChart, renderDoughnutChart,
    renderTrendLine, renderGroupedBarChart,
    fmtGps, fmtInt
  };
})(window);
