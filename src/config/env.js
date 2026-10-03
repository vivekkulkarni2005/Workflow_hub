'use strict';

require('dotenv').config();

const bool = (v, dflt = false) => {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
};

const int = (v, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

const list = (v, dflt = []) =>
  v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : dflt;

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: int(process.env.PORT, 4000),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/workflow-hub',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  // When true the app boots with an in-process Redis substitute instead of a real
  // server. Handy for unit tests / CI without infrastructure.
  redisInMemory: bool(process.env.REDIS_IN_MEMORY, false),

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    issuer: process.env.JWT_ISSUER || 'workflow-hub',
  },

  cookies: {
    accessName: process.env.COOKIE_ACCESS_NAME || 'wf_access',
    refreshName: process.env.COOKIE_REFRESH_NAME || 'wf_refresh',
    domain: process.env.COOKIE_DOMAIN || undefined,
    secure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
    sameSite: process.env.COOKIE_SAMESITE || 'strict',
    path: '/',
  },

  corsOrigins: list(process.env.CORS_ORIGINS, [
    'http://localhost:3000',
    'http://localhost:5173',
  ]),

  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: int(process.env.RATE_LIMIT_MAX, 300),
    authMax: int(process.env.RATE_LIMIT_AUTH_MAX, 10),
  },

  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),

  reports: {
    cacheTtlSeconds: int(process.env.REPORT_CACHE_TTL, 60),
  },

  pagination: {
    defaultLimit: int(process.env.PAGINATION_DEFAULT_LIMIT, 20),
    maxLimit: int(process.env.PAGINATION_MAX_LIMIT, 100),
  },

  shutdownTimeoutMs: int(process.env.SHUTDOWN_TIMEOUT_MS, 10_000),
};

// Fail fast in production when insecure defaults are still in place.
if (env.isProd) {
  const weak = [
    ['JWT_ACCESS_SECRET', env.jwt.accessSecret],
    ['JWT_REFRESH_SECRET', env.jwt.refreshSecret],
  ].filter(([, v]) => !v || v.includes('change-me'));
  if (weak.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[config] Refusing to boot in production with default secrets: ${weak
        .map(([k]) => k)
        .join(', ')}`
    );
    process.exit(1);
  }
}

module.exports = env;
