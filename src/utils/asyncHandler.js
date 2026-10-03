'use strict';

/**
 * Wraps an async express handler so rejected promises reach the central error
 * handler instead of becoming unhandled rejections (express 4 does not await
 * handlers, so without this an async throw would hang the request).
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
