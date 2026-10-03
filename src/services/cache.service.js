'use strict';

const { getClient, getMode } = require('../config/redis');
const logger = require('../config/logger');
const env = require('../config/env');

const NS = (key) => `workflow-hub:${key}`;

/**
 * Thin, typed-ish wrapper over the shared Redis client. Every read is a cache
 * hit attempt; every failure degrades to a miss instead of breaking the request
 * (a cache outage must never take the API down with it).
 */
class CacheService {
  get mode() {
    return getMode();
  }

  async getJson(key) {
    try {
      const client = getClient();
      if (!client) return null;
      const raw = await client.get(NS(key));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn({ err: err.message, key }, 'cache get failed');
      return null;
    }
  }

  async setJson(key, value, ttlSeconds = env.reports.cacheTtlSeconds) {
    try {
      const client = getClient();
      if (!client) return false;
      await client.set(NS(key), JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch (err) {
      logger.warn({ err: err.message, key }, 'cache set failed');
      return false;
    }
  }

  async del(key) {
    try {
      const client = getClient();
      if (!client) return 0;
      return await client.del(NS(key));
    } catch (err) {
      logger.warn({ err: err.message, key }, 'cache del failed');
      return 0;
    }
  }

  /** Pattern delete built on SCAN (never KEYS — KEYS blocks the Redis event loop). */
  async delPattern(pattern) {
    try {
      const client = getClient();
      if (!client) return 0;
      const match = NS(pattern);
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 200);
        cursor = next;
        if (keys.length) removed += await client.del(...keys);
      } while (cursor !== '0');
      return removed;
    } catch (err) {
      logger.warn({ err: err.message, pattern }, 'cache delPattern failed');
      return 0;
    }
  }
}

const cache = new CacheService();
module.exports = { cache, CacheService, NS };
