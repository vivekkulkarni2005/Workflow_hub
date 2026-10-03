'use strict';

const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/config/db');
const { connectRedis, quitRedis } = require('../src/config/redis');

beforeAll(async () => {
  await connectDb(process.env.MONGODB_URI);
  await connectRedis();
}, 60000);

afterAll(async () => {
  await quitRedis();
  await disconnectDb();
}, 30000);

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
});
