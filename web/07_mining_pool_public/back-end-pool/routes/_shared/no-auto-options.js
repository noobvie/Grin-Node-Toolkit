// Mount-time wrapper for every route-file Router.
//
// An Express Router answers OPTIONS on its own: when a request runs off the end of a Router's
// stack and any route inside it matched the PATH, the Router replies `200 Allow: GET,HEAD` (body
// "GET,HEAD") instead of falling through. Routes registered directly on
// the app's own router never hit this: the final 404 catch-all is reached first — so OPTIONS on any path
// the CORS middleware does not answer (/api/admin/*, /api/auth/*, /blog/*, /health …) was
// `404 {"error":"Not found"}`. Mounted Routers turn that into a 200 that lists the methods of
// every admin route to anyone, ahead of the IP filter and the rate limiter (no route middleware
// runs on that path). This keeps that answer by letting OPTIONS skip the Router entirely.
//
// That is exact ONLY while no route inside a Router handles OPTIONS itself (no router.all /
// router.options): skipping the Router would then skip that route too. The one ALL route,
// /api/admin/games/*, is registered on the app by lib/games-link.js, not in a Router.
// scripts/test-router-options.js asserts both halves and that every mounted Router carries this.
//
// Returns the SAME Router (only its `handle` is shadowed): the endpoints directory and the route-manifest
// recorder both recognise a mount by the Router object, so a wrapper function would hide every
// route behind it (a wrapper once broke /api/public/endpoints).
module.exports = function noAutoOptions(router) {
  const handle = router.handle;
  router.handle = function noAutoOptionsHandle(req, res, out) {
    if (req.method === 'OPTIONS') return out();
    return handle.call(this, req, res, out);
  };
  return router;
};
