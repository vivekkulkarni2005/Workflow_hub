'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

mongoose.set('strictQuery', true);

/**
 * NOTE: `sanitizeFilter` is intentionally NOT enabled.
 * In Mongoose 8 it wraps every filter value in a Trusted wrapper, which breaks
 * legitimate operators such as `$in` on a typed path (they get cast as a plain
 * value and throw). NoSQL injection is already handled at the edge by
 * express-mongo-sanitize (src/app.js) plus Zod validation, and every query in
 * this codebase is built from validated input — never from a raw user object.
 */

async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: env.isProd ? 50 : 10,
    minPoolSize: env.isProd ? 5 : 1,
    autoIndex: !env.isProd, // in production indexes are built by migrations
    retryWrites: true,
  });
  logger.info('mongodb connected');
  return mongoose.connection;
}

async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('mongodb disconnected');
  }
}

function dbState() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting', 'uninitialized'];
  return states[mongoose.connection.readyState] ?? 'unknown';
}

module.exports = { connectDb, disconnectDb, dbState, mongoose };
