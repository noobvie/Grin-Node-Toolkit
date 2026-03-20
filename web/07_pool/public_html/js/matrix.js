// matrix.js — Canvas matrix rain background
// Uses Grin + Japanese katakana chars
// Activated when <body> has class 'theme-matrix'

window.MatrixRain = (function () {
  let _canvas = null;
  let _ctx    = null;
  let _raf    = null;
  let _drops  = [];
  let _resizeFn = null;

  const CHARS     = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホGRIN012345679ツ';
  const FONT_SIZE = 14;
  const COLOR     = '#00ff41';

  function init() {
    if (_canvas) return; // already running
    _canvas = document.createElement('canvas');
    _canvas.id = 'matrix-canvas';
    Object.assign(_canvas.style, {
      position:      'fixed',
      top:           '0',
      left:          '0',
      width:         '100%',
      height:        '100%',
      zIndex:        '-1',
      pointerEvents: 'none',
      opacity:       '0.18',
    });
    document.body.prepend(_canvas);
    _ctx = _canvas.getContext('2d');

    _resizeFn = resize;
    window.addEventListener('resize', _resizeFn);
    resize();
    _draw();
  }

  function resize() {
    if (!_canvas) return;
    _canvas.width  = window.innerWidth;
    _canvas.height = window.innerHeight;
    const cols = Math.floor(_canvas.width / FONT_SIZE);
    _drops = new Array(cols).fill(1);
  }

  function _draw() {
    if (!_canvas) return;
    _ctx.fillStyle = 'rgba(0,0,0,0.05)';
    _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
    _ctx.fillStyle = COLOR;
    _ctx.font = FONT_SIZE + 'px monospace';
    for (let i = 0; i < _drops.length; i++) {
      const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
      _ctx.fillText(ch, i * FONT_SIZE, _drops[i] * FONT_SIZE);
      if (_drops[i] * FONT_SIZE > _canvas.height && Math.random() > 0.975) {
        _drops[i] = 0;
      }
      _drops[i]++;
    }
    _raf = requestAnimationFrame(_draw);
  }

  function destroy() {
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    if (_canvas) { _canvas.remove(); _canvas = null; _ctx = null; _drops = []; }
    if (_resizeFn) { window.removeEventListener('resize', _resizeFn); _resizeFn = null; }
  }

  return { init, destroy, _draw };
})();

// ── Sakura Rain (CSS-based) ────────────────────────────────────────────────
window.SakuraRain = (function () {
  let _container = null;
  const PETAL_COUNT = 15;

  function init() {
    if (_container) return;
    _container = document.createElement('div');
    _container.className = 'sakura-canvas';
    _container.id = 'sakura-container';
    for (let i = 0; i < PETAL_COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'sakura-petal';
      _container.appendChild(p);
    }
    document.body.prepend(_container);
  }

  function destroy() {
    if (_container) { _container.remove(); _container = null; }
  }

  return { init, destroy };
})();
