'use strict';

const mongoose = require('mongoose');
const Task = require('../models/Task');
const AppError = require('../utils/AppError');
const { encodeCursor, decodeCursor, cursorFilter, parseLimit } = require('../utils/pagination');
const { logActivity } = require('./activity.service');

/**
 * Every sort ends with a unique tie-breaker (`_id`), which is what makes the
 * keyset cursor total: without it, two tasks sharing a `dueDate` could appear
 * on two pages or on none.
 */
const SORTABLE = {
  createdAt: { createdAt: -1, _id: -1 },
  dueDate: { dueDate: 1, _id: 1 },
  priority: { priority: 1, _id: 1 },
  status: { status: 1, _id: 1 },
};

/**
 * Task listing with filtering + keyset pagination.
 *
 * The filter/sort combination is deliberately restricted so it always maps onto
 * one of the compound indexes declared in models/Task.js; an arbitrary `sort`
 * field from the client would force a blocking in-memory sort.
 */
async function list(workspaceId, query = {}) {
  const limit = parseLimit(query.limit);
  const sortKey = SORTABLE[query.sort] ? query.sort : 'createdAt';
  const sortSpec = SORTABLE[sortKey];

  const filter = { workspace: workspaceId };

  if (query.status) {
    filter.status = Array.isArray(query.status) ? { $in: query.status } : query.status;
  }
  if (query.priority) {
    filter.priority = Array.isArray(query.priority) ? { $in: query.priority } : query.priority;
  }
  if (query.assignee === 'me' && query.userId) {
    filter.assignee = query.userId;
  } else if (query.assignee === 'unassigned') {
    filter.assignee = null;
  } else if (query.assignee) {
    filter.assignee = query.assignee;
  }
  if (query.overdue === 'true') {
    filter.dueDate = { $ne: null, $lt: new Date() };
    filter.status = { $ne: 'done' };
  }
  if (query.q) {
    // Anchored, escaped regex: uses the index for the workspace prefix, never a
    // full collection regex scan.
    const safe = String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.title = { $regex: `^${safe}`, $options: 'i' };
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    Object.assign(filter, cursorFilter(cursor, sortSpec, sortKey));
  }

  // +1 row: the classic "do I have a next page?" probe that costs no extra query.
  const docs = await Task.find(filter).sort(sortSpec).limit(limit + 1);

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1], sortSpec, sortKey) : null;

  return { items: page, nextCursor, hasMore, sort: sortKey };
}

async function getById(workspaceId, taskId) {
  const task = await Task.findOne({ _id: taskId, workspace: workspaceId })
    .populate('assignee', 'name email avatarColor')
    .populate('createdBy', 'name email avatarColor');
  if (!task) throw AppError.notFound('Task not found', 'TASK_NOT_FOUND');
  return task;
}

/**
 * An assignee must actually belong to the workspace — otherwise a task could
 * be parked on a stranger and leak into somebody else's personal task list.
 */
function assertAssignable(workspace, assigneeId) {
  if (assigneeId === undefined || assigneeId === null) return;
  if (!mongoose.isValidObjectId(assigneeId)) {
    throw AppError.badRequest('assignee must be a user id', 'INVALID_ASSIGNEE');
  }
  if (!workspace.roleOf(assigneeId)) {
    throw AppError.badRequest('Assignee must be a workspace member', 'ASSIGNEE_NOT_MEMBER');
  }
}

async function create(workspace, actorId, payload) {
  assertAssignable(workspace, payload.assignee);
  const task = await Task.create({
    workspace: workspace._id,
    title: payload.title,
    description: payload.description ?? '',
    status: payload.status ?? 'todo',
    priority: payload.priority ?? 'medium',
    assignee: payload.assignee ?? null,
    dueDate: payload.dueDate ?? null,
    labels: payload.labels ?? [],
    createdBy: actorId,
  });
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'task.created',
    entity: 'task',
    entityId: task._id,
    meta: { title: task.title },
  });
  return task;
}

async function update(workspace, actorId, taskId, patch) {
  const task = await Task.findOne({ _id: taskId, workspace: workspace._id });
  if (!task) throw AppError.notFound('Task not found', 'TASK_NOT_FOUND');

  if (patch.assignee !== undefined) {
    assertAssignable(workspace, patch.assignee);
  }

  const fields = ['title', 'description', 'status', 'priority', 'assignee', 'dueDate', 'labels'];
  const changed = {};
  for (const field of fields) {
    if (patch[field] !== undefined) changed[field] = patch[field];
  }

  task.set(changed);
  await task.save();
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'task.updated',
    entity: 'task',
    entityId: task._id,
    meta: { fields: Object.keys(changed) },
  });
  return task;
}

async function remove(workspace, actorId, taskId) {
  const task = await Task.findOneAndDelete({ _id: taskId, workspace: workspace._id });
  if (!task) throw AppError.notFound('Task not found', 'TASK_NOT_FOUND');
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'task.deleted',
    entity: 'task',
    entityId: task._id,
    meta: { title: task.title },
  });
  return task;
}

module.exports = { list, getById, create, update, remove, SORTABLE };
