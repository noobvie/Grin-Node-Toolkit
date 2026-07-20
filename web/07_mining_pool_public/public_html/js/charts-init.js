// Chart.js renderers for the public pool (Chart.js vendored locally at /js/vendor/chart.umd.min.js
// — no CDN).
//
// Series come from the pool API as [{ t: unixSeconds, ... }] oldest→newest. We render with a
// CATEGORY x-axis of pre-formatted time labels so we don't need the Chart.js date adapter (which
// would be a second vendored file).
//
// Both axes are ELASTIC — they adapt to the selected timeframe rather than using fixed formats:
//
//   x — the label format is derived from the DATA (span + median spacing), not from a caller's
//       declared bucket. A 7-day window of HOURLY buckets must show the day ("Jul 14 08:00"),
//       or eight ticks of bare "08:00" repeat meaninglessly across the week; a multi-year window
//       of monthly buckets must show the year. Tick COUNT is derived from the canvas width and
//       the rendered label length, so longer labels automatically thin out instead of colliding.
//
//   y — the unit is chosen ONCE for the whole axis from its max, never per tick. Formatting each
//       tick independently produced mixed-unit axes ("800.00 G/s" directly under "1.00 kG/s").
//       Decimal places follow the tick step, so a 0–8 axis reads 0,1,2… not 0.00,1.00,2.00.
//       Zero-basing is automatic: series that hug a high baseline (network hashrate) would be a
//       flat line against a zeroed axis, so they get a padded axis instead — see yAxis().

