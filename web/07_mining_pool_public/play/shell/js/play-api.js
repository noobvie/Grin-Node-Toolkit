/* play-api.js — the ONE way the /play/ shell talks to the games service (design §19).
 *
 * Every call is same-origin JSON. The rule that matters: an answer that is not JSON from
 * the games service is "the games are offline", whatever its status. A stopped service is
 * nginx's 502 HTML page, a Cloudflare error is its own HTML, a parked domain answers 200
 * with HTML — none of those may be read as data (CLAUDE.md: reachability needs a parsed
 * result, not an HTTP 200). So a response only counts when its Content-Type is JSON, it
 * parses, and it is an object carrying `ok`.
 *
 *   PlayApi.get(path)        → Promise<body>                     (body.ok === true)
 *   PlayApi.post(path, data) → Promise<body>
 *   PlayApi.rules()          → Promise<body of GET rules>, one request per page load
 *   rejects with PlayApi.Error { kind, status, code, message, body }
 *     kind 'offline' — network error, timeout, non-JSON answer, or the service restarting
 *     kind 'http'    — the service answered with { ok:false, error, message, … }
 *
 * `path` is under /play/api/ and is built by the caller from constants and numbers only;
 * nothing typed by the player is ever put in a URL.
 */
(function () {
  'use strict';

  var BASE = '/play/api/';
  var TIMEOUT_MS = 20000;   // nginx gives the service 30 s; a move with a bot reply is ~ms

  function PlayApiError(kind, status, code, message, body) {
    this.name = 'PlayApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.message = message;
    this.body = body || null;
  }
  PlayApiError.prototype = Object.create(Error.prototype);
  PlayApiError.prototype.constructor = PlayApiError;

  function offline(status, why) {
    return new PlayApiError('offline', status || 0, 'offline', why || 'The games are offline.');
  }

  function isJson(res) {
    var ct = res.headers.get('Content-Type') || '';
    return /^application\/json\b/i.test(ct);
  }

  function request(method, path, data) {
    if (typeof path !== 'string' || !/^[a-z0-9/_-]+(\?[a-z0-9=&_-]*)?$/i.test(path)) {
      return Promise.reject(new PlayApiError('http', 0, 'bad_path', 'Bad request.'));
    }
    var opts = {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',            // an API call is never redirected; a login portal is not data
      headers: { 'Accept': 'application/json' }
    };
    if (method !== 'GET') {
      // JSON content type = CSRF layer 2 (§19.5): a cross-site form cannot send it.
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data || {});
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    }
    return fetch(BASE + path, opts).then(function (res) {
      if (!isJson(res)) throw offline(res.status, 'The games are offline.');
      return res.json().then(function (body) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') {
          throw offline(res.status, 'The games are offline.');
        }
        if (res.ok && body.ok === true) return body;
        var code = typeof body.error === 'string' ? body.error : 'error';
        // The service draining for a restart is an outage to the player, not a refusal.
        if (res.status === 503 && (code === 'shutting_down' || code === 'db_unavailable')) {
          throw offline(res.status, 'The games are restarting. Try again in a moment.');
        }
        var msg = typeof body.message === 'string' ? body.message : 'Something went wrong.';
        throw new PlayApiError('http', res.status, code, msg, body);
      }, function () {
        throw offline(res.status, 'The games are offline.');
      });
    }, function () {
      throw offline(0, 'The games could not be reached.');
    }).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e instanceof PlayApiError) throw e;
      throw offline(0, 'The games could not be reached.');
    });
  }

  // GET rules, shared: the chat panel, the lobby and the guest forms all read the live rules
  // (settings only, nothing per player), so the page asks once. A failure is not cached — the
  // next caller asks again.
  var rulesP = null;
  function rules() {
    if (!rulesP) {
      rulesP = request('GET', 'rules');
      rulesP.catch(function () { rulesP = null; });
    }
    return rulesP;
  }

  window.PlayApi = Object.freeze({
    get: function (path) { return request('GET', path); },
    post: function (path, data) { return request('POST', path, data); },
    rules: rules,
    Error: PlayApiError
  });
})();
