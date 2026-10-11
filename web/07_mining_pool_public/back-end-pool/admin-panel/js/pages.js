// pages.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F4).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js, api.js, admin-shell.js, vendor/quill.js and cms-editor.js, whose globals it uses (H14).
API.guardAdminPage();

let _pages = [];
let editor = null;
let slugTouched = false;

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const NAV_LABEL = { footer: 'Footer', header: 'Header', none: '—' };

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
function maybeSyncSlug() {
  if (slugTouched) return;
  const slug = slugify(document.getElementById('page-title-in').value);
  document.getElementById('page-slug').value = slug;
  document.getElementById('slug-preview').textContent = slug || 'slug';
}

function flash(msg, isErr) {
  const el = document.getElementById('page-msg');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function resetForm() {
  document.getElementById('page-id').value = '';
  document.getElementById('page-title-in').value = '';
  document.getElementById('page-slug').value = '';
  document.getElementById('slug-preview').textContent = 'slug';
  document.getElementById('page-nav').value = 'footer';
  document.getElementById('page-order').value = '0';
  document.getElementById('page-seo-title').value = '';
  document.getElementById('page-seo-desc').value = '';
  document.getElementById('page-published').checked = true;
  if (editor) editor.setHTML('');
  slugTouched = false;
  document.getElementById('form-title').textContent = 'New page';
  document.getElementById('cancel-btn').style.display = 'none';
}

async function loadPages() {
  const tbody = document.getElementById('pages-tbody');
  try {
    const d = await API.get('/api/admin/pages');
    if (!d || d.error) throw new Error(d && d.error ? d.error : 'Failed to load pages');
    _pages = d.pages || [];
    if (!_pages.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No pages yet. Create one above.</td></tr>';
      return;
    }
    tbody.innerHTML = _pages.map(p => `
      <tr>
        <td>${escHtml(p.title)}</td>
        <td class="mono">${escHtml(p.slug)}</td>
        <td>${escHtml(NAV_LABEL[p.nav_location] || p.nav_location)}</td>
        <td>${p.is_published ? '<span class="badge badge-ok">Live</span>' : '<span class="badge badge-dim">Draft</span>'}</td>
        <td>
          <div class="row-actions">
            <a class="btn-icon" href="/page.html?p=${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" data-tip="View the live page" aria-label="View the live page">👁️</a>
            <button class="btn-icon" data-action="edit-page" data-id="${p.id}" data-tip="Edit this page" aria-label="Edit this page">✏️</button>
            <button class="btn-icon btn-icon-danger" data-action="delete-page" data-id="${p.id}" data-tip="Delete this page" aria-label="Delete this page">🗑️</button>
          </div>
        </td>
      </tr>`).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function editPage(id) {
  const p = _pages.find(x => x.id === id);
  if (!p) return;
  document.getElementById('page-id').value = p.id;
  document.getElementById('page-title-in').value = p.title || '';
  document.getElementById('page-slug').value = p.slug || '';
  document.getElementById('slug-preview').textContent = p.slug || 'slug';
  document.getElementById('page-nav').value = p.nav_location || 'footer';
  document.getElementById('page-order').value = p.sort_order != null ? p.sort_order : 0;
  document.getElementById('page-seo-title').value = p.seo_title || '';
  document.getElementById('page-seo-desc').value = p.seo_desc || '';
  document.getElementById('page-published').checked = !!p.is_published;
  if (editor) editor.setHTML(p.html || '');
  slugTouched = true;
  document.getElementById('form-title').textContent = 'Edit page #' + p.id;
  document.getElementById('cancel-btn').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitPage() {
  const id = document.getElementById('page-id').value;
  const body = {
    title: document.getElementById('page-title-in').value.trim(),
    slug: document.getElementById('page-slug').value.trim(),
    html: editor ? editor.getHTML() : '',
    nav_location: document.getElementById('page-nav').value,
    sort_order: parseInt(document.getElementById('page-order').value, 10) || 0,
    seo_title: document.getElementById('page-seo-title').value.trim(),
    seo_desc: document.getElementById('page-seo-desc').value.trim(),
    is_published: document.getElementById('page-published').checked,
  };
  try {
    const r = id ? await API.post('/api/admin/pages/' + id, body)
                 : await API.post('/api/admin/pages', body);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Save failed');
    flash('Page saved.', false);
    resetForm();
    loadPages();
  } catch (err) {
    flash(err.message, true);
  }
}

async function deletePage(id) {
  const p = _pages.find(x => x.id === id);
  if (!confirm(`Delete page "${p ? p.title : id}"? This cannot be undone.`)) return;
  try {
    const r = await API.del('/api/admin/pages/' + id);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Delete failed');
    flash('Page deleted.', false);
    loadPages();
  } catch (err) {
    flash(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  editor = CmsEditor.mount('#editor', { placeholder: 'Write the page content…' });
  loadPages();
});

// ==== F4: event wiring — replaces the on*= attributes (inline handlers are blocked by a strict script-src) ====
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'submit-page': submitPage(); break;
    case 'reset-form': resetForm(); break;
    case 'edit-page': editPage(Number(el.dataset.id)); break;
    case 'delete-page': deletePage(Number(el.dataset.id)); break;
  }
});
document.addEventListener('input', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'maybe-sync-slug': maybeSyncSlug(); break;
    case 'slug-touched': slugTouched = true; break;
  }
});
