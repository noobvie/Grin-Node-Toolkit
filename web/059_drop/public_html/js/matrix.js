// matrix.js — Canvas matrix rain background (shared across themes that use it)
// Activated when <body> has class 'theme-matrix'

(function () {
  let canvas, ctx, drops, animId;
  const CHARS = "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEFGRIN";
  const FONT_SIZE = 14;
  const COLOR = "#00ff41";

  function init() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.id = "matrix-canvas";
    Object.assign(canvas.style, {
      position: "fixed", top: 0, left: 0,
      width: "100%", height: "100%",
      zIndex: -1, pointerEvents: "none",
      opacity: "0.18",
    });
    document.body.prepend(canvas);
    ctx = canvas.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    animate();
  }

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const cols = Math.floor(canvas.width / FONT_SIZE);
    drops = new Array(cols).fill(1);
  }

  function animate() {
    ctx.fillStyle = "rgba(0,0,0,0.05)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLOR;
    ctx.font = FONT_SIZE + "px monospace";
    for (let i = 0; i < drops.length; i++) {
      const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
      ctx.fillText(ch, i * FONT_SIZE, drops[i] * FONT_SIZE);
      if (drops[i] * FONT_SIZE > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
    animId = requestAnimationFrame(animate);
  }

  function destroy() {
    if (animId) cancelAnimationFrame(animId);
    if (canvas) { canvas.remove(); canvas = null; ctx = null; drops = null; animId = null; }
    window.removeEventListener("resize", resize);
  }

  // Public API
  window.MatrixRain = { init, destroy };
})();
