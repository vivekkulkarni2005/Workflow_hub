'use strict';

const User = require('../models/User');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { verifyAccessToken, readCookie } = require('../utils/jwt');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Extracts the access token from the HttpOnly cookie, or (for non-browser
 * clients such as Postman) from `Authorization: Bearer <token>`.
 */
function extractToken(req) {
  const fromCookie = readCookie(req, env.cookies.accessName);
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * `authenticate` — 401 unless a valid, unexpired access token is present.
 * On success attaches `req.user` (a lean User document) and `req.token`.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw AppError.unauthorized('Missing access token', 'NO_TOKEN');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    throw AppError.unauthorized(
      expired ? 'Access token expired' : 'Invalid access token',
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    );
  }

  const user = await User.findById(payload.sub).lean();
  if (!user || !user.isActive) {
    throw AppError.unauthorized('Account no longer active', 'USER_INACTIVE');
  }

  req.user = user;
  req.userId = String(user._id);
  req.token = token;
  next();
});

module.exports = { authenticate, extractToken };
