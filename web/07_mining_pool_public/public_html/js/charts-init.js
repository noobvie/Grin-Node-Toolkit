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

  // Network difficulty (per-block, chain units). Same K/M/G suffixes as the homepage spec plate,
  // plus T; three significant figures per value ("29.3 G").
  var DIFF_UNITS = [[1e12, ' T'], [1e9, ' G'], [1e6, ' M'], [1e3, ' K']];

  function diffUnit(scale) {
    for (var i = 0; i < DIFF_UNITS.length; i++) if (scale >= DIFF_UNITS[i][0]) return DIFF_UNITS[i];
    return [1, ''];
  }

  function fmtDiff(d) {
    if (!isFinite(d)) return '—';
    var u = diffUnit(Math.abs(d));
    var n = d / u[0];
    return n.toFixed(u[0] === 1 ? 0 : (Math.abs(n) < 10 ? 2 : (Math.abs(n) < 100 ? 1 : 0))) + u[1];
  }

  // Axis labels: three significant figures from the axis max ("28.6 G"), plus just enough extra
  // decimals that adjacent ticks never round to the same label. Its ticks are usually the locked
  // re-label of a round left axis, so they are not round themselves — more digits only widen it.
  fmtDiff.axis = function (v, max, ticks) {
    var u = diffUnit(Math.abs(Number(max)) || Math.abs(Number(v)) || 0);
    var m = Math.abs(Number(max) || Number(v) || 0) / u[0];
    var sig = u[0] === 1 ? 0 : (m < 10 ? 2 : (m < 100 ? 1 : 0));
    var step = tickStep(ticks, v) / u[0];
    var distinct = step >= 10 ? 0 : Math.max(0, Math.floor(-Math.log10(step)) + 1);
    return (Number(v) / u[0]).toFixed(Math.min(3, Math.max(sig, distinct))) + u[1];
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
  // Read from BODY, not documentElement. dashboard.css declares the whole token bridge
  // (--accent/--primary/…) on `body` precisely so themes.css can remap it per body class;
  // :root carries only the raw --dark-*/--neon-* inputs, so a :root lookup returned '' and
  // every chart on every theme silently fell back to the hard-coded #7cb342.
  function accent() {
    try {
      const el = document.body || document.documentElement;
      const cs = getComputedStyle(el);
      const c = cs.getPropertyValue('--accent') || cs.getPropertyValue('--primary');
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

  // A LOCKED second scale on the right: a pure re-label of the left axis in another unit (°C/°F),
  // never a second series. Its bounds and ticks are the left axis's FINAL bounds and ticks × factor,
  // so it cannot disagree with the left axis — that is why this is not the dual-axis pattern the
  // rest of this file refuses. Copied in afterBuildTicks, which in Chart.js 4 runs before
  // configure() maps values to pixels; the layout fits left boxes before right ones on every pass,
  // so `scales.y` is already final for that pass (grace, zero-basing and tick snapping included).
  // bounds:'data' is belt-and-braces: Chart.js snaps min/max to ticks inside buildTicks, which runs
  // before this hook overwrites them.
  // No grid lines of its own: the left axis's grid is the one both scales are read against.
  function lockedScale(sec) {
    const factor = Number(sec.factor);
    const fmt = sec.fmt;
    return {
      axis: 'y',
      position: 'right',
      bounds: 'data',
      grid: { drawOnChartArea: false },
      title: { display: !!sec.title, text: sec.title || '' },
      afterBuildTicks: function (scale) {
        const y = scale.chart.scales.y;
        if (!y) return;
        scale.min = y.min * factor;
        scale.max = y.max * factor;
        scale.ticks = y.ticks.map(function (t) { return { value: t.value * factor }; });
      },
      ticks: {
        callback: function (v, i, all) {
          return typeof fmt.axis === 'function' ? fmt.axis(v, this.max, all) : fmt(v);
        }
      }
    };
  }

  // A theme text token (for neutral reference marks), read from BODY like accent().
  function textToken(name, fallback) {
    try {
      const c = getComputedStyle(document.body || document.documentElement).getPropertyValue(name);
      return (c && c.trim()) || fallback;
    } catch (e) { return fallback; }
  }

  // Generic bar chart (e.g. per-worker hashrate). `labels` + `data` are parallel arrays.
  // opts.valueFmt(v) formats the tooltip/value-axis (defaults to fmtGps for hashrate).
  // opts.horizontal=true lays bars horizontally (value on x) — better for long category labels.
  // opts.line = { label, data, valueFmt? } overlays a dashed neutral REFERENCE line in the SAME unit on the
  // same axis (e.g. expected vs found blocks) — never a second measure, never a second axis. A
  // null in line.data is a gap. Vertical bars only. The legend shows only while a line is drawn.
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

    const line = (!horizontal && opts.line && Array.isArray(opts.line.data)
                  && opts.line.data.some(v => v != null)) ? opts.line : null;
    const lineData = line ? line.data.map(v => (v == null || !isFinite(Number(v))) ? null : Number(v)) : [];
    const scaleData = data.concat(lineData.filter(v => v != null));

    const valueScale = () => yAxis(scaleData, valueFmt, { zeroBase: true });
    const catScale = () => horizontal ? { grid: { display: false } } : xAxis(canvas, labels);
    const tipLabel = (ctx) => {
      const v = horizontal ? ctx.parsed.x : ctx.parsed.y;
      if (v == null) return null;
      if (!line) return valueFmt(v);
      const f = (ctx.dataset.type === 'line' && typeof line.valueFmt === 'function') ? line.valueFmt : valueFmt;
      return ctx.dataset.label + ': ' + f(v);
    };
    const barSet = () => ({
      type: 'bar',
      label: opts.label || 'Value',
      data,
      backgroundColor: col + 'cc',
      borderColor: col,
      borderWidth: 1,
      borderRadius: 4,
      maxBarThickness: 48,
      order: 2
    });
    const lineSet = () => {
      const ink = textToken('--text-dim', '#9aa4b2');
      return {
        type: 'line',
        label: line.label || 'Reference',
        data: lineData,
        borderColor: ink,
        backgroundColor: ink,
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0,
        spanGaps: false,
        fill: false,
        order: 1
      };
    };
    const datasets = () => line ? [barSet(), lineSet()] : [barSet()];
    // With a reference line, one hover reads both values for the column; without one, keep
    // Chart.js' default (hover the bar itself) so existing bar charts behave as before.
    const interaction = () => line ? { intersect: false, mode: 'index' } : { intersect: true, mode: 'nearest' };

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      ch.data.labels = labels;
      ch.data.datasets = datasets();
      // Tooltip + value axis must be rebuilt too: a range switch can change both the formatter
      // and the magnitude, and the old closures would keep formatting the previous window.
      ch.options.plugins.tooltip.callbacks.label = tipLabel;
      ch.options.plugins.legend.display = !!line;
      ch.options.interaction = interaction();
      ch.options.scales.x = horizontal ? valueScale() : catScale();
      ch.options.scales.y = horizontal ? catScale() : valueScale();
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: datasets() },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        interaction: interaction(),
        plugins: {
          legend: { display: !!line, position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: tipLabel } }
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
  // opts.gaps = a null/undefined `v` stays a GAP in the line (and out of the axis range) instead of
  // plotting as 0 — for series where null means "not sampled".
  // opts.secondaryScale = { factor, fmt, title, label } adds a locked right-hand scale (see
  // lockedScale) and appends "· <label> <fmt(v × factor)>" to the tooltip. Only for a quantity that
  // IS the plotted one times a constant.
  function renderTrendLine(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];
    const valueFmt = typeof opts.valueFmt === 'function' ? opts.valueFmt : fmtGps;
    const fmtLabel = timeLabeler(series.map(p => p.t), opts.bucketSeconds);
    const labels = series.map(p => fmtLabel(p.t));
    const data = opts.gaps
      ? series.map(p => (p.v === null || p.v === undefined) ? null : (Number(p.v) || 0))
      : series.map(p => Number(p.v) || 0);
    // yAxis() maps through Number(), which turns a null into a real 0 — keep gaps out of the range.
    const rangeData = opts.gaps ? data.filter(v => v !== null) : data;
    const col = opts.color || accent();
    const sec = (opts.secondaryScale && typeof opts.secondaryScale.fmt === 'function'
                 && isFinite(Number(opts.secondaryScale.factor))) ? opts.secondaryScale : null;
    const tipLabel = sec
      ? (ctx) => {
          const v = ctx.parsed.y;
          if (v === null || !isFinite(v)) return null;
          return valueFmt(v) + ' · ' + (sec.label ? sec.label + ' ' : '') + sec.fmt(v * Number(sec.factor));
        }
      : opts.gaps
        ? (ctx) => (ctx.parsed.y === null ? null : valueFmt(ctx.parsed.y))
        : (ctx) => valueFmt(ctx.parsed.y);
    // With gaps, a sample with null on both sides draws no segment — give exactly that point a dot,
    // or a lone sample (first hour after an outage) leaves a blank panel with no empty state.
    const pointRadius = opts.gaps
      ? (c) => {
          const d = c.dataset.data, i = c.dataIndex;
          return d[i] != null && d[i - 1] == null && d[i + 1] == null ? 2.5 : 0;
        }
      : 0;

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
      ch.options.plugins.tooltip.callbacks.label = tipLabel;
      applyScales(ch, canvas, labels, rangeData, valueFmt, scaleOpts);
      if (sec) ch.options.scales.y2 = lockedScale(sec);
      ch.update('none');
      return ch;
    }

    const scales = {
      x: xAxis(canvas, labels, scaleOpts.xExtra),
      y: yAxis(rangeData, valueFmt, scaleOpts)
    };
    if (sec) scales.y2 = lockedScale(sec);

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
          pointRadius,
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
          tooltip: { callbacks: { label: tipLabel } }
        },
        scales
      }
    });
    return _charts[canvasId];
  }

  // A duration in seconds, two largest units: "45s", "14m 3s", "2h 5m", "3d 4h". Round values
  // print one unit ("5m", "2h"), so the same function labels the log axis below.
  function fmtDuration(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var units = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][0] || i === units.length - 1) {
        var big = Math.floor(s / units[i][0]);
        var rest = i < units.length - 1 ? Math.floor((s % units[i][0]) / units[i + 1][0]) : 0;
        return big + units[i][1] + (rest ? ' ' + rest + units[i + 1][1] : '');
      }
    }
    return '0s';
  }

  // Log-axis ticks a person reads as durations. Chart.js' own log ticks land on 1-2-5 × 10ⁿ
  // SECONDS ("2000s"), which is no unit anyone thinks in. Neighbours sit ≥6× apart: at 2×
  // (15m/30m/1h/2h) the labels collide on a 240px canvas. 365d is there because a small pool's
  // long gap runs past a month; anything longer still gets headroom above the last tick.
  var DURATION_TICKS = [1, 10, 60, 600, 3600, 21600, 86400, 604800, 2592000, 31536000];

  // Time between events on a LOG axis — one dot per event, plus a dashed neutral reference line
  // for the expected interval. `series` = [{ t, v, ref, title, hollow, note }] oldest→newest:
  // v = seconds since the previous event, ref = expected seconds or null (a gap in the line),
  // title = the tooltip heading (e.g. "Block 1,234,567"), hollow = draw the dot as a ring (e.g.
  // an orphaned block), note = an extra tooltip line. Log, because intervals are exponential: on a
  // linear axis one long drought flattens every other point onto the floor. A 0 s interval plots
  // at 1 s (log has no zero); its tooltip still says 0s. A dot over opts.longFactor × ref
  // (default 3, the ~5% tail at a steady rate) is drawn in opts.longColor (default the theme's
  // --warn, which light themes re-pick for a white panel) AND as a triangle, so it does not rest
  // on colour alone — "above the line" by itself is the ordinary 37% case, not news.
  // The x axis is a category axis: dots are spaced per event, not by time.
  // Returns the Chart or null.
  function renderIntervalChart(canvasId, series, opts) {
    opts = opts || {};
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof global.Chart === 'undefined') return null;
    series = Array.isArray(series) ? series : [];
    const fmtLabel = timeLabeler(series.map(p => p.t));
    const labels = series.map(p => fmtLabel(p.t));
    const num = v => (v == null || !isFinite(Number(v))) ? null : Number(v);
    const vals = series.map(p => num(p.v));
    const refs = series.map(p => { const r = num(p.ref); return r != null && r > 0 ? r : null; });
    const col = opts.color || accent();
    const longCol = opts.longColor || textToken('--warn', '#d29922');
    const longFactor = Number(opts.longFactor) > 0 ? Number(opts.longFactor) : 3;
    const ink = textToken('--text-dim', '#9aa4b2');
    const hasRef = refs.some(r => r != null);

    // Axis bounds snap outward to the nearest duration ticks, so the top and bottom are labelled.
    // A value past the last tick gets headroom instead: an explicit max clips at the chart area,
    // so a max below the data would erase the longest drought — the one point that matters.
    const plotted = vals.filter(v => v != null).map(v => Math.max(1, v))
      .concat(refs.filter(v => v != null));
    const lo = plotted.length ? Math.min.apply(null, plotted) : 60;
    const hi = plotted.length ? Math.max.apply(null, plotted) : 3600;
    const lastTick = DURATION_TICKS[DURATION_TICKS.length - 1];
    let min = DURATION_TICKS[0], max = lastTick;
    DURATION_TICKS.forEach(function (t) { if (t <= lo) min = t; });
    for (let i = DURATION_TICKS.length - 1; i >= 0; i--) if (DURATION_TICKS[i] >= hi) max = DURATION_TICKS[i];
    if (hi > lastTick) max = hi * 1.5;
    if (max <= min) max = DURATION_TICKS[Math.min(DURATION_TICKS.indexOf(min) + 1, DURATION_TICKS.length - 1)];
    const yScale = () => ({
      type: 'logarithmic', min, max,
      afterBuildTicks: function (scale) {
        scale.ticks = DURATION_TICKS.filter(t => t >= min && t <= max).map(t => ({ value: t }));
      },
      ticks: { callback: v => fmtDuration(v), autoSkip: false }
    });

    const isLong = i => vals[i] != null && refs[i] != null && vals[i] > longFactor * refs[i];
    const radius = series.length > 200 ? 2 : 3;
    const pointColors = series.map((p, i) => isLong(i) ? longCol : col);
    // Both datasets are rebuilt as plain property sets and MERGED into the live objects on an
    // update: Chart.js keys a dataset's state (legend-hidden) by object identity, so replacing
    // the objects re-shows a series the visitor hid on every refresh.
    const datasets = () => [{
      type: 'line',
      label: opts.label || 'Interval',
      data: vals.map(v => v == null ? null : Math.max(1, v)),
      showLine: false,
      borderColor: col,
      backgroundColor: col,
      pointStyle: series.map((p, i) => isLong(i) ? 'triangle' : 'circle'),
      pointRadius: series.map((p, i) => isLong(i) ? radius + 2 : radius),
      pointHoverRadius: 5,
      pointBackgroundColor: series.map((p, i) => p.hollow ? 'transparent' : pointColors[i]),
      pointBorderColor: pointColors,
      pointBorderWidth: series.map(p => p.hollow ? 1.5 : 1),
      // The bounds snap to ticks, so a dot ON the min or max would lose half its disc to the
      // default zero clip an explicit min/max sets.
      clip: 8,
      order: 1
    }, {
      type: 'line',
      label: opts.refLabel || 'Expected',
      data: refs,
      borderColor: ink,
      backgroundColor: ink,
      borderWidth: 2,
      borderDash: [6, 4],
      pointStyle: 'line',
      pointRadius: 0,
      pointHoverRadius: 0,
      tension: 0,
      spanGaps: false,
      fill: false,
      order: 2
    }];
    // The axis labels drop the date when the window is short; the tooltip never does.
    const fullDate = t => utc(t, { month: 'short', day: 'numeric', year: 'numeric',
                                   hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC';
    const callbacks = {
      title: items => {
        const p = items.length ? series[items[0].dataIndex] : null;
        return p ? [p.title || '', isFinite(Number(p.t)) ? fullDate(Number(p.t)) : ''].filter(Boolean) : '';
      },
      label: ctx => {
        const i = ctx.dataIndex;
        const v = ctx.datasetIndex === 0 ? vals[i] : refs[i];
        if (v == null) return null;
        const ratio = ctx.datasetIndex === 0 && refs[i] != null && v > 0
          ? ' (' + (v / refs[i]).toFixed(1) + '× expected)' : '';
        return ctx.dataset.label + ': ' + fmtDuration(v) + ratio;
      },
      footer: items => {
        const p = items.length ? series[items[0].dataIndex] : null;
        return p && p.note ? String(p.note) : '';
      }
    };
    // Legend: the dot series' marker is a plain filled circle whatever its first point looks
    // like (Chart.js draws the swatch from point 0), and "Expected" is listed only when drawn.
    const legendLabels = {
      usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 12,
      generateLabels: chart => global.Chart.defaults.plugins.legend.labels.generateLabels(chart)
        .map(item => item.datasetIndex === 0
          ? Object.assign(item, { pointStyle: 'circle', fillStyle: col, strokeStyle: col })
          : item),
      filter: item => item.datasetIndex !== 1 || hasRef
    };

    if (_charts[canvasId]) {
      const ch = _charts[canvasId];
      const next = datasets();
      ch.data.labels = labels;
      next.forEach((d, i) => {
        if (ch.data.datasets[i]) Object.assign(ch.data.datasets[i], d);
        else ch.data.datasets[i] = d;
      });
      ch.options.plugins.tooltip.callbacks = callbacks;
      ch.options.plugins.legend.labels = legendLabels;
      ch.options.scales.x = xAxis(canvas, labels);
      ch.options.scales.y = yScale();
      // An open tooltip indexes the OLD series; after a range switch it would describe a block
      // that is no longer drawn.
      if (ch.tooltip) ch.tooltip.setActiveElements([], { x: 0, y: 0 });
      ch.update('none');
      return ch;
    }

    _charts[canvasId] = new global.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: datasets() },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: true, position: 'bottom', labels: legendLabels },
          tooltip: { callbacks }
        },
        scales: { x: xAxis(canvas, labels), y: yScale() }
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
      // A null/undefined `v` stays NULL, it does not become 0 (audit §J11-5). Chart.js already
      // treats null as a gap — the `grid.map` below emits one for any bucket a series has no
      // point in — and a withheld value must draw as that same gap, never as a real zero.
      // `/api/pool/metrics/history/regions` now nulls per-region miner counts under the
      // k-anonymity floor, and `Number(null) || 0` would have plotted "this gateway had 0
      // miners" for a gateway that had one or two. Same failure §J5-4 recorded on the block
      // counts: a suppressed number rendered as a measured one is worse than no number.
      // NaN and non-numeric junk still collapse to 0, as before.
      const byT = new Map((s.points || []).map(function (p) {
        return [p.t, (p.v === null || p.v === undefined) ? null : (Number(p.v) || 0)];
      }));
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
      // MERGE into the live dataset objects, never replace them: Chart.js keys legend-hidden
      // state by object identity, so a replaced set re-shows a series the visitor hid on every
      // 60 s poll (same rule as renderIntervalChart).
      built.forEach((d, i) => {
        if (ch.data.datasets[i]) Object.assign(ch.data.datasets[i], d);
        else ch.data.datasets[i] = d;
      });
      ch.data.datasets.length = built.length;
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
    renderTrendLine, renderMultiTrendLine, renderGroupedBarChart, renderIntervalChart,
    fmtGps, fmtInt, fmtDiff, fmtDuration, timeLabels, timeLabeler, PALETTE
  };
})(window);
