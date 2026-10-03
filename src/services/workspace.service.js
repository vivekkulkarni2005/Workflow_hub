'use strict';

const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const Task = require('../models/Task');
const AppError = require('../utils/AppError');
const { logActivity } = require('./activity.service');
const { invalidateWorkspaceReport } = require('./report.service');

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workspace';
}

async function uniqueSlug(name) {
  const base = slugify(name);
  let candidate = base;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Workspace.exists({ slug: candidate })) {
    i += 1;
    candidate = `${base}-${i}`;
  }
  return candidate;
}

async function create({ name, description, ownerId }) {
  const workspace = await Workspace.create({
    name,
    description,
    slug: await uniqueSlug(name),
    owner: ownerId,
    members: [{ user: ownerId, role: 'owner', joinedAt: new Date() }],
  });
  await logActivity({
    workspace: workspace._id,
    actor: ownerId,
    action: 'workspace.created',
    entity: 'workspace',
    entityId: workspace._id,
  });
  return workspace;
}

/** Must match the cursor's sort key and the index in models/Workspace.js. */
const LIST_SORT = { updatedAt: -1, _id: -1 };
const LIST_SORT_KEY = 'updatedAt';

async function listForUser(userId, { limit = 20, cursor = null } = {}) {
  const filter = { 'members.user': userId, archivedAt: null };
  if (cursor) {
    const { cursorFilter } = require('../utils/pagination');
    Object.assign(filter, cursorFilter(cursor, LIST_SORT, LIST_SORT_KEY));
  }
  return Workspace.find(filter)
    .sort(LIST_SORT)
    .limit(limit + 1)
    .populate('owner', 'name email avatarColor')
    .populate('members.user', 'name email avatarColor');
}

async function getByIdOrSlug(idOrSlug) {
  const query = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug };
  return Workspace.findOne(query);
}

async function update(workspace, actorId, patch) {
  const allowed = {};
  if (patch.name !== undefined) allowed.name = patch.name;
  if (patch.description !== undefined) allowed.description = patch.description;
  if (patch.archivedAt !== undefined) allowed.archivedAt = patch.archivedAt;

  workspace.set(allowed);
  await workspace.save(); // save() bumps updatedAt -> keeps the ESR index ordering fresh
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'workspace.updated',
    entity: 'workspace',
    entityId: workspace._id,
    meta: { fields: Object.keys(allowed) },
  });
  return workspace;
}

async function remove(workspace) {
  await Task.deleteMany({ workspace: workspace._id });
  await workspace.deleteOne();
  await invalidateWorkspaceReport(workspace._id);
}

async function addMember(workspace, actorId, userId, role) {
  if (workspace.roleOf(userId)) {
    throw AppError.conflict('User is already a member', 'ALREADY_MEMBER');
  }
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found', 'USER_NOT_FOUND');

  workspace.addMember(userId, role);
  await workspace.save();
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'workspace.member_added',
    entity: 'workspace',
    entityId: workspace._id,
    meta: { userId: String(userId), role },
  });
  return workspace;
}

async function removeMember(workspace, actorId, targetUserId) {
  const targetRole = workspace.roleOf(targetUserId);
  if (!targetRole) throw AppError.notFound('User is not a member', 'NOT_A_MEMBER');
  if (targetRole === 'owner') {
    throw AppError.forbidden('The workspace owner cannot be removed', 'CANNOT_REMOVE_OWNER');
  }
  workspace.removeMember(targetUserId);
  await workspace.save();
  // Their tasks stay, but become unassigned from that workspace's view.
  await Task.updateMany({ workspace: workspace._id, assignee: targetUserId }, { $set: { assignee: null } });
  await invalidateWorkspaceReport(workspace._id);
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'workspace.member_removed',
    entity: 'workspace',
    entityId: workspace._id,
    meta: { userId: String(targetUserId) },
  });
  return workspace;
}

async function changeRole(workspace, actorId, targetUserId, role) {
  const targetRole = workspace.roleOf(targetUserId);
  if (!targetRole) throw AppError.notFound('User is not a member', 'NOT_A_MEMBER');
  if (targetRole === 'owner') {
    throw AppError.forbidden('The owner role cannot be reassigned', 'CANNOT_CHANGE_OWNER');
  }
  const member = workspace.members.find((m) => String(m.user) === String(targetUserId));
  member.role = role;
  await workspace.save();
  await logActivity({
    workspace: workspace._id,
    actor: actorId,
    action: 'workspace.member_role_changed',
    entity: 'workspace',
    entityId: workspace._id,
    meta: { userId: String(targetUserId), from: targetRole, to: role },
  });
  return workspace;
}

async function listMembers(workspace) {
  return workspace.populate('members.user', 'name email avatarColor lastSeenAt');
}

module.exports = {
  create,
  listForUser,
  LIST_SORT,
  LIST_SORT_KEY,
  getByIdOrSlug,
  update,
  remove,
  addMember,
  removeMember,
  changeRole,
  listMembers,
  slugify,
};
