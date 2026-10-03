'use strict';

const mongoose = require('mongoose');

// Load `.env` explicitly rather than relying on a transitive require chain
// (seedData -> User -> config/env) to have populated process.env first.
require('dotenv').config();

/**
 * Connects to MongoDB for the scripts.
 *
 * Order of preference:
 *   1. An already-running server at MONGODB_URI (e.g. `docker compose up mongo`).
 *   2. Otherwise a throwaway in-memory mongod, so `npm run seed` and
 *      `npm run benchmark` work on a clean machine with zero infrastructure.
 *
 * The caller MUST call `closeMongo(handle)` when finished: an orphaned mongod
 * child process keeps the parent alive forever, which looks like a hung script.
 */
async function ensureMongo({ quiet = false } = {}) {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/workflow-hub';

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    return { uri, ephemeral: false, mongod: null };
  } catch (err) {
    // eslint-disable-next-line global-require
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create({ instance: { dbName: 'workflow-hub' } });
    const memoryUri = mongod.getUri('workflow-hub');
    await mongoose.connect(memoryUri);
    if (!quiet) {
      // eslint-disable-next-line no-console
      console.log(
        `!!  No MongoDB at ${uri} - started a temporary in-memory instance.\n` +
          '   Run `docker compose up -d mongo` to benchmark against a real server.\n' +
          `   Using: ${memoryUri}`
      );
    }
    return { uri: memoryUri, ephemeral: true, mongod };
  }
}

/** Disconnects mongoose and, if we started it, stops the temporary mongod. */
async function closeMongo(handle) {
  await mongoose.disconnect().catch(() => {});
  if (handle?.mongod) await handle.mongod.stop().catch(() => {});
}

module.exports = { ensureMongo, closeMongo };
