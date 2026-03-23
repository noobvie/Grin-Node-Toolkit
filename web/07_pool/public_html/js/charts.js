// charts.js — Chart.js wrappers for pool dashboard
// Requires Chart.js loaded via CDN before this file

const Charts = {
  hashrateChart: null,
  rewardChart:   null,

  // ── Hashrate line chart (multi-worker) ──────────────────────────────────
  initHashrate(canvasId, labels, datasets) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (this.hashrateChart) { this.hashrateChart.destroy(); this.hashrateChart = null; }

    const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#00ff41';
    const textDim = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
    const border  = getComputedStyle(document.body).getPropertyValue('--border').trim() || '#333';
    const bgCard  = getComputedStyle(document.body).getPropertyValue('--bg-card').trim() || '#111';

    const COLORS = [
      accent,
      '#4a90d9',
      '#f57c00',
      '#d4006a',
      '#9c59d1',
      '#00bcd4',
      '#ffb300',
      '#43a047',
    ];

    const styledDatasets = datasets.map((ds, i) => ({
      label:           ds.label || ('Worker ' + i),
      data:            ds.data,
      borderColor:     COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length] + '18',
      borderWidth:     2,
      pointRadius:     2,
      pointHoverRadius: 4,
      tension:         0.35,
      fill:            false,
    }));

    this.hashrateChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: styledDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: textDim, font: { size: 11 }, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: bgCard,
            borderColor: border,
            borderWidth: 1,
            titleColor: accent,
            bodyColor: textDim,
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed.y;
                return ' ' + ctx.dataset.label + ': ' + this._formatHashrate(val);
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: textDim, font: { size: 10 }, maxTicksLimit: 10 },
            grid:  { color: border + '55' },
          },
          y: {
            ticks: {
              color: textDim,
              font: { size: 10 },
              callback: (v) => this._formatHashrate(v),
            },
            grid: { color: border + '55' },
          },
        },
      },
    });
  },

  // ── Reward line chart (single dataset, GRIN per day) ────────────────────
  initReward(canvasId, labels, data) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (this.rewardChart) { this.rewardChart.destroy(); this.rewardChart = null; }

    const accent  = getComputedStyle(document.body).getPropertyValue('--accent').trim()    || '#00ff41';
    const textDim = getComputedStyle(document.body).getPropertyValue('--text-dim').trim()  || '#888';
    const border  = getComputedStyle(document.body).getPropertyValue('--border').trim()    || '#333';
    const bgCard  = getComputedStyle(document.body).getPropertyValue('--bg-card').trim()   || '#111';
    const yellow  = '#f2c94c';

    this.rewardChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label:           'GRIN earned',
          data,
          borderColor:     yellow,
          backgroundColor: yellow + '18',
          borderWidth:     2,
          pointRadius:     2,
          pointHoverRadius: 4,
          tension:         0.35,
          fill:            true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: {
            labels: { color: textDim, font: { size: 11 }, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: bgCard,
            borderColor: border,
            borderWidth: 1,
            titleColor: yellow,
            bodyColor: textDim,
            callbacks: {
              label: (ctx) => ' GRIN ' + (ctx.parsed.y || 0).toFixed(4),
            },
          },
        },
        scales: {
          x: {
            ticks: { color: textDim, font: { size: 10 }, maxTicksLimit: 12 },
            grid:  { color: border + '55' },
          },
          y: {
            ticks: {
              color: textDim,
              font: { size: 10 },
              callback: (v) => v.toFixed(2),
            },
            grid: { color: border + '55' },
          },
        },
      },
    });
  },

  // ── Update ────────────────────────────────────────────────────────────────
  updateHashrate(labels, datasets) {
    if (!this.hashrateChart) return;
    this.hashrateChart.data.labels = labels;
    datasets.forEach((ds, i) => {
      if (this.hashrateChart.data.datasets[i]) {
        this.hashrateChart.data.datasets[i].data = ds.data;
        this.hashrateChart.data.datasets[i].label = ds.label;
      }
    });
    this.hashrateChart.update('none');
  },

  updateReward(labels, data) {
    if (!this.rewardChart) return;
    this.rewardChart.data.labels = labels;
    this.rewardChart.data.datasets[0].data = data;
    this.rewardChart.update('none');
  },

  // ── Helpers ───────────────────────────────────────────────────────────────
  _formatHashrate(gps) {
    if (gps === null || gps === undefined) return '—';
    if (gps >= 1000) return (gps / 1000).toFixed(2) + ' KG/s';
    return gps.toFixed(4) + ' G/s';
  },
};
