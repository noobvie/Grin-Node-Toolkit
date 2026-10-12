// settings-announcements.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F4).
// Classic script (no defer/module) loaded at the same position as the old block, after settings-common.js (and the scripts before it), whose globals it uses (H14).
  // ── Stratum section (design §21) ─────────────────────────────────────────────────────────
  // Reads the state from admin-shell's shared poll (window.AdminStratum — the same answer the
  // strip renders), and acts through the five freshAdmin routes with adminFetch, so a stale
  // session gets the in-page step-up dialog. After an action the route's own `state` is handed
  // to AdminStratum.set() and a fresh poll follows; a 409 also carries `state`, so a second
  // admin acting on a stale page sees what is really true (§21.11). Nothing here is part of
  // saveSection(): no input id below is a settings key, and every one is settings-skip.
  (function () {
    'use strict';
    var S = window.AdminStratum;
    var LIMITS = { duration_min: [15, 30, 60, 120], window_min_s: 300, window_max_s: 21600,
                   window_lead_s: 900, window_horizon_s: 2592000, reason_min: 3, reason_max: 300 };
    var cur = null;       // last control payload
    var busy = false;     // an action is in flight: every button stays disabled, polls included
    var prefilled = false;
    var stale = false;    // the "could not refresh" warning is up; the next good answer clears it
    var $ = function (id) { return document.getElementById(id); };

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function showMsg(text, isError) {
      var el = $('stratum-msg');
      el.textContent = text;
      el.style.color = isError ? 'var(--danger)' : 'var(--text-dim)';
      el.style.display = text ? '' : 'none';
    }

    // datetime-local has no zone. The page states UTC, so the typed wall time IS UTC: append Z.
    // NEVER new Date(value) — that reads it in the BROWSER's zone and shifts the window.
    function zoned(v) {
      v = String(v || '');
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v + ':00Z';
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v + 'Z';
      return null;
    }
    function localValue(sec) { return new Date(sec * 1000).toISOString().slice(0, 16); }
    function zonedSec(v) { var z = zoned(v); return z ? Math.floor(Date.parse(z) / 1000) : null; }

    function listenerRows(c) {
      var live = {};
      (c.listeners || []).forEach(function (l) { if (l && l.listening) live[Number(l.port)] = true; });
      var down = {};
      S.down(c).forEach(function (d) { down[d.port] = d; });
      var rows = [];
      function row(label, port, deferred) {
        var p = Number(port), st;
        if (live[p]) st = '<span class="st-good">listening</span>';
        // `deferred` is true for EVERY region while paused (nothing is held), so it cannot tell a
        // region paired during the pause from one that was closed by it — and need not.
        else if (c.paused) st = deferred ? 'closed — opens on resume' : 'closed';
        else if (down[p]) st = '<span class="st-bad">NOT listening' + (down[p].error ? ' — ' + esc(down[p].error) : '') + '</span>';
        else st = 'not listening';
        rows.push('<li>' + label + ' <code>:' + esc(port) + '</code> — ' + st + '</li>');
      }
      if (c.public_port) row('Public', c.public_port, false);
      (c.regions || []).forEach(function (r) { if (r && r.port) row('Region <strong>' + esc(r.region) + '</strong>', r.port, r.deferred); });
      return rows.length ? '<ul>' + rows.join('') + '</ul>' : '';
    }

    function render(c) {
      cur = c;
      if (stale) { stale = false; if (!busy) showMsg('', false); }
      if (c.limits && Array.isArray(c.limits.duration_min)) LIMITS = c.limits;
      var now = S.now(), k = S.classify(c);
      var tone = k.tone || (k.level === 'ok' ? 'ok' : null);

      var pill = $('stratum-pill');
      var PILL = { ok: ['badge-ok', 'ACCEPTING'], scheduled: ['badge-warn', 'ACCEPTING · window scheduled'],
                   pausing: ['badge-error', 'PAUSING'], paused: ['badge-error', 'PAUSED'],
                   resuming: ['badge-warn', 'RESUMING'], degraded: ['badge-error', 'DEGRADED'] }[k.level];
      if (PILL) { pill.className = 'badge ' + PILL[0]; pill.textContent = PILL[1]; pill.style.display = ''; }
      else pill.style.display = 'none';

      var box = $('stratum-status');
      box.className = 'stratum-status' + (tone ? ' tone-' + tone : '');
      var meta = [];
      if (c.paused) {
        if (c.reason) meta.push('Reason: ' + esc(c.reason));
        meta.push(c.settled_at
          ? '<strong>Settled ' + S.time(c.settled_at) + ' — safe to proceed.</strong>'
          : '<span class="st-bad">Not settled yet — ' + esc(c.inflight) + ' submit(s) still in flight. They are still recorded when they finish; wait before you proceed.</span>');
      }
      meta.push('Connections now: ' + esc(c.connections) + ' · in-flight submits: ' + esc(c.inflight));
      box.innerHTML = '<div class="st-head">' + S.summaryHtml(c) + '</div>' +
        '<div class="st-meta">' + meta.join('<br>') + '</div>' + listenerRows(c);

      // Planned window: scheduled → shown with Cancel; running → it is the pause above.
      var pl = $('stratum-planned');
      if (c.planned) {
        pl.style.display = '';
        pl.className = 'stratum-status tone-amber';
        pl.innerHTML = '<div class="st-head"><strong>Scheduled:</strong> ' + S.range(c.planned.start, c.planned.end) +
          ' (' + S.dur(c.planned.end - c.planned.start) + ', starts in ' + S.dur(c.planned.start - now) + ')</div>' +
          '<div class="st-meta">Reason: ' + esc(c.planned.reason) + (c.planned.by ? ' · by ' + esc(c.planned.by) : '') + '</div>';
      } else if (c.paused && c.source === 'planned') {
        pl.style.display = '';
        pl.className = 'stratum-status tone-red';
        pl.innerHTML = '<div class="st-head">A planned window is running now — it is the pause above and ends with it.</div>';
      } else {
        pl.style.display = 'none';
        pl.innerHTML = '';
      }

      if (!prefilled) {
        prefilled = true;
        var start = Math.ceil((now + 3600) / 900) * 900;
        $('st-win-start').value = localValue(start);
        $('st-win-end').value = localValue(start + 3600);
      }
      $('st-win-start').min = localValue(now + (LIMITS.window_lead_s || 900));
      $('st-win-start').max = localValue(now + (LIMITS.window_horizon_s || 2592000));
      setButtons();
    }

    function renderError(err) {
      if (cur) {
        // Keep the last answer visible but say it is not fresh.
        if (busy) return;
        stale = true;
        showMsg('Could not refresh the stratum state (' + err.message + ') — what is shown may be stale.', true);
        return;
      }
      var box = $('stratum-status');
      box.className = 'stratum-status tone-red';
      box.innerHTML = '<div class="st-head">Stratum state unknown — ' + esc(err.message) + '</div>' +
        '<div class="st-meta">The controls stay disabled until the pool answers.</div>';
    }

    function setButtons() {
      var c = cur, t = busy || !c || c.transition;
      var down = c ? S.down(c) : [];
      $('st-pause').disabled = t || c.paused || c.accept_state !== 'accepting';
      $('st-extend').disabled = t || !c.paused || c.accept_state !== 'paused';
      var resume = $('st-resume');
      if (c && !c.paused && down.length) {
        resume.textContent = 'Re-bind';
        resume.disabled = t;
      } else {
        resume.textContent = 'Resume now';
        resume.disabled = t || !c.paused || c.accept_state !== 'paused';
      }
      $('st-schedule').disabled = t;
      var cancel = $('st-cancel-window');
      cancel.style.display = c && c.planned ? '' : 'none';
      cancel.disabled = t;
    }

    function setBusy(on, text) {
      busy = on;
      if (text) showMsg(text, false);
      setButtons();
    }

    // ── The dialog ─────────────────────────────────────────────────────────────────────────
    // Resolves { reason, duration } on Confirm, or null on Cancel / Escape / backdrop. `check`
    // validates on submit and returns an error string to keep the dialog open.
    function ask(o) {
      var ov = $('stratum-dialog'), form = $('st-dlg-form'), err = $('st-dlg-error');
      var reason = $('st-dlg-reason'), dur = $('st-dlg-duration'), submit = $('st-dlg-submit');
      $('st-dlg-title').textContent = o.title;
      $('st-dlg-body').textContent = o.body;
      $('st-dlg-reason-group').style.display = o.reason ? '' : 'none';
      $('st-dlg-duration-group').style.display = o.duration ? '' : 'none';
      reason.value = '';
      reason.minLength = LIMITS.reason_min || 3;
      reason.maxLength = LIMITS.reason_max || 300;
      dur.innerHTML = (LIMITS.duration_min || []).map(function (m) {
        var v = Number(m);
        return '<option value="' + v + '"' + (v === 60 ? ' selected' : '') + '>' +
          (v >= 60 ? (v / 60) + ' h' : v + ' min') + '</option>';
      }).join('');
      err.style.display = 'none';
      submit.textContent = o.confirm;
      submit.className = o.danger ? 'btn btn-danger' : 'btn';
      return new Promise(function (resolve) {
        function done(v) {
          ov.classList.remove('open');
          form.removeEventListener('submit', onSubmit);
          $('st-dlg-cancel').removeEventListener('click', onCancel);
          ov.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey);
          resolve(v);
        }
        function onSubmit(e) {
          e.preventDefault();
          var v = { reason: reason.value.trim(), duration: Number(dur.value) };
          var problem = o.reason && (v.reason.length < (LIMITS.reason_min || 3))
            ? 'A reason of at least ' + (LIMITS.reason_min || 3) + ' characters is required — it goes in the audit log.' : '';
          if (problem) { err.textContent = problem; err.style.display = ''; reason.focus(); return; }
          done(v);
        }
        function onCancel() { done(null); }
        function onBackdrop(e) { if (e.target === ov) done(null); }
        function onKey(e) { if (e.key === 'Escape') done(null); }
        form.addEventListener('submit', onSubmit);
        $('st-dlg-cancel').addEventListener('click', onCancel);
        ov.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        ov.classList.add('open');
        (o.reason ? reason : o.duration ? dur : submit).focus();
      });
    }

    // POST/DELETE through adminFetch. A refusal (incl. the step-up's own) throws the server's
    // reason; a 409's `state` is applied first so the page re-renders from the truth.
    async function call(method, url, body) {
      var res = await adminFetch(url, {
        method: method, credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        if (data && data.state) S.set(data.state);
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      if (data && data.state) S.set(data.state);
      return data;
    }
    function persistNote(d) {
      return d && d.persisted === false ? ' NOT persisted — the database write failed, so a restart will reopen stratum.' : '';
    }
    function bindResults(results) {
      return (results || []).filter(function (r) { return r && !r.bound && !r.already; })
        .map(function (r) { return ':' + r.port + ' (' + (r.region || '?') + ') ' + (r.code || r.error || 'failed'); }).join(', ');
    }

    async function onPause() {
      var n = cur ? cur.connections : 0;
      var v = await ask({
        title: 'Pause stratum',
        body: 'Closes the public port and every regional listener now. Shares already in flight are ' +
          'recorded first (up to 30 s), then all ' + n + ' connection(s) are dropped and every miner is ' +
          'refused until you resume. Miners fail over to their backup pool.\n\nThe pool resumes on its own ' +
          'after the time below. You may be asked for your admin password.',
        reason: true, duration: true, confirm: 'Pause now', danger: true
      });
      if (!v) return;
      setBusy(true, 'Pausing — listeners closed, waiting for in-flight shares to settle (up to ~35 s)…');
      try {
        var d = await call('POST', '/api/admin/stratum/pause', { reason: v.reason, duration_min: v.duration });
        var t = d.settled
          ? 'Paused · settled — safe to proceed. '
          : 'Paused, but NOT settled: ' + d.inflight_left + ' submit(s) still in flight (' + d.blocks_in_flight +
            ' block candidate(s)). They are still recorded when they finish — wait for "Settled" above before you proceed. ';
        t += d.sockets_closed + ' connection(s) dropped, ' + (d.listeners_closed || []).length + ' listener(s) closed.';
        showMsg(t + persistNote(d), !d.settled || d.persisted === false);
      } catch (e) {
        showMsg('Not paused: ' + e.message, true);
      } finally {
        setBusy(false);
        S.refresh();
      }
    }

    async function onExtend() {
      var v = await ask({
        title: 'Extend the pause',
        body: 'Sets a NEW automatic resume time, counted from now — it is not added to the current one ' +
          '(' + S.time(cur && cur.until) + ' UTC). Each extension is its own audit entry.',
        reason: false, duration: true, confirm: 'Extend'
      });
      if (!v) return;
      setBusy(true, 'Extending…');
      try {
        var d = await call('POST', '/api/admin/stratum/extend', { duration_min: v.duration });
        showMsg('Extended — resumes on its own at ' + S.time(d.state && d.state.until) + ' UTC.' + persistNote(d), d.persisted === false);
      } catch (e) {
        showMsg('Not extended: ' + e.message, true);
      } finally {
        setBusy(false);
        S.refresh();
      }
    }

    async function onResume() {
      var rebind = !!(cur && !cur.paused);
      var v = await ask(rebind ? {
        title: 'Re-bind missing listeners',
        body: 'Tries again to open: ' + S.down(cur).map(function (x) { return ':' + x.port + ' (' + x.region + ')'; }).join(', ') +
          '. Listeners that are already up are left alone.',
        confirm: 'Re-bind'
      } : {
        title: 'Resume stratum now',
        body: 'Re-opens the public port and every regional listener; miners return on their own.' +
          (cur && cur.source === 'planned' ? ' This also ends the running planned window.' : '') +
          '\n\nDuring a restore or a hub move, resume only once the pool has been checked: an early resume ' +
          'accepts shares into a database that may still be replaced.',
        confirm: 'Resume now'
      });
      if (!v) return;
      setBusy(true, rebind ? 'Re-binding…' : 'Resuming — re-binding every listener…');
      try {
        var d = await call('POST', '/api/admin/stratum/resume');
        var bad = bindResults(d.results);
        showMsg(d.failed
          ? (rebind ? 'Still not listening: ' : 'Resumed, but not listening: ') + bad +
            '. Miners on those ports fail over. Free the port (EADDRINUSE) or bring the tunnel up (EADDRNOTAVAIL), then Re-bind.'
          : (rebind ? 'Re-bound — every listener is up.' : 'Resumed — every listener is up; miners return on their own.'),
          !!d.failed);
        if (!rebind && d.persisted === false) {
          // The opposite of persistNote(): the row still says PAUSED, so a restart boots paused.
          showMsg($('stratum-msg').textContent + ' NOT persisted — the database write failed, so a restart ' +
            'will boot stratum PAUSED again until its old resume time.', true);
        }
      } catch (e) {
        showMsg((rebind ? 'Not re-bound: ' : 'Not resumed: ') + e.message, true);
      } finally {
        setBusy(false);
        S.refresh();
      }
    }

    async function onSchedule() {
      var startV = $('st-win-start').value, endV = $('st-win-end').value, reason = $('st-win-reason').value.trim();
      var a = zonedSec(startV), b = zonedSec(endV), now = S.now();
      // Convenience checks only — the server enforces every cap (§21.7).
      var problem = !a || !b ? 'Pick a start and an end.'
        : b <= a ? 'The end must be after the start.'
        : a < now + (LIMITS.window_lead_s || 900) ? 'The start must be at least ' + S.dur(LIMITS.window_lead_s || 900) + ' from now — for sooner, use Pause stratum.'
        : reason.length < (LIMITS.reason_min || 3) ? 'A reason of at least ' + (LIMITS.reason_min || 3) + ' characters is required.'
        : '';
      if (problem) { showMsg('Not scheduled: ' + problem, true); return; }
      var v = await ask({
        title: 'Schedule a planned window',
        body: 'Stratum pauses ' + S.range(a, b) + ' UTC (' + S.dur(b - a) + ') and resumes on its own. ' +
          'Miners see a banner from 24 h before it starts.' +
          (cur && cur.planned ? '\n\nThis REPLACES the window scheduled for ' + S.range(cur.planned.start, cur.planned.end) + ' UTC.' : ''),
        confirm: 'Schedule'
      });
      if (!v) return;
      setBusy(true, 'Scheduling…');
      try {
        var d = await call('POST', '/api/admin/stratum/window', { start: zoned(startV), end: zoned(endV), reason: reason });
        $('st-win-reason').value = '';
        showMsg('Scheduled ' + S.range(a, b) + ' UTC.' + (d.replaced ? ' The previous window was replaced.' : '') + persistNote(d), d.persisted === false);
      } catch (e) {
        showMsg('Not scheduled: ' + e.message, true);
      } finally {
        setBusy(false);
        S.refresh();
      }
    }

    async function onCancelWindow() {
      if (!cur || !cur.planned) return;
      var v = await ask({
        title: 'Cancel the scheduled window',
        body: 'Removes the window ' + S.range(cur.planned.start, cur.planned.end) + ' UTC.' +
          (cur.paused ? ' The pause running now is not changed — it still resumes at ' + S.time(cur.until) + ' UTC.'
                      : ' Nothing is paused now, so nothing else changes.'),
        confirm: 'Remove window', danger: true
      });
      if (!v) return;
      setBusy(true, 'Cancelling…');
      try {
        var d = await call('DELETE', '/api/admin/stratum/window');
        showMsg('Window cancelled.' + persistNote(d), d.persisted === false);
      } catch (e) {
        showMsg('Not cancelled: ' + e.message, true);
      } finally {
        setBusy(false);
        S.refresh();
      }
    }

    if (!S) {
      $('stratum-status').textContent = 'Stratum controls unavailable — admin-shell.js did not load.';
      return;
    }
    $('st-pause').addEventListener('click', onPause);
    $('st-extend').addEventListener('click', onExtend);
    $('st-resume').addEventListener('click', onResume);
    $('st-schedule').addEventListener('click', onSchedule);
    $('st-cancel-window').addEventListener('click', onCancelWindow);
    S.subscribe(render, renderError);
  })();
