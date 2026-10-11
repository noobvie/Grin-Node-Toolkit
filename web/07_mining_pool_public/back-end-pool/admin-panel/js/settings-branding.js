// settings-branding.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F4).
// Classic script (no defer/module) loaded at the same position as the old block, after settings-common.js (and the scripts before it), whose globals it uses (H14).
    // Testnet pools always link to test.grinscan.org (the only explorer with a usable testnet),
    // so the mainnet choice is greyed out there. Disabling is safe for the Branding save: the
    // harvester still sends the select, but its value is the stored one (already a valid enum),
    // or '' when the stored value matches no option — and an empty scalar is dropped, never
    // saved. The network comes from admin-shell's /api/pool/stats fetch: read the attribute if
    // it has already landed, otherwise wait for its event.
    (function () {
      var sel = document.getElementById('explorer_mainnet');
      var help = document.getElementById('explorer-help');
      if (!sel || !help) return;
      function applyNetwork(net) {
        if (net !== 'testnet' || sel.disabled) return;
        sel.disabled = true;
        sel.style.opacity = '.55';
        sel.style.cursor = 'not-allowed';
        help.className = 'warn-msg';
        help.textContent = '';
        var b = document.createElement('b');
        b.textContent = 'Testnet pool:';
        help.appendChild(b);
        help.appendChild(document.createTextNode(' every link opens test.grinscan.org — this choice only applies to mainnet pools.'));
      }
      applyNetwork(document.documentElement.getAttribute('data-pool-network'));
      document.addEventListener('admin:pool-network', function (e) { applyNetwork(e.detail && e.detail.network); });
    })();
