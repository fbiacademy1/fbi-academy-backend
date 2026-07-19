// Wraps an async route handler so a thrown error / rejected promise gets
// passed to Express's error-handling middleware (which sends a real JSON
// error response) instead of silently hanging the request until the client
// times out. Express 4 does not do this automatically for async functions.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
