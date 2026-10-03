'use strict';

/**
 * Application-level error carrying an HTTP status and a stable machine code.
 * Anything thrown that is *not* an AppError is treated as an unexpected bug by
 * the central error handler and reported as a generic 500.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg = 'Bad request', code = 'BAD_REQUEST', details) {
    return new AppError(msg, 400, code, details);
  }
  static unauthorized(msg = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(msg, 401, code);
  }
  static forbidden(msg = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new AppError(msg, 403, code);
  }
  static notFound(msg = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(msg, 404, code);
  }
  static conflict(msg = 'Resource already exists', code = 'CONFLICT') {
    return new AppError(msg, 409, code);
  }
  static unprocessable(msg = 'Validation failed', details) {
    return new AppError(msg, 422, 'VALIDATION_ERROR', details);
  }
  static tooMany(msg = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppError(msg, 429, code);
  }
  static internal(msg = 'Internal server error', code = 'INTERNAL_ERROR') {
    return new AppError(msg, 500, code);
  }
}

module.exports = AppError;