(function (global) {
  'use strict';

  var DAY = 86400;

  // ── Value formatters ───────────────────────────────────────────────────────────────────────
  // Each exposes a `.axis(value, max, ticks)` variant used for AXIS ticks, which scales the whole
  // axis to one unit. The bare function stays per-value and is what tooltips and page text use
  // (a single hovered value should read in its own natural unit).

  function fmtGps(gps) {
    if (!isFinite(gps)) return '—';
    if (gps >= 1e6) return (gps / 1e6).toFixed(2) + ' MG/s';
    if (gps >= 1e3) return (gps / 1e3).toFixed(2) + ' kG/s';
    return gps.toFixed(2) + ' G/s';
  }

  // Distance between two adjacent ticks — drives how many decimals an axis actually needs.
  function tickStep(ticks, value) {
    if (Array.isArray(ticks) && ticks.length > 1) {
      var s = Math.abs(Number(ticks[1].value) - Number(ticks[0].value));
      if (isFinite(s) && s > 0) return s;
    }
    return Math.abs(Number(value)) || 1;
  }

  function decimalsFor(step) {
    if (!isFinite(step) || step <= 0) return 2;
    if (step >= 10) return 0;
    if (step >= 1) return 1;
    if (step >= 0.1) return 2;
    return 3;
  }

  fmtGps.axis = function (v, max, ticks) {
    var scale = Math.abs(Number(max)) || Math.abs(Number(v)) || 0;
    var div = scale >= 1e6 ? 1e6 : (scale >= 1e3 ? 1e3 : 1);
    var unit = div === 1e6 ? ' MG/s' : (div === 1e3 ? ' kG/s' : ' G/s');
    return (Number(v) / div).toFixed(decimalsFor(tickStep(ticks, v) / div)) + unit;
  };

  // Plain integer formatter (miner counts, block counts, payout counts).
  function fmtInt(v) { return Number(v || 0).toLocaleString('en-US'); }

  // Counts get compact units only once the axis is genuinely large; a 0–8 miners axis must stay
  // 0,1,2…. Chart.js is additionally told `precision: 0` for integer axes (see yAxis) so it never
  // proposes fractional ticks for a whole-number measure.
  fmtInt.axis = function (v, max) {
    var scale = Math.abs(Number(max)) || Math.abs(Number(v)) || 0;
    var n = Number(v) || 0;
    if (n === 0) return '0'; // "0M" / "0k" is noise on an otherwise scaled axis
    if (scale >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + 'M';
    if (scale >= 1e4) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1) + 'k';
    return Math.round(n).toLocaleString('en-US');
  };

  // ── Time axis ──────────────────────────────────────────────────────────────────────────────
  // All labels are UTC (site-wide rule). `bucketHint` is only a FLOOR: several endpoints thin or
  // re-bucket server-side, and some callers pass a nominal bucket that doesn't match the points
  // they actually got, so the real spacing is measured from the timestamps and the larger wins.

  function medianStep(ts) {
    if (!ts || ts.length < 2) return 0;
    var gaps = [];
    for (var i = 1; i < ts.length; i++) {
      var g = Number(ts[i]) - Number(ts[i - 1]);
      if (isFinite(g) && g > 0) gaps.push(g);
    }
    if (!gaps.length) return 0;
    gaps.sort(function (a, b) { return a - b; });
    return gaps[Math.floor(gaps.length / 2)];
  }

  function utc(t, o) { return new Date(t * 1000).toLocaleString('en-US', Object.assign({ timeZone: 'UTC' }, o)); }

  // Returns fmt(unixSeconds) for a series, chosen from its span AND spacing:
  //   sub-day steps, ≤2-day span    → "08:00"          (a single day needs no date)
  //   sub-day steps, longer span    → "Jul 14 08:00"   (a week of hourly buckets MUST show the day)
  //   day+ steps, under ~1 year     → "Jul 14"
  //   day+ steps, a year or more    → "Jul 2026"       (monthly/weekly buckets over the 'all' range)
  function timeLabeler(timestamps, bucketHint) {
    var ts = (timestamps || []).map(Number).filter(isFinite);
    var step = Math.max(medianStep(ts), Number(bucketHint) || 0);
    var span = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) : step;

    if (step < DAY && span <= 2 * DAY) {
      return function (t) { return utc(t, { hour: '2-digit', minute: '2-digit', hour12: false }); };
    }
    if (step < DAY) {
      return function (t) {
        return utc(t, { month: 'short', day: 'numeric' }) + ' ' +
               utc(t, { hour: '2-digit', minute: '2-digit', hour12: false });
      };
    }
    if (step >= 28 * DAY) {  // monthly buckets ('all' range) — the day carries no information
      return function (t) { return utc(t, { month: 'short', year: 'numeric' }); };
    }
    if (span >= 300 * DAY) { // a year of daily buckets: "Jul 21" at both ends is a year apart
      return function (t) { return utc(t, { month: 'short', day: 'numeric', year: 'numeric' }); };
    }
    return function (t) { return utc(t, { month: 'short', day: 'numeric' }); };
  }

  // Convenience for callers that build their own category labels (bar charts): same rules.
  function timeLabels(timestamps, bucketHint) {
    var f = timeLabeler(timestamps, bucketHint);
    return (timestamps || []).map(f);
  }

  // How many x ticks fit: canvas width ÷ rendered label width. Longer labels ("Jul 14 08:00")
  // thin themselves out instead of overlapping, and a 4-point series never claims 8 ticks.
  function xTickLimit(canvas, labels) {
    var w = canvas.clientWidth || canvas.width || 600;
    var maxLen = 5;
    for (var i = 0; i < labels.length; i++) maxLen = Math.max(maxLen, String(labels[i]).length);
    var perLabel = maxLen * 7 + 18; // ~7px/char at the default 12px font, plus padding
    return Math.max(2, Math.min(labels.length || 1, Math.floor(w / perLabel) || 2));
  }

  function xAxis(canvas, labels, extra) {
    return Object.assign({
      grid: { display: false },
      ticks: { autoSkip: true, maxRotation: 0, maxTicksLimit: xTickLimit(canvas, labels) }
    }, extra || {});
  }

  // Build the y scale for `data` with `valueFmt`.
  //   opts.zeroBase  true  — always start at zero (bars: a non-zero bar baseline lies about ratios)
  //                  false — never
  //                  'auto'/undefined — zero unless the data hugs a high baseline. Network hashrate
  //                  sits at ~1.25 MG/s ±2%; zeroed, that is a dead-flat line and the chart says
  //                  nothing. When min > 35% of max we drop the zero and pad instead.
  //   opts.ticksExtra merges into ticks (e.g. maxTicksLimit for compact sparklines).
  function yAxis(data, valueFmt, opts) {
    opts = opts || {};
    var nums = (data || []).map(Number).filter(function (v) { return isFinite(v); });
    var min = nums.length ? Math.min.apply(null, nums) : 0;
    var max = nums.length ? Math.max.apply(null, nums) : 0;

    var zero = opts.zeroBase;
    if (zero === undefined || zero === 'auto') {
      zero = !(nums.length && min > 0 && max > 0 && min > 0.35 * max);
    }

    var axisFmt = (typeof valueFmt === 'function' && typeof valueFmt.axis === 'function')
      ? valueFmt.axis : null;

    var ticks = {
      callback: function (v, i, all) {
        // `this` is the scale — its max is what makes the whole axis share one unit.
        var m = (this && isFinite(this.max)) ? this.max : max;
        return axisFmt ? axisFmt(v, m, all) : valueFmt(v);
      }
    };
    if (valueFmt === fmtInt) ticks.precision = 0; // counts are whole numbers, never 0.5 miners
    Object.assign(ticks, opts.ticksExtra || {});

    var scale = { ticks: ticks };
    if (zero) scale.beginAtZero = true;
    else { scale.beginAtZero = false; scale.grace = '8%'; }
    return scale;
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

  // Re-apply the elastic scales on an in-place update. The axes depend on the DATA, so a range
  // switch that only swapped labels/data would keep the previous timeframe's tick density, unit
  // and zero-basing — the original bug. Every update path calls this.
  function applyScales(ch, canvas, labels, data, valueFmt, opts) {
    ch.options.scales.x = xAxis(canvas, labels, opts && opts.xExtra);
    ch.options.scales.y = yAxis(data, valueFmt, opts);
  }

  // Render or update a hashrate line chart. `series` = [{t, gps}]. Returns the Chart instance,
  // or null if Chart.js isn't loaded / the canvas is missing / there's no data.
  function renderHashrateChart(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];

    const fmtLabel = timeLabeler(series.map(p => p.t), opts.bucketSeconds);
    const labels = series.map(p => fmtLabel(p.t));
    const data = series.map(p => Number(p.gps) || 0);
    const col = accent();

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      applyScales(ch, canvas, labels, data, fmtGps, opts);
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
        scales: { x: xAxis(canvas, labels), y: yAxis(data, fmtGps, opts) }
      }
    });
    return _charts[canvasId];
  }

  // Generic bar chart (e.g. per-worker hashrate). `labels` + `data` are parallel arrays.
  // opts.valueFmt(v) formats the tooltip/value-axis (defaults to fmtGps for hashrate).
  // opts.horizontal=true lays bars horizontally (value on x) — better for long category labels.
  // Bars always start at zero (a truncated bar baseline misstates the ratio between bars).
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

    const valueScale = () => yAxis(data, valueFmt, { zeroBase: true });
    const catScale = () => horizontal ? { grid: { display: false } } : xAxis(canvas, labels);

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      // Tooltip + value axis must be rebuilt too: a range switch can change both the formatter
      // and the magnitude, and the old closures would keep formatting the previous window.
      ch.options.plugins.tooltip.callbacks.label = (ctx) => valueFmt(horizontal ? ctx.parsed.x : ctx.parsed.y);
      ch.options.scales.x = horizontal ? valueScale() : catScale();
      ch.options.scales.y = horizontal ? catScale() : valueScale();
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
          ? { x: valueScale(), y: catScale() }
          : { x: catScale(), y: valueScale() }
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

    // Percentages must come from the CURRENT slices — a captured total went stale on every
    // in-place update, so a re-rendered doughnut showed percentages of the previous window.
    const pctLabel = (ctx) => {
      const ds = (ctx.chart.data.datasets[0] || {}).data || [];
      const total = ds.reduce((a, b) => a + (Number(b) || 0), 0);
      const v = Number(ctx.parsed) || 0;
      const pct = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '0%';
      return ctx.label + ': ' + v.toLocaleString('en-US') + ' (' + pct + ')';
    };

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
          tooltip: { callbacks: { label: pctLabel } }
        }
      }
    });
    return _charts[canvasId];
  }

  // Generic area/line trend chart for the durable pool metrics. `series` = [{ t, v }] oldest→newest;
  // opts.valueFmt formats the y-axis + tooltip (defaults to fmtGps), opts.bucketSeconds is a FLOOR
  // hint for the x-label granularity (real spacing is measured from the data), opts.color overrides
  // the theme accent, opts.zeroBase forces/forbids a zero baseline. Returns the Chart instance or
  // null if Chart.js / the canvas is missing.
  // opts.compact = sparkline mode: the trace is a companion to a full chart directly above it that
  // already carries the x axis, so drop the duplicate time labels and thin the y ticks to 3. Shape
  // stays readable in ~70px; exact values come from the (still active) hover tooltip.
  function renderTrendLine(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;
    const fmtLabel = timeLabeler(series.map(p => p.t), opts.bucketSeconds);
    const labels = series.map(p => fmtLabel(p.t));
    const data = series.map(p => Number(p.v) || 0);
    const col = opts.color || accent();

    const scaleOpts = {
      zeroBase: opts.zeroBase,
      ticksExtra: opts.compact ? { maxTicksLimit: 3 } : null,
      xExtra: opts.compact ? { ticks: { display: false }, border: { display: false } } : null
    };

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets[0].data = data;
      ch.data.datasets[0].borderColor = col;
      ch.data.datasets[0].backgroundColor = col + '22';
      ch.options.plugins.tooltip.callbacks.label = (ctx) => valueFmt(ctx.parsed.y);
      applyScales(ch, canvas, labels, data, valueFmt, scaleOpts);
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
          x: xAxis(canvas, labels, scaleOpts.xExtra),
          y: yAxis(data, valueFmt, scaleOpts)
        }
      }
    });
    return _charts[canvasId];
  }

  // Fixed categorical palette for multi-series charts (per-region lines). Eight dark-surface
  // steps validated (2026-07-17) against the pool panel background for adjacent-pair CVD
  // separation, normal-vision separation, chroma and ≥3:1 contrast. Assign slots to entities
  // in a FIXED order (e.g. region names sorted alphabetically), never by rank and never
  // cycled past 8 — the public region UI is already capped at 8 regions.
  var PALETTE = ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'];

  // Multi-series line chart on ONE shared y-axis (never dual-axis — two measures of different
  // magnitude get two charts instead). `seriesList` = [{ label, points: [{t, v}], color }];
  // series are aligned on the union of their timestamps, with nulls where a series has no
  // bucket (gaps stay visible — an offline gateway shows a hole, not an interpolated line).
  // A legend renders automatically for ≥2 series. opts: valueFmt, bucketSeconds, spanGaps.
  function renderMultiTrendLine(canvasId, seriesList, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    seriesList = Array.isArray(seriesList) ? seriesList : [];
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;

    // Union time grid, oldest→newest, so differently-gapped series stay x-aligned.
    const tSet = new Set();
    seriesList.forEach(function (s) {
      (s.points || []).forEach(function (p) { tSet.add(p.t); });
    });
    const grid = [...tSet].sort(function (a, b) { return a - b; });
    const fmtLabel = timeLabeler(grid, opts.bucketSeconds);
    const labels = grid.map(fmtLabel);

    const mk = function (s, i) {
      const c = s.color || PALETTE[i % PALETTE.length];
      const byT = new Map((s.points || []).map(function (p) { return [p.t, Number(p.v) || 0]; }));
      return {
        label: s.label || ('Series ' + (i + 1)),
        data: grid.map(function (t) { return byT.has(t) ? byT.get(t) : null; }),
        borderColor: c,
        backgroundColor: c + '22',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.25,
        fill: false,
        spanGaps: !!opts.spanGaps
      };
    };

    const datasets = seriesList.map(mk);
    // The y axis spans ALL series, so it is scaled off the flattened values (nulls dropped).
    const allValues = datasets.reduce(function (acc, d) {
      d.data.forEach(function (v) { if (v != null) acc.push(v); });
      return acc;
    }, []);

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets = datasets;
      ch.options.plugins.legend.display = seriesList.length > 1;
      ch.options.plugins.tooltip.callbacks.label = function (ctx) {
        return ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y);
      };
      applyScales(ch, canvas, labels, allValues, valueFmt, opts);
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: seriesList.length > 1, position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y) } }
        },
        scales: { x: xAxis(canvas, labels), y: yAxis(allValues, valueFmt, opts) }
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

    const built = datasets.map(mk);
    const allValues = built.reduce(function (acc, d) { return acc.concat(d.data); }, []);

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets = built;
      ch.options.plugins.tooltip.callbacks.label = (ctx) => ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y);
      ch.options.scales.x = xAxis(canvas, labels);
      ch.options.scales.y = yAxis(allValues, valueFmt, { zeroBase: true });
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: built },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + valueFmt(ctx.parsed.y) } }
        },
        scales: { x: xAxis(canvas, labels), y: yAxis(allValues, valueFmt, { zeroBase: true }) }
      }
    });
    return _charts[canvasId];
  }

  global.PoolCharts = {
    renderHashrateChart, renderBarChart, renderDoughnutChart,
    renderTrendLine, renderMultiTrendLine, renderGroupedBarChart,
    fmtGps, fmtInt, timeLabels, timeLabeler, PALETTE
  };
})(window);
