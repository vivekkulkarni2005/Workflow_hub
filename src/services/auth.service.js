'use strict';

const crypto = require('crypto');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const env = require('../config/env');
const logger = require('../config/logger');
const {
  signAccessToken,
  signRefreshToken,
  hashToken,
  randomId,
} = require('../utils/jwt');

/* ------------------------------------------------------------------ *
 * Refresh-token store (Redis)
 *
 * Key layout:
 *   rt:<jti>          -> { userId, familyId }  the ONE currently valid token
 *   rtf:<familyId>    -> SET of every JTI ever issued in this family
 *   rtu:<userId>      -> SET of familyIds (all of a user's live sessions)
 *
 * ROTATION WITH REUSE DETECTION
 *   Every refresh mints a new JTI, stores it, and deletes the old one while
 *   remembering it in the family set. If a *deleted* JTI is ever presented we
 *   know the token was stolen and replayed, so we nuke the whole family and
 *   force a fresh login. One-shot tokens + reuse detection = a stolen refresh
 *   token has a very short useful life.
 * ------------------------------------------------------------------ */

const K = {
  token: (jti) => `rt:${jti}`,
  familySeen: (familyId) => `rtf:${familyId}`,
  userFamilies: (userId) => `rtu:${userId}`,
};

const TTL_SECONDS = () => {
  const m = /^(\d+)([smhd])$/.exec(env.jwt.refreshTtl);
  if (!m) return 7 * 24 * 3600;
  const n = Number(m[1]);
  return { s: n, m: n * 60, h: n * 3600, d: n * 86400 }[m[2]];
};

async function issueRefreshToken(redis, userId, familyId = randomId(8)) {
  const jti = randomId(16);
  const token = signRefreshToken({ sub: userId, jti, fam: familyId, typ: 'refresh' });
  const ttl = TTL_SECONDS();
  await redis
    .multi()
    .set(K.token(jti), JSON.stringify({ userId: String(userId), familyId }), 'EX', ttl)
    .sadd(K.familySeen(familyId), jti)
    .expire(K.familySeen(familyId), ttl)
    .sadd(K.userFamilies(userId), familyId)
    .expire(K.userFamilies(userId), ttl)
    .exec();
  return { token, jti, familyId };
}

/** Rotate: verify -> detect reuse -> delete old -> issue new. */
async function rotateRefreshToken(redis, presentedToken) {
  const { verifyRefreshToken } = require('../utils/jwt');
  let payload;
  try {
    payload = verifyRefreshToken(presentedToken);
  } catch {
    throw AppError.unauthorized('Invalid refresh token', 'REFRESH_INVALID');
  }
  if (payload.typ !== 'refresh') {
    throw AppError.unauthorized('Wrong token type', 'REFRESH_INVALID');
  }

  const key = K.token(payload.jti);
  const record = await redis.get(key);

  if (!record) {
    // Unknown or already-rotated JTI -> possible theft. Burn the family.
    const wasSeen = await redis.sismember(K.familySeen(payload.fam), payload.jti);
    if (wasSeen) {
      await revokeFamily(redis, payload.fam, payload.sub);
      logger.warn({ userId: payload.sub, jti: payload.jti }, 'refresh token reuse detected');
      throw AppError.unauthorized(
        'Refresh token reuse detected — all sessions revoked',
        'REFRESH_REUSE'
      );
    }
    throw AppError.unauthorized('Refresh token expired or revoked', 'REFRESH_EXPIRED');
  }

  const meta = JSON.parse(record);
  if (meta.userId !== String(payload.sub)) {
    throw AppError.unauthorized('Refresh token mismatch', 'REFRESH_INVALID');
  }

  const { token } = await issueRefreshToken(redis, meta.userId, payload.fam);
  await redis.del(key); // one-shot: the old JTI dies the moment a new one is born
  return { userId: meta.userId, token, familyId: payload.fam };
}

/** Kill every token in a family (logout, password change, reuse detection). */
async function revokeFamily(redis, familyId, userId) {
  const jtis = await redis.smembers(K.familySeen(familyId));
  const keys = jtis.map((jti) => K.token(jti));
  if (keys.length) await redis.del(...keys);
  await redis.del(K.familySeen(familyId));
  if (userId) await redis.srem(K.userFamilies(userId), familyId);
  return keys.length;
}

/** Logout: drop this session and every token in its family. */
async function revokeRefreshToken(redis, presentedToken) {
  try {
    const { verifyRefreshToken } = require('../utils/jwt');
    const payload = verifyRefreshToken(presentedToken);
    await revokeFamily(redis, payload.fam, payload.sub);
    return true;
  } catch {
    return false;
  }
}

async function revokeAllForUser(redis, userId) {
  const families = await redis.smembers(K.userFamilies(userId));
  for (const fam of families) await revokeFamily(redis, fam, userId);
  await redis.del(K.userFamilies(userId));
}

function accessTokenFor(user) {
  return signAccessToken({ sub: String(user._id ?? user.id), typ: 'access' });
}

/* ------------------------------ flows ------------------------------ */

async function register({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) throw AppError.conflict('Email already registered', 'EMAIL_TAKEN');

  const passwordHash = await User.hashPassword(password);
  const user = await User.create({
    name,
    email,
    passwordHash,
    avatarColor: `#${crypto.randomBytes(3).toString('hex')}`,
  });
  return user;
}

async function login({ email, password }, redis) {
  const user = await User.findOne({ email }).select('+passwordHash');
  // Always run bcrypt so a missing user and a wrong password take the same time
  // (otherwise response latency enumerates valid accounts).
  const hash = user?.passwordHash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcryptCompare(password, hash);
  if (!user || !ok) throw AppError.unauthorized('Invalid email or password', 'BAD_CREDENTIALS');
  if (!user.isActive) throw AppError.forbidden('Account is disabled', 'USER_DISABLED');

  const { token: refreshToken } = await issueRefreshToken(redis, user._id);
  return { user, accessToken: accessTokenFor(user), refreshToken };
}

async function refresh(redis, presentedToken) {
  const { userId, token: refreshToken } = await rotateRefreshToken(redis, presentedToken);
  const user = await User.findById(userId);
  if (!user || !user.isActive) {
    await revokeAllForUser(redis, userId);
    throw AppError.unauthorized('Account no longer active', 'USER_INACTIVE');
  }
  return { user, accessToken: accessTokenFor(user), refreshToken };
}

async function logout(redis, presentedToken) {
  if (!presentedToken) return false;
  return revokeRefreshToken(redis, presentedToken);
}

async function me(userId) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');
  return user;
}

// Kept in a helper so `login` reads cleanly and the compare cost is explicit.
function bcryptCompare(plain, hash) {
  // eslint-disable-next-line global-require
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(plain, hash);
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  accessTokenFor,
  issueRefreshToken,
  revokeAllForUser,
  revokeFamily,
  K,
};
