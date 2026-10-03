'use strict';

const workspaceService = require('../services/workspace.service');
const reportService = require('../services/report.service');
const taskService = require('../services/task.service');
const { encodeCursor, decodeCursor, parseLimit } = require('../utils/pagination');
const { LIST_SORT, LIST_SORT_KEY } = require('../services/workspace.service');
const { getIO } = require('../sockets');

async function create(req, res) {
  const workspace = await workspaceService.create({
    name: req.body.name,
    description: req.body.description,
    ownerId: req.userId,
  });
  // The creator is in the room for their new workspace immediately.
  getIO()?.in(`user:${req.userId}`).socketsJoin(`ws:${workspace._id}`);
  res.status(201).json({ workspace });
}

async function list(req, res) {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const items = await workspaceService.listForUser(req.userId, { limit, cursor });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  res.json({
    items: page,
    hasMore,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1], LIST_SORT, LIST_SORT_KEY) : null,
  });
}

async function getOne(req, res) {
  // req.workspace is already loaded by authorize(); support slug lookup too.
  let workspace = req.workspace;
  if (!workspace) {
    workspace = await workspaceService.getByIdOrSlug(req.params.workspaceId);
  }
  await workspaceService.listMembers(workspace);
  res.json({ workspace });
}

async function update(req, res) {
  const workspace = await workspaceService.update(req.workspace, req.userId, req.body);
  getIO()?.to(`ws:${workspace._id}`).emit('workspace:updated', { workspace });
  res.json({ workspace });
}

async function remove(req, res) {
  await workspaceService.remove(req.workspace);
  getIO()?.to(`ws:${req.workspace._id}`).emit('workspace:deleted', {
    workspaceId: req.params.workspaceId,
  });
  res.status(204).send();
}

async function listMembers(req, res) {
  await workspaceService.listMembers(req.workspace);
  res.json({ members: req.workspace.members });
}

async function addMember(req, res) {
  const workspace = await workspaceService.addMember(
    req.workspace,
    req.userId,
    req.body.userId,
    req.body.role
  );
  await workspaceService.listMembers(workspace);
  getIO()?.to(`ws:${workspace._id}`).emit('workspace:member_added', {
    workspaceId: String(workspace._id),
    member: workspace.members.find((m) => String(m.user?._id) === String(req.body.userId)),
  });
  // Tell the new member's other tabs to start receiving this workspace's events.
  getIO()?.in(`user:${req.body.userId}`).socketsJoin(`ws:${workspace._id}`);
  res.status(201).json({ members: workspace.members });
}

async function removeMember(req, res) {
  const workspace = await workspaceService.removeMember(
    req.workspace,
    req.userId,
    req.params.userId
  );
  await workspaceService.listMembers(workspace);
  getIO()?.to(`ws:${workspace._id}`).emit('workspace:member_removed', {
    workspaceId: String(workspace._id),
    userId: req.params.userId,
  });
  getIO()?.in(`user:${req.params.userId}`).socketsLeave(`ws:${workspace._id}`);
  res.json({ members: workspace.members });
}

async function changeRole(req, res) {
  const workspace = await workspaceService.changeRole(
    req.workspace,
    req.userId,
    req.params.userId,
    req.body.role
  );
  await workspaceService.listMembers(workspace);
  getIO()?.to(`ws:${workspace._id}`).emit('workspace:member_role_changed', {
    workspaceId: String(workspace._id),
    userId: req.params.userId,
    role: req.body.role,
  });
  res.json({ members: workspace.members });
}

async function activity(req, res) {
  const ActivityLog = require('../models/ActivityLog');
  const limit = parseLimit(req.query.limit);
  const items = await ActivityLog.find({ workspace: req.workspace._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor', 'name avatarColor')
    .lean();
  res.json({ items });
}

async function report(req, res) {
  const result = await reportService.getReport(req.workspace._id);
  res.json(result);
}

async function listTasks(req, res) {
  const result = await taskService.list(req.workspace._id, {
    ...req.query,
    userId: req.userId,
  });
  res.json(result);
}

module.exports = {
  create,
  list,
  getOne,
  update,
  remove,
  listMembers,
  addMember,
  removeMember,
  changeRole,
  activity,
  report,
  listTasks,
};
