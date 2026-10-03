'use strict';

const authService = require('../services/auth.service');
const env = require('../config/env');
const { getClient } = require('../config/redis');
const { setAuthCookies, clearAuthCookies, readCookie } = require('../utils/jwt');

function sessionResponse(user) {
  return {
    id: String(user._id ?? user.id),
    name: user.name,
    email: user.email,
    avatarColor: user.avatarColor,
  };
}

async function register(req, res) {
  const { name, email, password } = req.body;
  const user = await authService.register({ name, email, password });
  const { accessToken, refreshToken } = await authService.login(
    { email, password },
    getClient()
  );
  setAuthCookies(res, accessToken, refreshToken);
  res.status(201).json({ user: sessionResponse(user) });
}

async function login(req, res) {
  const { email, password } = req.body;
  const { user, accessToken, refreshToken } = await authService.login(
    { email, password },
    getClient()
  );
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ user: sessionResponse(user) });
}

/**
 * Refresh rotation. The refresh cookie is scoped to /api/v1/auth so it is only
 * ever transmitted to these endpoints.
 */
async function refresh(req, res) {
  const presented = readCookie(req, env.cookies.refreshName) || req.body?.refreshToken;
  const { user, accessToken, refreshToken } = await authService.refresh(getClient(), presented);
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ user: sessionResponse(user) });
}

async function logout(req, res) {
  const presented = readCookie(req, env.cookies.refreshName) || req.body?.refreshToken;
  await authService.logout(getClient(), presented);
  clearAuthCookies(res);
  res.status(204).send();
}

async function me(req, res) {
  const user = await authService.me(req.userId);
  res.json({ user: sessionResponse(user) });
}

module.exports = { register, login, refresh, logout, me };
