// Applies the saved theme before first paint, so a light-mode user doesn't get
// a dark flash on every load. Lives in its own file (not inline in <head>) so
// the nginx CSP can ship script-src 'self' with no 'unsafe-inline' — on a wallet
// UI that keyword is what would turn any HTML-injection bug into seed theft.
// Must be loaded WITHOUT defer/async, above the stylesheet, or the flash returns.
(function () {
    try {
        if (localStorage.getItem('grin-theme') === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
        }
    } catch (e) { /* storage blocked — dark default is fine */ }
}());
