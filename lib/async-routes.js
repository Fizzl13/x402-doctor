// Express 4 does not catch a rejected promise from an async route handler: the rejection goes unhandled and Node
// exits, taking every service on this server down (21 Nov 2026: one Trust Index submission of a local address did
// exactly that). catchAsyncRoutes() wraps every route handler once, process-wide, so a rejection goes to next(err)
// instead: the app's last error handler (lib/error-report.js) answers that request, reports a 5xx to Sentry, and the
// server keeps running.
const METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const WRAPPED = Symbol('asyncRouteGuard');

function guard(fn) {
  // Error handlers (4 arguments), routers and sub-apps keep their own shape.
  if (typeof fn !== 'function' || fn.length === 4 || fn[WRAPPED] || fn.handle || fn.stack) return fn;
  const wrapped = function asyncRouteGuard(req, res, next) {
    let out;
    try {
      out = fn.call(this, req, res, next);
    } catch (err) {
      return next(err);
    }
    if (out && typeof out.then === 'function') out.then(undefined, (err) => next(err || new Error('route failed')));
    return out;
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}

function flatten(args) {
  return args.map((a) => (Array.isArray(a) ? flatten(a) : guard(a)));
}

let installed = false;
function catchAsyncRoutes(express) {
  if (installed) return;
  installed = true;
  const proto = express.Route.prototype;
  for (const m of METHODS) {
    const original = proto[m];
    if (typeof original !== 'function') continue;
    proto[m] = function (...handlers) {
      return original.apply(this, flatten(handlers));
    };
  }
}

module.exports = { catchAsyncRoutes, guard };
