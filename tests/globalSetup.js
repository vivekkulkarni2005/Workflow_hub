'use strict';

/**
 * Boots a real MongoDB (in-memory binary) once for the whole run and exports
 * its URI through the environment so every worker/test file can connect to it.
 * No Docker, no local mongod, no fixtures on disk.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
  process.env.NODE_ENV = 'test';
  process.env.REDIS_IN_MEMORY = 'true';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.BCRYPT_ROUNDS = '4'; // hashing is the slowest thing in the suite
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.RATE_LIMIT_AUTH_MAX = '100000';
  process.env.LOG_LEVEL = 'silent';

  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'workflow-hub-test' } });
  process.env.MONGODB_URI = mongod.getUri('workflow-hub-test');
  global.__MONGOD__ = mongod;
};

module.exports.globalTeardown = async function globalTeardown() {
  await global.__MONGOD__?.stop();
};
