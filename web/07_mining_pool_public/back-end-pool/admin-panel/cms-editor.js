/* cms-editor.js — shared Quill rich-text editor for the admin CMS (pages + posts).
 * Vendored Quill 2.x is loaded from /js/vendor/quill.js (+ quill.snow.css). The image
 * toolbar button is overridden to UPLOAD to /api/admin/media (instead of Quill's default
 * base64 inline embed, which would bloat the DB) and insert the returned URL.
 *
 * Usage:
 *   const ed = CmsEditor.mount('#editor');   // returns { getHTML, setHTML, quill }
 *   ed.setHTML('<p>existing…</p>');
 *   const html = ed.getHTML();
 */
window.CmsEditor = (function () {
  const TOOLBAR = [
    [{ header: [2, 3, 4, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['blockquote', 'code-block'],
    ['link', 'image'],
    ['clean'],
  ];

  // Upload one File to /api/admin/media; resolves to the served URL. Same-origin fetch sends
  // the httpOnly admin cookie automatically.
  async function uploadImage(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/admin/media', { method: 'POST', body: fd, credentials: 'include' });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok || !json || !json.url) {
      throw new Error((json && json.error) || ('upload failed (' + res.status + ')'));
    }
    return json.url;
  }

  function mount(selector, opts) {
    opts = opts || {};
    if (typeof Quill === 'undefined') {
      console.error('[cms-editor] Quill not loaded — check /js/vendor/quill.js');
      return null;
    }
    const quill = new Quill(selector, {
      theme: 'snow',
      placeholder: opts.placeholder || 'Write here…',
      modules: { toolbar: TOOLBAR },
    });

    // Insert an uploaded image URL at the current cursor (or end of doc). Goes through
    // Quill's API so the editor's internal model (delta) holds the URL, not base64.
    function insertImageUrl(url) {
      const range = quill.getSelection(true) || { index: quill.getLength() };
      quill.insertEmbed(range.index, 'image', url, 'user');
      quill.setSelection(range.index + 1, 0);
    }

    // Upload each image file and insert its URL. Used by the toolbar button AND the
    // paste/drop handlers below, so NO image ever enters the document as base64.
    async function uploadAndInsert(files) {
      for (const file of files) {
        if (!file || !file.type || file.type.indexOf('image/') !== 0) continue;
        try {
          const url = await uploadImage(file);
          insertImageUrl(url);
        } catch (err) {
          alert('Image upload failed: ' + err.message);
        }
      }
    }

    // Toolbar image button: pick a file → upload → insert URL.
    quill.getModule('toolbar').addHandler('image', function () {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
      input.onchange = function () {
        if (input.files && input.files.length) uploadAndInsert([input.files[0]]);
      };
      input.click();
    });

    // Paste handler: if the clipboard carries image FILE(s) (e.g. a screenshot or a copied
    // image), intercept BEFORE Quill turns them into a base64 data: URL — upload + insert a
    // /uploads link instead. Runs in the capture phase to beat Quill's own paste listener.
    // Non-image pastes (text/HTML) fall through untouched so normal paste still works.
    quill.root.addEventListener('paste', function (e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;       // let Quill handle text/HTML paste normally
      e.preventDefault();
      e.stopPropagation();
      uploadAndInsert(files);
    }, true);

    // Drag-and-drop image files onto the editor → upload instead of base64-embed.
    quill.root.addEventListener('drop', function (e) {
      const dropped = (e.dataTransfer && e.dataTransfer.files) || [];
      const files = [];
      for (let i = 0; i < dropped.length; i++) {
        if (dropped[i].type && dropped[i].type.indexOf('image/') === 0) files.push(dropped[i]);
      }
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      uploadAndInsert(files);
    }, true);

    return {
      quill,
      getHTML() {
        const html = quill.root.innerHTML;
        // Quill leaves an empty editor as "<p><br></p>" — normalise that to "".
        return (html === '<p><br></p>' || html === '<p></p>') ? '' : html;
      },
      setHTML(html) {
        quill.root.innerHTML = html || '';
      },
    };
  }

  return { mount, uploadImage };
})();
