// A small DOM for running real admin page scripts under node:vm, built by parsing the real page, so
// a test sees the shipped ids, classes and buttons. It covers what those scripts use and no more:
// no layout and no CSS. Selectors: comma lists, descendant combinators, tag, #id, .class and [attr="value"]. click() honours `disabled` as a browser does.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const camel = (k) => k.slice(5).replace(/-(.)/g, (_, c) => c.toUpperCase());

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
    this.attrs = {};
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.id = '';
    this.className = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this._text = '';
    this._html = null;
    const self = this;
    this.classList = {
      add: (...c) => { self.className = [...new Set(self.className.split(/\s+/).filter(Boolean).concat(c))].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { (on ? self.classList.add : self.classList.remove)(c); },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
    else if (k === 'class') this.className = String(v);
    else if (k.startsWith('data-')) this.dataset[camel(k)] = String(v);
  }
  getAttribute(k) {
    if (k === 'id') return this.id || null;
    if (k === 'class') return this.className || null;
    if (k.startsWith('data-')) {
      const v = this.dataset[camel(k)];
      return v === undefined ? null : v;
    }
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  get value() { return this._value; }
  set value(v) { this._value = v == null ? '' : String(v); }
  get textContent() {
    if (this._html !== null) return this._html.replace(/<[^>]*>/g, '');
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this._html = null;
    this.children.forEach((c) => { c.parentElement = null; });
    this.children = [];
  }
  get innerHTML() { return this._html === null ? this.textContent : this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = '';
    this.children = [];
    this.ownerDocument.parseInto(this._html, this);
  }
  appendChild(el) {
    if (el.parentElement) el.remove();
    el.parentElement = this;
    this.children.push(el);
    return el;
  }
  append(...els) {
    for (const el of els) this.appendChild(typeof el === 'string' ? this.ownerDocument.createTextNode(el) : el);
  }
  prepend(el) {
    if (el.parentElement) el.remove();
    el.parentElement = this;
    this.children.unshift(el);
  }
  remove() {
    if (!this.parentElement) return;
    const sibs = this.parentElement.children;
    sibs.splice(sibs.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) {
    for (let el = this; el; el = el.parentElement) {
      for (const fn of el.listeners[type] || []) fn({ type, target: this, currentTarget: el, preventDefault() {} });
    }
    const doc = this.ownerDocument;
    for (const fn of doc.listeners[type] || []) fn({ type, target: this, currentTarget: doc, preventDefault() {} });
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  scrollIntoView() {}
  focus() {}
  matchesCompound(c) {
    if (c.tag && this.tagName !== c.tag) return false;
    if (c.id && this.id !== c.id) return false;
    if (c.classes.some((x) => !this.classList.contains(x))) return false;
    return c.attrs.every(([k, v]) => (v === undefined ? this.hasAttribute(k) : this.getAttribute(k) === v));
  }
  matches(sel) { return parseSelector(sel).some((chain) => matchesChain(this, chain)); }
  closest(sel) {
    for (let el = this; el; el = el.parentElement) if (el.matches(sel)) return el;
    return null;
  }
  * walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) {
    const chains = parseSelector(sel);
    return [...this.walk()].filter((el) => chains.some((chain) => matchesChain(el, chain)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function parseSelector(sel) {
  return sel.split(',').map((part) => part.trim().split(/\s+/).map((tok) => {
    const c = { tag: null, id: null, classes: [], attrs: [] };
    for (const m of tok.matchAll(/^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      const t = m[0];
      if (t[0] === '#') c.id = t.slice(1);
      else if (t[0] === '.') c.classes.push(t.slice(1));
      else if (t[0] === '[') c.attrs.push([m[1], m[2]]);
      else c.tag = t.toUpperCase();
    }
    return c;
  }));
}

function matchesChain(el, chain) {
  if (!el.matchesCompound(chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = el.parentElement; p && i >= 0; p = p.parentElement) if (p.matchesCompound(chain[i])) i--;
  return i < 0;
}

function parseAttrs(src) {
  const out = {};
  for (const m of src.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

class FakeDocument {
  constructor(html) {
    this.listeners = {};
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.currentScript = null;
    this.hidden = false;
    if (html) this.parseInto(html);
  }
  createElement(tag) { return new FakeElement(tag, this); }
  createTextNode(text) {
    const el = new FakeElement('#text', this);
    el.textContent = text;
    return el;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  getElementById(id) { return [...this.documentElement.walk()].find((el) => el.id === id) || null; }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  parseInto(html, root = this.body) {
    const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    const body = (src.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [null, src])[1];
    let cur = root;
    const stack = [];
    for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g)) {
      if (m[4] !== undefined) {
        if (m[4].trim()) cur.appendChild(this.createTextNode(m[4]));
        continue;
      }
      const tag = m[2].toLowerCase();
      if (m[1]) {
        while (stack.length && cur.tagName !== tag.toUpperCase()) cur = stack.pop();
        if (stack.length) cur = stack.pop();
        continue;
      }
      const el = this.createElement(tag);
      const attrs = parseAttrs(m[3]);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      const defaultType = { input: 'text', textarea: 'textarea', select: 'select-one', button: 'submit' }[tag] || '';
      el.type = attrs.type || defaultType;
      el.value = attrs.value || '';
      el.checked = 'checked' in attrs;
      el.disabled = 'disabled' in attrs;
      cur.appendChild(el);
      if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) { stack.push(cur); cur = el; }
    }
    // A select shows its selected option, else its first; a textarea's value is its text.
    for (const sel of root.querySelectorAll('select')) {
      const opts = sel.querySelectorAll('option');
      const pick = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      if (pick) sel.value = pick.getAttribute('value') ?? pick.textContent;
    }
    for (const ta of root.querySelectorAll('textarea')) ta.value = ta.textContent;
  }
}

module.exports = { FakeDocument, FakeElement };
