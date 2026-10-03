'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl,
    issuer: env.jwt.issuer,
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshTtl,
    issuer: env.jwt.issuer,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret, { issuer: env.jwt.issuer });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret, { issuer: env.jwt.issuer });
}

/**
 * Refresh tokens are stored in Redis *hashed* (SHA-256). A leaked Redis dump
 * therefore cannot be replayed against the API, and hashing keeps the store
 * fixed-width. SHA-256 (not bcrypt) is correct here: the input is already
 * 256 bits of cryptographic randomness, so there is nothing to brute-force.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Cookie options shared by the access and refresh cookies. */
function baseCookieOptions() {
  return {
    httpOnly: true, // JavaScript (XSS) cannot read the token
    secure: env.cookies.secure, // HTTPS only (forced on in production)
    sameSite: env.cookies.sameSite, // blocks cross-site form/GET CSRF
    domain: env.cookies.domain,
    path: env.cookies.path,
  };
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(env.cookies.accessName, accessToken, {
    ...baseCookieOptions(),
    maxAge: 15 * 60 * 1000,
  });
  if (refreshToken) {
    res.cookie(env.cookies.refreshName, refreshToken, {
      ...baseCookieOptions(),
      path: '/api/v1/auth', // refresh cookie is only sent to the auth routes
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}

function clearAuthCookies(res) {
  res.clearCookie(env.cookies.accessName, baseCookieOptions());
  res.clearCookie(env.cookies.refreshName, {
    ...baseCookieOptions(),
    path: '/api/v1/auth',
  });
}

function readCookie(req, name) {
  return req.cookies?.[name];
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  randomId,
  baseCookieOptions,
  setAuthCookies,
  clearAuthCookies,
  readCookie,
};
