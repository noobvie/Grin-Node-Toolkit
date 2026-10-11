// posts.html page script — moved BYTE-verbatim out of the page's inline <script> (code-layout F4).
// Classic script (no defer/module) loaded at the same position as the old block, after auth.js, api.js, admin-shell.js, vendor/quill.js and cms-editor.js, whose globals it uses (H14).
API.guardAdminPage();

let _posts = [];
let editor = null;
let slugTouched = false;

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function maybeSyncSlug() {
  if (slugTouched) return;
  const slug = slugify(document.getElementById('post-title-in').value);
  document.getElementById('post-slug').value = slug;
  document.getElementById('slug-preview').textContent = slug || 'slug';
}
function toLocalInput(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function flash(msg, isErr) {
  const el = document.getElementById('post-msg');
  el.textContent = msg;
  el.className = isErr ? 'error-msg' : 'success-msg';
  el.style.display = '';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function setCover(url) {
  document.getElementById('post-cover').value = url || '';
  const img = document.getElementById('cover-preview');
  if (url) { img.src = url; img.style.display = ''; }
  else { img.removeAttribute('src'); img.style.display = 'none'; }
}

async function uploadCover() {
  const input = document.getElementById('post-cover-file');
  const file = input.files && input.files[0];
  if (!file) return;
  try {
    const url = await CmsEditor.uploadImage(file);
    setCover(url);
    flash('Cover uploaded.', false);
  } catch (err) {
    flash('Cover upload failed: ' + err.message, true);
  } finally {
    input.value = '';
  }
}

function resetForm() {
  document.getElementById('post-id').value = '';
  document.getElementById('post-title-in').value = '';
  document.getElementById('post-slug').value = '';
  document.getElementById('slug-preview').textContent = 'slug';
  document.getElementById('post-excerpt').value = '';
  document.getElementById('post-tags').value = '';
  document.getElementById('post-status').value = 'draft';
  document.getElementById('post-date').value = '';
  setCover('');
  if (editor) editor.setHTML('');
  slugTouched = false;
  document.getElementById('form-title').textContent = 'New post';
  document.getElementById('cancel-btn').style.display = 'none';
}

async function loadPosts() {
  const tbody = document.getElementById('posts-tbody');
  try {
    const d = await API.get('/api/admin/posts');
    if (!d || d.error) throw new Error(d && d.error ? d.error : 'Failed to load posts');
    _posts = d.posts || [];
    if (!_posts.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No posts yet. Write one above.</td></tr>';
      return;
    }
    tbody.innerHTML = _posts.map(p => {
      const when = p.published_at || p.created_at;
      const dateStr = when ? new Date(when * 1000).toLocaleDateString() : '—';
      const badge = p.status === 'published'
        ? '<span class="badge badge-ok">Published</span>'
        : '<span class="badge badge-dim">Draft</span>';
      return `
      <tr>
        <td>${escHtml(p.title)}</td>
        <td>${badge}</td>
        <td>${escHtml(dateStr)}</td>
        <td>${escHtml(p.tags || '')}</td>
        <td>
          <div class="row-actions">
            <a class="btn-icon" href="/blog/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" data-tip="View the live post" aria-label="View the live post">👁️</a>
            <button class="btn-icon" data-action="edit-post" data-id="${p.id}" data-tip="Edit this post" aria-label="Edit this post">✏️</button>
            <button class="btn-icon btn-icon-danger" data-action="delete-post" data-id="${p.id}" data-tip="Delete this post" aria-label="Delete this post">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function editPost(id) {
  const p = _posts.find(x => x.id === id);
  if (!p) return;
  document.getElementById('post-id').value = p.id;
  document.getElementById('post-title-in').value = p.title || '';
  document.getElementById('post-slug').value = p.slug || '';
  document.getElementById('slug-preview').textContent = p.slug || 'slug';
  document.getElementById('post-excerpt').value = p.excerpt || '';
  document.getElementById('post-tags').value = p.tags || '';
  document.getElementById('post-status').value = p.status || 'draft';
  document.getElementById('post-date').value = toLocalInput(p.published_at);
  setCover(p.cover_image || '');
  if (editor) editor.setHTML(p.body_html || '');
  slugTouched = true;
  document.getElementById('form-title').textContent = 'Edit post #' + p.id;
  document.getElementById('cancel-btn').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitPost() {
  const id = document.getElementById('post-id').value;
  const body = {
    title: document.getElementById('post-title-in').value.trim(),
    slug: document.getElementById('post-slug').value.trim(),
    body_html: editor ? editor.getHTML() : '',
    excerpt: document.getElementById('post-excerpt').value.trim(),
    tags: document.getElementById('post-tags').value.trim(),
    cover_image: document.getElementById('post-cover').value.trim(),
    status: document.getElementById('post-status').value,
    published_at: fromLocalInput(document.getElementById('post-date').value),
  };
  try {
    const r = id ? await API.post('/api/admin/posts/' + id, body)
                 : await API.post('/api/admin/posts', body);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Save failed');
    flash('Post saved.', false);
    resetForm();
    loadPosts();
  } catch (err) {
    flash(err.message, true);
  }
}

async function deletePost(id) {
  const p = _posts.find(x => x.id === id);
  if (!confirm(`Delete post "${p ? p.title : id}"? This cannot be undone.`)) return;
  try {
    const r = await API.del('/api/admin/posts/' + id);
    if (!r || r.error) throw new Error(r && r.error ? r.error : 'Delete failed');
    flash('Post deleted.', false);
    loadPosts();
  } catch (err) {
    flash(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  editor = CmsEditor.mount('#editor', { placeholder: 'Write your post…' });
  loadPosts();
});

// ==== F4: event wiring — replaces the on*= attributes (inline handlers are blocked by a strict script-src) ====
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'submit-post': submitPost(); break;
    case 'reset-form': resetForm(); break;
    case 'edit-post': editPost(Number(el.dataset.id)); break;
    case 'delete-post': deletePost(Number(el.dataset.id)); break;
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
document.addEventListener('change', function (e) {
  var el = e.target.closest && e.target.closest('[data-action]');
  if (el && el.dataset.action === 'upload-cover') uploadCover();
});
