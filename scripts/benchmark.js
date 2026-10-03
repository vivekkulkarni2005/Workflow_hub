'use strict';

/**
 * BENCHMARK - proves the value of the compound index on `tasks`.
 *
 *   npm run benchmark
 *   npm run benchmark -- --runs=20 --tasks=100000
 *
 * Method
 *   1. Make sure the dataset exists (seeds 100k tasks if needed).
 *   2. DROP the compound indexes and run the report aggregation N times.
 *   3. explain('executionStats') the same pipeline -> docsExamined, keysExamined.
 *   4. BUILD the indexes and run the exact same aggregation N times.
 *   5. explain again and print the percentage difference.
 *
 * The report is computed through the service on purpose: it is the exact code
 * path the HTTP endpoint uses, just with the Redis cache bypassed (otherwise the
 * 2nd run would be answered from cache and the numbers would be meaningless).
 */

const mongoose = require('mongoose');
const { ensureMongo, closeMongo } = require('./lib/mongo');
const { seedDatabase } = require('./lib/seedData');

const Workspace = require('../src/models/Workspace');
const Task = require('../src/models/Task');
const { buildPipeline } = require('../src/services/report.service');

const argv = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const RUNS = Number(argv.runs ?? 20);
const MIN_TASKS = Number(argv.tasks ?? 100_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` N times and returns { avg, min, max, results }. */
async function timeRuns(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples,
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * The exact report pipeline, imported from the service the API uses, so the
 * benchmark can never drift away from production behaviour.
 */
function reportPipeline(workspaceId, now) {
  return buildPipeline(new mongoose.Types.ObjectId(String(workspaceId)), now);
}

/** executionStats of the report pipeline, flattened to the numbers we care about. */
async function explainReport(workspaceId) {
  const stats = await Task.collection
    .aggregate(reportPipeline(workspaceId, new Date()))
    .explain('executionStats');

  const exec = stats.stages?.[0]?.$cursor?.executionStats ?? stats.executionStats ?? {};
  return {
    docsExamined: exec.totalDocsExamined ?? 0,
    keysExamined: exec.totalKeysExamined ?? 0,
    nReturned: exec.nReturned ?? 0,
    millis: exec.executionTimeMillis ?? 0,
  };
}

/**
 * The plan for the $match predicate alone. Explaining the *find* is far more
 * portable than digging the winning plan out of an aggregation explain, and it
 * is the plan that decides the whole query: COLLSCAN vs IXSCAN.
 */
async function explainMatch(workspaceId) {
  const explain = await Task.collection
    .find({
      workspace: new mongoose.Types.ObjectId(String(workspaceId)),
      status: { $in: ['todo', 'doing'] },
      assignee: { $ne: null },
    })
    .explain('executionStats');

  const plan = explain.queryPlanner?.winningPlan ?? explain.stages?.[0]?.$cursor?.queryPlanner?.winningPlan;

  // The winning plan is a tree: FETCH -> IXSCAN -> ... Walk to the bottom and
  // report the access stage plus the index it used.
  let node = plan;
  while (node?.inputStage) node = node.inputStage;

  return {
    stage: node?.stage ?? 'n/a',
    indexName: node?.indexName ?? (node?.keyPattern ? JSON.stringify(node.keyPattern) : '-'),
    docsExamined: explain.executionStats?.totalDocsExamined ?? 0,
  };
}

const fmt = (n, digits = 2) => Number(n).toLocaleString('en-US', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const pct = (before, after) => (before === 0 ? 0 : ((before - after) / before) * 100);
const fmtBytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  '))
    .join('\n');
}

/** Bytes on disk for the report index - the write-side cost of having it. */
async function indexSize() {
  const stats = await mongoose.connection.db.command({ collStats: Task.collection.collectionName });
  return stats.totalIndexSize;
}

async function ensureData() {
  const count = await Task.countDocuments();
  if (count >= MIN_TASKS) {
    console.log(`  [ok] reusing ${count.toLocaleString('en-US')} existing tasks\n`);
    return;
  }
  console.log(`  -> seeding ${MIN_TASKS.toLocaleString('en-US')} tasks (first run only)...`);
  await seedDatabase({
    tasks: MIN_TASKS,
    onProgress: ({ inserted, total }) => {
      process.stdout.write(
        `\r    ${Number(inserted).toLocaleString('en-US')}/${Number(total).toLocaleString('en-US')}   `
      );
    },
  });
  process.stdout.write('\n');
}

async function run() {
  const db = await ensureMongo();
  const { uri } = db;
  console.log(`\n=== workflow-hub report benchmark ===`);
  console.log(`  mongo : ${uri}`);
  console.log(`  runs  : ${RUNS} per scenario\n`);

  await ensureData();

  const total = await Task.countDocuments();
  const workspace = await Workspace.findOne();
  if (!workspace) throw new Error('no workspace found - run `npm run seed` first');
  const workspaceId = workspace._id;
  const perWorkspace = await Task.countDocuments({ workspace: workspaceId });

  console.log(`  tasks in collection : ${total.toLocaleString('en-US')}`);
  console.log(`  workspaces          : ${await Workspace.countDocuments()}`);
  console.log(`  tasks in the reported workspace : ${perWorkspace.toLocaleString('en-US')}`);
  console.log(`  reported workspace  : ${workspace.slug}\n`);

  const pipeline = (now) => reportPipeline(workspaceId, now);

  /* ---------------- scenario 1: NO compound index ---------------- */
  console.log('3/4  dropping compound indexes (forces a collection scan)');
  const existing = await Task.collection.indexes();
  const droppable = existing
    .filter((ix) => ix.key && Object.keys(ix.key).length > 1)
    .map((ix) => ix.name);
  if (droppable.length) await Task.collection.dropIndexes();

  // Warm the page cache so scenario 1 is not unfairly penalised by cold I/O.
  await Task.collection.aggregate(pipeline(new Date())).toArray();
  await Task.collection.aggregate(pipeline(new Date())).toArray();

  const withoutIndex = await timeRuns(
    () => Task.collection.aggregate(pipeline(new Date())).toArray(),
    RUNS
  );
  const withoutExplain = await explainReport(workspaceId);
  const withoutPlan = await explainMatch(workspaceId);
  console.log(`     done - avg ${fmt(withoutIndex.avg)} ms\n`);

  /* ------------------- scenario 2: WITH index --------------------- */
  console.log('4/4  building compound indexes');
  const INDEXES = [
    [{ workspace: 1, status: 1, assignee: 1 }, 'workspace_1_status_1_assignee_1'],
    [{ workspace: 1, createdAt: -1, _id: -1 }, 'workspace_1_createdAt_-1__id_-1'],
    [{ workspace: 1, status: 1, dueDate: 1, _id: 1 }, 'workspace_1_status_1_dueDate_1__id_1'],
    [{ assignee: 1, status: 1, dueDate: 1 }, 'assignee_1_status_1_dueDate_1'],
  ];
  for (const [key, name] of INDEXES) {
    // eslint-disable-next-line no-await-in-loop
    await Task.collection.createIndex(key, { name });
  }

  await Task.collection.aggregate(pipeline(new Date())).toArray();
  await Task.collection.aggregate(pipeline(new Date())).toArray();

  const withIndex = await timeRuns(
    () => Task.collection.aggregate(pipeline(new Date())).toArray(),
    RUNS
  );
  const withExplain = await explainReport(workspaceId);
  const withPlan = await explainMatch(workspaceId);
  console.log(`     done - avg ${fmt(withIndex.avg)} ms\n`);

  /* ------------------------- the numbers -------------------------- */
  const avgGain = pct(withoutIndex.avg, withIndex.avg);
  const docsGain = pct(withoutExplain.docsExamined, withExplain.docsExamined);

  console.log('\n---------------- RESULTS ----------------');
  console.log(
    table([
      ['metric', 'WITHOUT index', 'WITH index', 'improvement'],
      [
        'avg latency (ms)',
        fmt(withoutIndex.avg),
        fmt(withIndex.avg),
        `${fmt(avgGain, 1)}% faster`,
      ],
      ['min latency (ms)', fmt(withoutIndex.min), fmt(withIndex.min), `${fmt(pct(withoutIndex.min, withIndex.min), 1)}% faster`],
      ['max latency (ms)', fmt(withoutIndex.max), fmt(withIndex.max), `${fmt(pct(withoutIndex.max, withIndex.max), 1)}% faster`],
      [
        'docsExamined',
        fmt(withoutExplain.docsExamined, 0),
        fmt(withExplain.docsExamined, 0),
        `${fmt(docsGain, 1)}% fewer`,
      ],
      [
        'keysExamined',
        fmt(withoutExplain.keysExamined, 0),
        fmt(withExplain.keysExamined, 0),
        // A scan reads no keys at all, so a percentage here would be misleading.
        'index-only keys',
      ],
      ['nReturned', fmt(withoutExplain.nReturned, 0), fmt(withExplain.nReturned, 0), '-'],
      ['winning plan', withoutPlan.stage, `${withPlan.stage} (${withPlan.indexName})`, '-'],
      ['index size on disk', '-', fmtBytes(await indexSize()), '-'],
    ])
  );

  console.log(
    `\nPer-run WITHOUT index (ms): ${withoutIndex.samples.map((s) => s.toFixed(1)).join(', ')}`
  );
  console.log(
    `Per-run WITH    index (ms): ${withIndex.samples.map((s) => s.toFixed(1)).join(', ')}`
  );
  console.log(
    `\nSummary: the report is ${fmt(avgGain, 1)}% faster with the index, ` +
      `examining ${fmt(docsGain, 1)}% fewer documents ` +
      `(${fmt(withoutExplain.docsExamined, 0)} -> ${fmt(withExplain.docsExamined, 0)}).\n` +
      'A collection scan touches every task in the database. The compound indexes\n' +
      'let the planner seek straight to the (workspace, status) ranges that can\n' +
      'possibly match, which is what the ESR rule is for. Note the winning plan:\n' +
      'MongoDB picked the index that best serves this exact query, which is the\n' +
      'point of declaring several ESR-ordered indexes rather than one.\n'
  );

  await closeMongo(db);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
