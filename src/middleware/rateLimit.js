'use strict';

const { getClient, getMode } = require('../config/redis');
const env = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');

/**
 * Redis-backed fixed-window rate limiter.
 *
 * Why Redis: the counter must be shared by every API instance, otherwise a user
 * behind N pods gets N x the limit. The counter is a plain key that self-expires
 * (`INCR`, then `PEXPIRE` only on the hit that created it), so there is no cleanup
 * job to run and nothing to leak if a process dies mid-window.
 *
 * Why a custom store instead of express-rate-limit's default: the default keeps
 * counters in-process (useless with >1 instance), and this project also needs to
 * work against the in-process Redis substitute used by the test-suite.
 */
class RedisStore {
  constructor({ prefix, windowMs }) {
    this.prefix = prefix;
    this.windowMs = windowMs;
  }

  key(bucket, id) {
    return `${this.prefix}:${bucket}:${id}`;
  }

  async increment(bucket, id) {
    const client = getClient();
    const key = this.key(bucket, id);
    if (!client) return { totalHits: 1, resetTime: Date.now() + this.windowMs };

    const totalHits = Number(await client.incr(key));

    // Only the hit that *creates* the counter may define the window boundary.
    // Re-arming the TTL on every request would turn this into a sliding window
    // that a client could keep alive indefinitely by never pausing.
    if (totalHits === 1) {
      await client.pexpire(key, this.windowMs);
    }

    const secondsLeft = await client.ttl(key);
    const resetTime = Date.now() + Math.max(1, Number(secondsLeft ?? this.windowMs / 1000)) * 1000;
    return { totalHits, resetTime };
  }

  async reset(bucket, id) {
    const client = getClient();
    if (client) await client.del(this.key(bucket, id));
  }
}

function clientId(req) {
  // Prefer the authenticated user; fall back to the client IP behind a proxy.
  return req.userId || req.ip || 'anonymous';
}

function rateLimit({ windowMs, max, bucket, message }) {
  const store = new RedisStore({ prefix: 'workflow-hub:rl', windowMs });

  return async function rateLimitMiddleware(req, res, next) {
    try {
      const { totalHits, resetTime } = await store.increment(bucket, clientId(req));
      const remaining = Math.max(0, max - totalHits);

      res.set({
        'RateLimit-Limit': String(max),
        'RateLimit-Remaining': String(remaining),
        'RateLimit-Reset': String(Math.ceil(resetTime / 1000)),
      });

      if (totalHits > max) {
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfter));
        logger.warn({ bucket, id: clientId(req), totalHits }, 'rate limit exceeded');
        return next(
          AppError.tooMany(message || `Rate limit exceeded. Retry in ${retryAfter}s.`)
        );
      }
      return next();
    } catch (err) {
      // Fail open: a rate-limiter outage must not take the API down.
      logger.error({ err: err.message, bucket }, 'rate limiter error, failing open');
      return next();
    }
  };
}

const apiRateLimit = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  bucket: 'api',
});

/** Deliberately ~30x stricter: credential endpoints are the brute-force surface. */
const authRateLimit = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  bucket: 'auth',
  message: 'Too many authentication attempts. Try again later.',
});

module.exports = { rateLimit, apiRateLimit, authRateLimit, RedisStore, redisMode: getMode };
