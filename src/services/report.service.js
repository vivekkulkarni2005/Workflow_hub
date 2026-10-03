'use strict';

const mongoose = require('mongoose');
const Task = require('../models/Task');
const { cache } = require('./cache.service');
const env = require('../config/env');
const logger = require('../config/logger');

const REPORT_KEY = (workspaceId) => `report:ws:${String(workspaceId)}`;

/**
 * Open / overdue tasks per assignee.
 *
 * Pipeline (requirement: $match, $group, $lookup, $project):
 *   $match  — equality on `workspace` + a bounded `$in` on `status`; served by
 *             { workspace: 1, status: 1, assignee: 1 } so only this workspace's
 *             non-done tasks are examined instead of the whole collection.
 *   $group  — one bucket per assignee, counting open / overdue / urgent.
 *             Because the index yields documents already ordered by assignee,
 *             the group stage is a streaming $group (no hash spill).
 *   $lookup — joins the user profile for each grouped assignee.
 *   $project — trims the result to exactly what the client needs.
 */
function buildPipeline(workspaceId, now = new Date()) {
  return [
    {
      $match: {
        workspace: new mongoose.Types.ObjectId(String(workspaceId)),
        status: { $in: ['todo', 'doing'] },
        assignee: { $ne: null },
      },
    },
    {
      $group: {
        _id: '$assignee',
        open: { $sum: 1 },
        overdue: {
          $sum: {
            $cond: [{ $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] }, 1, 0],
          },
        },
        urgent: { $sum: { $cond: [{ $eq: ['$priority', 'urgent'] }, 1, 0] } },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'assignee',
      },
    },
    { $unwind: { path: '$assignee', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        assigneeId: '$_id',
        name: { $ifNull: ['$assignee.name', 'Unknown user'] },
        email: { $ifNull: ['$assignee.email', null] },
        avatarColor: { $ifNull: ['$assignee.avatarColor', '#94a3b8'] },
        open: 1,
        overdue: 1,
        urgent: 1,
      },
    },
    { $sort: { open: -1, name: 1 } },
  ];
}

async function computeReport(workspaceId) {
  return Task.aggregate(buildPipeline(workspaceId));
}

async function getReport(workspaceId, { ttl = env.reports.cacheTtlSeconds } = {}) {
  const key = REPORT_KEY(workspaceId);

  const cached = await cache.getJson(key);
  if (cached) {
    logger.debug({ workspaceId }, 'report served from cache');
    return { ...cached, cached: true };
  }

  const startedAt = process.hrtime.bigint();
  const rows = await computeReport(workspaceId);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const totals = rows.reduce(
    (acc, r) => ({
      open: acc.open + r.open,
      overdue: acc.overdue + r.overdue,
      urgent: acc.urgent + r.urgent,
    }),
    { open: 0, overdue: 0, urgent: 0 }
  );

  const payload = {
    workspaceId: String(workspaceId),
    generatedAt: new Date().toISOString(),
    durationMs: Number(durationMs.toFixed(2)),
    totals,
    rows,
  };

  await cache.setJson(key, payload, ttl);
  return { ...payload, cached: false };
}

/** Called after every task mutation so users never see a stale report. */
async function invalidateWorkspaceReport(workspaceId) {
  const removed = await cache.del(REPORT_KEY(workspaceId));
  logger.debug({ workspaceId, removed }, 'report cache invalidated');
  return removed;
}

module.exports = {
  getReport,
  computeReport,
  invalidateWorkspaceReport,
  buildPipeline,
  REPORT_KEY,
};
