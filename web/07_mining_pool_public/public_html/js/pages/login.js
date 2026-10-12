// login.js — the login page's own script. Until 2026-10 (pool code-layout refactor,
// part F2) this was login.html's inline <script> block; it moved out byte-for-byte so
// a strict script-src can drop 'unsafe-inline'. The block's indent is kept.
//
// The page loads it as a CLASSIC script at the block's old position. Never add defer / async /
// type="module": the order and the shared global scope are what this code was written against.
    function showError(msg) {
      const el = document.getElementById('error-msg');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 5000);
    }

    function showSuccess(msg) {
      const el = document.getElementById('success-msg');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 5000);
    }

    // Why the operator is looking at this page. AdminSession (admin-shell.js) appends
    // ?reason= when it signs an idle or over-cap session out, so the panel explains itself
    // instead of appearing to have logged them out at random. Note this message is chosen
    // from the URL, so it is never treated as authoritative — it is a courtesy label, not a
    // security signal, and it never says whether an account exists.
    (function () {
      var m = /[?&]reason=([a-z_]+)/.exec(location.search || '');
      if (!m) return;
      var TEXT = {
        idle:    'Signed out after a period of inactivity. Please log in again.',
        expired: 'Your session reached its maximum length. Please log in again.'
      };
      var msg = TEXT[m[1]];
      if (!msg) return;
      var el = document.getElementById('success-msg');   // neutral styling; not an error
      if (!el) return;
      el.textContent = msg;
      el.style.display = 'block';
      // No auto-hide: unlike a transient form error, this explains why the page is here at
      // all, and the operator may be reading it after walking back to the desk.
    })();

    // Short-lived token from the password step, used to complete 2FA.
    var twofaToken = null;

    async function handleTotp(e) {
      e.preventDefault();
      const code = document.getElementById('totp-code').value;
      const btn = document.getElementById('totp-btn');
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>Verifying...';
      try {
        const res = await fetch('/api/auth/login/totp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ twofa_token: twofaToken, code: code }),
          credentials: 'include'
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = '/admin/';
        } else {
          showError(data.error || 'Verification failed');
          // The token is finished — expired, or burned through its guess budget (the budget is
          // bound to the token, not to the IP; audit §J2-3). Either way the code form can no
          // longer succeed, so go back for a fresh password + captcha rather than leaving the
          // operator typing into a dead form. `restart_login` is the server's explicit signal;
          // the string test stays as a fallback for the expiry message.
          if (data.restart_login || /expired/i.test(data.error || '')) cancelTotp();
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Verify';
      }
    }

    function cancelTotp(e) {
      if (e) e.preventDefault();
      twofaToken = null;
      document.getElementById('totp-form').style.display = 'none';
      document.getElementById('login-form').style.display = 'block';
      loadCaptcha('login'); // step-1 captcha was consumed → get a fresh one
    }

    // ── Self-hosted CAPTCHA (single-use, must be re-fetched after every attempt) ──
    var captchaIds = { login: null, register: null };

    async function loadCaptcha(which, _attempt) {
      var qId = which === 'register' ? 'reg-captcha-question' : 'captcha-question';
      var aId = which === 'register' ? 'reg-captcha-answer' : 'captcha-answer';
      _attempt = _attempt || 0;
      // Clear any stale challenge id up front: if this fetch fails, a null id makes the
      // login gate say "captcha expired" (honest) instead of silently reusing a dead one.
      captchaIds[which] = null;
      document.getElementById(qId).textContent = 'Loading verification…';
      try {
        var res = await fetch('/api/auth/captcha', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status); // e.g. 503 from a rate limiter
        var data = await res.json();
        if (!data || !data.id || !data.question) throw new Error('bad payload');
        captchaIds[which] = data.id;
        document.getElementById(qId).textContent = data.question;
        document.getElementById(aId).value = '';
      } catch (e) {
        // Transient (rate limiter / network blip): back off briefly and retry once
        // automatically so the operator doesn't have to keep clicking "↻ new".
        if (_attempt < 1) {
          setTimeout(function () { loadCaptcha(which, _attempt + 1); }, 1200);
          return;
        }
        document.getElementById(qId).textContent = 'Verification unavailable — click ↻ new';
      }
    }

    function toggleRegister(e) {
      e.preventDefault();
      var loginVisible = document.getElementById('login-form').style.display !== 'none';
      document.getElementById('login-form').style.display = loginVisible ? 'none' : 'block';
      document.getElementById('register-form').style.display = loginVisible ? 'block' : 'none';
      // Load a fresh challenge for whichever form is now shown.
      loadCaptcha(loginVisible ? 'register' : 'login');
    }

    async function handleLogin(e) {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const btn = document.getElementById('login-btn');

      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>Logging in...';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username, password,
            captcha_id: captchaIds.login,
            captcha_answer: document.getElementById('captcha-answer').value
          }),
          credentials: 'include'  // send the httpOnly session cookies
        });

        const data = await res.json();

        if (data.success) {
          // The token is in an httpOnly cookie, not in the response body —
          // there is nothing to store in localStorage.
          window.location.href = '/admin/';
        } else if (data.totp_required) {
          // Password OK, but this admin has 2FA on → show the code step (no new captcha needed).
          twofaToken = data.twofa_token;
          document.getElementById('login-form').style.display = 'none';
          document.getElementById('register-form').style.display = 'none';
          document.getElementById('totp-form').style.display = 'block';
          const c = document.getElementById('totp-code');
          c.value = ''; c.focus();
        } else {
          showError(data.error || 'Login failed');
          loadCaptcha('login'); // single-use → always refresh after a failed attempt
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        loadCaptcha('login');
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Login';
      }
    }

    async function handleRegister(e) {
      e.preventDefault();
      const username = document.getElementById('reg-username').value;
      const password = document.getElementById('reg-password').value;
      const passwordConfirm = document.getElementById('reg-password-confirm').value;
      const btn = document.getElementById('register-btn');

      if (username.length < 3) {
        showError('Username must be at least 3 characters');
        return;
      }

      if (password.length < 8) {
        showError('Password must be at least 8 characters');
        return;
      }

      if (password !== passwordConfirm) {
        showError('Passwords do not match');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>Creating...';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username, password,
            captcha_id: captchaIds.register,
            captcha_answer: document.getElementById('reg-captcha-answer').value
          }),
          credentials: 'include'  // send the httpOnly session cookies
        });

        const data = await res.json();

        if (data.success) {
          // Register already authenticated us (httpOnly cookies set server-side) — go straight in.
          showSuccess('Admin account created! Redirecting…');
          setTimeout(() => { window.location.href = '/admin/'; }, 800);
        } else {
          showError(data.error || 'Registration failed');
          loadCaptcha('register'); // single-use → refresh after a failed attempt
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        loadCaptcha('register');
      } finally {
        btn.disabled = false;
        btn.innerHTML = 'Create Admin Account';
      }
    }

    // Check if already logged in by testing API access (the token is in an httpOnly cookie).
    // Must hit an AUTH-GATED endpoint — /api/health is public and 200 for everyone, which
    // would redirect every visitor to the dashboard (and loop). /api/admin/dashboard returns
    // 200 only with a valid admin cookie, so a logged-out visitor stays on this page.
    async function checkIfLoggedIn() {
      try {
        const res = await fetch('/api/admin/dashboard', { credentials: 'include' });
        if (res.status === 200) {
          window.location.href = '/admin/';
        }
      } catch (e) {
        // Not logged in, stay on login page
      }
    }

    checkIfLoggedIn();
    loadCaptcha('login');

// ==== F2: event wiring — replaces the inline on*= attributes this page used to carry (strict
// script-src blocks them). One delegated listener per event type, keyed on data-action; each
// action calls the SAME function with the SAME arguments the old attribute did (`event` → e).
document.addEventListener('click', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'captcha-login': loadCaptcha('login'); break;
    case 'captcha-register': loadCaptcha('register'); break;
    case 'toggle-register': toggleRegister(e); break;
    case 'cancel-totp': cancelTotp(e); break;
  }
});
document.addEventListener('submit', function (e) {
  var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  switch (el.getAttribute('data-action')) {
    case 'login-submit': handleLogin(e); break;
    case 'register-submit': handleRegister(e); break;
    case 'totp-submit': handleTotp(e); break;
  }
});
