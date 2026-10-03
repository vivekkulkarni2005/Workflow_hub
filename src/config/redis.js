'use strict';

const Redis = require('ioredis');
const MemoryRedis = require('./memoryRedis');
const env = require('./env');
const logger = require('./logger');

/**
 * Single shared Redis connection for the whole process.
 * `createClient()` hands out a duplicate (Redis keeps pub/sub connections
 * separate from command connections — reusing one socket breaks pub/sub).
 */
let client = null;
let mode = null;

function createClient(options = {}) {
  if (!client) throw new Error('Redis not initialised. Call connectRedis() first.');
  if (mode === 'memory') {
    const dup = client.duplicate();
    dup.on('error', (err) => logger.error({ err: err.message }, 'redis(memory) error'));
    return dup;
  }
  const dup = client.duplicate(options);
  dup.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
  return dup;
}

async function connectRedis() {
  if (client) return client;

  if (env.redisInMemory) {
    client = new MemoryRedis();
    mode = 'memory';
    logger.warn('Using in-process Redis substitute (REDIS_IN_MEMORY=true)');
    return client;
  }

  const real = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  real.on('error', (err) => logger.error({ err: err.message }, 'redis connection error'));

  try {
    await real.connect();
    await real.ping();
    client = real;
    mode = 'redis';
    logger.info({ url: env.redisUrl.replace(/:\/\/.*@/, '://***@') }, 'redis connected');
  } catch (err) {
    logger.error({ err: err.message }, 'redis unavailable');
    if (!env.isTest && !env.isProd) {
      logger.warn('Falling back to in-process Redis substitute');
      await real.quit().catch(() => {});
      client = new MemoryRedis();
      mode = 'memory';
      return client;
    }
    throw err;
  }
  return client;
}

function getClient() {
  return client;
}

function getMode() {
  return mode;
}

async function quitRedis() {
  if (!client) return;
  await client.quit().catch(() => client.disconnect?.());
  client = null;
  mode = null;
}

module.exports = { connectRedis, createClient, getClient, getMode, quitRedis, MemoryRedis };
