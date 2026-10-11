// blog.js — the blog page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was blog.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
    (function () {
      var PAGE_SIZE = 8;
      var offset = 0, total = 0;

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function fmtDate(unix) {
        if (!unix) return '';
        try { return new Date(unix * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
        catch (e) { return ''; }
      }

      function render(data) {
        var grid = document.getElementById('post-grid');
        var posts = (data && data.posts) || [];
        total = (data && data.total) || 0;
        if (!posts.length) {
          grid.innerHTML = '<p class="muted">No posts yet. Check back soon.</p>';
          document.getElementById('pager').style.display = 'none';
          return;
        }
        grid.innerHTML = posts.map(function (p) {
          var href = '/blog/' + encodeURIComponent(p.slug);
          var cover = p.cover_image
            ? '<img class="cover" src="' + esc(p.cover_image) + '" alt="">'
            : '<div class="no-cover">📝</div>';
          var tags = (p.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
          return '<a class="post-card" href="' + href + '">' +
            cover +
            '<div class="body">' +
              '<h2>' + esc(p.title) + '</h2>' +
              '<div class="meta">' + esc(fmtDate(p.published_at)) + '</div>' +
              '<div class="excerpt">' + esc(p.excerpt || '') + '</div>' +
              '<div>' + tags + '</div>' +
            '</div>' +
          '</a>';
        }).join('');

        var pager = document.getElementById('pager');
        if (total > PAGE_SIZE) {
          pager.style.display = '';
          document.getElementById('prev').disabled = offset <= 0;
          document.getElementById('next').disabled = offset + PAGE_SIZE >= total;
        } else {
          pager.style.display = 'none';
        }
      }

      function load() {
        fetch('/api/public/posts?limit=' + PAGE_SIZE + '&offset=' + offset)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { render(j && j.data); window.scrollTo({ top: 0 }); })
          .catch(function () {
            document.getElementById('post-grid').innerHTML = '<p class="muted">Could not load posts.</p>';
          });
      }

      window.go = function (dir) {
        offset = Math.max(0, offset + dir * PAGE_SIZE);
        load();
      };

      load();
    })();

// ==== F2: event wiring — replaces the inline on*= attributes this page used to carry (strict
// script-src blocks them). One delegated listener per event type, keyed on data-action; each
// action calls the SAME function with the SAME arguments the old attribute did (`event` → e).
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'go-prev': go(-1); break;
    case 'go-next': go(1); break;
  }
});
