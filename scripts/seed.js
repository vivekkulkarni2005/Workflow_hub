'use strict';

/**
 * SEEDER - bulk-generates a realistic dataset.
 *
 *   npm run seed                       # 100,000 tasks (defaults)
 *   npm run seed -- --tasks=250000
 *   npm run seed -- --workspaces=40 --users=100
 *
 * Writes go through unordered `bulkWrite` batches: one round trip per batch
 * instead of one per document.
 */

const { ensureMongo, closeMongo } = require('./lib/mongo');
const { seedDatabase } = require('./lib/seedData');
const Task = require('../src/models/Task');

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const TOTAL_TASKS = Number(argv.tasks ?? 100_000);
const WORKSPACES = Number(argv.workspaces ?? 20);
const USERS = Number(argv.users ?? 50);
const BATCH = Number(argv.batch ?? 5_000);

const fmt = (n) => Number(n).toLocaleString('en-US');

async function run() {
  const t0 = Date.now();
  const db = await ensureMongo();
  const { uri } = db;

  console.log(`\nSeeding ${uri}`);
  console.log(
    `  users=${fmt(USERS)} workspaces=${fmt(WORKSPACES)} tasks=${fmt(TOTAL_TASKS)} batch=${fmt(BATCH)}\n`
  );

  const result = await seedDatabase({
    tasks: TOTAL_TASKS,
    workspaces: WORKSPACES,
    users: USERS,
    batch: BATCH,
    onProgress: ({ inserted, total }) => {
      process.stdout.write(
        `\r  -> ${fmt(inserted)}/${fmt(total)} tasks (${Math.round((inserted / total) * 100)}%)   `
      );
    },
  });
  process.stdout.write('\n');

  console.log(`  [ok] ${fmt(result.users)} users`);
  console.log(`  [ok] ${fmt(result.workspaces)} workspaces`);
  console.log(`  [ok] ${fmt(result.tasks)} tasks`);
  console.log(`  [ok] ${(await Task.collection.indexes()).length} indexes on tasks`);

  console.log(
    `\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. ` +
      'Log in with any seeded user: user1@seed.local / SeedPassword123!\n'
  );
  await closeMongo(db);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSeed failed:', err);
    process.exit(1);
  });
