// page.js — the page page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was page.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
    (function () {
      var params = new URLSearchParams(location.search);
      var key = (params.get('p') || '').replace(/[^a-z0-9_-]/gi, '');
      // No ?p= at all: this is the bare shell, not a missing page. Say so, and list what
      // is published rather than pretending the visitor asked for something that is gone.
      if (!key) { renderMissing(false); return; }

      fetch('/api/public/page/' + encodeURIComponent(key))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || !json.data) { renderMissing(true); return; }
          // Skip when the server rendered the head: its title is "<page> — <pool>" (and may
          // use the page's seo_title override), which the bare title here would undo.
          if (!document.querySelector('meta[name="server-seo"]')) document.title = json.data.title;
          var t = document.getElementById('page-title');
          t.textContent = json.data.title;
          t.classList.remove('muted');
          // Operator-authored HTML: rendered in a sandboxed frame, never on this origin (D22-4).
          showBody(document.getElementById('page-body'), json.data.html, 'content', json.data.title);
          // Set the page key so per-page SEO overrides can target it.
          document.documentElement.setAttribute('data-page', 'page-' + key);
        })
        .catch(function () { renderMissing(true); });

      // The body goes into a frame with no allow-scripts (js/cms-frame.js). If that script did
      // not load, the body is NOT shown — falling back to innerHTML would undo the fix.
      function showBody(host, html, wrapClass, title) {
        if (window.CmsFrame) { window.CmsFrame.mount(host, html, { wrapClass: wrapClass, title: title }); return; }
        var p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'This page could not be shown. Reload to try again.';
        host.appendChild(p);
      }

      // hadKey = the visitor asked for a specific page that did not resolve (renamed,
      // unpublished, or mistyped). false = they hit /page.html with no key. Either way the
      // body becomes an index of the published pages, fetched from the same list the
      // footer links are built from, so this is never a dead end.
      function renderMissing(hadKey) {
        var title = hadKey ? 'Page not found' : 'Pages';
        // Mirrors the success path: the server already rendered a matching title when it
        // handled this request, so only set it on the legacy/no-server-head route.
        if (!document.querySelector('meta[name="server-seo"]')) document.title = title;
        var t = document.getElementById('page-title');
        t.textContent = title;
        t.classList.remove('muted');
        var body = document.getElementById('page-body');
        var intro = document.createElement('p');
        intro.className = 'muted';
        intro.textContent = hadKey
          ? 'That page is not available — it may have been renamed or unpublished.'
          : 'These are the pages published on this site.';
        body.innerHTML = '';
        body.appendChild(intro);

        var home = document.createElement('p');
        home.innerHTML = '<a href="/">Return home</a>';

        fetch('/api/public/pages')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (json) {
            var list = (json && json.data) || [];
            if (!list.length) { body.appendChild(home); return; }
            var ul = document.createElement('ul');
            ul.className = 'page-index';
            list.forEach(function (p) {
              var li = document.createElement('li');
              var a = document.createElement('a');
              a.href = '/page.html?p=' + encodeURIComponent(p.key);
              a.textContent = p.title;
              li.appendChild(a);
              ul.appendChild(li);
            });
            body.appendChild(ul);
            body.appendChild(home);
          })
          .catch(function () { body.appendChild(home); });
      }
    })();
