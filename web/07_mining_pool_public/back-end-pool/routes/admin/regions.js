// /api/admin/poolstats, locations, gateways. Moved verbatim out of routes/index.js (code-layout
// refactor P8); registrations stay at 2-space indent and write FULL paths.

const express = require('express');
const caches = require('../_shared/caches');
const { gwctl } = require('../../lib/gateway-status');

module.exports = function createAdminRegionsRoutes(ctx, guards) {
  const { config, db, stratumServer, poolstatsReporter } = ctx;
  const { secureAdmin, freshAdmin, stepUpRefused } = guards;
  const router = express.Router();

  // ─── Poolstats Reporter (miningpoolstats.stream integration) ────────────────
  router.get('/api/admin/poolstats', secureAdmin, (req, res) => {
    try {
      const status = poolstatsReporter.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/poolstats/update-key', freshAdmin, (req, res) => {
    try {
      const { api_key } = req.body;
      if (!api_key || api_key.trim().length === 0) {
        return res.status(400).json({ error: 'API key cannot be empty' });
      }
      poolstatsReporter.updateApiKey(api_key);
      res.json({
        success: true,
        message: 'Poolstats API key updated',
        status: poolstatsReporter.getStatus()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/poolstats/test', secureAdmin, (req, res) => {
    try {
      poolstatsReporter.submit()
        .then(() => res.json({
          success: true,
          message: 'Test submission sent to poolstats.stream',
          status: poolstatsReporter.getStatus()
        }))
        .catch(err => res.status(500).json({ error: err.message }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── MULTI-REGION LOCATIONS (Admin only) ──────────────────────────
  // CRUD over pool_locations — the operator's descriptive registry of regions/gateways
  // (labels + public stratum URLs surfaced to miners via /api/pool/locations). This is
  // metadata only; the actual region wiring is the WireGuard peer + per-region port set up
  // by Script 07 (W) Multi-region) — live status comes from /api/admin/health/gateways.
  router.get('/api/admin/locations', secureAdmin, (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM pool_locations ORDER BY region ASC').all();
      res.json({ success: true, locations: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or update a region by its unique `region` key (upsert).
  // Optional `wg_pubkey` (design §13.3): when present, the WireGuard gateway peer
  // is paired in the SAME step via grin-gateway-ctl — the panel replaces the old
  // 4-hop SSH ping-pong. Metadata save is never hostage to wg state: a helper
  // failure still keeps the saved location and reports 502 + wg_error.
  router.post('/api/admin/locations', secureAdmin, async (req, res) => {
    try {
      const { region, label, country, country_code, api_url, stratum_url } = req.body || {};
      const is_active = req.body && req.body.is_active === false ? 0 : 1;
      const reg = String(region || '').trim();
      if (!reg) return res.status(400).json({ error: 'region is required' });
      // Optional map position of the gateway box (operator-typed, never resolved from an IP —
      // see the column comment in lib/db.js). Both blank → NULL/NULL and the network map falls
      // back to the country centroid; one blank, non-numeric, or out of range → 400, because a
      // half pair silently becomes "no pin" and NaN/Infinity would put the marker off the globe.
      // Number() not parseFloat(): parseFloat('12abc') is 12, and a typo must not save as a spot.
      // A body with NEITHER key (an API caller editing just the label) keeps the stored pin —
      // clearing is an explicit blank pair, never an omission. The panel always posts both.
      const _rawLat = req.body && req.body.lat, _rawLng = req.body && req.body.lng;
      const _blank = (v) => v == null || String(v).trim() === '';
      const keepPin = !(req.body && ('lat' in req.body || 'lng' in req.body));
      let lat = null, lng = null;
      if (!_blank(_rawLat) || !_blank(_rawLng)) {
        if (_blank(_rawLat) || _blank(_rawLng)) {
          return res.status(400).json({ error: 'lat and lng must be given together (or both left blank)' });
        }
        lat = Number(String(_rawLat).trim()); lng = Number(String(_rawLng).trim());
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return res.status(400).json({ error: 'lat must be a number in -90..90 and lng in -180..180 (decimal degrees, e.g. 34.05 / -118.24)' });
        }
        lat = Math.round(lat * 1e4) / 1e4; lng = Math.round(lng * 1e4) / 1e4;
      }
      const wgPubkey = req.body && req.body.wg_pubkey ? String(req.body.wg_pubkey).trim() : '';
      // A malformed key is a typo, not wg state — fail fast before saving anything.
      if (wgPubkey && !/^[A-Za-z0-9+/]{43}=$/.test(wgPubkey)) {
        return res.status(400).json({ error: 'wg_pubkey is not a WireGuard public key (44 base64 chars ending "=")' });
      }
      if (wgPubkey && !/^[a-z0-9-]{2,12}$/.test(reg)) {
        return res.status(400).json({ error: 'a gateway region key must match ^[a-z0-9-]{2,12}$ (it becomes the wg peer tag)' });
      }
      // Step-up gate for the PAIRING branch only: adding a wg peer grants a remote box a
      // trusted tunnel that forwards stratum with PROXY-protocol source IPs (which feed the
      // miner ownership gate) — at least as sensitive as peer REMOVAL, which is already
      // freshAdmin. Metadata-only saves (no wg_pubkey) stay plain secureAdmin so routine
      // region edits don't prompt. Same challenge contract as requireFreshAuth, so the
      // admin client's adminFetch() step-up flow handles it transparently.
      if (wgPubkey && stepUpRefused(req, res)) return;

      // Step-up gate for the ENDPOINT branch (audit §J1-3). stratum_url is not metadata: it is
      // published by GET /api/pool/locations and rendered on the public dashboard as the
      // connection string miners copy into their rigs (public_html/js/reactor-dashboard.js),
      // so editing it re-points the pool's own "how to connect" panel at another server.
      // Deleting the same region is already freshAdmin; advertising a new destination for the
      // whole pool's hashrate must not be cheaper than that. Compare against what is stored so
      // a label/country edit — which re-posts these fields unchanged — still saves without a
      // prompt, and treat "no stored row yet" as a change so a freshly INSERTed region carrying
      // a URL is gated too.
      const _u = (v) => String(v == null ? '' : v).trim();
      const prevLoc = db.prepare('SELECT api_url, stratum_url, lat, lng FROM pool_locations WHERE region = ?').get(reg);
      const endpointChanged = _u(stratum_url) !== _u(prevLoc && prevLoc.stratum_url) ||
                              _u(api_url) !== _u(prevLoc && prevLoc.api_url);
      if (endpointChanged && stepUpRefused(req, res)) return;
      if (keepPin && prevLoc) { lat = prevLoc.lat; lng = prevLoc.lng; }

      // Pre-flight the hub tunnel BEFORE writing anything (read-only `list`).
      // The upsert used to run first, so a pool that had never raised its
      // WireGuard server ended up holding a saved region card AND a 502 that
      // named an SSH menu — the worst possible moment to discover a prerequisite.
      // Refuse the whole request instead, and point at the button that fixes it.
      if (wgPubkey) {
        try {
          await gwctl(['list']);
        } catch (e) {
          return res.status(409).json({
            error: 'Multi-region is not enabled on this pool yet, so the gateway key cannot be paired. Turn it on with "Enable multi-region" at the top of this page, then save this region again.',
            wg_server_missing: true,
            wg_error: e.message
          });
        }
      }

      const cc = country_code ? String(country_code).trim().toUpperCase().slice(0, 2) : null;

      db.prepare(`
        INSERT INTO pool_locations (region, label, country, country_code, api_url, stratum_url, is_active, lat, lng, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(region) DO UPDATE SET
          label = excluded.label,
          country = excluded.country,
          country_code = excluded.country_code,
          api_url = excluded.api_url,
          stratum_url = excluded.stratum_url,
          is_active = excluded.is_active,
          lat = excluded.lat,
          lng = excluded.lng,
          updated_at = unixepoch()
      `).run(reg, label || null, country || null, cc, api_url || null, stratum_url || null, is_active, lat, lng);

      const row = db.prepare('SELECT * FROM pool_locations WHERE region = ?').get(reg);
      // The public map memoises /api/pool/topology for 30 s; an operator who just moved a
      // pin (or hid a region) and opens the map expects to see it, not the previous answer.
      caches.topology = { at: 0, body: null };
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_upsert', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, reg, JSON.stringify({ label, country, country_code: cc, api_url, stratum_url, is_active, lat, lng }), req.ip);

      if (!wgPubkey) return res.json({ success: true, location: row });

      let pair;
      try {
        pair = await gwctl(['add-peer', '--region', reg, '--pubkey', wgPubkey]);
      } catch (e) {
        return res.status(502).json({
          success: false, location: row, wg_error: e.message,
          error: 'Region saved, but WireGuard pairing failed: ' + e.message
        });
      }

      // Hot-bind (§13.3): the helper persisted region_ports in pool.json; mirror it
      // in the in-memory config and bind the tunnel listener NOW — no service
      // restart, zero disruption to connected miners. On the next boot the
      // listener is rebuilt from pool.json anyway. `existing` (dup pubkey) and
      // `replaced` (new box, same region) keep their port, so bind is a no-op then.
      let bindError = null;
      let bindDeferred = false;
      if (pair.region_port) {
        config.region_ports = config.region_ports || {};
        config.region_ports[pair.region] = pair.region_port;
        if (pair.hub_tunnel_ip) config.region_listen_host = pair.hub_tunnel_ip;
        if (stratumServer) {
          // AWAIT the real outcome and surface it (audit §J6-12). bindRegionListener used to
          // return true unconditionally — the listen is asynchronous and its error handler only
          // logged — and this call discarded the return value anyway, so the panel reported a
          // successful pairing for a listener that was not listening. A bind failure is exactly
          // the case an operator must be told about: the region is saved and the tunnel is up,
          // but no miner in it can reach the pool.
          try {
            const r = await stratumServer.bindRegionListener(pair.region, pair.region_port);
            if (r && r.error) bindError = r.error;
            // Stratum is PAUSED (design §21.4): nothing was bound, and that is correct — the
            // port is already in config.region_ports above, which is what resume binds. "No
            // error" must not read as "listening", so say so.
            if (r && r.deferred) bindDeferred = true;
          } catch (e) {
            bindError = e.message;
            console.error(`[ERROR] hot-bind region listener ${pair.region}: ${e.message}`);
          }
        }
      }

      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'gateway_pair', 'wg_peer', ?, ?, ?)
      `).run(req.user.user_id, pair.region, JSON.stringify({
        region: pair.region, pubkey: wgPubkey, peer_ip: pair.peer_ip,
        region_port: pair.region_port, existing: !!pair.existing, replaced: !!pair.replaced
      }), req.ip);

      // `synced:false` = the peer is in the CONFIG but `wg syncconf` did not load it
      // into the running interface, so the gateway will hand-shake only after a
      // tunnel bounce. The CLI has always warned about this; the panel used to
      // report plain success and leave the operator debugging the gateway box.
      res.json({
        success: true, location: row,
        // Non-fatal but load-bearing: the region exists and the peer is configured, yet its
        // stratum listener did not come up, so nothing in that region can connect (§J6-12).
        stratum_bind_error: bindError,
        stratum_bind_deferred: bindDeferred,
        stratum_bind_note: bindDeferred
          ? 'Region saved — stratum is paused, so its listener opens when stratum resumes.' : null,
        pairing: pair.pairing, peer_ip: pair.peer_ip, region_port: pair.region_port,
        existing: !!pair.existing, replaced: !!pair.replaced,
        synced: pair.synced !== false,
        sync_warning: pair.synced === false
          ? 'The peer was written to the WireGuard config, but it could not be loaded into the running tunnel. '
            + 'This gateway will not hand-shake until the tunnel is brought back up on this box.'
          : undefined
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── MULTI-REGION SERVER (Admin only) ──────────────────────────────
  // The hub's OWN WireGuard tunnel — the thing every gateway peers with. Until
  // these two routes existed it could only be raised from the CLI (menu W → 1),
  // which made "pair a gateway from the panel, no SSH needed" false for every
  // pool that had never gone multi-region. GET is the page's pre-flight; POST is
  // the button that fixes it in place.
  router.get('/api/admin/gateways/server', secureAdmin, async (req, res) => {
    try {
      const list = await gwctl(['list']);
      // Two independent facts. `ready` = the hub was set up at all (conf + keypair);
      // `interface_up` = the tunnel is running RIGHT NOW. A conf outlives a
      // `wg-quick down` and a boot where the unit failed, so collapsing them into
      // one light is how a dead tunnel renders green while every gateway is dark.
      res.json({
        success: true, ready: true,
        interface_up: list.interface_up !== false,
        hub_pubkey: list.hub_pubkey || null,
        hub_endpoint: list.hub_endpoint || null,
        hub_tunnel_ip: list.hub_tunnel_ip || null,
        peers: (list.gateways || []).length
      });
    } catch (e) {
      // NOT an error: "no tunnel yet" is the normal state of a single-box pool,
      // and the page renders a banner for it rather than a failure.
      res.json({ success: true, ready: false, interface_up: false, reason: e.message });
    }
  });

  // Raising a tunnel and opening a UDP port is at least as sensitive as pairing a
  // peer, so it takes the same step-up gate peer REMOVAL takes. The long timeout
  // is deliberate: on a box without wireguard-tools the helper installs the
  // package inside this request rather than failing with homework for the operator.
  router.post('/api/admin/gateways/server', freshAdmin, async (req, res) => {
    try {
      const r = await gwctl(['init-server'], 180000);
      // Mirror region_listen_host into the live config so a pairing done in this
      // same process binds its listener on the tunnel IP without a restart.
      if (r.hub_tunnel_ip) config.region_listen_host = r.hub_tunnel_ip;
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'gateway_server_init', 'wg_server', ?, ?, ?)
      `).run(req.user.user_id, r.hub_tunnel_ip || 'wg', JSON.stringify({
        config: r.config, keypair: r.keypair, interface: r.interface,
        firewall: r.firewall, listen_port: r.listen_port, boot_enabled: r.boot_enabled
      }), req.ip);
      // Two steps can legitimately fail while the tunnel itself came up, and BOTH
      // are invisible until something else breaks much later, so they are reported
      // as caveats rather than folded into success:
      //   · boot_enabled=false — /etc/systemd/system is not writable in this
      //     service's namespace, so the tunnel is up now and gone after a reboot.
      //   · firewall='ufw-failed' — same reason for /etc/ufw; the UDP port stays
      //     shut and every gateway times out with no local symptom at all.
      // The CLI (root, no namespace) does both, which is why W → 1 is the fallback.
      const caveats = [];
      if (r.boot_enabled === false) {
        caveats.push('The tunnel could not be enabled at boot from here, so a reboot of this box would '
          + 'take it down. Run "systemctl enable wg-quick@<interface>" over SSH once, or use pool menu W → 1.');
      }
      if (r.firewall === 'ufw-failed') {
        caveats.push('ufw is active but the WireGuard UDP port could not be opened from here. Until you run '
          + `"ufw allow ${r.listen_port}/udp" over SSH, gateways will not be able to hand-shake.`);
      }
      res.json({
        success: true,
        already_configured: !!r.already_configured,
        hub_pubkey: r.hub_pubkey, hub_endpoint: r.hub_endpoint,
        hub_tunnel_ip: r.hub_tunnel_ip, listen_port: r.listen_port,
        firewall: r.firewall, interface: r.interface,
        boot_enabled: r.boot_enabled !== false,
        caveats: caveats.length ? caveats : undefined
      });
    } catch (e) {
      // Journal it: the audit row above is written only on success, so until this
      // line a failed enable left no trace on the box at all — and the browser's
      // copy of the message is one page reload from gone.
      console.error(`[gateways] init-server failed (${req.user && req.user.user_id ? 'admin ' + req.user.user_id : 'admin ?'}): ${e.message}`);
      res.status(502).json({ error: 'Could not enable multi-region: ' + e.message });
    }
  });

  // Re-print a region's GRINGW1 pairing string (replaces SSH `W → 3` for a lost
  // string). Read-only — the helper re-derives it from the live wg conf + pool.json.
  router.get('/api/admin/gateways/:region/pairing', secureAdmin, async (req, res) => {
    try {
      const region = String(req.params.region || '').trim();
      if (!/^[a-z0-9-]{2,12}$/.test(region)) return res.status(400).json({ error: 'invalid region key' });
      const list = await gwctl(['list']);
      const g = (list.gateways || []).find((x) => x.region === region);
      if (!g) return res.status(404).json({ error: `no WireGuard gateway peer for region "${region}"` });
      res.json({ success: true, region, pairing: g.pairing, peer_ip: g.peer_ip, region_port: g.region_port });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Peer removal is destructive (revokes the gateway's tunnel) → stays behind
  // freshAdmin with the delete. `?remove_peer=1` also unpairs the wg peer; without
  // it only the display card goes (the tunnel keeps working — legacy behaviour).
  router.delete('/api/admin/locations/:id', freshAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM pool_locations WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'location not found' });
      db.prepare('DELETE FROM pool_locations WHERE id = ?').run(id);
      caches.topology = { at: 0, body: null }; // same 30 s memo as the upsert above
      db.prepare(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
        VALUES (?, 'location_delete', 'pool_location', ?, ?, ?)
      `).run(req.user.user_id, row.region, JSON.stringify(row), req.ip);

      if (String(req.query.remove_peer || '') !== '1') {
        return res.json({ success: true, deleted: row.region });
      }
      try {
        const rm = await gwctl(['remove-peer', '--region', row.region]);
        if (config.region_ports) delete config.region_ports[row.region];
        // v1 does NOT hot-unbind the listener (rare op) — it idles on the tunnel
        // IP until the next natural service restart rebuilds from pool.json.
        db.prepare(`
          INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, ip)
          VALUES (?, 'gateway_unpair', 'wg_peer', ?, ?, ?)
        `).run(req.user.user_id, row.region, JSON.stringify({ region: row.region, synced: rm.synced !== false }), req.ip);
        res.json({ success: true, deleted: row.region, wg_removed: true });
      } catch (e) {
        // The card is already gone — surface the peer failure instead of 500ing.
        res.json({ success: true, deleted: row.region, wg_removed: false, wg_error: e.message });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
