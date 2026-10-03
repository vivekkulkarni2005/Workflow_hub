'use strict';

const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../config/logger');

/** 404 for unmatched routes — runs after every router. */
function notFound(req, _res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

/**
 * Central error handler. Guarantees ONE response shape for every failure:
 *
 *   { "error": { "code", "message", "details"?, "requestId" } }
 *
 * Mongoose/JWT/duplicate-key errors are translated here so controllers never
 * have to know about driver internals, and 5xx details are never leaked.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let error = err;

  if (error.name === 'ValidationError' && error.errors) {
    error = AppError.unprocessable(
      'Database validation failed',
      Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }))
    );
  } else if (error.name === 'CastError') {
    error = AppError.badRequest(`Invalid value for ${error.path}`, 'INVALID_ID');
  } else if (error.code === 11000) {
    error = AppError.conflict(
      `Duplicate value for ${Object.keys(error.keyPattern || {}).join(', ')}`,
      'DUPLICATE_KEY'
    );
  } else if (error.type === 'entity.parse.failed') {
    error = AppError.badRequest('Malformed JSON body', 'INVALID_JSON');
  } else if (!(error instanceof AppError)) {
    error = AppError.internal(
      env.isProd ? 'Internal server error' : error.message,
      'INTERNAL_ERROR'
    );
  }

  const logPayload = {
    err: err.message,
    code: error.code,
    status: error.statusCode,
    method: req.method,
    url: req.originalUrl,
    userId: req.userId,
    requestId: req.id,
  };
  if (error.statusCode >= 500) logger.error(logPayload, 'request failed');
  else logger.warn(logPayload, 'request rejected');

  res.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId: req.id,
    },
  });
}

module.exports = { errorHandler, notFound };
