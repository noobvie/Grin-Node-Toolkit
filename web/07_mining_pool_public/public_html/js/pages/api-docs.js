// api-docs.js — the api-docs page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was api-docs.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
    // Auto-generated API reference. The endpoint list comes from /api/public/endpoints
    // (server walks its own Express route table → always accurate). Grouped by the path's
    // second segment (public / account / pool / config / stratum). All values escaped.
    function escHtml(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var GROUP_LABELS = {
      pool: 'Pool', account: 'Account', public: 'Public', config: 'Config',
      stratum: 'Stratum', network: 'Network',
    };
    function groupOf(path) {
      var seg = path.split('/').filter(Boolean); // ['api','pool',...]
      return (seg[1] || 'public');
    }

    function tag(cls, text) {
      return '<span class="api-tag ' + cls + '">' + escHtml(text) + '</span>';
    }

    // Badges, then params/body, then a runnable example. Only GETs get a curl line: a POST
    // here needs an ownership proof, and printing a copy-paste command that will always 403
    // teaches the wrong thing — those rows list their body fields instead.
    function rowMeta(e) {
      var out = '';
      var tags = '';
      if (e.shape) tags += tag('shape', e.shape);
      if (e.auth) tags += tag('auth', '🔒 ' + e.auth);
      if (e.gated) tags += tag('gated', 'off unless: ' + e.gated);
      if (e.rate_limit && e.rate_limit !== 'public') tags += tag('rate', 'rate: ' + e.rate_limit);
      if (tags) out += '<div class="api-tags">' + tags + '</div>';

      if (e.params) out += '<div class="api-meta"><b>query</b> · ' + escHtml(e.params) + '</div>';
      if (e.body) out += '<div class="api-meta"><b>body</b> · ' + escHtml(e.body) + '</div>';

      if (e.method === 'GET') {
        // Path params render as <addr>, not :addr — a copy-pasted `:addr` 404s, and a command
        // that only fails once you run it is the same trap as the POST examples above. Angle
        // brackets read as "fill this in" to anyone who has used a man page.
        var shown = e.path.replace(/:(\w+)/g, '<$1>');
        out += '<div class="api-curl">curl -s ' + escHtml(location.origin + shown) + '</div>';
      }
      return out;
    }

    function render(endpoints, notes) {
      var list = document.getElementById('api-list');
      if (!endpoints || !endpoints.length) {
        list.innerHTML = '<p style="color:var(--text-mute);">No public endpoints reported.</p>';
        return;
      }
      var groups = {};
      endpoints.forEach(function (e) {
        var g = groupOf(e.path);
        (groups[g] = groups[g] || []).push(e);
      });
      // Stable, friendly ordering.
      var order = ['pool', 'account', 'stratum', 'network', 'public', 'config'];
      var keys = Object.keys(groups).sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });

      var html = '';
      keys.forEach(function (g) {
        html += '<div class="api-group"><h2>' + escHtml(GROUP_LABELS[g] || g) +
          ' <span style="text-transform:none;letter-spacing:0;">(' + groups[g].length + ')</span></h2>';
        groups[g].forEach(function (e) {
          var m = (e.method || 'GET').toLowerCase();
          html += '<div class="api-row">' +
            '<span class="api-method ' + escHtml(m) + '">' + escHtml(e.method) + '</span>' +
            '<div><div class="api-path">' + escHtml(e.path) + '</div>' +
            (e.description ? '<div class="api-desc">' + escHtml(e.description) + '</div>' : '') +
            rowMeta(e) +
            '</div></div>';
        });
        html += '</div>';
      });
      list.innerHTML = html;

      // Cross-cutting facts, stated once. Rate limits come from the server's live config, so an
      // operator who raises them doesn't leave a wrong number published here.
      var n = notes || {};
      var bits = [];
      if (n.errors) bits.push(escHtml(n.errors));
      if (n.times) bits.push(escHtml(n.times));
      if (n.rate_limits) {
        bits.push('Rate limits per IP, per minute: ' +
          escHtml(String(n.rate_limits.public)) + ' for reads, ' +
          escHtml(String(n.rate_limits.withdraw)) + ' for payout actions, ' +
          escHtml(String(n.rate_limits.export)) + ' for CSV exports' +
          // Distinct addresses per minute, effectively: repeat probes of one address are served
          // from a 60 s cache. Printed here because the row carries the bucket NAME only.
          (n.rate_limits.torcheck != null ? ', ' + escHtml(String(n.rate_limits.torcheck)) + ' for Tor reachability probes' : '') +
          '. Over the limit returns 429.');
      }
      if (n.cors) bits.push(escHtml(n.cors));
      document.getElementById('api-notes').innerHTML = bits.join(' ');
    }

    document.addEventListener('DOMContentLoaded', function () {
      document.getElementById('api-base').textContent = location.origin;
      fetch('/api/public/endpoints', { credentials: 'same-origin' })
        // A non-2xx must reach the .catch below ("API reference is temporarily unavailable")
        // rather than collapsing to null, which renders "No public endpoints reported" — a
        // statement about the pool, not about the request (audit §J15-2).
        .then(function (r) {
          if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status));
          return r.json();
        })
        .then(function (j) {
          var d = (j && j.data) || {};
          render(d.endpoints, d.notes);
        })
        .catch(function () {
          document.getElementById('api-list').innerHTML =
            '<p style="color:var(--text-mute);">API reference is temporarily unavailable.</p>';
        });
    });
